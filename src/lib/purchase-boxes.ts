import type { PurchaseListItem, PurchaseListProduct } from "./purchase-list.ts";
import type { RestockShoppingListItem } from "./restock-shopping-list.ts";
import { latestKnownProductUnitCost, type ProductCostMemory } from "./purchase-cost-memory.ts";

export type BoxProduct = PurchaseListProduct & ProductCostMemory & { case_quantity?: number | string | null };
export type BoxPurchaseListItem = PurchaseListItem & {
  caseQuantity: number | null;
  suggestedBoxesQty: number | null;
  purchaseUnits: number | null;
  boxSizeMissing: boolean;
};

/** The database defaults to 1. That is not a verified wholesale box size. */
export function verifiedBoxSize(value: unknown): number | null {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 1 ? size : null;
}

export function planWholeBoxes(requiredUnits: number, sizeValue: unknown) {
  if (!Number.isFinite(requiredUnits) || requiredUnits < 0) throw new Error("Invalid required stock quantity.");
  const size = verifiedBoxSize(sizeValue);
  const needed = Math.ceil(requiredUnits);
  if (!Number.isSafeInteger(needed)) throw new Error("Stock quantity is too large.");
  if (needed === 0) return { caseQuantity: size, suggestedBoxesQty: 0, purchaseUnits: 0, boxSizeMissing: false };
  if (size === null) return { caseQuantity: null, suggestedBoxesQty: null, purchaseUnits: null, boxSizeMissing: true };
  const boxes = Math.ceil(needed / size);
  const units = boxes * size;
  if (!Number.isSafeInteger(units)) throw new Error("Box quantity is too large.");
  return { caseQuantity: size, suggestedBoxesQty: boxes, purchaseUnits: units, boxSizeMissing: false };
}

export function boxPurchaseRecommendations(items: PurchaseListItem[], products: BoxProduct[]): BoxPurchaseListItem[] {
  const byId = new Map(products.map(product => [product.id, product]));
  return items.map(item => {
    const packed = planWholeBoxes(item.suggestedBuyQty, byId.get(item.productId)?.case_quantity);
    return { ...item, ...packed, estimatedBuyCost: item.lastPurchaseCost === null || packed.purchaseUnits === null
      ? null : Math.round((item.lastPurchaseCost * packed.purchaseUnits + Number.EPSILON) * 100) / 100 };
  });
}

/** Compatibility: suggestedQty always remains units; only the purchasing UI edits boxes. */
export function boxShoppingItem(item: RestockShoppingListItem, product: BoxProduct): RestockShoppingListItem {
  if (product.active === false || product.id !== item.productId) throw new Error(`${item.name}: product is no longer available.`);
  const packed = planWholeBoxes(item.suggestedQty, product.case_quantity);
  if (packed.boxSizeMissing || !packed.caseQuantity || !packed.suggestedBoxesQty || !packed.purchaseUnits) {
    throw new Error(`${item.name}: set the units per box on the product first.`);
  }
  if (item.purchaseUnit === "box" && (item.unitsPerBox !== packed.caseQuantity || item.boxesQty !== packed.suggestedBoxesQty || item.suggestedQty !== packed.purchaseUnits)) {
    throw new Error(`${item.name}: packaging changed. Reopen the Purchase List and review the boxes again.`);
  }
  return { ...item, name: product.name, suggestedQty: packed.purchaseUnits, purchaseUnit: "box",
    unitsPerBox: packed.caseQuantity, boxesQty: packed.suggestedBoxesQty,
    lastPurchaseCost: latestKnownProductUnitCost(product) };
}

export function boxDraftLine(item: RestockShoppingListItem, product: BoxProduct) {
  const packed = boxShoppingItem(item, product);
  const cost = latestKnownProductUnitCost(product);
  return { productId: item.productId, boxesQty: packed.boxesQty!, unitsPerBox: packed.unitsPerBox!,
    looseUnitsQty: 0, unitCost: cost ?? 0, unitCostBlank: cost === null, unitCostZeroConfirmed: false,
    unitCostSource: cost === null ? "blank" as const : "product_memory" as const,
    lineTotal: 0, pricingMode: "unit" as const, matchAction: "change" as const };
}
