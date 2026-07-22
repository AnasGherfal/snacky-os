import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatProductQuantity,
  roundUnitsUpToCase,
  splitProductQuantity,
} from "../src/lib/product-quantity.ts";
import { buildProductPlanningRecommendation } from "../src/lib/product-planning.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const planningPage = read("src/app/product-planning/page.tsx");
const buyListSummary = read("src/app/product-planning/BuyListLiveSummary.tsx");
const planningHelper = read("src/lib/product-planning.ts");
const inventoryPage = read("src/app/inventory/page.tsx");
const pickupPage = read("src/app/operator/routes/[id]/pick-list/page.tsx");
const pickupApi = read("src/app/api/operator/routes/[id]/pick-list/route.ts");
const authz = read("src/lib/authz.ts");
const moduleTabs = read("src/components/module-tabs-config.ts");
const migration = read("supabase/migrations/202607160001_product_monthly_purchase_plans.sql");

test("water quantities are shown as boxes plus loose bottles", () => {
  const split = splitProductQuantity(95, {
    caseQuantity: 13,
    productName: "Snacky Water",
    category: "Water",
  });
  assert.equal(split.boxes, 7);
  assert.equal(split.looseUnits, 4);
  assert.equal(split.totalUnits, 95);
  assert.equal(
    formatProductQuantity(95, {
      caseQuantity: 13,
      productName: "Snacky Water",
      category: "Water",
    }),
    "7 boxes and 4 bottles (95 total)",
  );
});

test("exact full boxes do not show zero loose units", () => {
  assert.equal(
    formatProductQuantity(84, {
      caseQuantity: 12,
      productName: "Pepsi",
      category: "Drinks",
    }),
    "7 boxes (84 total)",
  );
  assert.equal(roundUnitsUpToCase(85, 12), 96);
});

test("new products remain protected for testing even with no sales", () => {
  const recommendation = buildProductPlanningRecommendation({
    productId: "new-water",
    productName: "New Water",
    category: "Water",
    createdAt: "2026-06-15T00:00:00.000Z",
    caseQuantity: 13,
    currentStorageUnits: 0,
    unitCost: 1.5,
    salesMonths: [],
  }, "2026-07-01");

  assert.equal(recommendation.action, "testing");
  assert.equal(recommendation.actionLabel, "New product — keep testing");
  assert.equal(recommendation.isNewProduct, true);
  assert.equal(recommendation.minimumStockUnits, 13);
  assert.equal(recommendation.suggestedBuyUnits, 13);
  assert.equal(recommendation.recommendedPlanUnits, 13);
  assert.equal(recommendation.recommendedBudgetLyd, 19.5);
});

test("established products with no sales in current or previous periods can be removed", () => {
  const recommendation = buildProductPlanningRecommendation({
    productId: "old-slow",
    productName: "Old Slow Product",
    createdAt: "2025-01-01T00:00:00.000Z",
    caseQuantity: 12,
    currentStorageUnits: 24,
    unitCost: 2,
    currentMonthObservedDays: 15,
    currentMonthSalesThrough: "2026-07-15",
    salesMonths: [
      { month: "2026-05-01", units: 0, revenue: 0, grossProfit: 0 },
      { month: "2026-06-01", units: 0, revenue: 0, grossProfit: 0 },
      { month: "2026-07-01", units: 0, revenue: 0, grossProfit: 0 },
    ],
  }, "2026-07-01");

  assert.equal(recommendation.action, "remove");
  assert.equal(recommendation.isNewProduct, false);
  assert.equal(recommendation.currentMonthDataAvailable, true);
});

