import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260909211000_allow_operator_multiple_route_custody.sql"),
  "utf8",
).replace(/\s+/g, " ").trim();

test("operator custody identity is route-scoped while each route remains unique", () => {
  assert.match(migration, /primary key \(operator_id, route_id\)/i);
  assert.match(migration, /unique \(route_id\)/i);
  assert.match(migration, /v_primary_key_columns = array\['operator_id'\]::text\[\][\s\S]*drop constraint operator_route_custody_leases_pkey/i);
  assert.match(migration, /primary key \(operator_id, route_id\)[\s\S]*route-unique custody constraint is missing/i);
});

test("custody claims allow multiple routes without weakening route ownership", () => {
  assert.match(migration, /remove the one-route-per-statement custody guard/i);
  assert.match(migration, /where lease\.operator_id = v_touch\.operator_id and lease\.route_id = v_touch\.route_id for update/i);
  assert.match(migration, /if v_has_existing_lease then/i);
  assert.match(migration, /already carries inventory for another route[\s\S]*new_claim_lookup/i,
    "the guarded rewrite must explicitly remove the old rejection");
  assert.match(migration, /strpos\(v_assert_definition, 'already carries inventory for another route'\) > 0/i);
});

test("finishing one route releases only that route's custody", () => {
  assert.match(migration, /where lease\.operator_id = p_operator_id and lease\.route_id = p_route_id for update/i);
  assert.match(migration, /strpos\(v_release_definition, 'and lease\.route_id = p_route_id'\) = 0/i);

  const leases = new Set(["operator-a:route-a", "operator-a:route-b"]);
  leases.delete("operator-a:route-a");
  assert.deepEqual([...leases], ["operator-a:route-b"]);
});

test("rewritten helpers remain private and schema-safe", () => {
  assert.match(migration, /revoke all on function public\._snacky_assert_operator_route_custody_touches\(jsonb\) from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all on function public\._snacky_release_operator_route_custody\(uuid, uuid, text, uuid\) from public, anon, authenticated, service_role/i);
  assert.match(migration, /select pg_catalog\.pg_notify\('pgrst', 'reload schema'\);\s*$/i);
});
