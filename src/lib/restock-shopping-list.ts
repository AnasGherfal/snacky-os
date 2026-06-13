export type RestockShoppingListItem = {
  productId: string;
  name: string;
  suggestedQty: number;
  priorityScore?: number;
  status?: string | null;
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

  if (!productId || !name || suggestedQty <= 0) return null;

  return {
    productId,
    name,
    suggestedQty,
    priorityScore: Number.isFinite(priorityScore) ? priorityScore : 0,
    status,
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

export function writeRestockShoppingList(items: Array<Partial<RestockShoppingListItem> | null | undefined>) {
  if (!hasBrowserStorage()) return;

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
