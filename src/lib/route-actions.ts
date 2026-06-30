"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { inventoryMovementIdempotencyKey } from "@/lib/inventory-movement";
import { canExecuteRoutes, isAdminRole } from "@/lib/authz";
import {
  ROUTE_ASSIGNED_STATUS,
  ROUTE_CANCELED_STATUS,
  ROUTE_DRAFT_STATUS,
  fallbackRouteStatusForEnumMismatch,
  isAvailableRouteStatus,
  isRouteStatusEnumMismatch,
  isTerminalRouteStatus,
} from "@/lib/route-workflow";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function isMissingOnConflictConstraint(error: unknown) {
  const message = String((error as any)?.message ?? "").toLowerCase();
  const details = String((error as any)?.details ?? "").toLowerCase();
  const hint = String((error as any)?.hint ?? "").toLowerCase();
  return message.includes("no unique or exclusion constraint") || message.includes("could not find a unique") || details.includes("no unique or exclusion constraint") || hint.includes("no unique or exclusion constraint");
}

function requireConfirmedReason(formData: FormData, path: string) {
  if (clean(formData.get("confirm_action")) !== "yes") fail(path, "Confirmation is required.");
  const reason = clean(formData.get("reason"));
  if (!reason) fail(path, "Reason is required.");
  return reason;
}

