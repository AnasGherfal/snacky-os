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
  assert.match(page, /varianceAmount:\s*roundMoney\(cashCountedAmount - vmsSalesAmount\)/);
  assert.match(page, /accuracy:\s*vmsSalesAmount > 0 \? cashCountedAmount \/ vmsSalesAmount : null/);
});

test("machine table compares the same two sources", () => {
  assert.match(page, /buildMachineCashReconciliation/);
  assert.match(page, /rangeVariance:\s*roundMoney\(row\.countedCash - row\.vmsSalesAmount\)/);
  assert.match(page, /headers=\{\["Machine", "Location", "VMS sales", "Units", "Cash counted", "Difference"/);
});

test("pending cash stays separate from counted totals", () => {
  assert.match(page, /\.in\("review_status", \["pending_collection", "collected_pending_count"\]\)/);
  assert.match(page, /Removed in this period but not counted; excluded from counted cash/);
});

test("change is read-only and does not touch route or pickup workflows", () => {
  assert.doesNotMatch(page, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  assert.doesNotMatch(page, /snacky_confirm_route_pickup|completeStop|inventory_movements/);
});
