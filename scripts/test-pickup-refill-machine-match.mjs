import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRefillLinePickRows } from "../src/lib/route-pickup-refill-allocation.ts";

const patch=readFileSync("supabase/migrations/20261122105000_pickup_refill_machine_scoped_equality.sql","utf8");

test("v3 expected refill picks are matched to the selected machine, not another stop with same product",()=>{
 assert.match(patch,/machine_id uuid,\s*product_id uuid,\s*picked_qty integer,\s*action_type text/);
 assert.match(patch,/and \(row_value\.machine_id is null\s*or refill\.machine_id = row_value\.machine_id\)/);
 assert.match(patch,/where row_value\.action_type <> 'extra_product'/);
 assert.match(patch,/where refill\.route_id = p_route_id/);
 assert.match(patch,/pg_get_functiondef\(v_oid\)/);
 assert.match(patch,/Refusing automatic SQL patch/);
 assert.match(patch,/v_new_recordset in pg_get_functiondef/);
 assert.match(patch,/v_new_match in pg_get_functiondef/);
});

test("Khalij 8 Spuds cannot alter Istiklal refill line, while matching Khalij water is recorded",()=>{
 const spuds="11111111-1111-4111-8111-111111111111";
 const water="22222222-2222-4222-8222-222222222222";
 const khalij="33333333-3333-4333-8333-333333333333";
 const istiklal="44444444-4444-4444-8444-444444444444";
 const items=[
  {machineId:khalij,productId:spuds,quantity:8},
  {machineId:khalij,productId:water,quantity:111},
 ];
 const lines=[
  {id:"66666666-6666-4666-8666-666666666666",machineId:istiklal,productId:spuds,plannedQty:5},
  {id:"77777777-7777-4777-8777-777777777777",machineId:khalij,productId:water,plannedQty:111},
 ];
 const picked=buildRefillLinePickRows({stopItems:items,legacyItems:[],refillLines:lines});
 assert.deepEqual(picked,[{id:lines[1].id,picked_qty:111}]);
 assert.equal(picked.some(row=>row.id===lines[0].id),false);
 // Original RPC grouped all route machines by product and mistakenly
 // required an Istiklal refill row for Khalij's manually added Spuds.
 // The patched SQL excludes Khalij's Spuds from refill comparison but
 // preserves the actual pickup line, inventory movement and stop count.
});

test("Existing same-machine refill line is still compared strictly; legacy null-machine fallback remains",()=>{
 const sql=patch;
 assert.match(sql,/and \(row_value.machine_id is null/);
 const route="11111111-1111-4111-8111-111111111111";
 const p="22222222-2222-4222-8222-222222222222";
 const id="33333333-3333-4333-8333-333333333333";
 const rows=buildRefillLinePickRows({stopItems:[{machineId:route,productId:p,quantity:3}],legacyItems:[],refillLines:[{id,machineId:route,productId:p,plannedQty:5}]});
 assert.deepEqual(rows,[{id,picked_qty:3}]);
});
