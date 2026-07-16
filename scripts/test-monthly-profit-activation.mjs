import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const activation = read("src/lib/vms-monthly-profit-activation.ts");
const action = read("src/lib/vms-monthly-profit-actions.ts");
const repairPage = read("src/app/vms-import/monthly-profit-repair/page.tsx");
const moduleTabs = read("src/components/module-tabs-config.ts");
const migration = read("supabase/migrations/202607160002_monthly_profit_batch_activation.sql");

test("manual repair verifies persisted monthly profit rows before changing batch state", () => {
  assert.match(activation, /from\("vms_monthly_product_profit"\)/);
  assert.match(activation, /eq\("import_batch_id", cleanBatchId\)/);
  assert.match(activation, /NO_MONTHLY_ROWS/);
  assert.match(activation, /no saved Monthly Product Profit rows to activate/i);
});

test("manual repair writes and verifies usable batch metadata", () => {
  assert.match(activation, /status:\s*"imported"/);
  assert.match(activation, /is_active:\s*true/);
  assert.match(activation, /rows_imported:\s*persistedRowCount/);
  assert.match(activation, /report_start_date:\s*reportStartDate/);
  assert.match(activation, /report_end_date:\s*reportEndDate/);
  assert.match(activation, /select\("id, status, is_active, rows_imported, report_start_date, report_end_date"\)/);
});

test("manual repair replaces older active partial uploads only for the same month", () => {
  assert.match(activation, /monthlyProfitBatchMonth\(row\) === businessMonth/);
  assert.match(activation, /deactivatedBatchIds/);
  assert.match(activation, /update\(\{ is_active: false/);
  assert.match(activation, /older partial uploads for the same month could not be disabled safely/i);
});

test("database trigger automatically activates saved monthly profit rows", () => {
  assert.match(migration, /snacky_activate_monthly_profit_batch_from_rows/);
  assert.match(migration, /after insert on public\.vms_monthly_product_profit/i);
  assert.match(migration, /after update on public\.vms_monthly_product_profit/i);
  assert.match(migration, /referencing new table as new_rows/i);
  assert.match(migration, /perform public\.snacky_refresh_monthly_profit_batch_activation/i);
});

test("automatic activation keeps one latest source per business month", () => {
  assert.match(migration, /partition by stats\.business_month/i);
  assert.match(migration, /stats\.report_end_date desc nulls last/i);
  assert.match(migration, /is_active = ranked\.activation_rank = 1/i);
  assert.match(migration, /where stats\.business_month = p_business_month/i);
  assert.match(migration, /batches\.disabled_at is null/i);
});

test("migration repairs existing inactive batches immediately", () => {
  assert.match(migration, /Repair existing Monthly Product Profit rows immediately/i);
  assert.match(migration, /select distinct\s+coalesce\(rows\.business_month/i);
  assert.match(migration, /perform public\.snacky_refresh_monthly_profit_batch_activation\(v_business_month\)/i);
});

test("repair screen exposes verified activation and refreshes Product Planning", () => {
  assert.match(repairPage, /Monthly Product Profit Activation/);
  assert.match(repairPage, /activateMonthlyProfitImportBatch/);
  assert.match(repairPage, /Activate saved rows/);
  assert.match(repairPage, /savedRows > 0/);
  assert.match(action, /ensureMonthlyProfitBatchActivated/);
  assert.match(action, /revalidatePath\("\/product-planning"\)/);
  assert.match(moduleTabs, /Monthly Profit Activation/);
});

test("repair is non-destructive to monthly profit data", () => {
  for (const source of [activation, action, repairPage, migration]) {
    assert.doesNotMatch(source, /from\("vms_monthly_product_profit"\)\s*\.delete|delete\s+from\s+public\.vms_monthly_product_profit|truncate\s+table\s+public\.vms_monthly_product_profit|drop\s+table\s+public\.vms_monthly_product_profit/is);
  }
});
