import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const migration = await readFile(
  new URL("../supabase/migrations/202608260003_anonymous_table_exposure_hardening.sql", import.meta.url),
  "utf8",
);

const internalTables = [
  "cash_collections",
  "finance_categories",
  "finance_import_batches",
  "finance_import_rows",
  "finance_opening_balances",
  "finance_settings",
  "historical_route_deduction_batches",
  "historical_route_deduction_lines",
  "issues",
  "locations",
  "machine_aliases",
  "machine_refill_history",
  "machine_slots",
  "machines",
  "product_aliases",
  "receipt_scan_results",
  "route_pick_adjustments",
  "route_stop_fill_lines",
  "system_activity_logs",
  "team_members",
  "vms_machine_aliases",
  "vms_machine_status_snapshots",
  "vms_product_catalog_snapshots",
  "vms_sales_snapshots",
  "vms_stock_snapshots",
  "vms_sync_runs",
];

test("all remaining legacy internal tables are covered", () => {
  assert.equal(internalTables.length, 26);
  for (const table of internalTables) assert.match(migration, new RegExp(`'${table}'`));
});

test("anonymous access is removed without changing signed-in privileges", () => {
  assert.match(migration, /revoke all on table public\.%I from public, anon/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.%I to authenticated/i);
});

test("future tables do not inherit anonymous grants", () => {
  assert.match(migration, /alter default privileges for role postgres in schema public[\s\S]*revoke all on tables from public, anon/i);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

test("bare public Supabase clients are limited to auth bootstrap", async () => {
  const files = await sourceFiles(path.join(root, "src"));
  const matches = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes("getSupabaseServerClient()")) {
      matches.push(path.relative(root, file).replaceAll(path.sep, "/"));
    }
  }
  assert.deepEqual(matches.sort(), ["src/app/login/page.tsx", "src/lib/auth.ts"]);
});
