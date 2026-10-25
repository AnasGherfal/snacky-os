import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeOperatorBagBalances,
} from "../src/lib/operator-bag-stock.ts";
import { formatSignedProductQuantity } from "../src/lib/product-quantity.ts";
import { combineMovementFilterGroups } from "../src/lib/inventory-movement-filter-groups.ts";

const balance = (qty, overrides = {}) => ({
  product_id: "product-1",
  product_name: "Snacky Water",
  location_id: "operator-1",
  location_name: "Test Operator",
  quantity_on_hand: qty,
  ...overrides,
});
const packages = new Map([["product-1", {
  id: "product-1", sku: "WATER-24", category: "Water", case_quantity: 24,
}]]);

test("positive and negative operator custody balances are both visible", () => {
  const rows = normalizeOperatorBagBalances([
    balance(27),
    balance(-5, { product_id: "product-2", product_name: "Chips", location_id: "operator-2" }),
  ], packages, false);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.productId === "product-1").quantity, 27);
  assert.equal(rows.find(r => r.productId === "product-2").quantity, -5);
  assert.equal(rows.filter(r => r.quantity < 0).length, 1);
  assert.equal(rows[0].quantity, -5, "negative custody balances must be shown before ordinary stock");
  assert.equal(rows.find(r => r.productId === "product-1").caseQuantity, 24);
  assert.equal(rows.find(r => r.productId === "product-2").caseQuantity, null);
  assert.ok(formatSignedProductQuantity(-5, { productName: "Chips", caseQuantity: 1 }).startsWith("−5"));
});

test("a zero line stays absent but never excludes a negative balance", () => {
  const rows = normalizeOperatorBagBalances([
    balance(0),
    balance(-3, { product_id: "product-2" }),
  ], null);
  assert.deepEqual(rows.map(r => r.quantity), [-3]);
});

test("invalid, duplicate or missing operator bag ledger data fails closed", () => {
  for (const qty of [null, "NaN", "2.4", Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeOperatorBagBalances([balance(qty)], packages));
  }
  assert.throws(() => normalizeOperatorBagBalances([balance(3, { product_id: null })], packages));
  assert.throws(() => normalizeOperatorBagBalances([balance(3, { location_id: null })], packages));
  assert.throws(() => normalizeOperatorBagBalances([balance(3), balance(-1)], packages), /Duplicate operator bag/);
});

test("no missing packaging data is made up as a verified box size", () => {
  const withoutMetadata = normalizeOperatorBagBalances([balance(26)], null);
  assert.equal(withoutMetadata[0].caseQuantity, null);
  const withMetadata = normalizeOperatorBagBalances([balance(26)], packages);
  assert.equal(withMetadata[0].caseQuantity, 24);
  assert.equal(withMetadata[0].sku, "WATER-24");
});

test("operator bag custody is on-demand and does not slow the standard Stock page", () => {
  const stock = readFileSync("src/app/inventory/page.tsx", "utf8");
  const bag = readFileSync("src/app/inventory/OperatorBagStockView.tsx", "utf8");
  const movementLog = readFileSync("src/app/inventory/movements/page.tsx", "utf8");
  const bagBranch = stock.indexOf("if (operatorBagView)");
  const stockRead = stock.indexOf("await loadPhysicalStorageData(inventoryReadClient)");
  assert.ok(bagBranch > 0 && stockRead > bagBranch, "Operator Bags must be a separate view before Storage loads");
  assert.match(stock, /href="\/inventory\?view=operator-bags"/);
  assert.doesNotMatch(stock, /from\("current_inventory_by_location"\)/);
  assert.doesNotMatch(stock, /from\("inventory_movements"\)/);
  assert.match(stock, /href="\/inventory\/movements"/);
  assert.match(stock, /canSeeMovementHistory=\{canAccessPath\(userContext, "\/inventory\/movements"\)\}/);
  assert.match(bag, /canSeeMovementHistory \? /);
  assert.match(bag, /product_id=\$\{encodeURIComponent\(r\.productId\)\}/);
  assert.match(bag, /bag_id=\$\{encodeURIComponent\(r\.operatorId\)\}/);
  assert.match(bag, /\.eq\("location_type", "operator_bag"\)/);
  assert.match(bag, /count: "exact"/);
  assert.match(bag, /normalizeOperatorBagBalances\(balances\.data/);
  assert.match(bag, /records\.filter\(\(r\) => r\.quantity < 0\)/);
  assert.match(bag, /Negative operator bag balances need investigation/);
  assert.match(bag, /negativeBalances\.map/);
  assert.match(bag, /affectedOperators/);
  assert.match(bag, /deficitUnits/);
  assert.match(bag, /not proof of physical loss/);
  assert.match(bag, /Review ledger/);
  assert.match(bag, /canReviewHealth \? /);
  assert.match(bag, /href="\/operations-health#inventory-health"/);
  assert.match(stock, /canReviewHealth=\{canAccessPath\(userContext, "\/operations-health"\)\}/);
  assert.match(movementLog, /from\("inventory_movements"\)/);
  assert.match(movementLog, /formatSignedProductQuantity/);
});

test("custody view never creates or adjusts warehouse records", () => {
  const bag = readFileSync("src/app/inventory/OperatorBagStockView.tsx", "utf8");
  assert.doesNotMatch(bag, /\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});

test("discrepancy drilldown filters to one validated operator bag and preserves search", () => {
  const audit = readFileSync("src/app/inventory/movements/page.tsx", "utf8");
  assert.match(audit, /bag_id\?: string/);
  assert.match(audit, /\^\[0-9a-f\]\{8\}/);
  assert.match(audit, /from_entity_type\.eq\.operator_bag,from_entity_id\.eq/);
  assert.match(audit, /to_entity_type\.eq\.operator_bag,to_entity_id\.eq/);
  assert.match(audit, /name="bag_id" value=\{bagId\}/);
  assert.match(audit, /Invalid operator bag filter/);
  assert.match(audit, /Back to operator bags/);
  assert.match(audit, /\.eq\("product_id", params\.product_id\)/);
});

test("bag filter cannot be overwritten by text search or machine filters", () => {
  const bag = ["and(from_entity_type.eq.operator_bag,from_entity_id.eq.bag)", "and(to_entity_type.eq.operator_bag,to_entity_id.eq.bag)"];
  const machine = ["related_machine_id.eq.machine", "to_entity_id.eq.machine", "from_entity_id.eq.machine"];
  const search = ["notes.ilike.*x*", "product_id.in.(p1)"];
  const expression = combineMovementFilterGroups([bag, machine, search]);
  assert.ok(expression.startsWith("and("), expression);
  assert.ok(expression.includes("or(" + bag.join(",") + ")"), expression);
  assert.ok(expression.includes("or(" + machine.join(",") + ")"), expression);
  assert.ok(expression.includes("or(" + search.join(",") + ")"), expression);
  assert.equal(combineMovementFilterGroups([]), null);
  assert.equal(combineMovementFilterGroups([bag]), bag.join(","));
  const audit = readFileSync("src/app/inventory/movements/page.tsx", "utf8");
  assert.match(audit, /combineMovementFilterGroups\(alternativeGroups\)/);
  assert.equal((audit.match(/movementQuery = movementQuery\.or\(/g) ?? []).length, 1);
});
