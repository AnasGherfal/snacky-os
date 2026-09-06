import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const actionsPath = "src/lib/operator-actions.ts";
const stopApiPath = "src/app/api/operator/routes/[id]/stops/[stopId]/route.ts";

test("stop completion validates against the same operator-bag ledger shown in the UI", () => {
  const actions = read(actionsPath);
  const stopApi = read(stopApiPath);
  const migration = read("supabase/migrations/20260905091000_route_stop_inventory_commit.sql");

  assert.match(stopApi, /bagBalanceByProduct/);
  assert.match(stopApi, /availableByProduct/);
  assert.match(stopApi, /currentStopFilledByProduct/);
  assert.match(stopApi, /rpc\("snacky_route_bag_balances"/);
  assert.match(stopApi, /Could not load the authoritative route inventory balance/);
  assert.doesNotMatch(stopApi, /\.eq\("related_route_id", routeId\)\s*\.limit\(5000\)/);
  assert.doesNotMatch(stopApi, /movementError \? \[\] : \(routeMovements/);

  assert.match(actions, /snacky_commit_route_stop_inventory_v1/);
  assert.match(migration, /_snacky_route_bag_balances/i);
  assert.match(migration, /related_route_id\s*=\s*p_route_id/i);
  assert.match(migration, /v_operator_bag_before/i);
  assert.match(migration, /v_route_bag_before/i);
});

test("machine-storage quantities are not posted again as normal machine fills", () => {
  const actions = read(actionsPath);
  const migration = read("supabase/migrations/20260905091000_route_stop_inventory_commit.sql");

  assert.match(actions, /p_fill_lines/);
  assert.match(actions, /p_machine_storage_lines/);
  assert.match(migration, /v_fill_totals/i);
  assert.match(migration, /v_machine_storage_totals/i);
  assert.match(migration, /operator_bag[^\n]{0,200}machine_storage/i);
  assert.match(migration, /Use the assigned fill line instead of adding the same product to machine storage/i);
});

test("actual field fill above recorded custody is persisted as a reviewable discrepancy without making the bag negative", () => {
  const actions = read(actionsPath);
  const migration = read("supabase/migrations/20260905091000_route_stop_inventory_commit.sql");

  assert.match(actions, /snacky_commit_route_stop_inventory_v1/);
  assert.doesNotMatch(actions, /Actual field fill exceeds recorded carried quantity; completing with inventory discrepancy/);
  assert.match(migration, /route_inventory_discrepancies/i);
  assert.match(migration, /operator_bag/i);
  assert.match(migration, /adjustment/i);
  assert.doesNotMatch(migration, /raise exception[^;]{0,300}filled quantity cannot exceed/i);
});
