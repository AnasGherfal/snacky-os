"use server";

import { revalidatePath } from "next/cache";
import { actionFailure, actionSuccess, type ActionResult } from "@/lib/action-result";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";

export type SupplementalRoutePickupItem = {
  routeStopItemId: string;
  quantity: number;
};

export type SupplementalRoutePickupResult = ActionResult<{
  pickupBatchId: string;
  routeStatus: string | null;
  pickedUnits: number;
  remainingAdditionalUnits: number;
}>;

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function publicError(error: unknown) {
  if (!error || typeof error !== "object") return "Could not confirm the additional pickup.";
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const message = [row.message, row.details, row.hint]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" — ");
  const text = `${row.code ?? ""} ${message}`.toLowerCase();

  const allowed = [
    "not enough physical storage stock",
    "additional pickup quantity exceeds",
    "pending stops must use",
    "completed or skipped machine stop",
    "confirm the original route pickup",
    "route not found",
    "route must be assigned",
    "permission",
    "does not belong to this route",
    "retry does not match",
    "incomplete prior attempt",
  ];
  if (allowed.some((fragment) => text.includes(fragment))) return message || "Could not confirm the additional pickup.";
  return "Could not confirm the additional pickup. Refresh the route and try again.";
}

function revalidateRoutePaths(routeId: string) {
  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);
  revalidatePath(`/routes/${routeId}/edit`);
  revalidatePath("/operator/routes");
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/pick-list`);
  revalidatePath(`/operator/routes/${routeId}/leftovers`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
}

export async function confirmSupplementalRoutePickup(
  routeId: string,
  items: SupplementalRoutePickupItem[],
  submissionId: string,
): Promise<SupplementalRoutePickupResult> {
  const cleanRouteId = String(routeId ?? "").trim();
  const cleanSubmissionId = String(submissionId ?? "").trim();
  const normalizedItems = (items ?? [])
    .map((item) => ({
      route_stop_item_id: String(item?.routeStopItemId ?? "").trim(),
      quantity: unitQuantity(item?.quantity),
    }))
    .filter((item) => item.route_stop_item_id && item.quantity > 0);

  if (!cleanRouteId || !cleanSubmissionId) {
    return actionFailure("Route and pickup submission are required.");
  }
  if (!normalizedItems.length) {
    return actionFailure("Choose at least one additional item to pick up.");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return actionFailure("Supabase is not configured.");

  try {
    const { data, error } = await supabase.rpc("snacky_confirm_supplemental_route_pickup_v1", {
      p_route_id: cleanRouteId,
      p_items: normalizedItems,
      p_submission_id: cleanSubmissionId,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    const result = {
      pickupBatchId: String(row?.pickup_batch_id ?? cleanSubmissionId),
      routeStatus: row?.route_status ? String(row.route_status) : null,
      pickedUnits: unitQuantity(row?.picked_units),
      remainingAdditionalUnits: unitQuantity(row?.remaining_additional_units),
    };

    revalidateRoutePaths(cleanRouteId);
    return actionSuccess(result);
  } catch (error) {
    console.error("[operator:supplemental-pickup] Failed to confirm additional pickup", {
      route_id: cleanRouteId,
      submission_id: cleanSubmissionId,
      error,
    });
    return actionFailure(publicError(error));
  }
}
