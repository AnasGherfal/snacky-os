import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../supabase/migrations/202608260002_security_invoker_view_hardening.sql", import.meta.url);
const migration = await readFile(migrationPath, "utf8");

const protectedViews = [
  "machine_refill_history_metrics",
  "machine_refill_history_monthly",
  "finance_import_clarification_groups",
  "finance_account_balance_impacts",
  "finance_account_balances",
  "product_reporting_costs",
  "operator_money_balances",
  "current_inventory_by_location",
  "kpi_machine_daily",
  "kpi_machine_monthly",
  "kpi_product_daily",
  "kpi_product_monthly",
  "kpi_location_monthly",
  "location_leads",
  "location_payroll_distances",
  "vms_sales_dashboard_clean",
  "vms_transaction_status_daily",
  "vms_transaction_status_monthly",
  "latest_vms_stock_by_slot",
  "refill_recommendations",
  "vms_sales_clean_legacy_202606060001",
];

test("all Security Advisor views are included", () => {
  for (const view of protectedViews) assert.match(migration, new RegExp(`'${view}'`));
});

test("views use caller privileges and cannot be read anonymously", () => {
  assert.match(migration, /alter view public\.%I set \(security_invoker = true\)/i);
  assert.match(migration, /revoke all on table public\.%I from public, anon/i);
  assert.match(migration, /grant select on table public\.%I to authenticated, service_role/i);
});

test("migration is resilient to missing or materialized views", () => {
  assert.match(migration, /c\.relkind in \('v', 'm'\)/i);
  assert.match(migration, /c\.relkind = 'v'/i);
});
