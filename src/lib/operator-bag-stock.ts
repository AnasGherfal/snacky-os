/**
 * Read-only normalizer for goods held in an operator bag after route pickup.
 * Never hide a negative ledger balance or turn invalid units into zero.
 */
export type BagLedgerRow = {
  product_id: string | null;
  product_name: string | null;
  location_id: string | null;
  location_name: string | null;
  quantity_on_hand: number | string | null;
};
export type ProductPackagingRow = {
  id: string;
  sku: string | null;
  category: string | null;
  case_quantity: number | null;
};
export type BagDisplayRow = {
  productId: string;
  productName: string;
  operatorId: string;
  operatorName: string;
  sku: string | null;
  quantity: number;
  category: string | null;
  caseQuantity: number | null;
};

export function normalizeOperatorBagBalances(
  balances: readonly BagLedgerRow[],
  productMetadata: ReadonlyMap<string, ProductPackagingRow> | null,
  ar = false,
): BagDisplayRow[] {
  const seen = new Set<string>();
  const rows: BagDisplayRow[] = [];

  for (const balance of balances) {
    const productId = String(balance.product_id ?? "").trim();
    const operatorId = String(balance.location_id ?? "").trim();
    const rawQuantity = balance.quantity_on_hand;
    if (!productId || !operatorId || rawQuantity === null || rawQuantity === undefined
        || (typeof rawQuantity === "string" && rawQuantity.trim() === "")) {
      throw new Error("Operator bag ledger has a missing identity or quantity");
    }
    if (typeof rawQuantity !== "number" && typeof rawQuantity !== "string") {
      throw new Error("Operator bag quantity is not a whole signed unit");
    }
    const quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity)) {
      throw new Error("Operator bag quantity is not a whole signed unit");
    }
    const key = `${operatorId}:${productId}`;
    if (seen.has(key)) throw new Error("Duplicate operator bag ledger balance");
    seen.add(key);
    if (quantity === 0) continue;

    const product = productMetadata?.get(productId);
    const packageSize = product ? Number(product.case_quantity ?? 1) : null;
    const caseQuantity = packageSize !== null && Number.isSafeInteger(packageSize) && packageSize > 0
      ? packageSize : null;
    rows.push({
      productId,
      productName: String(balance.product_name ?? "").trim() || (ar ? "منتج غير معروف" : "Unknown product"),
      operatorId,
      operatorName: String(balance.location_name ?? "").trim() || (ar ? "مشغّل غير محدد" : "Unassigned operator"),
      sku: product?.sku ?? null,
      quantity,
      category: product?.category ?? null,
      caseQuantity,
    });
  }
  // Investigate negative custody first, then group the remaining balances by
  // operator. Positive quantities remain visible without another filter tab.
  return rows.sort((a, b) =>
    Number(a.quantity >= 0) - Number(b.quantity >= 0)
    || a.operatorName.localeCompare(b.operatorName)
    || a.productName.localeCompare(b.productName)
  );
}
