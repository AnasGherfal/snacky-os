import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922134013_optimize_current_inventory_view_aggregation.sql"),
  "utf8",
);

test("current inventory view aggregates ledger movements before joining labels", () => {
  assert.match(source, /create or replace view public\.current_inventory_by_location/i);
  assert.match(source, /with \(security_invoker = true\)/i);
  assert.match(source, /balances as \([\s\S]*sum\(quantity_delta\)::integer as quantity_on_hand[\s\S]*group by product_id, location_type, location_id/i);

  const balancesAt = source.indexOf("balances as");
  const productJoinAt = source.indexOf("join public.products");
  assert.notEqual(balancesAt, -1);
  assert.notEqual(productJoinAt, -1);
  assert.ok(balancesAt < productJoinAt, "movement balances must be aggregated before product/location joins");

  assert.match(source, /p\.id as product_id,[\s\S]*p\.name as product_name,[\s\S]*b\.location_type::text as location_type,[\s\S]*b\.location_id,[\s\S]*location_name,[\s\S]*b\.quantity_on_hand/i);
  assert.match(source, /revoke all on table public\.current_inventory_by_location from public, anon/i);
  assert.match(source, /grant select on table public\.current_inventory_by_location to authenticated, service_role/i);
});
