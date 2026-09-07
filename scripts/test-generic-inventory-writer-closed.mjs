import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const closure = read("supabase/migrations/20260906155700_close_generic_inventory_writer.sql").replace(/\s+/g, " ");
const adjustmentMigration = read("supabase/migrations/20260905094500_inventory_movement_idempotency_constraint.sql").replace(/\s+/g, " ");
const inventoryActions = read("src/lib/inventory-actions.ts");
const authz = read("src/lib/authz.ts");
const movementForm = read("src/components/StockMovementForm.tsx");
const movementPage = read("src/app/inventory/movements/new/page.tsx");

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

test("the generic parentless movement RPC is closed to every API role", () => {
  assert.match(
    closure,
    /revoke all on function public\.snacky_create_stock_movement_v1\([\s\S]*?\) from public, anon, authenticated, service_role/i,
  );
  assert.match(closure, /revoke all on table public\.inventory_movements from service_role/i);
  assert.match(closure, /grant select on table public\.inventory_movements to service_role/i);
  assert.doesNotMatch(
    closure,
    /grant (?:all|insert|update|delete|truncate|references|trigger|maintain) on table public\.inventory_movements to service_role/i,
  );

  for (const table of [
    "inventory_adjustments",
    "route_stop_inventory_commits",
    "route_inventory_discrepancies",
    "route_inventory_discrepancy_resolution_events",
    "route_inventory_reconciliations",
    "route_inventory_reconciliation_lines",
    "route_manual_sales",
    "route_customer_compensations",
    "operator_route_custody_leases",
    "route_pickup_batches",
    "route_pick_list_items",
    "historical_route_deduction_apply_operations",
    "historical_route_deduction_source_claims",
    "purchase_orders",
    "purchase_order_lines",
  ]) {
    assert.match(closure, new RegExp(`revoke all on table public\\.${table} from service_role`, "i"));
    assert.match(closure, new RegExp(`grant select on table public\\.${table} to service_role`, "i"));
    assert.doesNotMatch(
      closure,
      new RegExp(`grant (?:all|insert|update|delete|truncate|references|trigger|maintain) on table public\\.${table} to service_role`, "i"),
    );
  }

  for (const helper of [
    "_snacky_active_route_custody\\(\\)",
    "_snacky_assert_operator_bag_balance_changes\\(jsonb\\)",
    "_snacky_assert_operator_route_custody_touches\\(jsonb\\)",
    "_snacky_audit_route_inventory_discrepancy_status_change\\(\\)",
    "_snacky_reject_route_inventory_resolution_event_mutation\\(\\)",
    "_snacky_release_operator_route_custody\\(uuid, uuid, text, uuid\\)",
    "_snacky_route_bag_balances\\(uuid\\)",
    "_snacky_route_bag_history_balances\\(uuid\\)",
    "_snacky_route_bag_ledger_token\\(uuid\\)",
    "_snacky_sync_route_stock_lines\\(uuid\\)",
    "snacky_guard_operator_bag_balance_insert\\(\\)",
    "snacky_guard_operator_bag_balance_update\\(\\)",
    "snacky_guard_operator_bag_balance_delete\\(\\)",
    "snacky_guard_operator_route_custody_insert\\(\\)",
    "snacky_guard_operator_route_custody_update\\(\\)",
    "snacky_guard_operator_route_custody_delete\\(\\)",
    "snacky_guard_route_inventory_integrity\\(\\)",
    "snacky_guard_terminal_route_inventory_movement\\(\\)",
    "snacky_guard_route_pickup_batch_audit\\(\\)",
    "snacky_release_terminal_route_custody\\(\\)",
  ]) {
    assert.match(
      closure,
      new RegExp(`revoke all on function public\\.${helper} from service_role`, "i"),
    );
  }
});

test("application source has no generic RPC or direct immutable-ledger writer", () => {
  const protectedTables = [
    "inventory_movements",
    "inventory_adjustments",
    "route_stop_inventory_commits",
    "route_inventory_discrepancies",
    "route_inventory_discrepancy_resolution_events",
    "route_inventory_reconciliations",
    "route_inventory_reconciliation_lines",
    "route_manual_sales",
    "route_customer_compensations",
    "operator_route_custody_leases",
    "historical_route_deduction_apply_operations",
    "historical_route_deduction_source_claims",
    "purchase_orders",
    "purchase_order_lines",
  ];
  const violations = [];
  for (const absolutePath of sourceFiles(path.join(root, "src"))) {
    const relativePath = path.relative(root, absolutePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    if (/snacky_create_stock_movement_v1/.test(source)) violations.push(`${relativePath}: generic RPC`);
    for (const table of protectedTables) {
      const directMutation = new RegExp(`\\.from\\(["']${table}["']\\)[\\s\\S]{0,180}?\\.(?:insert|upsert|update|delete)\\s*\\(`);
      if (directMutation.test(source)) violations.push(`${relativePath}: direct ${table} mutation`);
    }
  }
  assert.deepEqual(violations, []);
  assert.doesNotMatch(inventoryActions, /export async function createStockMovement/);
});

test("the remaining unparented correction is owner/admin physical storage count only", () => {
  const functionStart = adjustmentMigration.indexOf("create or replace function public.snacky_create_storage_adjustment_v1(");
  const functionEnd = adjustmentMigration.indexOf("revoke all on function public.snacky_create_storage_adjustment_v1(", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const functionBody = adjustmentMigration.slice(functionStart, functionEnd);

  assert.match(functionBody, /snacky_current_profile_has_any_role\(array\['owner', 'admin'\]\)/i);
  assert.match(inventoryActions, /if \(!profile \|\| !isOwnerAdminRole\(profile\)\) redirect\("\/unauthorized"\)/);
  assert.match(inventoryActions, /rpc\("snacky_create_storage_adjustment_v1"/);
  assert.match(movementPage, /if \(!profile \|\| !isOwnerAdminRole\(profile\)\)/);
  assert.match(authz, /pathname === "\/inventory\/movements\/new"[\s\S]*return isOwnerAdminRole\(user\)/);
  assert.doesNotMatch(movementForm, /Transfer \/ Advanced Movement|from_location|to_location|related_route_id|admin_override/);
  assert.match(movementForm, /Use the source workflow for custody movements/);
  assert.match(movementForm, /href="\/routes"/);
});
