/**
 * A partial direct XY response is not proof that configured products vanished.
 * Keep previous verified import rows visible when the vendor omits a selection
 * or omits its product identity. Mark these fallbacks as NOT live; never use
 * missing vendor identity to silently zero stock or display "Empty".
 *
 * A changed vendor product ID must never inherit the previous product's
 * Snacky ID, photograph, quantity or name.
 */
export type OperatorXyLayoutSlot = {
  slotCode: string;
  productId: string | null;
  productName: string;
  vmsProductId: string | null;
  vmsProductName: string | null;
  imageUrl: string | null;
  currentQty: number;
  capacity: number;
  priceLyd: number | null;
  capturedAt: string | null;
  plannedProductId: string | null;
  plannedProductName: string | null;
  mismatch: boolean;
  liveStockKnown?: boolean;
  sourceState?: "live" | "last_imported";
};

export type LiveOperatorXySlot = {
  slotCode: string;
  vmsProductId: string | null;
  productId: string | null;
  productName: string;
  imageUrl?: string | null;
  currentQty: number | null;
  capacity: number | null;
  priceLyd: number | null;
};

export type OperatorXyCatalogImage = { id: string; imageUrl?: string | null };

const clean = (value: unknown) => String(value ?? "").trim();
const meaningfulProduct = (value: unknown) => {
  const str = clean(value);
  return str && !["0", "0000", "null", "undefined"].includes(str.toLowerCase()) ? str : null;
};
const validQuantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function staleSlot(slot: OperatorXyLayoutSlot): OperatorXyLayoutSlot {
  return { ...slot, liveStockKnown: false, sourceState: "last_imported" };
}

export function mergeOperatorXyLiveLayout(
  previous: readonly OperatorXyLayoutSlot[],
  live: readonly LiveOperatorXySlot[],
  productCatalog: readonly OperatorXyCatalogImage[],
  fetchedAt: string,
): { slots: OperatorXyLayoutSlot[]; fallbackSlotCodes: string[] } {
  const previousByCode = new Map(previous.map((row) => [clean(row.slotCode), row]));
  const catalogImages = new Map(productCatalog.map((product) => [product.id, product.imageUrl || null]));
  const merged = new Map<string, OperatorXyLayoutSlot>();
  const fallback = new Set<string>();

  // Keep a last-imported fallback *visible*, never mark it live if direct XY
  // did not return it. No XY inventory/quantity update occurs in this helper.
  for (const row of previous) {
    if (!clean(row.slotCode)) continue;
    merged.set(row.slotCode, staleSlot(row));
    fallback.add(row.slotCode);
  }

  for (const direct of live) {
    const code = clean(direct.slotCode);
    if (!code) continue;
    const prior = previousByCode.get(code);
    const vendorProductId = meaningfulProduct(direct.vmsProductId);
    const previousVendorId = meaningfulProduct(prior?.vmsProductId);

    if (!vendorProductId) {
      if (prior) {
        // XY's response is incomplete/ambiguous, so preserve the last
        // verified product on screen without labeling its stock as live.
        merged.set(code, staleSlot(prior));
      } else {
        merged.set(code, {
          slotCode: code,
          vmsProductId: null,
          vmsProductName: clean(direct.productName) || null,
          productId: null,
          productName: clean(direct.productName) || "XY product not identified",
          imageUrl: direct.imageUrl || null,
          currentQty: 0,
          capacity: validQuantity(direct.capacity) ? direct.capacity : 0,
          priceLyd: direct.priceLyd,
          capturedAt: null,
          plannedProductId: null,
          plannedProductName: null,
          mismatch: false,
          liveStockKnown: false,
          sourceState: "last_imported",
        });
      }
      fallback.add(code);
      continue;
    }

    const identicalProduct = Boolean(prior && previousVendorId === vendorProductId);
    const productId = meaningfulProduct(direct.productId) ??
      (identicalProduct ? prior?.productId ?? null : null);
    const productName = clean(direct.productName)
      || (identicalProduct ? prior?.productName || "" : "")
      || `XY product ${vendorProductId}`;
    const productImage = clean(direct.imageUrl) || (productId ? clean(catalogImages.get(productId)) : "")
      || (identicalProduct ? clean(prior?.imageUrl) : "") || null;
    const hasLiveQty = validQuantity(direct.currentQty) && validQuantity(direct.capacity) && direct.capacity > 0
      && direct.currentQty <= direct.capacity;
    if (!hasLiveQty) fallback.add(code);
    else fallback.delete(code);

    const plannedProductId = prior?.plannedProductId ?? null;
    merged.set(code, {
      slotCode: code,
      vmsProductId: vendorProductId,
      vmsProductName: productName,
      productId,
      productName,
      imageUrl: productImage,
      // Use the last verified quantity only if it is the SAME vendor product.
      currentQty: hasLiveQty ? direct.currentQty! : identicalProduct ? prior?.currentQty ?? 0 : 0,
      capacity: validQuantity(direct.capacity) && direct.capacity > 0
        ? direct.capacity : identicalProduct ? prior?.capacity ?? 0 : 0,
      priceLyd: direct.priceLyd ?? (identicalProduct ? prior?.priceLyd ?? null : null),
      capturedAt: hasLiveQty ? fetchedAt : identicalProduct ? prior?.capturedAt ?? null : null,
      plannedProductId,
      plannedProductName: prior?.plannedProductName ?? null,
      mismatch: Boolean(plannedProductId && productId && plannedProductId !== productId),
      liveStockKnown: hasLiveQty,
      sourceState: hasLiveQty ? "live" : "last_imported",
    });
  }

  return {
    slots: [...merged.values()].sort((a, b) =>
      a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true })),
    fallbackSlotCodes: [...fallback].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}
