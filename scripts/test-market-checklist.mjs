import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_ITEM_LIMIT,
  validateMarketItem,
  validateMarketItems,
  validateMarketCommand,
  marketReceiptMatches,
  marketItemRemaining,
  marketEditItem,
  marketTotals,
  marketVisibleItems,
  parseMarketDraft,
  marketDraftKey,
  marketSuggestionsKey,
  marketItemsFromRecommendations,
  mergeMarketRecommendations,
} from "../src/lib/market-checklist.ts";

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (changes = {}) => ({
  id: uuid(1), product_id: null, label: "Chips", quantity: 6, unit: "boxes",
  flexibility: "any_brand", acquired_quantity: 0, unavailable: false,
  note: "Chips are the priority; choose an available flavour.", ...changes,
});
const create = (changes = {}) => ({
  request_id: uuid(100), list_id: uuid(101), revision: 0, action: "create",
  payload: { title: "Market run", instructions: "Check expiry dates", assigned_to: uuid(102), due_on: "2026-10-28", items: [item()] },
  ...changes,
});
const command = (action, payload) => ({ request_id: uuid(100), list_id: uuid(101), revision: 3, action, payload });

test("a generic shopping need can be saved without selecting an exact flavour or catalogue SKU", () => {
  const generic = item();
  assert.equal(validateMarketItem(generic), generic);
  assert.doesNotThrow(() => validateMarketCommand(create()));
  const preferred = item({ id: uuid(2), product_id: uuid(200), label: "Bebeto", flexibility: "any_flavour" });
  assert.equal(validateMarketItem(preferred).product_id, uuid(200));
  assert.equal(validateMarketItem(preferred).flexibility, "any_flavour");
});

test("partial and unavailable needs remain in Remaining; unavailable is never acquired", () => {
  const untouched = item();
  const partial = item({ id: uuid(2), label: "Mr Crunch", acquired_quantity: 2 });
  const missing = item({ id: uuid(3), label: "Bebeto", unavailable: true });
  const got = item({ id: uuid(4), label: "Water", quantity: 4, unit: "packs", acquired_quantity: 4 });
  const rows = [untouched, partial, missing, got];
  assert.equal(marketItemRemaining(partial), 4);
  assert.equal(marketItemRemaining(missing), 6);
  assert.deepEqual(marketTotals(rows), { total: 4, got: 1, remaining: 3, unavailable: 1, partial: 1 });
  assert.deepEqual(marketVisibleItems(rows, "remaining").map(row => row.id), [uuid(1), uuid(2), uuid(3)]);
  assert.deepEqual(marketVisibleItems(rows, "got").map(row => row.id), [uuid(4)]);
  assert.deepEqual(marketVisibleItems(rows, "all"), rows);
  assert.deepEqual(marketTotals([]), { total: 0, got: 0, remaining: 0, unavailable: 0, partial: 0 });
});

test("a checked need can be reopened without claiming any receipt or financial effect", () => {
  const acquired = item({ acquired_quantity: 6 });
  const reopened = { ...acquired, acquired_quantity: 0, unavailable: false };
  validateMarketItem(reopened);
  assert.equal(marketTotals([reopened]).remaining, 1);
  assert.equal(marketTotals([reopened]).got, 0);
  for (const financialField of ["purchase_id", "receipt_id", "unit_cost", "inventory_quantity", "actual_product_id"]) {
    assert.throws(() => validateMarketItem({ ...acquired, [financialField]: uuid(9) }), /invalid/);
  }
});

test("editing a shopping need preserves its identity and the meaning of already acquired quantities", () => {
  const previous = item({ acquired_quantity: 2 });
  assert.equal(marketEditItem(previous, { ...previous, label: "Mr Crunch", quantity: 8 }).quantity, 8);
  assert.throws(() => marketEditItem(previous, { ...previous, id: uuid(88) }), /invalid/);
  assert.throws(() => marketEditItem(previous, { ...previous, unit: "packs" }), /invalid/);
  const reset = { ...previous, acquired_quantity: 0 };
  assert.equal(marketEditItem(reset, { ...reset, unit: "packs" }).unit, "packs");
});

