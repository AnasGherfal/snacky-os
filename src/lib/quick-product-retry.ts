export type QuickProductIdentity = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string;
  selling_price: number | string | null;
};

/**
 * A UUID collision is safe to replay only when it is demonstrably the
 * *same* product creation request. A manual SKU must still match; generated
 * SKUs are allowed to differ because the server chooses them on first save.
 */
export function sameQuickProductRequest(
  existing: QuickProductIdentity,
  input: {
    id: string;
    name: string;
    requestedSku: string | null;
    barcode: string | null;
    brand: string | null;
    category: string;
    sellingPrice: number;
  },
): boolean {
  const normalize = (value: string | null) => String(value ?? "").trim();
  return existing.id === input.id
    && normalize(existing.name) === input.name
    && (!input.requestedSku || normalize(existing.sku) === input.requestedSku)
    && normalize(existing.barcode) === normalize(input.barcode)
    && normalize(existing.brand) === normalize(input.brand)
    && normalize(existing.category) === input.category
    && Number(existing.selling_price) === input.sellingPrice;
}
