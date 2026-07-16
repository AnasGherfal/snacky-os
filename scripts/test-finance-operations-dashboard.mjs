import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const helperSource = fs.readFileSync(path.join(repoRoot, "src/lib/finance-operations.ts"), "utf8");
const pageSource = fs.readFileSync(path.join(repoRoot, "src/app/finance/operations/page.tsx"), "utf8");
const tabSource = fs.readFileSync(path.join(repoRoot, "src/components/module-tabs-config.ts"), "utf8");

test("Finance module exposes the Operations dashboard", () => {
  assert.match(tabSource, /label:\s*"Operations",\s*href:\s*"\/finance\/operations"/);
});

test("dashboard exposes counted cash, VMS, machine, expense, rent, and purchasing controls", () => {
  for (const label of [
    "Actual counted cash",
    "Recorded VMS expected cash",
    "Machine cash reconciliation",
    "Expenses by category",
    "Rent by site",
    "Recent product buying",
    "Posted cash in finance",
    "Operating result",
  ]) {
    assert.match(pageSource, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("counted cash is grouped by counted date and pending cash by collected date", () => {
  assert.match(pageSource, /\.not\("counted_at",\s*"is",\s*null\)/);
  assert.match(pageSource, /\.gte\("counted_at",\s*startTimestamp\)/);
  assert.match(pageSource, /\.lte\("counted_at",\s*endTimestamp\)/);
  assert.match(pageSource, /\.in\("review_status",\s*\["pending_collection",\s*"collected_pending_count"\]\)/);
});

test("product purchases remain separate from operating expenses", () => {
  assert.match(helperSource, /isProductPurchase:\s*Boolean\(rule\.productPurchase\)/);
  assert.match(helperSource, /isOperatingExpense:\s*!rule\.productPurchase/);
  assert.match(helperSource, /productPurchases:\s*roundMoney\(categories\.filter\(\(row\)\s*=>\s*row\.isProductPurchase\)/);
  assert.match(helperSource, /operatingExpenses:\s*roundMoney\(categories\.filter\(\(row\)\s*=>\s*row\.isOperatingExpense\)/);
  assert.match(pageSource, /vmsGrossProfit\s*-\s*expenses\.operatingExpenses/);
  assert.doesNotMatch(pageSource, /vmsGrossProfit\s*-\s*expenses\.operatingExpenses\s*-\s*expenses\.productPurchases/);
});

test("owner funding, opening balances, and internal transfers are excluded from expenses", () => {
  assert.match(helperSource, /"owner funding"/);
  assert.match(helperSource, /"owner withdrawal"/);
  assert.match(helperSource, /"opening balance"/);
  assert.match(helperSource, /"internal transfer"/);
  assert.match(helperSource, /NON_OPERATING_CATEGORY_TOKENS\.some/);
});

test("machine reconciliation shows VMS sales separately from counted cash", () => {
  assert.match(helperSource, /vmsSalesAmount/);
  assert.match(helperSource, /expectedCash/);
  assert.match(helperSource, /countedCash/);
  assert.match(helperSource, /calculatedVariance:\s*roundMoney\(row\.countedCash\s*-\s*row\.expectedCash\)/);
  assert.match(pageSource, /VMS sales is shown as full machine revenue/);
});

test("VMS cash comparison is only displayed when payment split is available", () => {
  assert.match(pageSource, /paymentSplitAvailable/);
  assert.match(pageSource, /Period cash vs VMS cash/);
  assert.match(pageSource, /This source does not separate cash and card sales/);
});

test("dashboard uses existing data sources without destructive schema operations", () => {
  assert.match(pageSource, /cash_collections/);
  assert.match(pageSource, /financial_transactions|FINANCE_TRANSACTIONS_TABLE/);
  assert.match(pageSource, /sales_dashboard_monthly_summary|sales_dashboard_summary/);
  assert.doesNotMatch(`${pageSource}\n${helperSource}`, /\b(drop|truncate|delete\s+from|cascade|db reset)\b/i);
});