test("item validation rejects invalid identities, fractional/over-acquired quantities and ambiguous units", () => {
  const invalid = [
    { id: "" }, { id: "not-a-uuid" }, { product_id: "" }, { product_id: [] },
    { label: "   " }, { label: "a".repeat(161) }, { label: ["Chips"] },
    { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 10001 }, { quantity: "6" },
    { acquired_quantity: -1 }, { acquired_quantity: 7 }, { acquired_quantity: 0.5 },
    { unavailable: "true" }, { unavailable: true, acquired_quantity: 1 },
    { unit: "cases" }, { unit: ["boxes"] }, { unit: null },
    { flexibility: "maybe" }, { flexibility: ["any_flavour"] },
    { note: null }, { note: "a".repeat(1001) }, { ignored: true },
  ];
  for (const change of invalid) assert.throws(() => validateMarketItem(item(change)), /invalid/, JSON.stringify(change));
  const incomplete = item(); delete incomplete.product_id;
  assert.throws(() => validateMarketItem(incomplete), /invalid/);
});

test("list limits and stable row IDs prevent accidental duplicate entries during retry", () => {
  assert.equal(validateMarketItems([], true).length, 0);
  assert.throws(() => validateMarketItems([]), /invalid/);
  assert.throws(() => validateMarketItems([item(), item({ label: "Another label" })]), /invalid/);
  const letterId = "abcdefab-0000-4000-8000-000000000001";
  assert.throws(() => validateMarketItems([item({ id: letterId }), item({ id: letterId.toUpperCase() })]), /invalid/);
  assert.equal(validateMarketItems(Array.from({ length: MARKET_ITEM_LIMIT }, (_, index) => item({ id: uuid(index + 1) }))).length, 200);
  assert.throws(() => validateMarketItems(Array.from({ length: MARKET_ITEM_LIMIT + 1 }, (_, index) => item({ id: uuid(index + 1) }))), /invalid/);
});

test("commands validate real dates, expected revisions and only their own explicit fields", () => {
  for (const change of [
    { revision: 1 }, { request_id: "bad" }, { list_id: null }, { surprise: true },
    { payload: { ...create().payload, due_on: "2026-02-30" } },
    { payload: { ...create().payload, due_on: "2026-10-28T12:00:00Z" } },
    { payload: { ...create().payload, title: " " } },
    { payload: { ...create().payload, assigned_to: "" } },
    { payload: { ...create().payload, receipt_file: "invented" } },
  ]) assert.throws(() => validateMarketCommand(create(change)), /invalid/);
  assert.doesNotThrow(() => validateMarketCommand(create({ payload: { ...create().payload, due_on: "2028-02-29" } })));
  for (const action of ["complete", "reopen"]) {
    assert.doesNotThrow(() => validateMarketCommand(command(action, {})));
    assert.throws(() => validateMarketCommand({ ...command(action, {}), revision: 0 }), /invalid/);
    assert.throws(() => validateMarketCommand(command(action, { posted: true })), /invalid/);
  }
  assert.doesNotThrow(() => validateMarketCommand(command("add", { item: item() })));
  assert.doesNotThrow(() => validateMarketCommand(command("edit", { item: item({ label: "Mr Crunch" }) })));
  assert.doesNotThrow(() => validateMarketCommand(command("assign", { assigned_to: uuid(102) })));
  assert.doesNotThrow(() => validateMarketCommand(command("remove", { item_id: uuid(1) })));
  assert.throws(() => validateMarketCommand(command("cancel", { reason: " " })), /invalid/);
  assert.doesNotThrow(() => validateMarketCommand(command("cancel", { reason: "Shopping postponed" })));
  assert.throws(() => validateMarketCommand(command("purchase", {})), /invalid/);
});

test("progress is a checklist command; actual SKU or price cannot be smuggled into it", () => {
  const payload = { item_id: uuid(1), acquired_quantity: 3, unavailable: false, note: "Found another flavour" };
  assert.doesNotThrow(() => validateMarketCommand(command("progress", payload)));
  for (const change of [
    { acquired_quantity: "3" }, { acquired_quantity: 1.5 }, { acquired_quantity: 10001 },
    { unavailable: true }, { product_id: uuid(300) }, { price: 12 },
  ]) assert.throws(() => validateMarketCommand(command("progress", { ...payload, ...change })), /invalid/);
});

