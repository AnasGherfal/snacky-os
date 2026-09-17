import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("./ts-alias-loader.mjs", import.meta.url);
const { computePurchaseList } = await import("../src/lib/purchase-list.ts");
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const products = [
  { id: "fast", name: "Fast", active: true, last_purchase_cost_lyd: 2 },
  { id: "steady", name: "Steady", active: true, last_purchase_cost_lyd: 3 },
  { id: "new", name: "New this month", active: true },
  { id: "old", name: "Old only", active: true },
  { id: "covered", name: "Covered", active: true },
];
const previousPeriod = { start: "2026-08-01", end: "2026-08-31", coveredDays: 31, daysInMonth: 31 };
const currentPeriod = { start: "2026-09-01", end: "2026-09-16", coveredDays: 16, daysInMonth: 30 };

function calculate(days = 7) {
  return computePurchaseList({
    products,
    storageRows: [
      { product_id: "fast", quantity_on_hand: 5 },
      { product_id: "steady", quantity_on_hand: 20 },
      { product_id: "new", quantity_on_hand: 0 },
      { product_id: "old", quantity_on_hand: 0 },
      { product_id: "covered", quantity_on_hand: 500 },
    ],
    salesRows: [
      { product_id: "fast", month: "previous", units_sold: 310 },
      { product_id: "fast", month: "current", units_sold: 240 },
      { product_id: "steady", month: "previous", units_sold: 248 },
      { product_id: "steady", month: "current", units_sold: 80 },
      { product_id: "new", month: "current", units_sold: 64 },
      // "old" intentionally has no previous/current sales. Older history must not qualify it.
      { product_id: "covered", month: "previous", units_sold: 155 },
    ],
    previousPeriod,
    currentPeriod,
    coverageTargetDays: days,
  });
}

test("only previous/current-month sellers qualify and highest demand ranks first", () => {
  const rows = calculate();
  assert.deepEqual(rows.map((row) => row.productId), ["fast", "steady", "covered", "new"]);
  assert.equal(rows.some((row) => row.productId === "old"), false);
  assert.equal(rows[0].demandDailyRate, 15);
  assert.equal(rows[0].demandBasis, "current");
});

test("current storage is subtracted before suggesting a purchase", () => {
  const byId = new Map(calculate().map((row) => [row.productId, row]));
  assert.equal(byId.get("fast")?.targetStockQty, 105);
  assert.equal(byId.get("fast")?.suggestedBuyQty, 100);
  assert.equal(byId.get("steady")?.demandDailyRate, 8);
  assert.equal(byId.get("steady")?.suggestedBuyQty, 36);
  assert.equal(byId.get("covered")?.suggestedBuyQty, 0);
});

test("current-only products appear and a partial month is projected", () => {
  const row = calculate().find((item) => item.productId === "new");
  assert.ok(row);
  assert.equal(row.previousMonthUnits, 0);
  assert.equal(row.currentMonthUnits, 64);
  assert.equal(row.currentDailyRate, 4);
  assert.equal(row.currentMonthProjectedUnits, 120);
  assert.equal(row.suggestedBuyQty, 28);
});

test("coverage selector changes buy quantity without changing recent-demand eligibility", () => {
  const seven = new Map(calculate(7).map((row) => [row.productId, row]));
  const fourteen = new Map(calculate(14).map((row) => [row.productId, row]));
  const thirty = new Map(calculate(30).map((row) => [row.productId, row]));
  assert.equal(seven.get("fast")?.suggestedBuyQty, 100);
  assert.equal(fourteen.get("fast")?.suggestedBuyQty, 205);
  assert.equal(thirty.get("fast")?.suggestedBuyQty, 445);
  assert.deepEqual([...seven.keys()], [...fourteen.keys()]);
});

test("purchase list reads active monthly product imports and live storage, not the empty legacy KPI", () => {
  const source = read("src/lib/purchase-list-data.ts");
  assert.match(source, /from\("vms_monthly_product_profit"\)/);
  assert.match(source, /from\("vms_import_batches"\)/);
  assert.match(source, /eq\("report_type", "monthly_product_profit"\)/);
  assert.match(source, /eq\("is_active", true\)/);
  assert.match(source, /eq\("status", "imported"\)/);
  assert.match(source, /from\("current_inventory_by_location"\)/);
  assert.match(source, /eq\("location_type", "storage"\)/);
  assert.doesNotMatch(source, /kpi_product_monthly/);
});

test("UI explains recent-only logic, supports 7/14/30 days, and creates a purchase draft", () => {
  const page = read("src/app/restock-priority/purchase-list/page.tsx");
  const tabs = read("src/components/module-tabs-config.ts");
  assert.match(page, /coverageChoices = \[7, 14, 30\]/);
  assert.match(page, /Only products sold last month or this month appear here/);
  assert.match(page, /Current storage could not be verified/);
  assert.match(page, /CreatePurchaseListButton/);
  assert.match(page, /b\.demandDailyRate - a\.demandDailyRate|Buy these first/);
  assert.match(tabs, /Purchase List/);
  assert.match(tabs, /قائمة الشراء/);
  assert.match(tabs, /\/restock-priority\/purchase-list/);
});
