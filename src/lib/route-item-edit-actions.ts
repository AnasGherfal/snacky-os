"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { isRouteItemsEditableStatus } from "@/lib/route-workflow";

type RouteItemEditPayloadRow = {
  id?: string | null;
  routeStopId?: string | null;
  productId?: string | null;
  quantity?: unknown;
  notes?: string | null;
};

type RouteItemEditPayload = {
  routeId?: string | null;
  items?: RouteItemEditPayloadRow[] | null;
};

type ParsedRouteItemRow = {
  rowId: string | null;
  routeStopId: string;
  productId: string;
  quantity: number;
  notes: string | null;
};

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function quantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function itemKey(routeStopId: string, productId: string) {
  return `${routeStopId}:${productId}`;
}

function parsePayload(rawValue: FormDataEntryValue | null): RouteItemEditPayload {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return { items: [] };

  const parsed = JSON.parse(raw) as RouteItemEditPayload;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    throw new Error("Route items payload is invalid.");
  }

  return parsed;
}

function compareRouteItemPriority(left: any, right: any) {
  const leftActive = quantity(left.planned_quantity) > 0 ? 1 : 0;
  const rightActive = quantity(right.planned_quantity) > 0 ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;

  const leftHistory = (left.is_checked ? 8 : 0)
    + (quantity(left.picked_quantity) > 0 ? 4 : 0)
    + (quantity(left.filled_quantity) > 0 ? 2 : 0)
    + (quantity(left.returned_quantity) > 0 ? 1 : 0);
  const rightHistory = (right.is_checked ? 8 : 0)
    + (quantity(right.picked_quantity) > 0 ? 4 : 0)
    + (quantity(right.filled_quantity) > 0 ? 2 : 0)
    + (quantity(right.returned_quantity) > 0 ? 1 : 0);
  if (leftHistory !== rightHistory) return rightHistory - leftHistory;

  const leftManual = String(left.source ?? "") === "manual_admin_assignment" ? 1 : 0;
  const rightManual = String(right.source ?? "") === "manual_admin_assignment" ? 1 : 0;
  if (leftManual !== rightManual) return rightManual - leftManual;

  const leftCreated = new Date(String(left.created_at ?? left.updated_at ?? 0)).getTime() || 0;
  const rightCreated = new Date(String(right.created_at ?? right.updated_at ?? 0)).getTime() || 0;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;

  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function summarizeRouteItem(row: any) {
  return {
    id: String(row.id ?? ""),
    route_stop_id: String(row.route_stop_id ?? ""),
    machine_id: String(row.machine_id ?? ""),
    product_id: String(row.product_id ?? ""),
    planned_quantity: quantity(row.planned_quantity),
    picked_quantity: row.picked_quantity == null ? null : quantity(row.picked_quantity),
    filled_quantity: row.filled_quantity == null ? null : quantity(row.filled_quantity),
    returned_quantity: row.returned_quantity == null ? null : quantity(row.returned_quantity),
    source: String(row.source ?? ""),
    notes: row.notes ?? null,
    is_checked: Boolean(row.is_checked),
    checked_at: row.checked_at ?? null,
    checked_by: row.checked_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function requireOwnerAdminRouteAccess(path: string) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

async function revalidateRoutePaths(routeId: string, stopIds: string[]) {
  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);
  revalidatePath(`/routes/${routeId}/edit`);
  revalidatePath("/operator/routes");
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/pick-list`);
  revalidatePath(`/operator/routes/${routeId}/leftovers`);
  stopIds.forEach((stopId) => revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`));
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
}

