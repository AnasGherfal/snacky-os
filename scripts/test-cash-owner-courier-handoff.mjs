import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {validateCashCommand} from "../src/lib/cash-handover.ts";
const sql=fs.readFileSync("supabase/migrations/20261011090000_noury_ahmed_owner_cash_custody.sql","utf8");
test("deliver command has no amount",()=>{
const x=validateCashCommand({request_id:"d0d6582e-4f6e-4fe9-8ba3-ac14c5335840",collection_id:"a25fe14f-fad0-4084-a0ab-87367af5efca",action:"deliver",revision:1,payload:{delivery_location:"Owner office",notes:""}});
assert.equal(x.action,"deliver");
assert.equal(Object.hasOwn(x.payload,"amount"),false);
});
test("courier not automatically authorized to count",()=>{
assert.match(sql,/if v_action='count' and not v_counter/);
assert.match(sql,/cash_handover_courier_v1/);
assert.match(sql,/receiver_confirmed',false/);
});

test("warehouse courier requires assigned handover before pickup; no Finance or count write",()=>{
assert.match(sql,/when 'pickup','direct_pickup','takeover' then/);
assert.match(sql,/when 'deliver' then allowed:=array/);
assert.match(sql,/if v_action in \('pickup','direct_pickup'\) and not \(v_counter or v_courier\)/);
assert.match(sql,/h.assigned_to<>v_actor/);
assert.match(sql,/Wait for the courier to confirm physical delivery/);
assert.match(sql,/when 'deliver' then[\s\S]*?delivered_at=v_now/);
assert.match(sql,/c.picked_up_by=c.delivered_by then 'delivered'/);
assert.match(sql,/c.picked_up_by<>c.delivered_by then 'received'/);
});
test("operator and owner use one connected box timeline",()=>{
const ui=fs.readFileSync("src/components/CashHandlingWorkspace.tsx","utf8");
assert.match(ui,/suggestedAhmed/);
assert.match(ui,/storage_location/);
assert.match(ui,/action === 'deliver' \? \{ delivery_location/);
assert.match(ui,/action === 'takeover'/);
assert.match(ui,/box.state === 'delivered'/);
assert.match(ui,/box.state === 'received'/);
assert.match(ui,/amount.*recorded at removal/i);
});
