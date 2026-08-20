import { normalizeInventoryEntityType } from "./inventory-movement.ts";

export type RouteInventoryMovementRow = {
  product_id?: string | null;
  quantity?: number | string | null;
  reason?: string | null;
  from_entity_type?: string | null;
  to_entity_type?: string | null;
};

export type RouteInventorySummaryRow = {
  productId: string;
  loadedQty: number;
  filledQty: number;
  returnedQty: number;
  damagedQty: number;
  adjustmentInQty: number;
  adjustmentOutQty: number;
  remainingQty: number;
};

function quantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function createRow(productId: string): RouteInventorySummaryRow {
  return {
    productId,
    loadedQty: 0,
    filledQty: 0,
    returnedQty: 0,
    damagedQty: 0,
    adjustmentInQty: 0,
    adjustmentOutQty: 0,
    remainingQty: 0,
  };
}

function reasonBucket(movement: RouteInventoryMovementRow) {
  const reason = String(movement.reason ?? "").trim();
  const fromType = normalizeInventoryEntityType(movement.from_entity_type);
  const toType = normalizeInventoryEntityType(movement.to_entity_type);

  if (reason === "manual_correction") {
    if (fromType === "machine" && toType === "operator_bag") return "fill_correction" as const;
    if (fromType === "storage" && toType === "operator_bag") return "return_correction" as const;
    if (fromType === "operator_bag" && toType === "machine") return "filled" as const;
    if (fromType === "operator_bag" && toType === "storage") return "returned" as const;
  }

  switch (reason) {
    case "storage_to_route":
    case "storage_to_operator_bag":
      return "loaded" as const;
    case "route_to_machine":
    case "operator_bag_to_machine":
      return "filled" as const;
    case "route_to_storage_return":
    case "operator_bag_to_storage":
    case "machine_to_storage_return":
    case "machine_to_storage":
    case "returned_from_machine":
      return "returned" as const;
    case "route_to_damaged":
    case "machine_to_damaged":
    case "damaged":
    case "expired":
      return "damaged" as const;
    case "manual_adjustment_in":
    case "manual_adjustment_out":
    case "stock_count_correction":
    case "manual_correction":
    case "stock_count_adjustment":
      return "adjustment" as const;
    default:
      return "other" as const;
  }
}

function adjustmentDelta(movement: RouteInventoryMovementRow) {
  const qty = quantity(movement.quantity);
  if (qty <= 0) return 0;

  const fromType = normalizeInventoryEntityType(movement.from_entity_type);
  const toType = normalizeInventoryEntityType(movement.to_entity_type);

  if (fromType === "adjustment" && toType !== "adjustment") return qty;
  if (toType === "adjustment" && fromType !== "adjustment") return -qty;
  return 0;
}

export function summarizeRouteInventoryMovements(movements: RouteInventoryMovementRow[]) {
  const rows = new Map<string, RouteInventorySummaryRow>();

  for (const movement of movements) {
    const productId = String(movement.product_id ?? "").trim();
    if (!productId) continue;

    const qty = quantity(movement.quantity);
    if (qty <= 0) continue;

    const row = rows.get(productId) ?? createRow(productId);
    switch (reasonBucket(movement)) {
      case "loaded":
        row.loadedQty += qty;
        break;
      case "filled":
        row.filledQty += qty;
        break;
      case "fill_correction":
        row.filledQty -= qty;
        break;
      case "returned":
        row.returnedQty += qty;
        break;
      case "return_correction":
        row.returnedQty -= qty;
        break;
      case "damaged":
        row.damagedQty += qty;
        break;
      case "adjustment": {
        const delta = adjustmentDelta(movement);
        if (delta > 0) row.adjustmentInQty += delta;
        else if (delta < 0) row.adjustmentOutQty += Math.abs(delta);
        break;
      }
      default:
        break;
    }
    rows.set(productId, row);
  }

  return Array.from(rows.values())
    .map((row) => {
      row.filledQty = Math.max(0, row.filledQty);
      row.returnedQty = Math.max(0, row.returnedQty);
      row.remainingQty = row.loadedQty + row.adjustmentInQty - row.adjustmentOutQty - row.filledQty - row.returnedQty - row.damagedQty;
      return row;
    })
    .sort((left, right) => left.productId.localeCompare(right.productId));
}
