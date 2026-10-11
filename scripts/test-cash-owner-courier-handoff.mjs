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