test("current-month sales project remaining demand without buying the already-sold units again", () => {
  const recommendation = buildProductPlanningRecommendation({
    productId: "pepsi",
    productName: "Pepsi",
    category: "Drinks",
    createdAt: "2025-01-01T00:00:00.000Z",
    caseQuantity: 12,
    currentStorageUnits: 20,
    activeMachineCount: 8,
    unitCost: 2,
    currentMonthObservedDays: 15,
    currentMonthSalesThrough: "2026-07-15",
    purchasedUnitsThisMonth: 30,
    purchasedSpendThisMonth: 60,
    salesMonths: [
      { month: "2026-05-01", units: 60, revenue: 180, grossProfit: 60 },
      { month: "2026-06-01", units: 100, revenue: 300, grossProfit: 100 },
      { month: "2026-07-01", units: 60, revenue: 180, grossProfit: 60 },
    ],
  }, "2026-07-01");

  assert.equal(recommendation.currentMonthUnits, 60);
  assert.equal(recommendation.currentMonthObservedDays, 15);
  assert.equal(recommendation.projectedCurrentMonthUnits, 124);
  assert.equal(recommendation.remainingProjectedDemandUnits, 64);
  assert.equal(recommendation.targetStockUnits, 84);
  assert.equal(recommendation.suggestedBuyUnits, 72);
  assert.equal(recommendation.recommendedPlanUnits, 102);
  assert.equal(recommendation.remainingPlannedUnits, 72);
  assert.equal(recommendation.remainingBudgetLyd, 144);
  assert.equal(recommendation.recommendedBudgetLyd, 204);
  assert.equal(recommendation.action, "increase");
});

test("late-month current sales and existing storage can reduce suggested buying to zero", () => {
  const recommendation = buildProductPlanningRecommendation({
    productId: "water",
    productName: "Water",
    category: "Water",
    createdAt: "2025-01-01T00:00:00.000Z",
    caseQuantity: 12,
    currentStorageUnits: 24,
    unitCost: 1,
    currentMonthObservedDays: 28,
    currentMonthSalesThrough: "2026-07-28",
    salesMonths: [
      { month: "2026-05-01", units: 95, revenue: 190, grossProfit: 95 },
      { month: "2026-06-01", units: 100, revenue: 200, grossProfit: 100 },
      { month: "2026-07-01", units: 90, revenue: 180, grossProfit: 90 },
    ],
  }, "2026-07-01");

  assert.equal(recommendation.projectedCurrentMonthUnits, 100);
  assert.equal(recommendation.remainingProjectedDemandUnits, 10);
  assert.equal(recommendation.targetStockUnits, 12);
  assert.equal(recommendation.suggestedBuyUnits, 0);
  assert.equal(recommendation.remainingBudgetLyd, 0);
});

test("without current-month coverage the previous completed month remains the fallback", () => {
  const recommendation = buildProductPlanningRecommendation({
    productId: "pepsi",
    productName: "Pepsi",
    category: "Drinks",
    createdAt: "2025-01-01T00:00:00.000Z",
    caseQuantity: 12,
    currentStorageUnits: 20,
    activeMachineCount: 8,
    unitCost: 2,
    purchasedUnitsThisMonth: 30,
    purchasedSpendThisMonth: 60,
    salesMonths: [
      { month: "2026-05-01", units: 60, revenue: 180, grossProfit: 60 },
      { month: "2026-06-01", units: 100, revenue: 300, grossProfit: 100 },
    ],
  }, "2026-07-01");

  assert.equal(recommendation.currentMonthDataAvailable, false);
  assert.equal(recommendation.projectedCurrentMonthUnits, 100);
  assert.equal(recommendation.remainingProjectedDemandUnits, 100);
  assert.equal(recommendation.targetStockUnits, 120);
  assert.equal(recommendation.suggestedBuyUnits, 108);
  assert.equal(recommendation.recommendedPlanUnits, 138);
  assert.equal(recommendation.remainingBudgetLyd, 216);
  assert.equal(recommendation.recommendedBudgetLyd, 276);
});

