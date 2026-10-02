import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/migrations/20260905094800_operator_inventory_write_surface.sql").replace(/\s+/g, " ");
const closure = read("supabase/migrations/20260906155700_close_generic_inventory_writer.sql").replace(/\s+/g, " ");

test("assigned operators cannot insert raw inventory ledger rows", () => {
  assert.match(migration, /drop policy if exists "snacky_inventory_movements_insert_by_effective_role"/i);
  assert.doesNotMatch(migration, /create policy "snacky_inventory_movements_insert_by_effective_role"/i);
  assert.match(migration, /revoke all on table public\.inventory_movements from public, anon, authenticated/i);
  assert.match(migration, /grant select on table public\.inventory_movements to authenticated/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|truncate|references|trigger|maintain|all) on table public\.inventory_movements to authenticated/i);
  assert.match(migration, /inventory_movements_operator_bag_endpoint_ids[\s\S]*from_entity_id is not null[\s\S]*to_entity_id is not null[\s\S]*not valid/i);
  assert.match(closure, /revoke all on table public\.inventory_movements from service_role/i);
  assert.match(closure, /grant select on table public\.inventory_movements to service_role/i);
  assert.match(closure, /revoke all on function public\.snacky_create_stock_movement_v1\([\s\S]*?\) from public, anon, authenticated, service_role/i);
});

test("operator movement writers use protected database contracts", () => {
  const operatorActions = read("src/lib/operator-actions.ts");
  const manualSaleApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts");
  const compensationApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/compensations/route.ts");

  assert.match(operatorActions, /snacky_confirm_route_pickup_batch_v3/);
  assert.match(operatorActions, /snacky_commit_route_stop_inventory_v1/);
  assert.doesNotMatch(operatorActions, /from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)/s);
  assert.match(manualSaleApi, /snacky_create_route_manual_sale_v1/);
  assert.doesNotMatch(manualSaleApi, /from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)/s);
  assert.match(compensationApi, /snacky_create_route_customer_compensation_v1/);
  assert.doesNotMatch(compensationApi, /from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)/s);
});