async function requireRouteAccess(path: string) {
  const profile = await getCurrentProfile();
  if (!profile || !isAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

async function countByColumn(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, table: string, column: string, value: string) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  if (error) throw error;
  return count ?? 0;
}

function revalidateRoutePaths(id: string) {
  revalidatePath("/routes");
  revalidatePath(`/routes/${id}`);
  revalidatePath("/operator/routes");
  revalidatePath(`/operator/routes/${id}`);
  revalidatePath(`/operator/routes/${id}/pick-list`);
  revalidatePath(`/operator/routes/${id}/leftovers`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
}

function quantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function machineFillDelta(movement: any) {
  const qty = quantity(movement?.quantity);
  if (movement?.reason === "manual_correction" && movement?.from_entity_type === "machine" && movement?.to_entity_type === "operator_bag") return -qty;
  return qty;
}

async function reverseOutstandingPickedStock(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  routeId: string,
  actorTeamMemberId: string | null,
) {
  const [{ data: routeStockLines, error: stockError }, { data: fillMovements, error: fillError }, { data: pickMovements, error: pickError }] = await Promise.all([
    supabase.from("route_stock_lines").select("id, product_id, picked_qty, returned_qty").eq("route_id", routeId),
    supabase.from("inventory_movements").select("product_id, quantity, reason, from_entity_type, to_entity_type").eq("related_route_id", routeId).in("reason", ["operator_bag_to_machine", "manual_correction"]),
    supabase.from("inventory_movements").select("product_id, quantity, from_entity_id, to_entity_id").eq("related_route_id", routeId).in("reason", ["storage_to_operator_bag", "storage_to_route"]).order("created_at", { ascending: true }),
  ]);

  if (stockError) throw stockError;
  if (fillError) throw fillError;
  if (pickError) throw pickError;

  const filledByProduct = new Map<string, number>();
  (fillMovements ?? []).forEach((movement: any) => {
    const productId = String(movement.product_id ?? "");
    if (!productId) return;
    filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + machineFillDelta(movement));
  });

  const pickedStorageByProduct = new Map<string, { storageId: string; operatorId: string | null; quantity: number }[]>();
  (pickMovements ?? []).forEach((movement: any) => {
    const productId = String(movement.product_id ?? "");
    const storageId = String(movement.from_entity_id ?? "");
    if (!productId || !storageId) return;
    pickedStorageByProduct.set(productId, [
      ...(pickedStorageByProduct.get(productId) ?? []),
      {
        storageId,
        operatorId: movement.to_entity_id ? String(movement.to_entity_id) : null,
        quantity: quantity(movement.quantity),
      },
    ]);
  });

  const reversalMovements: any[] = [];
  const returnedUpdates: { id: string; returnedQty: number }[] = [];

  for (const line of routeStockLines ?? []) {
    const productId = String((line as any).product_id ?? "");
    if (!productId) continue;

    let remainingReturn = Math.max(0, quantity((line as any).picked_qty) - quantity((line as any).returned_qty) - (filledByProduct.get(productId) ?? 0));
    if (remainingReturn <= 0) continue;

    const pickedLocations = pickedStorageByProduct.get(productId) ?? [];
    let returnedQty = 0;
    for (const pickedLocation of pickedLocations) {
      if (remainingReturn <= 0) break;
      const movementQty = Math.min(remainingReturn, pickedLocation.quantity);
      if (movementQty <= 0) continue;
      reversalMovements.push({
        product_id: productId,
        quantity: movementQty,
        from_entity_type: "operator_bag",
        from_entity_id: pickedLocation.operatorId,
        to_entity_type: "storage",
        to_entity_id: pickedLocation.storageId,
        reason: "operator_bag_to_storage",
        related_route_id: routeId,
        source_type: "route_cancellation",
        source_id: routeId,
        idempotency_key: inventoryMovementIdempotencyKey("route-cancel-return", routeId, productId, pickedLocation.storageId, pickedLocation.operatorId ?? "", movementQty),
        created_by: actorTeamMemberId,
        notes: `Route cancellation return for ${routeId}`,
      });
      returnedQty += movementQty;
      remainingReturn -= movementQty;
    }

    if (returnedQty > 0) returnedUpdates.push({ id: String((line as any).id), returnedQty: quantity((line as any).returned_qty) + returnedQty });
  }

  if (reversalMovements.length) {
    const upsertResult = await supabase.from("inventory_movements").upsert(reversalMovements, { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (!upsertResult.error) {
      // no-op
    } else if (!isMissingOnConflictConstraint(upsertResult.error)) {
      throw upsertResult.error;
    } else {
      console.warn("[routes] inventory_movements upsert missing unique conflict target; falling back to insert", {
        routeId,
        row_count: reversalMovements.length,
        error: upsertResult.error,
      });
      const keys = Array.from(new Set(reversalMovements.map((movement) => String((movement as any).idempotency_key ?? "")).filter(Boolean)));
      let existingKeys = new Set<string>();
      if (keys.length) {
        const existingResult = await supabase.from("inventory_movements").select("idempotency_key").in("idempotency_key", keys);
        if (existingResult.error) throw existingResult.error;
        existingKeys = new Set((existingResult.data ?? []).map((row: any) => String(row.idempotency_key ?? "")));
      }
      const rowsToInsert = reversalMovements.filter((movement) => {
        const key = String((movement as any).idempotency_key ?? "");
        return !key || !existingKeys.has(key);
      });
      if (rowsToInsert.length) {
        const insertResult = await supabase.from("inventory_movements").insert(rowsToInsert);
        if (insertResult.error) throw insertResult.error;
      }
    }
  }

  for (const update of returnedUpdates) {
    const { error } = await supabase.from("route_stock_lines").update({ returned_qty: update.returnedQty, updated_at: new Date().toISOString() }).eq("id", update.id);
    if (error) throw error;
  }

  return reversalMovements;
}

export async function deleteDraftRoute(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/routes");
  const path = `/routes/${id}`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireRouteAccess(path);

  const { data: route, error: routeError } = await supabase.from("routes").select("*").eq("id", id).maybeSingle();
  if (routeError || !route) fail("/routes", "Route not found.");
  if (!isAvailableRouteStatus(route.status)) fail(path, "Only routes that have not started can be hard-deleted.");

  let movementCount = 0;
  let cashCount = 0;
  let financeCount = 0;
  try {
    [movementCount, cashCount, financeCount] = await Promise.all([
      countByColumn(supabase, "inventory_movements", "related_route_id", id),
      countByColumn(supabase, "cash_collections", "route_id", id),
      countByColumn(supabase, "financial_transactions", "related_route_id", id),
    ]);
  } catch (error) {
    console.error("[routes] Failed to verify draft route delete safety", error);
    fail(path, "Could not verify route history.");
  }

  if (movementCount > 0 || cashCount > 0 || financeCount > 0) {
    fail(path, "This route has inventory, cash, or finance history. Cancel it instead.");
  }

  const [{ data: stops }, { data: stockLines }, { data: stopItems }, { data: pickItems }, { data: refillOrders }] = await Promise.all([
    supabase.from("route_stops").select("*").eq("route_id", id),
    supabase.from("route_stock_lines").select("*").eq("route_id", id),
    supabase.from("route_stop_items").select("*").eq("route_id", id),
    supabase.from("route_pick_list_items").select("*").eq("route_id", id),
    supabase.from("refill_orders").select("*, refill_order_lines(*)").eq("route_id", id),
  ]);

  const { error } = await supabase.from("routes").delete().eq("id", id).eq("status", route.status);
  if (error) {
    console.error("[routes] Failed to delete draft route", error);
    fail(path, "Could not delete draft route.");
  }

  await logActivity({
    profile,
    action: "delete",
    entityType: "route",
    entityId: id,
    entityLabel: `Route ${route.route_date}`,
    beforeData: { route, stops, stockLines, stopItems, pickItems, refillOrders },
    metadata: { reason },
    summary: `Hard-deleted unstarted route for ${route.route_date}`,
  });

  revalidateRoutePaths(id);
  redirect("/routes");
}

export async function cancelRoute(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/routes");
  const path = `/routes/${id}`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireRouteAccess(path);

  const { data: route, error: routeError } = await supabase.from("routes").select("*").eq("id", id).maybeSingle();
  if (routeError || !route) fail("/routes", "Route not found.");
  if (isTerminalRouteStatus(route.status)) fail(path, "Completed or cancelled routes cannot be cancelled again.");

  let reversalMovements: any[] = [];
  try {
    reversalMovements = await reverseOutstandingPickedStock(supabase, id, profile.team_member_id);
  } catch (error) {
    console.error("[routes] Failed to reverse route stock before cancellation", error);
    fail(path, "Could not reverse outstanding picked stock for this route.");
  }

  const now = new Date().toISOString();
  const { data: after, error } = await supabase
    .from("routes")
    .update({
      status: ROUTE_CANCELED_STATUS,
      cancelled_at: now,
      cancelled_by: profile.team_member_id,
      cancellation_reason: reason,
    })
    .eq("id", id)
    .eq("status", route.status)
    .select("*")
    .single();
  if (error) {
    console.error("[routes] Failed to cancel route", error);
    fail(path, "Could not cancel route.");
  }

  await logActivity({
    profile,
    action: "cancel",
    entityType: "route",
    entityId: id,
    entityLabel: `Route ${route.route_date}`,
    beforeData: route,
    afterData: after,
    metadata: { reason, reversal_movement_count: reversalMovements.length },
    summary: reversalMovements.length
      ? `Cancelled route for ${route.route_date} and returned outstanding picked stock`
      : `Cancelled route for ${route.route_date}`,
  });

  revalidateRoutePaths(id);
  redirect(path);
}

export async function assignRoute(formData: FormData) {
  const id = clean(formData.get("id"));
  const operatorId = clean(formData.get("operator_id")) || null;
  if (!id) redirect("/routes");
  const path = `/routes/${id}`;
  const { profile, supabase } = await requireRouteAccess(path);

  const { data: route, error: routeError } = await supabase.from("routes").select("*").eq("id", id).maybeSingle();
  if (routeError || !route) fail("/routes", "Route not found.");
  if (isTerminalRouteStatus(route.status)) fail(path, "Completed, reviewed, or cancelled routes cannot be reassigned.");

  if (operatorId) {
    const { data: performer, error: performerError } = await supabase
      .from("team_members")
      .select("id, full_name, role, roles, active")
      .eq("id", operatorId)
      .maybeSingle();
    if (performerError) {
      console.error("[routes] Failed to verify route performer", performerError);
      fail(path, "Could not verify selected route performer.");
    }
    if (!performer || performer.active === false || !canExecuteRoutes({ id: performer.id, role: performer.role, roles: performer.roles })) {
      fail(path, "Selected route performer must be an active owner, admin, supervisor, or operator.");
    }
  }

  let nextStatus = operatorId
    ? (isAvailableRouteStatus(route.status) ? ROUTE_ASSIGNED_STATUS : route.status)
    : route.status === ROUTE_ASSIGNED_STATUS ? ROUTE_DRAFT_STATUS : route.status;
  let updateResult = await supabase
    .from("routes")
    .update({ operator_id: operatorId, status: nextStatus })
    .eq("id", id)
    .eq("status", route.status)
    .select("*")
    .single();

  if (updateResult.error && isRouteStatusEnumMismatch(updateResult.error, nextStatus)) {
    const fallbackStatus = fallbackRouteStatusForEnumMismatch(nextStatus);
    if (fallbackStatus) {
      console.warn("[routes] Retrying assignment with deployed enum fallback", { id, rejectedStatus: nextStatus, fallbackStatus });
      nextStatus = fallbackStatus;
      updateResult = await supabase
        .from("routes")
        .update({ operator_id: operatorId, status: nextStatus })
        .eq("id", id)
        .eq("status", route.status)
        .select("*")
        .single();
    }
  }

  if (updateResult.error) {
    console.error("[routes] Failed to assign route", updateResult.error);
    fail(path, "Could not update route assignment.");
  }

  await logActivity({
    profile,
    action: operatorId ? "assign_route" : "unassign_route",
    entityType: "route",
    entityId: id,
    entityLabel: `Route ${route.route_date}`,
    beforeData: route,
    afterData: updateResult.data,
    summary: operatorId ? `Assigned route for ${route.route_date}` : `Marked route for ${route.route_date} as available`,
  });

  revalidateRoutePaths(id);
  redirect(path);
}
