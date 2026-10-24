/**
 * Recorded Storage quantities are derived from movement-ledger entries.
 * They are not independent physical shelf counts or VMS sales forecasts.
 * This module does no IO and never changes inventory records.
 */
export type StorageProduct = {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  brand: string | null;
  case_quantity: number | string | null;
  min_storage_qty?: number | string | null;
  active: boolean | null;
};

export type StorageBalance = {
  product_id: string | null;
  quantity_on_hand: number | string | null;
};

export type StorageProductBalance = {
  productId: string;
  productName: string;
  sku: string | null;
  category: string | null;
  brand: string | null;
  caseQuantity: number;
  minStorageQty: number;
  active: boolean;
  currentQty: number;
  unmapped: boolean;
};

export function parseStorageUnits(value: unknown, field: string): number {
  // A missing ledger quantity must not become zero without evidence.
  if (value === null || value === undefined || value === "") throw new Error(`Missing ${field}`);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid whole-unit ${field}`);
  return n;
}

export function buildPhysicalStorageBalances(
  products: readonly StorageProduct[],
  balances: readonly StorageBalance[],
): StorageProductBalance[] {
  const stockById = new Map<string, number>();
  for (const balance of balances) {
    const id = String(balance.product_id ?? "").trim();
    if (!id) throw new Error("Storage balance without product ID");
    const qty = parseStorageUnits(balance.quantity_on_hand, `storage quantity for ${id}`);
    const next = (stockById.get(id) ?? 0) + qty;
    if (!Number.isSafeInteger(next)) throw new Error("Storage balance overflow");
    stockById.set(id, next);
  }
  const seen = new Set<string>();
  const result: StorageProductBalance[] = [];
  for (const product of products) {
    const id = String(product.id ?? "").trim();
    if (!id || seen.has(id)) throw new Error("Invalid or duplicate product in Storage catalog");
    seen.add(id);
    const currentQty = stockById.get(id) ?? 0;
    const active = product.active !== false;
    if (!active && currentQty === 0) continue;
    const caseQuantity = Number(product.case_quantity ?? 1);
    const minStorageQty = Number(product.min_storage_qty ?? 0);
    result.push({
      productId: id,
      productName: product.name,
      sku: product.sku,
      category: product.category,
      brand: product.brand,
      caseQuantity: Number.isSafeInteger(caseQuantity) && caseQuantity > 0 ? caseQuantity : 1,
      minStorageQty: Number.isSafeInteger(minStorageQty) && minStorageQty > 0 ? minStorageQty : 0,
      active,
      currentQty,
      unmapped: false,
    });
    stockById.delete(id);
  }
  // Do not erase physically stored items merely because their catalog row
  // became inactive, was unmapped or is absent from the product query.
  for (const [productId, currentQty] of stockById) {
    if (currentQty === 0) continue;
    result.push({
      productId, productName: `Unmapped product (${productId})`,
      sku: null, category: null, brand: null, caseQuantity: 1,
      minStorageQty: 0, active: false, currentQty, unmapped: true,
    });
  }
  return result.sort((left, right) => left.productName.localeCompare(right.productName));
}

export type PhysicalStockStatus = "review" | "out_of_stock" | "reserved" | "low_stock" | "available" | "unverified";
export function physicalStockStatus(
  quantity: number, reservedQty: number | null, minStorageQty: number, unmapped: boolean,
): PhysicalStockStatus {
  if (quantity < 0 || unmapped || (reservedQty !== null && reservedQty > quantity)) return "review";
  if (quantity === 0) return "out_of_stock";
  if (reservedQty === null) return "unverified";
  if (reservedQty > 0 && reservedQty === quantity) return "reserved";
  if (minStorageQty > 0 && Math.max(0, quantity - reservedQty) < minStorageQty) return "low_stock";
  return "available";
}
