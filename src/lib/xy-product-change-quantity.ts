/**
 * Changing a product label does not mean changing the physical stock count.
 * The current XY lane count is preserved unless the operator actually enters
 * a new final count. Smart Route replacements are different: the old product
 * must have been returned, so a new lane starts empty unless explicitly counted.
 */
export function resolveXyProductChangeQuantity(input: {
  currentStockQty: number | null;
  explicitFinalQty?: unknown;
  smartRouteSwap: boolean;
}): { targetStockQty: number; quantityEdited: boolean; stockPreserved: boolean } {
  const quantityEdited = input.explicitFinalQty !== undefined && input.explicitFinalQty !== null;
  if (quantityEdited && (
    typeof input.explicitFinalQty !== "number"
    || !Number.isSafeInteger(input.explicitFinalQty)
    || input.explicitFinalQty < 0
  )) {
    throw new Error("Enter a valid whole-number final quantity, including zero if empty.");
  }

  const current = input.currentStockQty;
  if (!input.smartRouteSwap && (current === null || !Number.isSafeInteger(current) || current < 0)) {
    throw new Error("XY did not report a reliable current quantity. Refresh XY before changing this product.");
  }

  return {
    targetStockQty: quantityEdited
      ? input.explicitFinalQty as number
      : input.smartRouteSwap ? 0 : current as number,
    quantityEdited,
    stockPreserved: !input.smartRouteSwap && !quantityEdited,
  };
}

export function isSafeStockPreservingQueuedRelabel(item: {
  previous_stock_qty: number;
  target_stock_qty: number;
  smart_route_swap: boolean;
  physical_change_confirmed: boolean;
  lane_disabled_confirmed: boolean;
  zero_stock_relabel: boolean;
}) {
  return item.zero_stock_relabel === false
    && item.smart_route_swap === false
    && item.physical_change_confirmed === false
    && item.lane_disabled_confirmed === false
    && Number.isSafeInteger(item.previous_stock_qty)
    && item.previous_stock_qty >= 0
    && item.target_stock_qty === item.previous_stock_qty;
}