async function syncRouteStockLines(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
  routeId: string,
) {
  const [{ data: allItems, error: allItemsError }, { data: stockLines, error: stockLinesError }] = await Promise.all([
    supabase.from("route_stop_items").select("product_id, planned_quantity").eq("route_id", routeId),
    supabase.from("route_stock_lines").select("id, product_id, picked_qty, returned_qty").eq("route_id", routeId),
  ]);

  if (allItemsError) throw allItemsError;
  if (stockLinesError) throw stockLinesError;

  const plannedByProduct = new Map<string, number>();
  (allItems ?? []).forEach((row: any) => {
    const productId = clean(row.product_id);
    if (!productId) return;
    const plannedQty = quantity(row.planned_quantity);
    if (plannedQty <= 0) return;
    plannedByProduct.set(productId, (plannedByProduct.get(productId) ?? 0) + plannedQty);
  });

  const now = new Date().toISOString();
  for (const row of stockLines ?? []) {
    const productId = String((row as any).product_id ?? "");
    const plannedQty = plannedByProduct.get(productId) ?? 0;
    const hasHistory = quantity((row as any).picked_qty) > 0 || quantity((row as any).returned_qty) > 0;
    if (plannedQty <= 0 && !hasHistory) {
      const { error } = await supabase.from("route_stock_lines").delete().eq("id", String((row as any).id ?? ""));
      if (error) throw error;
      continue;
    }

    const { error } = await supabase
      .from("route_stock_lines")
      .update({ planned_qty: plannedQty, updated_at: now })
      .eq("id", String((row as any).id ?? ""));
    if (error) throw error;
  }

  const existingProductIds = new Set((stockLines ?? []).map((row: any) => String(row.product_id ?? "")));
  const newRows = Array.from(plannedByProduct.entries())
    .filter(([productId, plannedQty]) => plannedQty > 0 && !existingProductIds.has(productId))
    .map(([productId, plannedQty]) => ({ route_id: routeId, product_id: productId, planned_qty: plannedQty, updated_at: now }));

  if (newRows.length) {
    const { error } = await supabase.from("route_stock_lines").insert(newRows);
    if (error) throw error;
  }
}

