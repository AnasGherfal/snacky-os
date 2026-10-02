"use server";

import { actionFailure, type ActionResult } from "@/lib/action-result";
import { confirmPickList } from "@/lib/operator-actions";

type DirectPickupItem = {
  routeStopItemId?: string | null;
  routeStopId?: string | null;
  machineId?: string | null;
  productId: string;
  quantity: number;
  plannedQty?: number;
  reason?: string;
  notes?: string;
};

type DirectPickupExtra = {
  routeStopId?: string | null;
  machineId?: string | null;
  productId: string;
  quantity: number;
  reason: string;
  notes?: string;
};

type DirectPickupOptions = {
  stopIds?: string[];
  clientSubmissionId?: string | null;
  acknowledgedPickupLineIds?: string[];
};

/**
 * One operator action for pickup confirmation.
 *
 * The legacy database contract still has a prepare/finalize pair. Keep that
 * compatibility detail on the server and execute both calls back-to-back with
 * exactly the same canonical payload. The operator no longer has to create,
 * keep, or reconcile a prepared snapshot in the browser.
 *
 * Actual warehouse availability, reservations, inventory movements and route
 * state validation remain inside confirmPickList / confirm_route_pickup_v3.
 */
export async function confirmPickupDirect(
  routeId: string,
  pickedItems: DirectPickupItem[],
  extras: DirectPickupExtra[] = [],
  options: DirectPickupOptions = {},
): Promise<ActionResult> {
  const clientSubmissionId = String(options.clientSubmissionId ?? "").trim() || crypto.randomUUID();
  const stopIds = Array.from(new Set((options.stopIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))).sort();

  const acknowledgedPickupLineIds = Array.from(
    new Set(
      (options.acknowledgedPickupLineIds ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ).sort();
  const acknowledgedSet = new Set(acknowledgedPickupLineIds);
  const requiredPickupLineIds = Array.from(
    new Set(
      pickedItems
        .map((item) => String(item.routeStopItemId ?? "").trim())
        .filter(Boolean),
    ),
  ).sort();
  const missingPickupLineIds = requiredPickupLineIds.filter((id) => !acknowledgedSet.has(id));
  if (missingPickupLineIds.length > 0) {
    return actionFailure("Check every pickup item before confirming pickup.");
  }

  // Preserve the operator's actual checklist state all the way into the
  // database contract. Confirmation must never manufacture acknowledgements.
  const canonicalItems = pickedItems.map((item) => {
    const routeStopItemId = String(item.routeStopItemId ?? "").trim();
    return { ...item, isChecked: Boolean(routeStopItemId && acknowledgedSet.has(routeStopItemId)) };
  });

  const prepared = await confirmPickList(routeId, canonicalItems, extras, {
    stopIds,
    clientSubmissionId,
    acknowledgedPickupLineIds,
    stage: "prepare",
  });

  if (!prepared.success) return prepared;

  const pickupBatchId = String(prepared.pickupBatchId ?? "").trim();
  if (!pickupBatchId) {
    return actionFailure("Could not confirm pickup because the pickup batch was not created. Please retry.");
  }

  return confirmPickList(routeId, canonicalItems, extras, {
    stopIds,
    clientSubmissionId,
    preparedBatchId: pickupBatchId,
    acknowledgedPickupLineIds,
    stage: "confirm",
  });
}
