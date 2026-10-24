import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildPhysicalStorageBalances,
  parseStorageUnits,
  physicalStockStatus,
} from "../src/lib/storage-inventory-model.ts";

const product = (id, changes = {}) => ({
  id, name: `Product ${id}`, sku: id, category: "Snacks", brand: null,
  case_quantity: 24, min_storage_qty: 10, active: true, ...changes,
});

test("Storage reads signed physical quantities and maintains packaging", () => {
  const rows = buildPhysicalStorageBalances(
    [product("a"), product("b", { name: "Chocolate", case_quantity: "12" })],
    [{ product_id: "a", quantity_on_hand: "29" }, { product_id: "a", quantity_on_hand: -5 },
     { product_id: "b", quantity_on_hand: "7" }],
  );
  assert.equal(rows.find(r => r.productId === "a").currentQty, 24);
  assert.equal(rows.find(r => r.productId === "a").caseQuantity, 24);
  assert.equal(rows.find(r => r.productId === "b").caseQuantity, 12);
  assert.equal(rows.find(r => r.productId === "b").minStorageQty, 10);
});

test("negative stock is not silently clamped to zero", () => {
  const rows = buildPhysicalStorageBalances([product("a")], [{ product_id: "a", quantity_on_hand: -3 }]);
  assert.equal(rows[0].currentQty, -3);
  assert.equal(physicalStockStatus(rows[0].currentQty, 0, rows[0].minStorageQty, false), "review");
});

test("inactive products with physical stock remain visible", () => {
  const rows = buildPhysicalStorageBalances([product("inactive", { active: false }), product("empty", { active: false })],
    [{ product_id: "inactive", quantity_on_hand: 15 }]);
  assert.deepEqual(rows.map(r => r.productId), ["inactive"]);
  assert.equal(rows[0].active, false);
  assert.equal(physicalStockStatus(rows[0].currentQty, 0, 0, !rows[0].active), "review");
});

test("unmapped products with ledger quantity show an investigation row", () => {
  const rows = buildPhysicalStorageBalances([product("known")], [{ product_id: "missing", quantity_on_hand: 8 }]);
  const unknown = rows.find(r => r.productId === "missing");
  assert.equal(unknown.currentQty, 8);
  assert.equal(unknown.unmapped, true);
  assert.equal(physicalStockStatus(unknown.currentQty, 0, 0, unknown.unmapped), "review");
});

test("invalid or truncated ledger amounts are not converted into plausible stock", () => {
  for (const bad of [null, undefined, "", "not-a-number", "1.3", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseStorageUnits(bad, "qty"), Error);
  }
  assert.throws(() => buildPhysicalStorageBalances([product("a")], [{ product_id: "a", quantity_on_hand: null }]));
  assert.throws(() => buildPhysicalStorageBalances([product("a"), product("a")], []));
  assert.throws(() => buildPhysicalStorageBalances([], [{ product_id: null, quantity_on_hand: 1 }]));
});

test("unverified route reservations cannot produce a fake available quantity", () => {
  assert.equal(physicalStockStatus(15, null, 10, false), "unverified");
  assert.equal(physicalStockStatus(0, null, 10, false), "out_of_stock");
  assert.equal(physicalStockStatus(10, 16, 0, false), "review");
  assert.equal(physicalStockStatus(8, 8, 0, false), "reserved");
  assert.equal(physicalStockStatus(15, 8, 10, false), "low_stock");
  assert.equal(physicalStockStatus(25, 8, 10, false), "available");
});

test("Storage page uses read-only physical stock loader, not sales or automatic route repair", () => {
  const page = readFileSync("src/app/inventory/page.tsx", "utf8");
  const loader = readFileSync("src/lib/storage-inventory-data.ts", "utf8");
  assert.match(page, /loadPhysicalStorageData\(inventoryReadClient\)/);
  assert.doesNotMatch(page, /loadRestockPriorityData\(/);
  assert.doesNotMatch(page, /suggestedBuyQty|salesVelocity|\.upsert\(/);
  assert.match(loader, /route_storage_stock_by_product/);
  assert.match(loader, /count: "exact"/);
  assert.match(loader, /stock\.count > stock\.data\.length/);
  assert.doesNotMatch(loader, /kpi_product_monthly|refill_recommendations|latest_vms_stock_by_slot|repairMissingRouteStockLines|\.upsert\(|\.insert\(|\.update\(/);
});

test("Stock page shows partial independent data only with visible uncertainty", () => {
  const page = readFileSync("src/app/inventory/page.tsx", "utf8");
  assert.match(page, /reservationsKnown \? filteredInventoryRows\.reduce/);
  assert.match(page, /row\.availableQty === null \? tr\("Unverified"/);
  assert.match(page, /filterCounts\.review/);
  assert.match(page, /Inactive product still has stock/);
  assert.match(page, /minStorageQty/);
});
