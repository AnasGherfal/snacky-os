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
  const parsed = Number(raw.replace(/[^\d.-]/g, ""));
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
    sellingPrice: xyNativeMoney(row, ["spjg", "spsj"], ["selling_price"]),
    costPrice: xyNativeMoney(row, ["spjj"], ["cost_price", "purchase_price"]),
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
