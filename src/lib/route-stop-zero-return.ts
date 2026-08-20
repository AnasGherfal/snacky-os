export type RouteStopFillForZeroReturn = {
  productId?: unknown;
  quantity?: unknown;
  assignedQty?: unknown;
};

export type ExplicitZeroFillReturnPlan = {
  productId: string;
  quantity: number;
};

export type ExplicitZeroFillReturnAdjustment = ExplicitZeroFillReturnPlan & {
  direction: "return" | "reverse";
};

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

/**
 * An explicit zero is field truth: the operator filled none of the quantity
 * assigned to this stop. Return only those assigned units to storage.
 * Partial underfills remain in the route bag for the normal leftovers flow.
 */
export function buildExplicitZeroFillReturnPlans(
  items: RouteStopFillForZeroReturn[],
): ExplicitZeroFillReturnPlan[] {
  const totals = new Map<string, number>();

  for (const item of items) {
    const productId = String(item.productId ?? "").trim();
    const actualQty = unitQuantity(item.quantity);
    const assignedQty = unitQuantity(item.assignedQty);
    if (!productId || assignedQty <= 0 || actualQty !== 0) continue;
    totals.set(productId, (totals.get(productId) ?? 0) + assignedQty);
  }

  return Array.from(totals, ([productId, quantity]) => ({ productId, quantity }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
}

/**
 * Reconcile the desired explicit-zero return with prior saved return/reversal
 * movements. This supports retry-safe saves and later edits of a completed stop.
 */
export function buildExplicitZeroFillReturnAdjustments(
  desiredPlans: ExplicitZeroFillReturnPlan[],
  existingNetByProduct: ReadonlyMap<string, number>,
): ExplicitZeroFillReturnAdjustment[] {
  const desiredByProduct = new Map(
    desiredPlans.map((plan) => [plan.productId, unitQuantity(plan.quantity)]),
  );
  const productIds = new Set([
    ...desiredByProduct.keys(),
    ...existingNetByProduct.keys(),
  ]);

  return Array.from(productIds)
    .map((productId) => {
      const desired = desiredByProduct.get(productId) ?? 0;
      const existing = Math.max(0, unitQuantity(existingNetByProduct.get(productId)));
      const delta = desired - existing;
      if (delta === 0) return null;
      return {
        productId,
        quantity: Math.abs(delta),
        direction: delta > 0 ? "return" as const : "reverse" as const,
      };
    })
    .filter((row): row is ExplicitZeroFillReturnAdjustment => Boolean(row?.quantity))
    .sort((left, right) => left.productId.localeCompare(right.productId));
}
