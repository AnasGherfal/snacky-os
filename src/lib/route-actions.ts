"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes, isAdminRole, isOwnerAdminRole } from "@/lib/authz";
import {
  ROUTE_ASSIGNED_STATUS,
  ROUTE_DRAFT_STATUS,
  fallbackRouteStatusForEnumMismatch,
  isAvailableRouteStatus,
  isRouteStatusEnumMismatch,
  isTerminalRouteStatus,
} from "@/lib/route-workflow";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { notifyRouteAssigned } from "@/lib/notification-delivery";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
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

export async function returnPickupToAssigned(formData: FormData) {
  const routeId = clean(formData.get("route_id"));
  const pickupBatchId = clean(formData.get("pickup_batch_id"));
  if (!routeId) redirect("/routes");
  const path = `/routes/${routeId}`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireRouteAccess(path);
  if (!isOwnerAdminRole(profile)) fail(path, "Only owner and admin users can return a pickup batch to Assigned.");

  const [{ data: route, error: routeError }, { data: pickupBatch, error: pickupBatchError }, { data: pickupMovements, error: pickupMovementsError }] = await Promise.all([
    supabase.from("routes").select("*").eq("id", routeId).maybeSingle(),
    supabase
      .from("route_pickup_batches")
      .select("id, route_id, operator_id, status, selected_stop_ids, product_summary, storage_deducted, confirmed_at, returned_to_assigned_at, returned_to_assigned_by, returned_to_assigned_reason")
      .eq("id", pickupBatchId)
      .maybeSingle(),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_id, to_entity_id, reason, related_pickup_batch_id, created_at")
      .eq("related_route_id", routeId)
      .eq("related_pickup_batch_id", pickupBatchId)
      .eq("reason", "storage_to_operator_bag")
      .order("created_at", { ascending: true }),
  ]);
  if (routeError || !route) fail(path, "Route not found.");
  if (pickupBatchError || !pickupBatch) fail(path, "Pickup batch not found.");
  if (pickupMovementsError) fail(path, "Could not load the pickup inventory history.");
  if (pickupBatch.route_id !== routeId) fail(path, "Pickup batch does not belong to this route.");

  const beforeData = {
    route,
    pickup_batch: pickupBatch,
    pickup_movements: pickupMovements ?? [],
  };

  const { data: rpcRows, error: rpcError } = await supabase.rpc("return_pickup_batch_to_assigned", {
    p_route_id: routeId,
    p_pickup_batch_id: pickupBatchId,
    p_reason: reason,
  });
  if (rpcError) {
    console.error("[routes] Failed to return pickup batch to Assigned", {
      route_id: routeId,
      pickup_batch_id: pickupBatchId,
      error: rpcError,
    });
    fail(path, "Could not return this pickup batch to Assigned.");
  }

  const { data: updatedRoute, error: updatedRouteError } = await supabase.from("routes").select("*").eq("id", routeId).maybeSingle();
  const { data: updatedPickupBatch, error: updatedPickupBatchError } = await supabase
    .from("route_pickup_batches")
    .select("id, route_id, operator_id, status, selected_stop_ids, product_summary, storage_deducted, confirmed_at, returned_to_assigned_at, returned_to_assigned_by, returned_to_assigned_reason")
    .eq("id", pickupBatchId)
    .maybeSingle();
  if (updatedRouteError || !updatedRoute || updatedPickupBatchError || !updatedPickupBatch) {
    fail(path, "Pickup batch was returned, but the refreshed route data could not be loaded.");
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "route",
    entityId: routeId,
    entityLabel: `Route ${route.route_date}`,
    beforeData,
    afterData: {
      route: updatedRoute,
      pickup_batch: updatedPickupBatch,
      rpc_result: Array.isArray(rpcRows) ? rpcRows[0] ?? null : rpcRows ?? null,
    },
    metadata: {
      reason,
      pickup_batch_id: pickupBatchId,
      compensating_movement_count: Array.isArray(rpcRows) ? Number(rpcRows[0]?.compensating_movement_count ?? 0) : Number((rpcRows as any)?.compensating_movement_count ?? 0),
      restored_quantity: Array.isArray(rpcRows) ? Number(rpcRows[0]?.restored_quantity ?? 0) : Number((rpcRows as any)?.restored_quantity ?? 0),
      already_returned: Array.isArray(rpcRows) ? Boolean(rpcRows[0]?.already_returned) : Boolean((rpcRows as any)?.already_returned),
    },
    summary: Array.isArray(rpcRows) && rpcRows[0]?.already_returned
      ? `Pickup batch for ${route.route_date} was already returned to Assigned`
      : `Returned pickup batch for ${route.route_date} to Assigned`,
  });

  revalidateRoutePaths(routeId);
  redirect(`${path}?success=${encodeURIComponent(Array.isArray(rpcRows) && rpcRows[0]?.already_returned ? "Pickup batch was already returned to Assigned." : "Pickup batch returned to Assigned.")}`);
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

  if (operatorId !== route.operator_id) {
    const { data: custodyBalances, error: custodyError } = await supabase
      .rpc("snacky_route_bag_balances", { p_route_id: id });
    if (custodyError) {
      console.error("[routes] Failed to verify route custody before reassignment", custodyError);
      fail(path, "Could not verify route stock custody. Try again before changing the operator.");
    }
    if ((custodyBalances ?? []).some((balance: { signed_quantity?: number | string | null }) => Number(balance.signed_quantity ?? 0) !== 0)) {
      fail(path, "This route already has picked stock. Return the pickup or complete inventory reconciliation before changing the operator.");
    }
  }

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

  if (operatorId && operatorId !== route.operator_id) {
    try {
      await notifyRouteAssigned(supabase, {
        routeId: id,
        routeDate: String(route.route_date ?? ""),
        operatorTeamMemberId: operatorId,
        assignedBy: profile.full_name,
        stopCount: null,
      });
    } catch (error) {
      console.warn("[routes] Failed to dispatch route assignment notification", { routeId: id, operatorId, error });
    }
  }

  revalidateRoutePaths(id);
  redirect(path);
}
