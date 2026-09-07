import { normalizeInventoryEntityType } from "./inventory-movement.ts";

export type RouteInventoryMovementRow = {
  product_id?: string | null;
  quantity?: number | string | null;
  reason?: string | null;
  from_entity_type?: string | null;
  from_entity_id?: string | null;
  to_entity_type?: string | null;
  to_entity_id?: string | null;
};

export type RouteInventorySummaryRow = {
  productId: string;
  loadedQty: number;
  filledQty: number;
  returnedQty: number;
  damagedQty: number;
  soldQty: number;
  compensatedQty: number;
  machineStorageQty: number;
  machineReturnQty: number;
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
    soldQty: 0,
    compensatedQty: 0,
    machineStorageQty: 0,
    machineReturnQty: 0,
    adjustmentInQty: 0,
    adjustmentOutQty: 0,
    remainingQty: 0,
  };
}

function descriptiveBucket(movement: RouteInventoryMovementRow) {
  const reason = String(movement.reason ?? "").trim();
  const fromType = normalizeInventoryEntityType(movement.from_entity_type);
  const toType = normalizeInventoryEntityType(movement.to_entity_type);

  if (fromType === "machine" && (toType === "storage" || reason === "returned_from_machine")) return "machine_return" as const;
  if (fromType === "storage" && toType === "operator_bag") {
    return reason === "manual_correction" ? "return_correction" as const : "loaded" as const;
  }
  if (fromType === "operator_bag" && toType === "storage") return "returned" as const;
  if (fromType === "operator_bag" && toType === "machine") return "filled" as const;
  if (fromType === "machine" && toType === "operator_bag") {
    return reason === "returned_from_machine" ? "machine_return" as const : "fill_correction" as const;
  }
  if (fromType === "operator_bag" && toType === "machine_storage") return "machine_storage" as const;
  if (fromType === "machine_storage" && toType === "operator_bag") return "machine_storage_correction" as const;
  if (fromType === "operator_bag" && toType === "waste") return "damaged" as const;
  if (fromType === "waste" && toType === "operator_bag") return "damage_correction" as const;
  if (fromType === "operator_bag" && reason === "manual_sale") return "sold" as const;
  if (toType === "operator_bag" && reason === "manual_sale") return "sale_correction" as const;
  if (fromType === "operator_bag" && reason === "customer_compensation") return "compensated" as const;
  if (toType === "operator_bag" && reason === "customer_compensation") return "compensation_correction" as const;
  return "adjustment" as const;
}

export function summarizeRouteInventoryMovements(movements: RouteInventoryMovementRow[]) {
  const rows = new Map<string, RouteInventorySummaryRow>();

  for (const movement of movements) {
    const productId = String(movement.product_id ?? "").trim();
    if (!productId) continue;

    const qty = quantity(movement.quantity);
    if (qty <= 0) continue;

    const row = rows.get(productId) ?? createRow(productId);
    switch (descriptiveBucket(movement)) {
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
      case "damage_correction":
        row.damagedQty -= qty;
        break;
      case "sold":
        row.soldQty += qty;
        break;
      case "sale_correction":
        row.soldQty -= qty;
        break;
      case "compensated":
        row.compensatedQty += qty;
        break;
      case "compensation_correction":
        row.compensatedQty -= qty;
        break;
      case "machine_storage":
        row.machineStorageQty += qty;
        break;
      case "machine_storage_correction":
        row.machineStorageQty -= qty;
        break;
      case "machine_return":
        row.machineReturnQty += qty;
        break;
      case "adjustment": {
        const fromType = normalizeInventoryEntityType(movement.from_entity_type);
        const toType = normalizeInventoryEntityType(movement.to_entity_type);
        if (toType === "operator_bag" && fromType !== "operator_bag") row.adjustmentInQty += qty;
        if (fromType === "operator_bag" && toType !== "operator_bag") row.adjustmentOutQty += qty;
        break;
      }
    }

    const fromType = normalizeInventoryEntityType(movement.from_entity_type);
    const toType = normalizeInventoryEntityType(movement.to_entity_type);
    if (toType === "operator_bag" && fromType !== "operator_bag") row.remainingQty += qty;
    if (fromType === "operator_bag" && toType !== "operator_bag") row.remainingQty -= qty;
    rows.set(productId, row);
  }

  return Array.from(rows.values())
    .map((row) => {
      row.filledQty = Math.max(0, row.filledQty);
      row.returnedQty = Math.max(0, row.returnedQty);
      row.damagedQty = Math.max(0, row.damagedQty);
      row.soldQty = Math.max(0, row.soldQty);
      row.compensatedQty = Math.max(0, row.compensatedQty);
      row.machineStorageQty = Math.max(0, row.machineStorageQty);
      row.machineReturnQty = Math.max(0, row.machineReturnQty);
      return row;
    })
    .sort((left, right) => left.productId.localeCompare(right.productId));
}
