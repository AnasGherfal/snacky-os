export type XyDataRow = Record<string, unknown>;

export function xyText(row: XyDataRow, key: string) {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

export function xyFirstText(row: XyDataRow, keys: string[]) {
  for (const key of keys) {
    const value = xyText(row, key);
    if (value) return value;
  }
  return "";
}

export function xyNumber(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/[^\d.-]/g, "");
  if (!normalized || !/\d/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function xyNativeMoney(row: XyDataRow, nativeKeys: string[], normalizedKeys: string[]) {
  for (const key of nativeKeys) {
    const parsed = xyNumber(row[key]);
    if (parsed !== null) return parsed / 100;
  }
  for (const key of normalizedKeys) {
    const parsed = xyNumber(row[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function xyInteger(value: unknown) {
  const parsed = xyNumber(value);
  return parsed === null ? null : Math.max(0, Math.floor(parsed));
}

export function xyProductIdentity(row: XyDataRow) {
  return {
    vmsProductId: xyFirstText(row, ["spbh", "vms_product_id", "product_id"]),
    thirdPartyProductId: xyFirstText(row, ["dsfspbh", "third_party_product_id", "sku"]),
    productName: xyFirstText(row, ["spmc", "product_name", "name"]),
    barcode: xyFirstText(row, ["sptxm", "barcode", "bar_code"]),
    imageUrl: xyFirstText(row, ["fjlj", "sptp", "image_url", "image"]),
    // XY's native price fields are integer minor units: 300 means 3.00 LYD.
    sellingPrice: xyNativeMoney(row, ["spjg", "spsj"], ["selling_price", "sellingPrice", "price"]),
    costPrice: xyNativeMoney(row, ["spjj"], ["cost_price", "purchase_price"]),
  };
}


/** Direct XY selection reads must never turn missing, negative or fractional
 * quantities into zero. XY native prices (spjg) are minor units, while
 * normalized fallback prices are already in LYD.
 */
function strictXySelectionQuantity(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function normalizeXyLiveSelection(row: XyDataRow) {
  const identity = xyProductIdentity(row);
  return {
    slotCode: xyFirstText(row, ["hdbh", "slotCode"]),
    vmsProductId: identity.vmsProductId || null,
    productName: identity.productName || xyFirstText(row, ["productName"]) || null,
    priceLyd: identity.sellingPrice !== null && identity.sellingPrice > 0 ? identity.sellingPrice : null,
    currentQty: strictXySelectionQuantity(row.hdkc ?? row.currentQty),
    capacity: strictXySelectionQuantity(row.hdrl ?? row.capacity),
  };
}

const placeholderProductIds = new Set(["0", "0000", "null", "undefined"]);

export function classifyXyLane(row: XyDataRow) {
  const identity = xyProductIdentity(row);
  const slotCode = xyText(row, "hdbh");
  const currentQty = xyInteger(row.hdkc);
  const capacity = xyInteger(row.hdrl);
  const normalizedProductId = identity.vmsProductId.toLowerCase();
  const placeholder = placeholderProductIds.has(normalizedProductId)
    || (!identity.vmsProductId && !identity.productName);

  if (placeholder) {
    return { kind: "placeholder" as const, identity, slotCode, currentQty, capacity, reason: "unassigned XY lane" };
  }
  if (!slotCode) {
    return { kind: "invalid" as const, identity, slotCode, currentQty, capacity, reason: "missing lane number" };
  }
  if (currentQty === null) {
    return { kind: "invalid" as const, identity, slotCode, currentQty, capacity, reason: "missing current quantity" };
  }
  if (capacity === null || capacity <= 0) {
    return { kind: "invalid" as const, identity, slotCode, currentQty, capacity, reason: "missing or zero capacity" };
  }
  if (currentQty > capacity) {
    return { kind: "invalid" as const, identity, slotCode, currentQty, capacity, reason: "current quantity exceeds capacity" };
  }

  return { kind: "configured" as const, identity, slotCode, currentQty, capacity, reason: null };
}
