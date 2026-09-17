export type RestockShoppingListItem = {
  productId: string;
  name: string;
  suggestedQty: number;
  purchaseUnit?: "box";
  unitsPerBox?: number;
  boxesQty?: number;
  priorityScore?: number;
  status?: string | null;
  lastPurchaseCost?: number | null;
};

export const RESTOCK_SHOPPING_LIST_STORAGE_KEY = "snacky-restock-shopping-list";

function hasBrowserStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeRestockShoppingListItem(item: Partial<RestockShoppingListItem> | null | undefined): RestockShoppingListItem | null {
  const productId = String(item?.productId ?? "").trim();
  const name = String(item?.name ?? "").trim();
  const suggestedQty = Math.max(0, Math.floor(Number(item?.suggestedQty ?? 0)));
  const priorityScore = Number(item?.priorityScore ?? 0);
  const status = item?.status ? String(item.status) : null;
  const parsedCost = Number(item?.lastPurchaseCost ?? 0);
  const lastPurchaseCost = Number.isFinite(parsedCost) && parsedCost > 0 ? parsedCost : null;

  if (!productId || !name || !Number.isSafeInteger(suggestedQty) || suggestedQty <= 0) return null;
  // Keep legacy unit-only lists readable, but never drop invalid box metadata.
  // A broken box payload must fail visibly, not silently revert to loose units.
  let boxFields: Pick<RestockShoppingListItem, "purchaseUnit" | "unitsPerBox" | "boxesQty"> = {};
  if (item?.purchaseUnit === "box") {
    const unitsPerBox = Number(item.unitsPerBox), boxesQty = Number(item.boxesQty);
    if (!Number.isSafeInteger(unitsPerBox) || unitsPerBox <= 1 || !Number.isSafeInteger(boxesQty) || boxesQty <= 0 || boxesQty * unitsPerBox !== suggestedQty || Number(item.suggestedQty) !== suggestedQty) {
      throw new Error("Saved box quantities are inconsistent. Recreate this list from Purchase List.");
    }
    boxFields = { purchaseUnit: "box", unitsPerBox, boxesQty };
  }

  return {
    ...boxFields,
    productId,
    name,
    suggestedQty,
    priorityScore: Number.isFinite(priorityScore) ? priorityScore : 0,
    status,
    lastPurchaseCost,
  };
}

export function readRestockShoppingList() {
  if (!hasBrowserStorage()) return [] as RestockShoppingListItem[];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(RESTOCK_SHOPPING_LIST_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeRestockShoppingListItem(item))
      .filter((item): item is RestockShoppingListItem => Boolean(item));
  } catch {
    return [];
  }
}

export function readRestockShoppingListStrict() {
  if (!hasBrowserStorage()) throw new Error("Browser storage is unavailable. Reopen the purchase list.");
  const raw = window.localStorage.getItem(RESTOCK_SHOPPING_LIST_STORAGE_KEY);
  if (raw === null) return [] as RestockShoppingListItem[];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Saved purchase list is invalid. Recreate it.");
  return parsed.map(item => {
    const normalized = normalizeRestockShoppingListItem(item);
    if (!normalized) throw new Error("A saved purchase item is invalid. Recreate the list.");
    return normalized;
  });
}

export function writeRestockShoppingList(items: Array<Partial<RestockShoppingListItem> | null | undefined>) {
  if (!hasBrowserStorage()) throw new Error("Browser storage is unavailable. The purchase list was not saved.");

  const normalized = items
    .map((item) => normalizeRestockShoppingListItem(item))
    .filter((item): item is RestockShoppingListItem => Boolean(item));

  const deduped = Array.from(
    normalized.reduce((map, item) => map.set(item.productId, item), new Map<string, RestockShoppingListItem>()).values(),
  );

  window.localStorage.setItem(RESTOCK_SHOPPING_LIST_STORAGE_KEY, JSON.stringify(deduped));
}

export function toggleRestockShoppingListItem(item: Partial<RestockShoppingListItem>) {
  const normalized = normalizeRestockShoppingListItem(item);
  if (!normalized) return [] as RestockShoppingListItem[];

  const current = readRestockShoppingList();
  const exists = current.some((entry) => entry.productId === normalized.productId);
  const next = exists
    ? current.filter((entry) => entry.productId !== normalized.productId)
    : [...current.filter((entry) => entry.productId !== normalized.productId), normalized];
  writeRestockShoppingList(next);
  return next;
}

export function clearRestockShoppingList() {
  if (!hasBrowserStorage()) return;
  window.localStorage.removeItem(RESTOCK_SHOPPING_LIST_STORAGE_KEY);
}

export function updateRestockShoppingListQuantity(productId: string, suggestedQty: number) {
  const quantity = Math.max(1, Math.ceil(Number(suggestedQty ?? 1)));
  if (!Number.isSafeInteger(quantity)) throw new Error("Invalid purchase quantity.");
  const next = readRestockShoppingList().map((item) => item.productId === productId ? (item.purchaseUnit === "box"
    ? { ...item, boxesQty: Math.ceil(quantity / item.unitsPerBox!), suggestedQty: Math.ceil(quantity / item.unitsPerBox!) * item.unitsPerBox! }
    : { ...item, suggestedQty: quantity }) : item);
  writeRestockShoppingList(next);
  return next;
}

export function removeRestockShoppingListItem(productId: string) {
  const next = readRestockShoppingList().filter((item) => item.productId !== productId);
  writeRestockShoppingList(next);
  return next;
}
