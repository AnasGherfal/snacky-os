import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const migrationName = fs
  .readdirSync(migrationsDir)
  .find((name) => name.endsWith("_role_based_rls_internal_tables.sql"));

assert.ok(migrationName, "role-based internal-table RLS migration is missing");
const migration = fs.readFileSync(path.join(migrationsDir, migrationName), "utf8");
const operatorActions = fs.readFileSync(path.join(root, "src", "lib", "operator-actions.ts"), "utf8");
const completeStopAction = operatorActions.slice(
  operatorActions.indexOf("export async function completeStop("),
  operatorActions.indexOf("export async function finalizeRouteInventory("),
);

const financeTables = [
  "cash_collections",
  "finance_categories",
  "finance_import_batches",
  "finance_import_rows",
  "finance_opening_balances",
  "finance_settings",
];

test("finance and cash tables are RLS protected by finance-capable roles", () => {
  for (const table of financeTables) assert.match(migration, new RegExp(`'${table}'`));
  for (const role of ["owner", "admin", "supervisor", "finance"]) {
    assert.match(migration, new RegExp(`''${role}''|'${role}'`));
  }
  assert.match(migration, /alter table public\.%I enable row level security/);
  assert.doesNotMatch(migration, /array\[[^\]]*'operator'[^\]]*\][\s\S]{0,160}finance_access/);
});

test("authorized route completion writes cash through the protected server client", () => {
  assert.match(completeStopAction, /const completionWorkflowClient = getSupabaseAdminClient\(\)/);
  assert.match(completeStopAction, /if \(!completionWorkflowClient\) \{[\s\S]*?protected stop-completion workflow is not configured/);
  assert.doesNotMatch(completeStopAction, /getSupabaseAdminClient\(\) \?\? supabase/);
  assert.match(completeStopAction, /completionWorkflowClient\s*\n\s*\.from\("vms_sales_snapshots"\)/);
  assert.match(completeStopAction, /completionWorkflowClient\s*\n\s*\.from\("cash_collections"\)/);
});

test("team members preserve self read and restrict mutations to owner/admin", () => {
  assert.match(migration, /drop policy if exists "snacky_team_members_self_read"/);
  assert.match(migration, /snacky_team_members_business_read/);
  assert.match(migration, /auth_user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /id = \(select public\.snacky_current_team_member_id\(\)\)/);
  assert.match(migration, /snacky_team_members_owner_admin_insert/);
  assert.match(migration, /snacky_team_members_owner_admin_update/);
  assert.match(migration, /snacky_team_members_owner_admin_delete/);
});

test("activity history is owner/admin read-only for authenticated clients", () => {
  assert.match(migration, /grant select on table public\.system_activity_logs to authenticated/);
  assert.match(migration, /snacky_system_activity_logs_owner_admin_read/);
  assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete|all)[^;]*system_activity_logs[^;]*authenticated/i);
});

test("receipt and historical recovery data have scoped business roles", () => {
  assert.match(migration, /snacky_receipt_scan_results_purchase_access/);
  for (const role of ["warehouse", "purchasing"]) assert.match(migration, new RegExp(`'${role}'`));
  assert.match(migration, /historical_route_deduction_batches/);
  assert.match(migration, /historical_route_deduction_lines/);
  assert.match(migration, /owner_admin_access/);
});

test("migration never creates an unrestricted authenticated policy", () => {
  assert.doesNotMatch(migration, /to authenticated\s+(?:using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\))/i);
  assert.doesNotMatch(migration, /disable row level security/i);
});
