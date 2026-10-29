/** Shopping intentions only. These entries are never purchase or inventory lines. */
export type MarketUnit = "boxes" | "packs" | "units";
export type MarketFlexibility = "exact" | "any_flavour" | "any_brand";
export type MarketFilter = "remaining" | "got" | "all";
export type MarketChecklistItem = {
  id: string;
  product_id: string | null;
  label: string;
  quantity: number;
  unit: MarketUnit;
  flexibility: MarketFlexibility;
  acquired_quantity: number;
  unavailable: boolean;
  note: string;
};
export type MarketCommand = {
  request_id: string;
  list_id: string;
  revision: number;
  action: "create" | "add" | "edit" | "progress" | "remove" | "complete" | "cancel" | "reopen" | "assign";
  payload: Record<string, unknown>;
};
export type MarketDraft = { version: 1; items: MarketChecklistItem[] };
export const MARKET_ITEM_LIMIT = 200;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const itemKeys = ["id", "product_id", "label", "quantity", "unit", "flexibility", "acquired_quantity", "unavailable", "note"];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) throw Error("invalid");
}
function id(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw Error("invalid");
}
function integer(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw Error("invalid");
}
function text(value: unknown, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw Error("invalid");
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error("invalid");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Error("invalid");
}

export function validateMarketItem(value: unknown): MarketChecklistItem {
  const item = record(value);
  keys(item, itemKeys);
  id(item.id);
  if (item.product_id !== null) id(item.product_id);
  text(item.label, 1, 160);
  integer(item.quantity, 1, 10000);
  integer(item.acquired_quantity, 0, Number(item.quantity));
  if (typeof item.unit !== "string" || !["boxes", "packs", "units"].includes(item.unit) || typeof item.flexibility !== "string" || !["exact", "any_flavour", "any_brand"].includes(item.flexibility)) throw Error("invalid");
  if (typeof item.unavailable !== "boolean" || (item.unavailable && item.acquired_quantity !== 0)) throw Error("invalid");
  text(item.note, 0, 1000);
  return item as MarketChecklistItem;
}

export function validateMarketItems(value: unknown, allowEmpty = false): MarketChecklistItem[] {
  if (!Array.isArray(value) || value.length > MARKET_ITEM_LIMIT || (!allowEmpty && !value.length)) throw Error("invalid");
  const items = value.map(validateMarketItem);
  const ids = new Set(items.map(item => item.id.toLowerCase()));
  if (ids.size !== items.length) throw Error("invalid");
  return items;
}

export function validateMarketCommand(value: unknown): MarketCommand {
  const command = record(value);
  keys(command, ["request_id", "list_id", "revision", "action", "payload"]);
  id(command.request_id);
  id(command.list_id);
  integer(command.revision, 0, 2147483646);
  const payload = record(command.payload);
  if (command.action !== "create" && command.revision === 0) throw Error("invalid");
  switch (command.action) {
    case "create":
      keys(payload, ["title", "instructions", "assigned_to", "due_on", "items"]);
      if (command.revision !== 0) throw Error("invalid");
      text(payload.title, 1, 160);
      text(payload.instructions, 0, 3000);
      id(payload.assigned_to);
      date(payload.due_on);
      validateMarketItems(payload.items);
      break;
    case "add":
    case "edit":
      keys(payload, ["item"]);
      validateMarketItem(payload.item);
      break;
    case "progress":
      keys(payload, ["item_id", "acquired_quantity", "unavailable", "note"]);
      id(payload.item_id);
      integer(payload.acquired_quantity, 0, 10000);
      if (typeof payload.unavailable !== "boolean" || (payload.unavailable && payload.acquired_quantity !== 0)) throw Error("invalid");
      text(payload.note, 0, 1000);
      break;
    case "remove":
      keys(payload, ["item_id"]);
      id(payload.item_id);
      break;
    case "assign":
      keys(payload, ["assigned_to"]);
      id(payload.assigned_to);
      break;
    case "cancel":
      keys(payload, ["reason"]);
      text(payload.reason, 1, 1000);
      break;
    case "complete":
    case "reopen":
      keys(payload, []);
      break;
    default:
      throw Error("invalid");
  }
  return command as MarketCommand;
}

export function marketReceiptMatches(command: MarketCommand, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return receipt.ok === true && receipt.request_id === command.request_id && receipt.list_id === command.list_id && receipt.revision === command.revision + 1;
}

