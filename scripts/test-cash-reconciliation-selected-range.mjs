import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const page = fs.readFileSync(path.join(root, "src/app/reports/cash-reconciliation/page.tsx"), "utf8");

test("selected duration uses the same Finance LYD In ledger source as Finance", () => {
  assert.match(page, /FINANCE_TRANSACTIONS_TABLE/);
  assert.match(page, /loadFinanceLedgerRows/);
  assert.match(page, /applyVisibleFinanceLedgerFilter/);
  assert.match(page, /isFinanceLedgerTransaction\(row,\s*financeCutoffDate\)/);
  assert.match(page, /financeCashRowsInRange/);
  assert.match(page, /sumFinanceRows\(financeCashRows,\s*"LYD",\s*"money_in"\)/);
  assert.match(page, /row\.transaction_date < range\.start/);
  assert.match(page, /row\.transaction_date > range\.end/);
  assert.doesNotMatch(page, /cash_reconciliation_summary/);
  assert.doesNotMatch(page, /cash_reconciliation_breakdown/);
});

test("counted machine cash belongs to the physical collection date, not the later office count date", () => {
  const helperStart = page.indexOf("function applyCountedCollectionRange");
  const helperEnd = page.indexOf("function applyCollectedAtRange", helperStart);
  const helper = page.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /\.not\("counted_at", "is", null\)/);
  assert.match(helper, /\.not\("actual_cash_collected", "is", null\)/);
  assert.match(helper, /\.gte\("collected_at",/);
  assert.match(helper, /\.lt\("collected_at",/);
  assert.doesNotMatch(helper, /\.gte\("counted_at",/);
  assert.doesNotMatch(helper, /\.lt\("counted_at",/);
  assert.match(page, /selectedCashQuery = applyCountedCollectionRange/);
  assert.match(page, /comparisonCashQuery[\s\S]*applyCountedCollectionRange/);
});

test("VMS summary and breakdown receive the selected range", () => {
  assert.match(page, /sales_dashboard_monthly_summary/);
  assert.match(page, /sales_dashboard_summary/);
  assert.match(page, /p_date_from:\s*selectedSalesRange\.start/);
  assert.match(page, /p_date_to:\s*selectedSalesRange\.end/);
  assert.match(page, /p_dimension:\s*"machine"/);
  assert.match(page, /p_dimension:\s*"month"/);
});

test("headline reconciliation is VMS sales versus cash counted", () => {
  assert.match(page, /VMS sales \/ مبيعات VMS/);
  assert.match(page, /Cash removed and counted \/ الكاش المسحوب والمعدود/);
  assert.match(page, /Cash removed minus VMS sales/);
  assert.match(page, /assigned by the pickup&apos;s collection date/);
  assert.match(page, /varianceAmount:\s*roundMoney\(cashCountedAmount - vmsSalesAmount\)/);
  assert.match(page, /accuracy:\s*vmsSalesAmount > 0 \? cashCountedAmount \/ vmsSalesAmount : null/);
});

test("machine table explicitly identifies expected, counted, and difference by machine", () => {
  assert.match(page, /buildMachineCashReconciliation/);
  assert.match(page, /Cash position by machine/);
  assert.match(page, /VMS sales for selected range/);
  assert.match(page, /Cash removed in selected range/);
  assert.match(page, /Period cash position/);
  assert.match(page, /Pickups removed/);
  assert.match(page, /Latest office count/);
  assert.match(page, /rangeVariance:\s*roundMoney\(row\.countedCash - row\.vmsSalesAmount\)/);
  assert.match(page, /financeToMachineDifference/);
  assert.match(page, /not mapped through machine cash-collection records/);
});

test("period balance is not presented as a confirmed cash shortage", () => {
  assert.match(page, /A negative value is not a confirmed shortage/);
  assert.match(page, /variance < -10\) return "cash remaining"/);
  assert.match(page, /variance > 10\) return "includes earlier cash"/);
  assert.doesNotMatch(page, /return "variance review"/);
});

test("machines are sorted by largest absolute difference and unmatched rows are visible", () => {
  assert.match(page, /Math\.abs\(right\.rangeVariance\) - Math\.abs\(left\.rangeVariance\)/);
  assert.match(page, /Unmatched VMS\/cash machine — fix mapping/);
});

test("pending cash stays separate from counted totals", () => {
  assert.match(page, /\.in\("review_status", \["pending_collection", "collected_pending_count"\]\)/);
  assert.match(page, /Removed in this period but not counted; excluded from counted cash/);
});

test("change is read-only and does not touch route or pickup workflows", () => {
  assert.doesNotMatch(page, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  assert.doesNotMatch(page, /snacky_confirm_route_pickup|completeStop|inventory_movements/);
});


test("custom ranges recover VMS totals by combining working month selections", () => {
  assert.match(page, /loadMonthlyVmsRangeByMonth/);
  assert.match(page, /selectedRange\.key === "custom"/);
  assert.match(page, /calendarMonthRanges/);
  assert.match(page, /sales_dashboard_monthly_summary/);
  assert.match(page, /combined by calendar month/);
  assert.match(page, /same finalized monthly VMS records that appear when each month is selected separately/);
});

test("shows the selected-period cash estimated to remain inside machines", () => {
  assert.match(page, /estimatedCashStillInMachines/);
  assert.match(page, /expectedMachineCashAmount/);
  assert.match(page, /VMS cash expected minus cash removed from machines in the same collection-date range/);
  assert.match(page, /Estimated still in machine/);
  assert.match(page, /Card sales are excluded when VMS payment methods are available/);
});

test("daily and monthly cash breakdowns use Finance transaction dates", () => {
  assert.match(page, /timeBucketFromFinance/);
  assert.match(page, /row\.transaction_date/);
  assert.match(page, /mergeTimeBreakdown\(selectedVmsDayRows,\s*selectedFinanceCashRows,\s*"day"\)/);
  assert.match(page, /mergeTimeBreakdown\(selectedVmsMonthRows,\s*selectedFinanceCashRows,\s*"month"\)/);
});

test("cash-in-machines estimate is read-only and never becomes negative", () => {
  assert.match(page, /Math\.max\(0, unboundedCashBalance\)/);
  assert.match(page, /Math\.max\(0, roundMoney\(row\.vmsSalesAmount - row\.countedCash\)\)/);
  assert.doesNotMatch(page, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});
