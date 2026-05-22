"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes, isAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

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
  const supabase = getSupabaseServerClient();
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
}

export async function deleteDraftRoute(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/routes");
  const path = `/routes/${id}`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireRouteAccess(path);

  const { data: route, error: routeError } = await supabase.from("routes").select("*").eq("id", id).maybeSingle();
  if (routeError || !route) fail("/routes", "Route not found.");
  if (route.status !== "draft") fail(path, "Only draft routes can be hard-deleted.");

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

  const { error } = await supabase.from("routes").delete().eq("id", id).eq("status", "draft");
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
    summary: `Hard-deleted draft route for ${route.route_date}`,
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
  if (["completed", "reviewed"].includes(route.status)) fail(path, "Completed routes cannot be cancelled or hard-deleted.");
  if (route.status === "cancelled") fail(path, "This route is already cancelled.");
  if (route.status === "draft") fail(path, "Draft routes can be deleted instead of cancelled.");

  const now = new Date().toISOString();
  const { data: after, error } = await supabase
    .from("routes")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_by: profile.team_member_id,
      cancellation_reason: reason,
    })
    .eq("id", id)
    .in("status", ["assigned", "in_progress"])
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
    metadata: { reason },
    summary: `Cancelled route for ${route.route_date}`,
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
  if (["completed", "reviewed", "cancelled"].includes(String(route.status))) fail(path, "Completed, reviewed, or cancelled routes cannot be reassigned.");

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

  const nextStatus = operatorId ? (route.status === "draft" ? "assigned" : route.status) : route.status === "assigned" ? "draft" : route.status;
  const { data: after, error } = await supabase
    .from("routes")
    .update({ operator_id: operatorId, status: nextStatus })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[routes] Failed to assign route", error);
    fail(path, "Could not update route assignment.");
  }

  await logActivity({
    profile,
    action: operatorId ? "assign_route" : "unassign_route",
    entityType: "route",
    entityId: id,
    entityLabel: `Route ${route.route_date}`,
    beforeData: route,
    afterData: after,
    summary: operatorId ? `Assigned route for ${route.route_date}` : `Marked route for ${route.route_date} as available`,
  });

  revalidateRoutePaths(id);
  redirect(path);
}