test("sharp sales decline or excess storage reduces buying", () => {
  const recommendation = buildProductPlanningRecommendation({
    productId: "declining",
    productName: "Declining Product",
    createdAt: "2025-01-01T00:00:00.000Z",
    caseQuantity: 12,
    currentStorageUnits: 120,
    unitCost: 2,
    salesMonths: [
      { month: "2026-05-01", units: 100, revenue: 300, grossProfit: 100 },
      { month: "2026-06-01", units: 40, revenue: 120, grossProfit: 40 },
    ],
  }, "2026-07-01");

  assert.equal(recommendation.action, "reduce");
  assert.equal(recommendation.minimumStockUnits, 40);
  assert.equal(recommendation.suggestedBuyUnits, 0);
});

test("Product Planning page exposes a persistent buy list ordered by monthly sales", () => {
  for (const label of [
    "Product Planning",
    "Current-month demand signal",
    "Sold this month",
    "Storage left",
    "Recommended buy",
    "Buy list quantity",
    "Last purchase cost",
    "Estimated cost",
    "Add to buy list",
    "Save & open buy list",
    "Estimated list cost",
  ]) {
    assert.match(planningPage, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(planningPage, /right\.recommendation\.currentMonthUnits - left\.recommendation\.currentMonthUnits/);
  assert.match(planningPage, /params\.view === "buy-list"/);
  assert.match(planningPage, /plan_status: selectedForBuyList \?/);
  assert.match(planningPage, /planned_units: purchasedUnits \+ \(selectedForBuyList \? buyQuantity : 0\)/);
  assert.match(planningPage, /last_purchase_cost_lyd, average_cost_lyd, last_purchase_date/);
  assert.match(planningPage, /\[&_\.data-table_th\]:sticky/);
  assert.match(planningPage, /BuyListLiveSummary/);
  assert.match(buyListSummary, /Live estimated total/);
  assert.match(buyListSummary, /data-buy-list-checkbox/);
  assert.match(buyListSummary, /quantity \* unitCost/);
  assert.match(planningPage, /\.lte\("business_month", planningMonth\)/);
  assert.match(planningPage, /\.lte\("sales_month", planningMonth\)/);
  assert.match(planningHelper, /New product — keep testing/);
  assert.match(moduleTabs, /label:\s*"Product Planning",\s*href:\s*"\/product-planning"/);
  assert.match(authz, /matchesPrefix\(pathname, \["\/product-planning"\]\)/);
});

test("inventory and route pickup use case_quantity packaging displays", () => {
  assert.match(inventoryPage, /formatProductQuantity/);
  assert.match(inventoryPage, /case_quantity/);
  assert.match(inventoryPage, /packagedQuantity\(row\.currentQty/);
  assert.match(inventoryPage, /packagedQuantity\(row\.quantity_on_hand/);
  assert.match(inventoryPage, /packagedQuantity\(movement\.quantity/);

  assert.match(pickupApi, /case_quantity/);
  assert.match(pickupApi, /caseQuantity:\s*Math\.max\(1, unitQuantity\(product\.case_quantity/);
  assert.match(pickupPage, /caseQuantity:\s*Math\.max\(1, Number\(item\.case_quantity/);
  assert.match(pickupPage, /formatProductQuantity\(item\.requestedQty/);
  assert.match(pickupPage, /formatProductQuantity\(item\.confirmedQty/);
  assert.match(pickupPage, /formatProductQuantity\(item\.quantity/);
  assert.match(pickupPage, /formatProductQuantity\(quantity/);
  assert.match(pickupPage, /formatProductQuantity\(selected\.availableStorageQty/);
});

test("monthly plan migration is additive and uniquely identifies product plans", () => {
  assert.match(migration, /create table if not exists public\.product_monthly_purchase_plans/i);
  assert.match(migration, /unique \(planning_month, product_id\)/i);
  assert.match(migration, /planned_units integer/i);
  assert.match(migration, /planned_budget_lyd numeric/i);
  assert.match(migration, /select pg_notify\('pgrst', 'reload schema'\)/i);
  assert.doesNotMatch(migration, /drop\s+(table|column|schema)|truncate|delete\s+from|cascade|db reset/i);
});
