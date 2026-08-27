export type RouteStockAllocationItem = {
  machineId: string;
  productId: string;
  quantity: number;
};

function units(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function assignedRouteUnits(
  items: RouteStockAllocationItem[],
  productId: string,
  excludeMachineId?: string,
) {
  return items.reduce((total, item) => {
    if (item.productId !== productId || item.machineId === excludeMachineId) return total;
    return total + units(item.quantity);
  }, 0);
}

export function remainingRouteStock(
  items: RouteStockAllocationItem[],
  productId: string,
  availableQty: number,
  additionallyReservedQty = 0,
) {
  return Math.max(
    0,
    units(availableQty) - units(additionallyReservedQty) - assignedRouteUnits(items, productId),
  );
}

export function availableRouteStockForMachine(
  items: RouteStockAllocationItem[],
  productId: string,
  machineId: string,
  availableQty: number,
  additionallyReservedQty = 0,
) {
  return Math.max(
    0,
    units(availableQty)
      - units(additionallyReservedQty)
      - assignedRouteUnits(items, productId, machineId),
  );
}
