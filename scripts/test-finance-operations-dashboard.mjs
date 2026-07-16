import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const helperSource = fs.readFileSync(path.join(repoRoot, "src/lib/finance-operations.ts"), "utf8");
const monthlyCloseSource = fs.readFileSync(path.join(repoRoot, "src/lib/monthly-cash-close.ts"), "utf8");
const pageSource = fs.readFileSync(path.join(repoRoot, "src/app/finance/operations/page.tsx"), "utf8");
const tabSource = fs.readFileSync(path.join(repoRoot, "src/components/module-tabs-config.ts"), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Finance module exposes the Operations dashboard", () => {
  assert.match(tabSource, /label:\s*"Operations",\s*href:\s*"\/finance\/operations"/);
});

test("dashboard exposes monthly cash close, machine, expense, rent, and purchasing controls", () => {
  for (const label of [
    "Cash counted for selected month",
    "Monthly VMS expected cash",
    "Monthly shortage / overage",
    "Monthly cash accuracy",
    "Machine cash reconciliation",
    "Expenses by category",
    "Rent by site",
    "Recent product buying",
    "Posted cash in finance",
    "Operating result",
  ]) {
    assert.match(pageSource, new RegExp(escapeRegExp(label)));
  }
});

test("counted cash is grouped by cash-removal date and pending cash by collected date", () => {
  assert.match(pageSource, /\.not\("counted_at",\s*"is",\s*null\)/);
  assert.match(pageSource, /\.gte\("collected_at",\s*startTimestamp\)/);
  assert.match(pageSource, /\.lte\("collected_at",\s*endTimestamp\)/);
  assert.doesNotMatch(pageSource, /\.gte\("counted_at",\s*startTimestamp\)/);
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

test("machine reconciliation adds pickups and compares at the monthly level", () => {
  assert.match(helperSource, /vmsSalesAmount/);
  assert.match(helperSource, /countedCash/);
  assert.match(pageSource, /monthlyExpectedCash/);
  assert.match(pageSource, /monthlyVariance/);
  assert.match(pageSource, /monthlyAccuracy/);
  assert.match(pageSource, /All pickups counted during the selected month are added per machine/);
});

test("monthly expectation uses VMS cash split or an explicit cash-only fallback", () => {
  assert.match(monthlyCloseSource, /vms_cash_split/);
  assert.match(monthlyCloseSource, /cash_only_total_sales/);
  assert.match(pageSource, /Cash-only assumption/);
  assert.match(pageSource, /report has no payment split, so monthly total sales are treated as expected cash/);
});

test("open months remain provisional until final machine cash is removed", () => {
  assert.match(monthlyCloseSource, /isCompleteClosedMonthRange/);
  assert.match(pageSource, /provisional until the month is fully closed/i);
  assert.match(pageSource, /provisional month/);
});

test("dashboard uses existing data sources without destructive schema operations", () => {
  assert.match(pageSource, /cash_collections/);
  assert.match(pageSource, /financial_transactions|FINANCE_TRANSACTIONS_TABLE/);
  assert.match(pageSource, /sales_dashboard_monthly_summary|sales_dashboard_summary/);
  assert.doesNotMatch(`${pageSource}\n${helperSource}\n${monthlyCloseSource}`, /\b(drop|truncate|delete\s+from|cascade|db reset)\b/i);
});
