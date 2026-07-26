import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const page = fs.readFileSync(path.join(root, "src/app/reports/cash-reconciliation/page.tsx"), "utf8");

test("selected duration filters physical cash by counted_at", () => {
  assert.match(page, /\.not\("counted_at",\s*"is",\s*null\)/);
  assert.match(page, /\.gte\("counted_at",\s*`\$\{range\.start\}T00:00:00\.000Z`\)/);
  assert.match(page, /\.lt\("counted_at",\s*`\$\{shiftIsoDate\(range\.end, 1\)\}T00:00:00\.000Z`\)/);
  assert.doesNotMatch(page, /cash_reconciliation_summary/);
  assert.doesNotMatch(page, /cash_reconciliation_breakdown/);
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
  assert.match(page, /Cash counted \/ الكاش المعدود/);
  assert.match(page, /Cash counted minus VMS sales/);
  assert.match(page, /See exactly which machines below/);
  assert.match(page, /varianceAmount:\s*roundMoney\(cashCountedAmount - vmsSalesAmount\)/);
  assert.match(page, /accuracy:\s*vmsSalesAmount > 0 \? cashCountedAmount \/ vmsSalesAmount : null/);
});

test("machine table explicitly identifies expected, counted, and difference by machine", () => {
  assert.match(page, /buildMachineCashReconciliation/);
  assert.match(page, /Which machine has the difference\?/);
  assert.match(page, /VMS expected sales for machine/);
  assert.match(page, /Cash counted for machine/);
  assert.match(page, /Difference for machine/);
  assert.match(page, /Counted pickups/);
  assert.match(page, /Latest finance count/);
  assert.match(page, /rangeVariance:\s*roundMoney\(row\.countedCash - row\.vmsSalesAmount\)/);
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
  assert.match(page, /VMS cash expected minus cash counted in Finance/);
  assert.match(page, /Estimated still in machine/);
  assert.match(page, /Card sales are excluded when VMS payment methods are available/);
});

test("cash-in-machines estimate is read-only and never becomes negative", () => {
  assert.match(page, /Math\.max\(0, unboundedCashBalance\)/);
  assert.match(page, /Math\.max\(0, roundMoney\(row\.vmsSalesAmount - row\.countedCash\)\)/);
  assert.doesNotMatch(page, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});
