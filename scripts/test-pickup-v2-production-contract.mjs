import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const rpc = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/202607150008_snacky_confirm_route_pickup_batch_v2.sql"),
  "utf8",
);
const contract = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/202607150013_pickup_v2_complete_production_contract.sql"),
  "utf8",
);

test("audit accounts for every ON CONFLICT contract in pickup v2", () => {
  assert.match(rpc, /on conflict \(id\) do update set/gi);
  assert.match(rpc, /on conflict \(idempotency_key\) do nothing/i);
  assert.match(rpc, /on conflict \(route_id, product_id\)/i);
  assert.match(rpc, /on conflict do nothing/i);

  assert.match(contract, /snacky_route_stop_items_id_uq/i);
  assert.match(contract, /snacky_route_pick_list_items_id_uq/i);
  assert.match(contract, /snacky_pickup_v2_inventory_movement_guard/i);
  assert.match(contract, /snacky_pickup_v2_route_stock_line_guard/i);
  assert.match(contract, /snacky_pickup_v2_batch_stop_guard/i);
});

test("contract removes unsupported business-key conflict targets from deployed RPC", () => {
  assert.match(contract, /idempotency_key[\s\S]*on conflict do nothing/i);
  assert.match(contract, /route_id[\s\S]*product_id[\s\S]*on conflict do nothing/i);
  assert.match(contract, /still depends on a missing inventory idempotency unique constraint/i);
  assert.match(contract, /still depends on a missing route stock-line unique constraint/i);
});

test("contract includes all previously discovered production repairs", () => {
  assert.match(contract, /add column if not exists is_active boolean/i);
  assert.match(contract, /superseded_at timestamptz/i);
  assert.match(contract, /superseded_reason text/i);
  assert.match(contract, /snacky_route_pickup_batch_insert_idempotency/i);
  assert.match(contract, /nullif\(x\.source_id, ''\)::uuid/i);
  assert.match(contract, /Expected public\.inventory_movements\.source_id to be uuid/i);
  assert.match(contract, /Expected exactly one public\.snacky_confirm_route_pickup_batch_v2 signature/i);
});

test("contract is additive and does not destroy business data", () => {
  assert.doesNotMatch(contract, /\btruncate\b/i);
  assert.doesNotMatch(contract, /\bdelete\s+from\b/i);
  assert.doesNotMatch(contract, /\bdrop\s+(table|column|schema)\b/i);
  assert.doesNotMatch(contract, /\bcascade\b/i);
  assert.doesNotMatch(contract, /supabase\s+db\s+reset/i);
  assert.match(contract, /select pg_notify\('pgrst', 'reload schema'\);/i);
});
