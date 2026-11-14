import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planCashVmsWindow } from "../src/lib/cash-vms-window.ts";

const D = (n) => "2026-11-"+String(n).padStart(2,"0")+"T09:00:00+02:00";
const pickup = (id,n,cash,extra={}) => ({
  id,machineId:"machine-1",machineName:"HTLand",machineCode:"2503000216",
  removedAt:D(n),removedBy:"Anas",custodyStatus:cash===null?"in_storage":"counted",
  removalType:"full",compartments:["notes","coins"],countedAmount:cash,
  timeUncertain:false,fullClearanceUnverified:false,comparison:null,...extra,
});
const manual = (start,end,ids,quality="owner_reported_exact_window") => ({
  start_collection_id:start,end_collection_id:end,start_at:D(1),end_at:D(3),
  included_collection_ids:ids,physical_cash_lyd:500,vms_cash_lyd:500,difference_lyd:0,
  quality,payment_scope:"cash_successful_only",source:"owner_entered_xy_vms",
  source_note:"XY successful cash orders",saved_at:"2026-11-14T11:00:00Z",
  saved_by:"owner",submission_id:"00000000-0000-4000-8000-000000000001",
});

test("first comparison starts at previous full cash clearance, not first day of month",()=>{
  const p=planCashVmsWindow([pickup("oct",1,100),pickup("nov",5,457)],"nov");
  assert.equal(p.startReason,"previous_full_removal");
  assert.equal(p.startAt,D(1));
  assert.equal(p.endAt,D(5));
  assert.deepEqual(p.included.map(x=>x.id),["nov"]);
  assert.equal(p.physicalCashTotal,457);
  assert.equal(p.quality,"provisional");
  assert.ok(p.warnings.some(w=>w.includes("NOT a previous verified")));
});

test("after a previous saved comparison, add all intervening counted removals once",()=>{
  const all=[pickup("base",3,600,{comparison:manual("oct","base",["base"])}),
    pickup("next",7,638),pickup("last",12,2177)];
  const p=planCashVmsWindow(all,"last");
  assert.equal(p.startReason,"previous_saved_comparison");
  assert.deepEqual(p.included.map(x=>x.id),["next","last"]);
  assert.equal(p.physicalCashTotal,2815);
  assert.equal(p.quality,"owner_reported_exact_window");
  assert.equal(p.canSave,true);
});

test("missing physical count prevents comparison, never treats missing as zero",()=>{
  const p=planCashVmsWindow([pickup("base",3,100,{comparison:manual("old","base",["base"])}),
    pickup("uncounted",5,null),pickup("last",12,2177)],"last");
  assert.equal(p.canSave,false);
  assert.equal(p.physicalCashTotal,null);
  assert.deepEqual(p.missingCounts,["uncounted"]);
});

test("unknown prior time is marked provisional, never called verified",()=>{
  const p=planCashVmsWindow([pickup("old",1,100,{timeUncertain:true}),
    pickup("new",13,457)],"new");
  assert.equal(p.canSave,true);
  assert.equal(p.quality,"provisional");
  assert.ok(p.warnings.some(w=>w.includes("placeholder")));
});

test("a partial cash pickup blocks comparison without evidence of retained cash",()=>{
  const p=planCashVmsWindow([pickup("base",1,100),pickup("new",13,457,{removalType:"partial"})],"new");
  assert.equal(p.canSave,false);
  assert.deepEqual(p.partialRemovals,["new"]);
});

test("new comparison cannot silently duplicate an already saved later grouped period",()=>{
  const p=planCashVmsWindow([pickup("old",1,100),pickup("middle",5,600),
    pickup("last",13,457,{comparison:manual("old","last",["middle","last"])})],"middle");
  assert.equal(p.canSave,false);
  assert.ok(p.warnings.some(w=>w.includes("already included")));
});

test("manual comparison UI must not post money or invent a verified API result",()=>{
  const action=readFileSync("src/lib/cash-vms-manual-actions.ts","utf8");
  const page=readFileSync("src/app/cash-collections/compare/page.tsx","utf8");
  assert.match(action,/manual_vms_group_comparison/);
  assert.match(action,/confirmed_cash_scope/);
  assert.doesNotMatch(action,/sync_cash_collection_to_financial_transaction|confirm_cash_count_auto_period|reconcile_cash_collection/);
  assert.match(page,/CASH transactions/);
  assert.match(page,/FROM — after this timestamp/);
  assert.match(page,/UNTIL — through this timestamp/);
  assert.match(page,/Cash removals included in this XY period/);
  assert.match(page,/No previous/);
});


test("dated and sourced official XY reconciliation becomes the next comparison baseline",()=>{
  const all=[
    pickup("official",3,1200,{officialComparison:true}),
    pickup("nov9",9,638),
    pickup("nov12",12,2177),
  ];
  const window=planCashVmsWindow(all,"nov12");
  assert.equal(window.startReason,"previous_saved_comparison");
  assert.equal(window.startPickup?.id,"official");
  assert.deepEqual(window.included.map(r=>r.id),["nov9","nov12"]);
  assert.equal(window.physicalCashTotal,2815);
});

test("unsourced historical matched status does not become a verified comparison baseline",()=>{
  const all=[
    pickup("old",1,300,{officialComparison:false}),
    pickup("new",12,457),
  ];
  const window=planCashVmsWindow(all,"new");
  assert.equal(window.startReason,"previous_full_removal");
  assert.equal(window.quality,"provisional");
});
