import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync("supabase/migrations/202607290001_post_machine_returns_to_storage.sql", "utf8");

test("returned machine products are posted from the operator bag into storage", () => {
  assert.match(migration, /new\.adjustment_type <> 'returned_from_machine'/);
  assert.match(migration, /snacky_route_leftover_storage_location_id\(new\.route_id\)/);
  assert.match(migration, /'operator_bag'[\s\S]*?'storage'/);
  assert.match(migration, /'operator_bag_to_storage'/);
  assert.match(migration, /'machine-return-storage:' \|\| new\.id::text/);
});

test("machine return storage posting is idempotent and repairs old records", () => {
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/);
  assert.match(migration, /Repair existing confirmed machine returns/);
  assert.match(migration, /ia\.adjustment_type = 'returned_from_machine'/);
  assert.match(migration, /ia\.status <> 'cancelled'/);
});

test("change does not alter route pickup or stop completion contracts", () => {
  assert.doesNotMatch(migration, /snacky_confirm_route_pickup|route_pickup_batches|route_stop_items/);
});
