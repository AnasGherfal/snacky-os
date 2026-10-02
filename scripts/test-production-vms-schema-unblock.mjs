import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const prepMigration = readFileSync(
  new URL("../supabase/migrations/202606060000_vms_sales_clean_view_compatibility.sql", import.meta.url),
  "utf8",
);
const blockedMigration = readFileSync(
  new URL("../supabase/migrations/202606060001_vms_import_status_sources.sql", import.meta.url),
  "utf8",
);
const monthlyProfitMigration = readFileSync(
  new URL("../supabase/migrations/202606240002_monthly_product_profit_report.sql", import.meta.url),
  "utf8",
);

test("compatibility migration safely frees the vms_sales_clean name", () => {
  assert.match(prepMigration, /alter view public\.vms_sales_clean\s+rename to vms_sales_clean_legacy_202606060001/i);
  assert.doesNotMatch(prepMigration, /drop\s+(table|column|schema)|truncate|delete\s+from|cascade/i);
});

test("blocked migration recreates the canonical sales view and normalizes legacy statuses", () => {
  assert.match(blockedMigration, /create or replace view public\.vms_sales_clean/i);
  assert.match(blockedMigration, /when 'completed' then 'imported'/i);
  assert.match(blockedMigration, /when 'completed_with_warnings' then 'imported_with_warnings'/i);
});

test("later migration creates the monthly report storage and dashboard RPCs", () => {
  assert.match(monthlyProfitMigration, /create table if not exists public\.vms_monthly_product_profit/i);
  assert.match(monthlyProfitMigration, /create or replace function public\.sales_dashboard_monthly_summary/i);
  assert.match(monthlyProfitMigration, /create or replace function public\.sales_dashboard_monthly_breakdown/i);
  assert.match(monthlyProfitMigration, /create or replace function public\.sales_dashboard_monthly_profit_breakdown/i);
});