export function marketItemRemaining(item: MarketChecklistItem): number {
  return Math.max(0, item.quantity - item.acquired_quantity);
}
export function marketEditItem(previous: MarketChecklistItem, next: MarketChecklistItem) {
  validateMarketItem(next);
  if (previous.id !== next.id || (previous.acquired_quantity > 0 && previous.unit !== next.unit)) throw Error("invalid");
  return next;
}
export function marketTotals(items: MarketChecklistItem[]) {
  return items.reduce((totals, item) => {
    const remaining = marketItemRemaining(item);
    totals.total++;
    if (remaining === 0) totals.got++;
    else totals.remaining++;
    if (item.unavailable) totals.unavailable++;
    if (item.acquired_quantity > 0 && remaining > 0) totals.partial++;
    return totals;
  }, { total: 0, got: 0, remaining: 0, unavailable: 0, partial: 0 });
}
export function marketVisibleItems(items: MarketChecklistItem[], filter: MarketFilter) {
  return items.filter(item => filter === "all" || (filter === "got" ? marketItemRemaining(item) === 0 : marketItemRemaining(item) > 0));
}

export function parseMarketDraft(raw: string): MarketDraft {
  const draft = record(JSON.parse(raw));
  keys(draft, ["version", "items"]);
  if (draft.version !== 1) throw Error("invalid");
  return { version: 1, items: validateMarketItems(draft.items, true) };
}
export function marketDraftKey(userId: string) {
  id(userId);
  return `snacky:market-checklist:v1:${userId}`;
}
export function marketSuggestionsKey(userId: string) {
  id(userId);
  return `snacky:market-suggestions:v1:${userId}`;
}

/** A catalogue ID is a preferred example, never proof of the SKU actually bought. */
export function marketItemsFromRecommendations(
  recommendations: { productId: string; name: string; suggestedQty: number; purchaseUnit?: "box"; boxesQty?: number; unitsPerBox?: number }[],
  makeId: () => string,
): MarketChecklistItem[] {
  if (recommendations.length > MARKET_ITEM_LIMIT) throw Error("invalid");
  const seen = new Set<string>();
  return recommendations.map(recommendation => {
    id(recommendation.productId);
    if (seen.has(recommendation.productId.toLowerCase())) throw Error("invalid");
    seen.add(recommendation.productId.toLowerCase());
    const boxed = recommendation.purchaseUnit === "box";
    if (boxed && (!Number.isSafeInteger(recommendation.unitsPerBox) || Number(recommendation.unitsPerBox) <= 1 || Number(recommendation.boxesQty) * Number(recommendation.unitsPerBox) !== recommendation.suggestedQty)) throw Error("invalid");
    return validateMarketItem({
      id: makeId(), product_id: recommendation.productId, label: recommendation.name,
      quantity: boxed ? recommendation.boxesQty : recommendation.suggestedQty,
      unit: boxed ? "boxes" : "units", flexibility: "exact",
      acquired_quantity: 0, unavailable: false, note: "",
    });
  });
}

/** Explicit merge adds new suggestions; it never replaces manual names, quantities or market progress. */
export function mergeMarketRecommendations(current: MarketChecklistItem[], incoming: MarketChecklistItem[]): MarketChecklistItem[] {
  validateMarketItems(current, true);
  validateMarketItems(incoming, true);
  const products = new Set(current.flatMap(item => item.product_id ? [item.product_id.toLowerCase()] : []));
  const result = [...current];
  for (const item of incoming) {
    if (item.product_id && products.has(item.product_id.toLowerCase())) continue;
    if (item.product_id) products.add(item.product_id.toLowerCase());
    result.push(item);
  }
  return validateMarketItems(result, true);
}

export function marketError(code: string, ar: boolean) {
  const messages: Record<string, [string, string]> = {
    denied: ["Your account cannot access or edit this checklist.", "لا يملك حسابك صلاحية الوصول إلى هذه القائمة أو تعديلها."],
    conflict: ["The checklist changed on another device. Reload before editing.", "تغيرت القائمة على جهاز آخر. أعد التحميل قبل التعديل."],
    invalid: ["Check the item name and quantities. Got quantities cannot exceed the amount needed.", "راجع اسم الصنف والكميات. لا يمكن أن تتجاوز الكمية التي حصلت عليها الكمية المطلوبة."],
    unavailable: ["The shared checklist is unavailable. Your saved draft has been kept on this device.", "القائمة المشتركة غير متاحة. احتُفظ بالمسودة المحفوظة على هذا الجهاز."],
    not_installed: ["Shared shopping checklists are not available yet. Your draft is still saved on this device.", "قوائم التسوق المشتركة غير متاحة بعد. ما زالت مسودتك محفوظة على هذا الجهاز."],
    uncertain: ["Save is not confirmed. Retry the same saved request before making another change.", "لم يتأكد الحفظ. أعد الطلب المحفوظ نفسه قبل إجراء تغيير آخر."],
  };
  return (messages[code] ?? messages.invalid)[ar ? 1 : 0];
}
