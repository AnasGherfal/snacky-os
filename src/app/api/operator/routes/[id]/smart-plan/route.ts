import { NextResponse } from "next/server";

import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { isTerminalRouteStatus } from "@/lib/route-workflow";
import { generateSmartRoutePlan } from "@/lib/smart-route-planner";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return [row.message, row.details, row.hint]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" — ");
  }
  return "Unknown error";
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: routeId } = await params;
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();

  if (!routeId) return jsonError("Route id is required.");
  if (!supabase || !profile) return jsonError("You must be signed in.", 401);

  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) return jsonError("Could not load the route.", 500);
  if (!route) return jsonError("Route not found.", 404);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return jsonError("This route is not assigned to you.", 403);
  }
  if (isTerminalRouteStatus(route.status)) {
    return jsonError("Completed or cancelled routes cannot be replanned.", 409);
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return jsonError("Smart Route server access is not configured.", 500);

  const [
    stopsResult,
    pickedItemsResult,
    pickedStockResult,
    movementResult,
    pickupBatchResult,
  ] = await Promise.all([
    admin
      .from("route_stops")
      .select("id, machine_id, status")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true }),
    admin
      .from("route_stop_items")
      .select("id, picked_quantity")
      .eq("route_id", routeId)
      .gt("picked_quantity", 0)
      .limit(1),
    admin
      .from("route_stock_lines")
      .select("id, picked_qty")
      .eq("route_id", routeId)
      .gt("picked_qty", 0)
      .limit(1),
    admin
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .eq("reason", "storage_to_operator_bag")
      .limit(1),
    admin
      .from("route_pickup_batches")
      .select("id, prepared_at, confirmed_at, returned_to_assigned_at")
      .eq("route_id", routeId)
      .is("returned_to_assigned_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const loadError = stopsResult.error
    ?? pickedItemsResult.error
    ?? pickedStockResult.error
    ?? movementResult.error
    ?? pickupBatchResult.error;
  if (loadError) {
    console.error("[operator:smart-route] Could not verify route replanning safety", {
      route_id: routeId,
      error: loadError,
    });
    return jsonError("Could not verify whether this route is safe to replan.", 500);
  }

  const preparedBatch = pickupBatchResult.data;
  if (
    pickedItemsResult.data?.length
    || pickedStockResult.data?.length
    || movementResult.data?.length
    || (preparedBatch?.prepared_at && !preparedBatch?.confirmed_at)
  ) {
    return jsonError(
      "Smart Route can only be regenerated before pickup starts. This route already has pickup activity or a prepared pickup snapshot.",
      409,
    );
  }

  const machineIds = Array.from(
    new Set(
      (stopsResult.data ?? [])
        .map((stop: { machine_id?: string | null }) => String(stop.machine_id ?? "").trim())
        .filter(Boolean),
    ),
  );
  if (!machineIds.length) return jsonError("This route has no machine stops to plan.", 409);

  try {
    const plan = await generateSmartRoutePlan({
      machineIds,
      routeDate: String(route.route_date ?? ""),
      operatorId: route.operator_id ? String(route.operator_id) : null,
      requestedBy: profile.team_member_id ?? null,
      excludeRouteId: routeId,
    });

    if (!plan.slotAssignments.length) {
      return jsonError(
        "Smart Route found no pickup quantities to apply from the current verified XY and storage data.",
        409,
        { plan },
      );
    }

    const items = plan.slotAssignments.map((item) => ({
      machine_id: item.machineId,
      product_id: item.productId,
      quantity: item.quantity,
      machine_slot_id: item.machineSlotId ?? null,
      slot_code: item.slotCode ?? null,
      notes: item.notes ?? null,
      slot_allocations: item.slotAllocations,
    }));

    const { data: applied, error: applyError } = await admin.rpc("snacky_apply_smart_route_plan_v1", {
      p_route_id: routeId,
      p_items: items,
    });

    if (applyError) {
      console.error("[operator:smart-route] Failed to apply Smart Route plan", {
        route_id: routeId,
        error: applyError,
      });
      return jsonError(errorMessage(applyError) || "Could not apply the Smart Route plan.", 409);
    }

    return NextResponse.json({
      ok: true,
      summary: plan.summary,
      plannerMode: plan.plannerMode,
      substitutions: plan.substitutions,
      warnings: plan.warnings,
      applied,
      freshness: plan.freshness,
    });
  } catch (error) {
    console.error("[operator:smart-route] Smart Route generation failed", {
      route_id: routeId,
      error,
    });
    return jsonError(
      error instanceof Error ? error.message : "Could not generate the Smart Route plan.",
      500,
    );
  }
}