test("only the matching request, list and next revision confirms persistence", () => {
  const c = command("complete", {});
  const receipt = { ok: true, request_id: c.request_id, list_id: c.list_id, revision: 4 };
  assert.equal(marketReceiptMatches(c, receipt), true);
  for (const change of [{ ok: false }, { request_id: uuid(500) }, { list_id: uuid(500) }, { revision: 3 }, { revision: "4" }, { revision: 5 }]) {
    assert.equal(marketReceiptMatches(c, { ...receipt, ...change }), false);
  }
  assert.equal(marketReceiptMatches(c, null), false);
  assert.equal(marketReceiptMatches(c, { ok: true }), false);
});

test("draft round-trip preserves added needs, flexibility, partial quantities and account isolation", () => {
  const items = [item(), item({ id: uuid(2), label: "Bebeto", acquired_quantity: 2, flexibility: "any_flavour" })];
  const raw = JSON.stringify({ version: 1, items });
  assert.deepEqual(parseMarketDraft(raw), { version: 1, items });
  assert.deepEqual(parseMarketDraft(JSON.stringify({ version: 1, items: [] })).items, []);
  for (const raw of ["broken", "null", "[]", JSON.stringify({ version: 2, items }), JSON.stringify({ version: 1, items, owner: uuid(1) })]) {
    assert.throws(() => parseMarketDraft(raw));
  }
  assert.notEqual(marketDraftKey(uuid(1)), marketDraftKey(uuid(2)));
  assert.notEqual(marketSuggestionsKey(uuid(1)), marketSuggestionsKey(uuid(2)));
  assert.notEqual(marketDraftKey(uuid(1)), marketSuggestionsKey(uuid(1)));
  assert.throws(() => marketDraftKey("unknown"), /invalid/);
});

test("recommendations become shopping needs without inferred receipt products or purchase costs", () => {
  let next = 10;
  const rows = marketItemsFromRecommendations([
    { productId: uuid(201), name: "Mr Crunch cheese", purchaseUnit: "box", boxesQty: 3, unitsPerBox: 24, suggestedQty: 72, lastPurchaseCost: 4 },
    { productId: uuid(202), name: "Bebeto", suggestedQty: 5 },
  ], () => uuid(next++));
  assert.equal(rows[0].quantity, 3);
  assert.equal(rows[0].unit, "boxes");
  assert.equal(rows[0].product_id, uuid(201));
  assert.equal(rows[0].acquired_quantity, 0);
  assert.equal(rows[0].flexibility, "exact");
  assert.equal(rows[1].quantity, 5);
  assert.equal(rows[1].unit, "units");
  assert.equal("lastPurchaseCost" in rows[0], false);
  assert.equal("unitsPerBox" in rows[0], false);
  assert.equal("actual_product_id" in rows[0], false);
  assert.throws(() => marketItemsFromRecommendations([{ productId: uuid(201), name: "Chips", purchaseUnit: "box", boxesQty: 3, unitsPerBox: 24, suggestedQty: 70 }], () => uuid(10)), /invalid/);
  assert.throws(() => marketItemsFromRecommendations([{ productId: uuid(201), name: "Chips", suggestedQty: 3 }, { productId: uuid(201), name: "Chips again", suggestedQty: 1 }], () => uuid(next++)), /invalid/);
});

test("an explicit sales refresh adds new suggestions while preserving manual choices and checked progress", () => {
  const manual = item({ label: "Chips, any brand", acquired_quantity: 6 });
  const edited = item({ id: uuid(2), product_id: uuid(201), label: "Mr Crunch — any available flavour", quantity: 8, acquired_quantity: 2, flexibility: "any_flavour" });
  const missing = item({ id: uuid(3), product_id: uuid(202), label: "Bebeto", unavailable: true });
  const current = [manual, edited, missing];
  const snapshot = JSON.stringify(current);
  const incoming = [
    item({ id: uuid(10), product_id: uuid(201), label: "Mr Crunch cheese", quantity: 1 }),
    item({ id: uuid(11), product_id: uuid(202), label: "Bebeto original", quantity: 9 }),
    item({ id: uuid(12), product_id: uuid(203), label: "Water", quantity: 2, unit: "packs" }),
  ];
  const merged = mergeMarketRecommendations(current, incoming);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.slice(0, 3), current);
  assert.equal(merged[3].product_id, uuid(203));
  assert.equal(JSON.stringify(current), snapshot, "The original saved list must not be mutated while preparing a merge");
  assert.deepEqual(mergeMarketRecommendations(merged, incoming), merged, "Repeating a confirmed import does not duplicate catalogue suggestions");
  assert.deepEqual(mergeMarketRecommendations(current, []), current, "An empty newer report does not erase the working checklist");
});
