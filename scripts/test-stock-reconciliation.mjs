import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/202607170001_stock_reconciliation_missing_items.sql");
const page = read("src/app/inventory/reconciliation/page.tsx");
const helper = read("src/lib/stock-reconciliation.ts");
const tabs = read("src/components/module-tabs-config.ts");

test("migration adds checkpoint, count, and variance-case tables", () => {
  assert.match(migration, /create table if not exists public\.stock_reconciliation_sessions/i);
  assert.match(migration, /create table if not exists public\.stock_reconciliation_counts/i);
  assert.match(migration, /create table if not exists public\.stock_reconciliation_variance_cases/i);
  assert.match(migration, /unique \(session_id, count_phase, entity_type, entity_key, product_id\)/i);
});

test("company reconciliation uses opening plus external inflows minus sales and losses", () => {
  assert.match(migration, /opening_units/i);
  assert.match(migration, /purchased_units/i);
  assert.match(migration, /other_inflow_units/i);
  assert.match(migration, /sold_units/i);
  assert.match(migration, /recorded_loss_units/i);
  assert.match(migration, /expected_closing_units/i);
  assert.match(migration, /actual_closing_units - calculated\.expected_closing_units/i);
  assert.match(migration, /greatest\(calculated\.expected_closing_units - calculated\.actual_closing_units, 0\)/i);
});

test("internal transfers do not create company purchases or losses", () => {
  assert.match(migration, /from_entity_type::text = 'supplier'/i);
  assert.match(migration, /to_entity_type::text in \('storage', 'operator_bag', 'machine'\)/i);
  assert.match(migration, /from_entity_type::text in \('storage', 'operator_bag', 'machine'\)/i);
  assert.match(migration, /to_entity_type::text not in \('storage', 'operator_bag', 'machine'\)/i);
});

test("sales source selection prevents double counting", () => {
  assert.match(migration, /monthly_product_profit/i);
  assert.match(migration, /detailed_transactions/i);
  assert.match(migration, /where mode\.sales_source = 'monthly_product_profit'/i);
  assert.match(migration, /where mode\.sales_source = 'detailed_transactions'/i);
});

test("date-misaligned checkpoints cannot become fake missing stock", () => {
  assert.match(migration, /sales_coverage_end/i);
  assert.match(migration, /baseline_misaligned/i);
  assert.match(migration, /closing_misaligned/i);
  assert.match(migration, /when calculated\.baseline_misaligned or calculated\.closing_misaligned then 'data_gap'/i);
  assert.match(migration, /when calculated\.sales_coverage_end < calculated\.period_end then 'suspected'/i);
  assert.match(migration, /case when rows\.confidence = 'data_gap' then 0 else rows\.missing_units end as missing_units/i);
  assert.match(migration, /case when rows\.confidence = 'data_gap' then 0 else \(rows\.missing_units \* rows\.unit_cost\)::numeric end as missing_cost/i);
  assert.match(page, /now\.getUTCDate\(\) - 1/);
  assert.match(page, /excluded from missing-unit and missing-cost totals/i);
});

test("variance results order by output aliases that exist in the final select", () => {
  assert.doesNotMatch(migration, /order by rows\.missing_cost/i);
  assert.match(migration, /order by missing_cost desc, missing_units desc, rows\.product_name/i);
});

test("page exposes baseline, closing capture, physical counts, and variance cases", () => {
  for (const text of [
    "Missing Items & Stock Reconciliation",
    "Create opening baseline",
    "Capture latest closing stock",
    "Physical opening baseline",
    "Physical closing counts",
    "Variance cases",
    "Missing cost",
    "audit trail",
  ]) {
    assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(page, /snacky_create_stock_reconciliation_session/);
  assert.match(page, /snacky_capture_stock_reconciliation_closing/);
  assert.match(page, /snacky_stock_reconciliation_variance/);
  assert.match(page, /count_source:\s*"manual"/);
  assert.match(page, /is_confirmed:\s*true/);
  assert.match(page, /name="count_phase" value="opening"/);
  assert.match(page, /name="count_phase" value="closing"/);
});

test("status helper distinguishes confirmed, suspected, gap, extra, and balanced", () => {
  for (const status of ["confirmed_missing", "suspected_missing", "data_gap", "extra_found", "balanced"]) {
    assert.match(helper, new RegExp(status));
  }
  for (const label of ["Confirmed missing", "Suspected missing", "Data gap", "Extra found", "Balanced"]) {
    assert.match(helper, new RegExp(label, "i"));
  }
});

test("inventory navigation includes Missing Items", () => {
  assert.match(tabs, /label:\s*"Missing Items",\s*href:\s*"\/inventory\/reconciliation"/);
});

test("feature never auto-adjusts or deletes operational inventory data", () => {
  for (const source of [migration, page]) {
    assert.doesNotMatch(source, /truncate\s+table|drop\s+table\s+public\.(inventory_movements|products|vms_)|delete\s+from\s+public\.(inventory_movements|vms_|products)/i);
  }
  assert.doesNotMatch(page, /from\("inventory_movements"\)\.delete|from\("products"\)\.delete|stock_count_adjustment.*insert/i);
});
