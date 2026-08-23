"use server";

import { revalidatePath } from "next/cache";
import { actionFailure, actionSuccess, type ActionResult } from "@/lib/action-result";
import { logActivity } from "@/lib/activity-log";
import {
  buildAdminMissedPickupRpcPayload,
  type AdminMissedPickupItemInput,
  type ExistingRoutePickListRow,
  type RouteStockLineForPickup,
  type RouteStopItemForPickup,
} from "@/lib/admin-route-pickup";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { isTerminalRouteStatus } from "@/lib/route-workflow";

export type RecordAdminMissedPickupInput = {
  routeId: string;
  storageLocationId: string;
  items: AdminMissedPickupItemInput[];
  submissionId: string;
  reason: string;
};

export type RecordAdminMissedPickupResult = ActionResult<{
  pickupBatchId: string;
  recordedItems: number;
  recordedUnits: number;
  alreadyRecorded?: boolean;
}>;

function revalidateRoutePickupPaths(routeId: string) {
  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);
  revalidatePath("/operator/routes");
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/pick-list`);
  revalidatePath(`/operator/routes/${routeId}/leftovers`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
}

function errorDetails(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" — ");
}

function publicPickupError(error: unknown) {
  const message = errorDetails(error);
  const normalized = message.toLowerCase();
  const allowedMessages = [
    "not enough storage stock",
    "missing from inventory",
    "route status changed",
    "route status does not allow",
    "every required pickup line",
    "pickup checklist",
    "confirmed pick list is incomplete",
    "add at least one product",
    "quantity greater than zero",
    "recorded quantity is too large",
    "correction reason",
    "assign the route",
    "confirm the original route pickup",
    "selected storage location is not active",
    "selected product is missing or inactive",
    "completed or cancelled routes",
  ];
  if (allowedMessages.some((fragment) => normalized.includes(fragment))) {
    return message.replace(/^P\w+\s*[—:-]?\s*/i, "") || "Could not record the missed pickup.";
  }
  return "Could not record the missed pickup. Refresh the route and try again.";
}

async function correctionAlreadyRecorded({
  supabase,
  routeId,
  pickupBatchId,
  idempotencyKeys,
}: {
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
  routeId: string;
  pickupBatchId: string;
  idempotencyKeys: string[];
}) {
  const [{ data: pickupBatch, error: pickupBatchError }, { data: movementRows, error: movementError }] = await Promise.all([
    supabase.from("route_pickup_batches").select("id").eq("id", pickupBatchId).eq("route_id", routeId).maybeSingle(),
    supabase.from("inventory_movements").select("idempotency_key").eq("related_route_id", routeId).in("idempotency_key", idempotencyKeys),
  ]);
  if (pickupBatchError || movementError || !pickupBatch) return false;
  const savedKeys = new Set((movementRows ?? []).map((row: { idempotency_key?: string | null }) => String(row.idempotency_key ?? "")));
  return idempotencyKeys.every((key) => savedKeys.has(key));
}

export async function recordAdminMissedRoutePickup(
  input: RecordAdminMissedPickupInput,
): Promise<RecordAdminMissedPickupResult> {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) {
    return actionFailure("Only owner and admin users can record a missed storage pickup.");
  }
  if (!profile.team_member_id) {
    return actionFailure("Your account is not linked to a team member, so this correction cannot be audited.");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return actionFailure("Supabase is not configured.");

  try {
    const routeId = String(input?.routeId ?? "").trim();
    const storageLocationId = String(input?.storageLocationId ?? "").trim();
    const selectedProductIds = Array.from(new Set(
      (input?.items ?? []).map((item) => String(item?.productId ?? "").trim()).filter(Boolean),
    ));
    if (!routeId || !storageLocationId || !selectedProductIds.length) {
      throw new Error("Add at least one product that physically left storage.");
    }

    const [routeResult, storageResult, productsResult, stopItemsResult, pickListResult, stockLinesResult] = await Promise.all([
      supabase.from("routes").select("id, route_date, operator_id, status, started_at").eq("id", routeId).maybeSingle(),
      supabase.from("storage_locations").select("id, name, location_type, active").eq("id", storageLocationId).maybeSingle(),
      supabase.from("products").select("id, name, active").in("id", selectedProductIds),
      supabase.from("route_stop_items").select("id, planned_quantity").eq("route_id", routeId),
      supabase
        .from("route_pick_list_items")
        .select("id, route_stop_id, route_stop_item_id, machine_id, product_id, planned_qty, picked_qty, action_type, pickup_batch_id, reason, notes, needs_review, created_by, is_active, created_at")
        .eq("route_id", routeId)
        .eq("is_active", true)
        .order("created_at", { ascending: false }),
      supabase.from("route_stock_lines").select("product_id, planned_qty, picked_qty").eq("route_id", routeId),
    ]);

    const queryError = [routeResult.error, storageResult.error, productsResult.error, stopItemsResult.error, pickListResult.error, stockLinesResult.error].find(Boolean);
    if (queryError) throw queryError;

    const route = routeResult.data;
    if (!route) throw new Error("Route not found.");
    if (!route.operator_id) throw new Error("Assign the route to an operator before recording a missed pickup.");
    if (isTerminalRouteStatus(route.status)) throw new Error("Completed or cancelled routes cannot receive a pickup correction.");
    if (!["in_progress", "pickup_confirmed"].includes(String(route.status ?? ""))) {
      throw new Error("Confirm the original route pickup before recording a missed item.");
    }
    if (!(pickListResult.data ?? []).length) {
      throw new Error("Confirm the original route pickup before recording a missed item.");
    }

    const storage = storageResult.data;
    if (!storage || storage.active === false || !["main_storage", "vehicle", "temporary", "other"].includes(String(storage.location_type ?? ""))) {
      throw new Error("The selected storage location is not active.");
    }

    const productById = new Map((productsResult.data ?? []).map((product: { id: string; name: string | null; active: boolean | null }) => [String(product.id), product]));
    if (selectedProductIds.some((productId) => !productById.get(productId)?.active)) {
      throw new Error("A selected product is missing or inactive. Remove it and try again.");
    }

    const payload = buildAdminMissedPickupRpcPayload({
      route: {
        id: route.id,
        operatorId: route.operator_id,
        status: route.status,
        startedAt: route.started_at,
      },
      storageLocationId,
      items: (input.items ?? []).map((item) => ({
        ...item,
        productName: productById.get(String(item.productId))?.name ?? item.productName ?? null,
      })),
      existingPickListRows: (pickListResult.data ?? []) as ExistingRoutePickListRow[],
      routeStopItems: (stopItemsResult.data ?? []) as RouteStopItemForPickup[],
      routeStockLines: (stockLinesResult.data ?? []) as RouteStockLineForPickup[],
      actorTeamMemberId: profile.team_member_id,
      submissionId: input.submissionId,
      reason: input.reason,
      recordedAt: new Date().toISOString(),
    });
    const idempotencyKeys = payload.rpcArgs.p_inventory_movements.map((movement) => movement.idempotency_key);
    const resultPayload = {
      pickupBatchId: payload.pickupBatchId,
      recordedItems: payload.items.length,
      recordedUnits: payload.items.reduce((sum, item) => sum + item.quantity, 0),
    };

    if (await correctionAlreadyRecorded({ supabase, routeId, pickupBatchId: payload.pickupBatchId, idempotencyKeys })) {
      revalidateRoutePickupPaths(routeId);
      return actionSuccess({ ...resultPayload, alreadyRecorded: true });
    }

    const { error: rpcError } = await supabase.rpc("snacky_confirm_route_pickup_batch_v2", payload.rpcArgs);
    if (rpcError) {
      if (await correctionAlreadyRecorded({ supabase, routeId, pickupBatchId: payload.pickupBatchId, idempotencyKeys })) {
        revalidateRoutePickupPaths(routeId);
        return actionSuccess({ ...resultPayload, alreadyRecorded: true });
      }
      throw rpcError;
    }

    await logActivity({
      profile,
      action: "record_missed_route_pickup",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${route.route_date ?? routeId.slice(0, 8)}`,
      afterData: {
        pickup_batch_id: payload.pickupBatchId,
        storage_location_id: storageLocationId,
        operator_id: route.operator_id,
        items: payload.items,
        reason: input.reason.trim(),
      },
      metadata: {
        route_id: routeId,
        pickup_batch_id: payload.pickupBatchId,
        storage_location_id: storageLocationId,
        operator_id: route.operator_id,
        correction_source: "admin_missed_route_pickup",
      },
      summary: `Recorded ${resultPayload.recordedUnits} missed pickup units across ${resultPayload.recordedItems} products`,
    });

    revalidateRoutePickupPaths(routeId);
    return actionSuccess(resultPayload);
  } catch (error) {
    console.error("[routes:admin-missed-pickup] Failed to record correction", {
      route_id: input?.routeId ?? null,
      submission_id: input?.submissionId ?? null,
      error: errorDetails(error),
    });
    return actionFailure(publicPickupError(error));
  }
}