export async function saveRouteItemEdits(formData: FormData) {
  const routeId = clean(formData.get("id"));
  if (!routeId) redirect("/routes");

  const editPath = `/routes/${routeId}/edit`;
  const { profile, supabase } = await requireOwnerAdminRouteAccess(editPath);

  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, status, started_at, completed_at, cancelled_at, operator_id")
    .eq("id", routeId)
    .maybeSingle();
  if (routeError || !route) fail(editPath, "Route not found.");
  if (!isRouteItemsEditableStatus(route.status)) fail(editPath, "Completed or cancelled routes cannot be edited.");

  let payload: RouteItemEditPayload;
  try {
    payload = parsePayload(formData.get("payload"));
  } catch (error) {
    fail(editPath, error instanceof Error && error.message ? error.message : "Route items payload is invalid.");
  }

  if (payload.routeId && payload.routeId !== routeId) {
    fail(editPath, "Route payload did not match this route.");
  }

  const { data: stops, error: stopsError } = await supabase
    .from("route_stops")
    .select("id, machine_id, stop_order")
    .eq("route_id", routeId)
    .order("stop_order", { ascending: true });
  if (stopsError) fail(editPath, "Could not load route stops.");

  const routeStops = stops ?? [];
  if (!routeStops.length) fail(editPath, "This route has no stops to edit.");

  const stopById = new Map(routeStops.map((stop: any) => [String(stop.id ?? ""), stop]));
  const routeMachineIds = Array.from(new Set(routeStops.map((stop: any) => String(stop.machine_id ?? "")).filter(Boolean)));

  const parsedRows: ParsedRouteItemRow[] = [];
  for (const rawRow of payload.items ?? []) {
    const rowId = clean(rawRow?.id);
    const routeStopId = clean(rawRow?.routeStopId);
    const productId = clean(rawRow?.productId);
    const notes = clean(rawRow?.notes);
    const qty = quantity(rawRow?.quantity);

    if (!rowId && qty === 0) continue;
    if (!routeStopId) fail(editPath, "Each route item needs a machine stop.");
    if (!stopById.has(routeStopId)) fail(editPath, "One of the selected stops does not belong to this route.");
    if (!productId) fail(editPath, "Each route item needs a product.");

    parsedRows.push({ rowId, routeStopId, productId, quantity: qty, notes });
  }

  if (!parsedRows.length) fail(editPath, "No route items were submitted.");

  const submittedProductIds = Array.from(new Set(parsedRows.map((row) => row.productId)));
  const [productResult, slotResult, currentRowsResult] = await Promise.all([
    submittedProductIds.length
      ? supabase.from("products").select("id").in("id", submittedProductIds)
      : Promise.resolve({ data: [], error: null }),
    submittedProductIds.length && routeMachineIds.length
      ? supabase
          .from("machine_slots")
          .select("id, machine_id, product_id, slot_code")
          .in("machine_id", routeMachineIds)
          .in("product_id", submittedProductIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, machine_slot_id, slot_code, planned_quantity, picked_quantity, filled_quantity, returned_quantity, source, notes, is_checked, checked_at, checked_by, created_at, updated_at")
      .eq("route_id", routeId),
  ]);

  if (productResult.error) fail(editPath, "Could not verify selected products.");
  if (slotResult.error) fail(editPath, "Could not load machine slot assignments.");
  if (currentRowsResult.error) fail(editPath, "Could not load the current route items.");

  const productIdSet = new Set((productResult.data ?? []).map((row: any) => String(row.id ?? "")));
  const slotByMachineProduct = new Map<string, any>();
  (slotResult.data ?? []).forEach((slot: any) => {
    const key = itemKey(String(slot.machine_id ?? ""), String(slot.product_id ?? ""));
    if (!slotByMachineProduct.has(key)) slotByMachineProduct.set(key, slot);
  });

  const currentRows = (currentRowsResult.data ?? []) as any[];
  const currentRowsById = new Map<string, any>();
  const currentRowsByKey = new Map<string, any[]>();
  currentRows.forEach((row) => {
    const rowId = String(row.id ?? "");
    currentRowsById.set(rowId, row);
    const key = itemKey(String(row.route_stop_id ?? ""), String(row.product_id ?? ""));
    currentRowsByKey.set(key, [...(currentRowsByKey.get(key) ?? []), row]);
  });

  const claimedTargetIds = new Set<string>();
  const now = new Date().toISOString();

  for (const row of parsedRows) {
    const stop = stopById.get(row.routeStopId);
    if (!stop) fail(editPath, "One of the selected stops does not belong to this route.");
    if (!productIdSet.has(row.productId)) fail(editPath, "One of the selected products is invalid.");

    const currentById = row.rowId ? currentRowsById.get(row.rowId) ?? null : null;
    const currentByKeyCandidates = currentRowsByKey.get(itemKey(row.routeStopId, row.productId)) ?? [];
    const currentByKey = currentByKeyCandidates.find((candidate) => !claimedTargetIds.has(String(candidate.id ?? ""))) ?? currentByKeyCandidates[0] ?? null;
    const target = currentById ?? currentByKey;
    const slot = slotByMachineProduct.get(itemKey(String(stop.machine_id ?? ""), row.productId)) ?? null;
    const originalKey = target ? itemKey(String(target.route_stop_id ?? ""), String(target.product_id ?? "")) : null;
    const sameKey = target ? originalKey === itemKey(row.routeStopId, row.productId) : false;
    const source = target && sameKey ? String(target.source ?? "manual_admin_assignment") : "manual_admin_assignment";
    const machineSlotId = slot?.id ?? (target && sameKey ? target.machine_slot_id ?? null : null);
    const slotCode = slot?.slot_code ?? (target && sameKey ? target.slot_code ?? null : null);

    if (target) {
      claimedTargetIds.add(String(target.id ?? ""));
      const { error: updateError } = await supabase
        .from("route_stop_items")
        .update({
          route_stop_id: row.routeStopId,
          machine_id: String(stop.machine_id ?? ""),
          product_id: row.productId,
          machine_slot_id: machineSlotId,
          slot_code: slotCode,
          planned_quantity: row.quantity,
          source,
          notes: row.notes,
          updated_at: now,
        })
        .eq("id", String(target.id ?? ""));
      if (updateError) fail(editPath, "Could not save route item changes.");
    } else if (row.quantity > 0) {
      const { error: insertError } = await supabase.from("route_stop_items").insert({
        route_id: routeId,
        route_stop_id: row.routeStopId,
        machine_id: String(stop.machine_id ?? ""),
        product_id: row.productId,
        machine_slot_id: machineSlotId,
        slot_code: slotCode,
        planned_quantity: row.quantity,
        picked_quantity: null,
        filled_quantity: null,
        returned_quantity: null,
        source: "manual_admin_assignment",
        notes: row.notes,
        is_checked: false,
        checked_at: null,
        checked_by: null,
        updated_at: now,
      });
      if (insertError) fail(editPath, "Could not save route item changes.");
    }
  }

  const { data: refreshedRows, error: refreshedRowsError } = await supabase
    .from("route_stop_items")
    .select("id, route_stop_id, machine_id, product_id, machine_slot_id, slot_code, planned_quantity, picked_quantity, filled_quantity, returned_quantity, source, notes, is_checked, checked_at, checked_by, created_at, updated_at")
    .eq("route_id", routeId);
  if (refreshedRowsError) fail(editPath, "Could not verify route item changes.");

  const activeGroups = new Map<string, any[]>();
  (refreshedRows ?? []).forEach((row: any) => {
    if (quantity(row.planned_quantity) <= 0) return;
    const key = itemKey(String(row.route_stop_id ?? ""), String(row.product_id ?? ""));
    activeGroups.set(key, [...(activeGroups.get(key) ?? []), row]);
  });

  for (const rowsForKey of activeGroups.values()) {
    if (rowsForKey.length <= 1) continue;
    const ordered = [...rowsForKey].sort(compareRouteItemPriority);
    const primary = ordered[0];
    const combinedQty = ordered.reduce((sum, row) => sum + quantity(row.planned_quantity), 0);
    const primaryNotes = ordered.find((row) => String(row.notes ?? "").trim())?.notes ?? null;
    const primarySource = ordered.find((row) => String(row.source ?? "") === "manual_admin_assignment")?.source ?? primary.source ?? "manual_admin_assignment";

    const { error: primaryError } = await supabase.from("route_stop_items").update({
      planned_quantity: combinedQty,
      notes: primaryNotes,
      source: primarySource,
      updated_at: now,
    }).eq("id", String(primary.id ?? ""));
    if (primaryError) fail(editPath, "Could not finalize route item changes.");

    for (const duplicate of ordered.slice(1)) {
      const { error: duplicateError } = await supabase.from("route_stop_items").update({
        planned_quantity: 0,
        updated_at: now,
      }).eq("id", String(duplicate.id ?? ""));
      if (duplicateError) fail(editPath, "Could not finalize route item changes.");
    }
  }

  await syncRouteStockLines(supabase, routeId);

  const { data: afterRows, error: afterRowsError } = await supabase
    .from("route_stop_items")
    .select("id, route_stop_id, machine_id, product_id, machine_slot_id, slot_code, planned_quantity, picked_quantity, filled_quantity, returned_quantity, source, notes, is_checked, checked_at, checked_by, created_at, updated_at")
    .eq("route_id", routeId);
  if (afterRowsError) fail(editPath, "Could not confirm route item changes.");

  await logActivity({
    profile,
    action: "update",
    entityType: "route",
    entityId: routeId,
    entityLabel: `Route ${route.route_date ?? routeId}`,
    beforeData: { route, route_stop_items: currentRows.map(summarizeRouteItem) },
    afterData: { route, route_stop_items: (afterRows ?? []).map(summarizeRouteItem) },
    metadata: {
      route_id: routeId,
      stop_count: routeStops.length,
      submitted_row_count: parsedRows.length,
    },
    summary: `Updated route items for ${route.route_date ?? routeId}`,
  });

  revalidateRoutePaths(routeId, routeStops.map((stop: any) => String(stop.id ?? "")).filter(Boolean));
  redirect(`/routes/${routeId}?success=${encodeURIComponent("ØªÙ… Ø­ÙØ¸ Ø§Ù„ØªØ¹Ø¯ÙŠÙ„Ø§Øª")}`);
}
