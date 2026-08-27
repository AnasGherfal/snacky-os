import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/202608260001_route_rls_and_rpc_exposure_hardening.sql"),
  "utf8",
);

test("core route tables enable RLS and remove broad client grants", () => {
  for (const table of [
    "routes",
    "route_stops",
    "route_stock_lines",
    "route_stop_items",
    "route_pick_list_items",
    "refill_orders",
    "refill_order_lines",
  ]) {
    assert.match(migration, new RegExp(`'${table}'`));
  }

  assert.match(migration, /alter table public\.%I enable row level security/);
  assert.match(migration, /revoke all on table public\.%I from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table public\.%I to authenticated/);
  assert.doesNotMatch(migration, /disable row level security/);
});

test("route reads preserve business-role and assigned-operator access", () => {
  assert.match(migration, /snacky_routes_select_by_effective_role/);
  for (const role of ["owner", "admin", "supervisor", "warehouse", "finance", "viewer"]) {
    assert.match(migration, new RegExp(`'${role}'`));
  }
  assert.match(migration, /snacky_operator_can_access_route\(id\)/);
});

test("refill orders and lines have explicit authenticated read policies", () => {
  assert.match(migration, /snacky_refill_orders_select_by_route_access[\s\S]*on public\.refill_orders for select[\s\S]*to authenticated/);
  assert.match(migration, /snacky_refill_order_lines_select_by_route_access[\s\S]*on public\.refill_order_lines for select[\s\S]*to authenticated/);
  assert.match(migration, /from public\.refill_orders ro[\s\S]*ro\.id = refill_order_id/);
});

test("privileged functions are not anonymous RPC endpoints", () => {
  assert.match(migration, /where n\.nspname = 'public'[\s\S]*and p\.prosecdef/);
  assert.match(migration, /revoke execute on function %s from public, anon/);
  assert.match(migration, /alter default privileges for role postgres in schema public[\s\S]*revoke execute on functions from public, anon/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon/);
});
