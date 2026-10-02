import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "src/app/dashboard/page.tsx"), "utf8");

test("dashboard MTD revenue uses the monthly-profit summary RPC", () => {
  assert.match(source, /sales_dashboard_monthly_summary current month/);
  assert.match(source, /supabase\.rpc\("sales_dashboard_monthly_summary", \{[\s\S]*p_date_from: monthStart,[\s\S]*p_date_to: today/);
  assert.doesNotMatch(source, /\.from\("kpi_machine_daily"\)/);
});

test("dashboard revenue coverage comes from the active monthly profit batch only", () => {
  assert.match(source, /reportTypes: \["vms_order_details_weekly", "monthly_product_profit", "sales", "stock", "machine_stock_snapshot", "planogram"\]/);
  assert.match(source, /batch\.report_type === "monthly_product_profit" && isActiveImportedVmsBatch\(batch\)/);
  assert.match(source, /monthlyRevenueReportEnd/);
});

test("dashboard labels monthly revenue honestly instead of presenting it as today's sales", () => {
  assert.match(source, /label=\{localize\("Sales MTD", "مبيعات الشهر حتى الآن"\)\}/);
  assert.match(source, /Revenue report through/);
  assert.doesNotMatch(source, /label=\{t\("Sales today"\)\}/);
  assert.match(source, /Today\/week sales detail is unavailable until an active Order Details file is imported/);
});
