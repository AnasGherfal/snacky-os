import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { isTerminalRouteStatus } from "@/lib/route-workflow";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" ");
}

function isMissingColumn(error: unknown, columns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? "Unknown database error");
  }
  return "Unknown database error";
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function routeStopProductKey(routeStopId: string | null | undefined, productId: string | null | undefined) {
  return `${routeStopId ?? ""}:${productId ?? ""}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  if (!routeId) {
    return NextResponse.json({ error: "Route id is required" }, { status: 400 });
  }

  try {
    const { data: route, error: routeError } = await supabase.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle();
    if (routeError) throw routeError;
    if (!route) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }
    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      return NextResponse.json({ error: "This route is not assigned to you" }, { status: 403 });
    }
    const readClient = getSupabaseAdminClient() ?? supabase;

    const { data: stops, error: stopsError } = await supabase
      .from("route_stops")
      .select("id, machine_id, stop_order, status, machine:machines(id, name, machine_code, location:locations(id, name))")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true });
    if (stopsError) throw stopsError;

    const stopById = new Map<string, any>();
    const stopByMachine = new Map<string, any>();
    (stops ?? []).forEach((stop: any) => {
      const stopId = String(stop.id ?? "");
      const machineId = String(stop.machine_id ?? "");
      if (stopId) stopById.set(stopId, stop);
      if (machineId) stopByMachine.set(machineId, stop);
    });
    const pendingStopIds = new Set((stops ?? []).filter((stop: any) => String(stop.status ?? "") === "pending").map((stop: any) => String(stop.id)));

    let { data: stopItems, error: stopItemsError }: { data: any[] | null; error: any } = await supabase
      .from("route_stop_items")
      .select(
        `id,
        route_stop_id,
        machine_id,
        machine:machines(id, name, machine_code),
        product_id,
        planned_quantity,
        source,
        product:products(id, name, sku)`
      )
      .eq("route_id", routeId);

    if (stopItemsError) {
      if (!isMissingTable(stopItemsError, "route_stop_items")) throw stopItemsError;
      const fallback = await supabase
        .from("refill_orders")
        .select(
          `id,
          machine_id,
          machine:machines(id, name, machine_code),
          refill_order_lines(
            id,
            machine_slot_id,
            product_id,
            final_qty_to_take,
            suggested_qty,
            source,
            product:products(id, name, sku)
          )`
        )
        .eq("route_id", routeId);
      if (fallback.error) throw fallback.error;
      stopItems = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          id: line.id,
          route_stop_id: stopByMachine.get(String(order.machine_id ?? ""))?.id ?? null,
          machine_id: order.machine_id,
          machine: order.machine,
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
          source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
          product: line.product,
        })),
      );
    }

    let { data: pickListItems, error: pickListError }: { data: any[] | null; error: any } = await supabase
      .from("route_pick_list_items")
      .select("id, route_stop_id, route_stop_item_id, machine_id, product_id, picked_qty, planned_qty, action_type, reason, notes")
      .eq("route_id", routeId);
    if (pickListError && isMissingColumn(pickListError, ["route_stop_id", "route_stop_item_id", "machine_id"])) {
      const fallback = await supabase
        .from("route_pick_list_items")
        .select("id, product_id, picked_qty, planned_qty, action_type, reason, notes")
        .eq("route_id", routeId);
      pickListItems = fallback.data;
      pickListError = fallback.error;
    }
    if (pickListError && !isMissingTable(pickListError, "route_pick_list_items")) throw pickListError;

    const pickedByStopItem = new Map<string, { quantity: number; reason: string | null; notes: string | null }>();
    const pickedByStopProduct = new Map<string, { quantity: number; reason: string | null; notes: string | null }>();
    const legacyPickedByProduct = new Map<string, { quantity: number; reason: string | null; notes: string | null }>();
    const pickedByProduct = new Map<string, number>();
    const extraItems = (pickListItems ?? [])
      .filter((line: any) => line.action_type === "extra_product" && line.product_id && line.route_stop_id && pendingStopIds.has(String(line.route_stop_id)) && !line.route_stop_item_id)
      .map((line: any) => {
        const productId = String(line.product_id ?? "").trim();
        const quantity = unitQuantity(line.picked_qty);
        if (productId) pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
        return {
          productId,
          routeStopId: line.route_stop_id ? String(line.route_stop_id) : null,
          machineId: line.machine_id ? String(line.machine_id) : null,
          quantity,
          reason: line.reason ?? "Customer demand",
          notes: line.notes ?? "",
        };
      });

    (pickListItems ?? []).forEach((line: any) => {
      const actionType = String(line.action_type ?? "");
      if (actionType !== "planned_pick" && !(actionType === "extra_product" && line.route_stop_item_id)) return;
      const productId = String(line.product_id ?? "").trim();
      if (!productId) return;
      const lineStopId = line.route_stop_id ? String(line.route_stop_id) : null;
      if (!lineStopId || !pendingStopIds.has(lineStopId)) return;
      const quantity = unitQuantity(line.picked_qty);
      pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
      const next = { quantity, reason: line.reason ?? null, notes: line.notes ?? null };
      if (line.route_stop_item_id) {
        const key = String(line.route_stop_item_id);
        const current = pickedByStopItem.get(key);
        pickedByStopItem.set(key, {
          quantity: (current?.quantity ?? 0) + quantity,
          reason: next.reason ?? current?.reason ?? null,
          notes: next.notes ?? current?.notes ?? null,
        });
        return;
      }
      if (line.route_stop_id) {
        const key = routeStopProductKey(String(line.route_stop_id), productId);
        const current = pickedByStopProduct.get(key);
        pickedByStopProduct.set(key, {
          quantity: (current?.quantity ?? 0) + quantity,
          reason: next.reason ?? current?.reason ?? null,
          notes: next.notes ?? current?.notes ?? null,
        });
        return;
      }
      const current = legacyPickedByProduct.get(productId);
      legacyPickedByProduct.set(productId, {
        quantity: (current?.quantity ?? 0) + quantity,
        reason: next.reason ?? current?.reason ?? null,
        notes: next.notes ?? current?.notes ?? null,
      });
    });

    const sortedStopItems = [...(stopItems ?? [])].sort((a: any, b: any) => {
      const aStop = stopById.get(String(a.route_stop_id ?? "")) ?? stopByMachine.get(String(a.machine_id ?? ""));
      const bStop = stopById.get(String(b.route_stop_id ?? "")) ?? stopByMachine.get(String(b.machine_id ?? ""));
      const stopOrderDiff = Number(aStop?.stop_order ?? 9999) - Number(bStop?.stop_order ?? 9999);
      if (stopOrderDiff) return stopOrderDiff;
      return String(a.product_id ?? "").localeCompare(String(b.product_id ?? ""));
    });

    const legacyAllocationByStopItem = new Map<string, { quantity: number; reason: string | null; notes: string | null }>();
    legacyPickedByProduct.forEach((legacyPick, productId) => {
      const productLines = sortedStopItems.filter((line: any) => String(line.product_id ?? "") === productId);
      let remaining = legacyPick.quantity;
      productLines.forEach((line: any, index: number) => {
        const lineId = String(line.id ?? "");
        if (!lineId) return;
        const plannedQty = unitQuantity(line.planned_quantity);
        const isLast = index === productLines.length - 1;
        const allocated = isLast ? Math.max(0, remaining) : Math.max(0, Math.min(remaining, plannedQty));
        remaining -= allocated;
        legacyAllocationByStopItem.set(lineId, {
          quantity: allocated,
          reason: legacyPick.reason,
          notes: legacyPick.notes,
        });
      });
    });

    const plannedByProduct = new Map<string, any>();
    const stopGroupsById = new Map<string, any>();
    (stops ?? []).forEach((stop: any) => {
      const machine = firstRelation(stop.machine);
      const location = firstRelation((machine as any)?.location);
      stopGroupsById.set(String(stop.id), {
        route_stop_id: stop.id,
        machine_id: stop.machine_id,
        stop_status: stop.status,
        machine_name: (machine as any)?.name ?? "Unknown machine",
        machine_code: (machine as any)?.machine_code ?? "-",
        location_name: (location as any)?.name ?? "Unknown location",
        stop_order: Number(stop.stop_order ?? 0),
        items: [],
      });
    });

    sortedStopItems.forEach((line: any) => {
      const productId = String(line.product_id ?? "").trim();
      const plannedQty = unitQuantity(line.planned_quantity);
      if (!productId || plannedQty <= 0) return;
      const routeStopId = line.route_stop_id ? String(line.route_stop_id) : null;
      const routeStopItemId = String(line.id ?? "");
      const stop = routeStopId ? stopById.get(routeStopId) : stopByMachine.get(String(line.machine_id ?? ""));
      if (String(stop?.status ?? "") !== "pending") return;
      const machine = firstRelation(stop?.machine) ?? firstRelation(line.machine);
      const location = firstRelation((machine as any)?.location);
      const product = firstRelation(line.product);
      const savedPick =
        (routeStopItemId ? pickedByStopItem.get(routeStopItemId) : undefined) ??
        pickedByStopProduct.get(routeStopProductKey(routeStopId, productId)) ??
        (routeStopItemId ? legacyAllocationByStopItem.get(routeStopItemId) : undefined) ??
        null;

      const groupId = routeStopId ?? `machine:${String(line.machine_id ?? "")}`;
      const group = stopGroupsById.get(groupId) ?? {
        route_stop_id: routeStopId,
        machine_id: line.machine_id,
        stop_status: stop?.status ?? null,
        machine_name: (machine as any)?.name ?? "Unknown machine",
        machine_code: (machine as any)?.machine_code ?? "-",
        location_name: (location as any)?.name ?? "Unknown location",
        stop_order: Number(stop?.stop_order ?? 0),
        items: [],
      };
      group.items.push({
        route_stop_item_id: routeStopItemId,
        route_stop_id: routeStopId,
        machine_id: line.machine_id,
        product_id: productId,
        product_name: (product as any)?.name || "Unknown Product",
        sku: (product as any)?.sku ?? null,
        planned_qty: plannedQty,
        picked_qty: savedPick ? savedPick.quantity : null,
        reason: savedPick?.reason ?? null,
        notes: savedPick?.notes ?? null,
        source: line.source ?? "manual_admin_assignment",
      });
      stopGroupsById.set(groupId, group);

      const current = plannedByProduct.get(productId) ?? {
        product_id: productId,
        product_name: (product as any)?.name || "Unknown Product",
        sku: (product as any)?.sku ?? null,
        planned_qty: 0,
        picked_qty: 0,
        has_picked_qty: false,
        machine_items: [],
      };
      current.planned_qty += plannedQty;
      if (savedPick) {
        current.picked_qty += savedPick.quantity;
        current.has_picked_qty = true;
      }
      current.machine_items.push({
        route_stop_item_id: routeStopItemId,
        route_stop_id: routeStopId,
        machine_id: line.machine_id,
        machine_name: (machine as any)?.name ?? "Unknown machine",
        machine_code: (machine as any)?.machine_code ?? "-",
        location_name: (location as any)?.name ?? "Unknown location",
        planned_qty: plannedQty,
        picked_qty: savedPick ? savedPick.quantity : null,
        source: line.source ?? "manual_admin_assignment",
      });
      plannedByProduct.set(productId, current);
    });

    const { data: productOptionsData, error: productOptionsError } = await readClient
      .from("products")
      .select("id, sku, barcode, name, category, brand, image_url, active")
      .eq("active", true)
      .order("name");
    if (productOptionsError) throw productOptionsError;

    const productIds = Array.from(new Set([
      ...Array.from(plannedByProduct.keys()),
      ...Array.from(pickedByProduct.keys()),
      ...(productOptionsData ?? []).map((product: any) => product.id),
    ].filter(Boolean)));

    const [storageResult, productNamesResult] = await Promise.all([
      productIds.length
        ? readClient
            .from("current_inventory_by_location")
            .select("product_id, quantity_on_hand")
            .eq("location_type", "storage")
            .in("product_id", productIds)
        : Promise.resolve({ data: [], error: null }),
      productIds.length
        ? readClient
            .from("products")
            .select("id, name, sku")
            .in("id", productIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (storageResult.error) throw storageResult.error;
    if (productNamesResult.error) throw productNamesResult.error;

    const productById = new Map((productNamesResult.data ?? []).map((product: any) => [String(product.id), product]));
    plannedByProduct.forEach((line: any, productId) => {
      const product = productById.get(productId);
      if (product?.name) line.product_name = product.name;
      if (product?.sku !== undefined) line.sku = product.sku;
    });

    const storageByProduct = new Map<string, number>();
    (storageResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id ?? "").trim();
      if (!productId) return;
      storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + unitQuantity(row.quantity_on_hand));
    });

    const stopGroups = Array.from(stopGroupsById.values())
      .map((group: any) => ({
        ...group,
        items: (group.items ?? []).map((line: any) => ({
          ...line,
          available_storage_qty: (storageByProduct.get(String(line.product_id)) ?? 0) + (pickedByProduct.get(String(line.product_id)) ?? 0),
        })),
      }))
      .filter((group: any) => group.items.length > 0)
      .sort((a: any, b: any) => Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0));

    const { data: pickMovements, error: pickMovementError } = await supabase
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .eq("reason", "storage_to_operator_bag")
      .limit(1);
    if (pickMovementError) throw pickMovementError;
    const confirmed = Boolean(pickMovements?.length);

    const items = Array.from(plannedByProduct.values()).map((line: any) => ({
      product_id: line.product_id,
      product_name: line.product_name || "Unknown product",
      sku: line.sku ?? null,
      planned_qty: unitQuantity(line.planned_qty),
      picked_qty: line.has_picked_qty ? unitQuantity(line.picked_qty) : null,
      available_storage_qty: (storageByProduct.get(String(line.product_id)) ?? 0) + (pickedByProduct.get(String(line.product_id)) ?? 0),
      machine_items: Array.isArray(line.machine_items) ? line.machine_items : [],
    }));

    const productOptions = (productOptionsData ?? []).map((product: any) => ({
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      category: product.category,
      brand: product.brand,
      imageUrl: product.image_url,
      availableStorageQty: (storageByProduct.get(String(product.id)) ?? 0) + (pickedByProduct.get(String(product.id)) ?? 0),
    }));

    return NextResponse.json({
      stopGroups,
      items,
      routeTotals: items,
      productOptions,
      extraItems,
      confirmed,
      locked: isTerminalRouteStatus(route.status),
      routeStatus: route.status,
      pendingStopCount: (stops ?? []).filter((stop: any) => String(stop.status ?? "") === "pending").length,
      debug: process.env.NODE_ENV === "development"
        ? { routeId, routeStopItemsCount: stopItems?.length ?? 0, aggregatedPickListCount: items.length, routePickListItemsCount: pickListItems?.length ?? 0, productOptionsCount: productOptions.length, operatorTeamMemberId: profile?.team_member_id ?? null }
        : undefined,
    });
  } catch (error) {
    console.error("[operator:pick-list] Error fetching pick list", {
      route_id: routeId,
      user_id: profile?.id ?? null,
      user_roles: profile?.roles ?? [],
      error,
    });
    return NextResponse.json(
      { error: "Failed to fetch pick list", details: errorMessage(error) },
      { status: 500 }
    );
  }
}
