import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planCashVmsWindow } from "../src/lib/cash-vms-window.ts";

const D=(day,hh="09:00:00")=>"2026-11-"+String(day).padStart(2,"0")+"T"+hh+"+02:00";
const pickup=(id,day,cash,extra={})=>({
  id,machineId:"machine-1",machineName:"Khalij University",machineCode:"2510001719",
  removedAt:D(day),removedBy:"Yamen",custodyStatus:cash===null?"in_storage":"counted",
  removalType:"full",compartments:["notes"],countedAmount:cash,
  timeUncertain:false,fullClearanceUnverified:false,comparison:null,...extra,
});
const manual=(start,end,ids)=>({
  start_collection_id:start,end_collection_id:end,start_at:D(1),end_at:D(12),
  included_collection_ids:ids,physical_cash_lyd:2815,vms_cash_lyd:2800,difference_lyd:15,
  quality:"provisional",payment_scope:"cash_successful_only",source:"owner_entered_xy_vms",
  source_note:"XY Order Management",saved_at:"2026-11-14T11:00:00Z",
  saved_by:"owner",submission_id:"00000000-0000-4000-8000-000000000001",
});

test("Khalij November 12 starts at November 9 removal, not September or the last XY comparison",()=>{
  const records=[
    pickup("september",1,100,{comparison:manual("prior","september",["september"])}),
    pickup("nov8",8,867),
    pickup("nov9",9,638),
    pickup("nov12",12,2177),
  ];
  const p=planCashVmsWindow(records,"nov12");
  assert.equal(p.startReason,"previous_removal");
  assert.equal(p.startPickup?.id,"nov9");
  assert.equal(p.startAt,D(9));
  assert.equal(p.endAt,D(12));
  assert.deepEqual(p.included.map(x=>x.id),["nov12"]);
  assert.equal(p.physicalCashTotal,2177);
  assert.equal(p.canSave,true);
});

test("Khalij November 9 compares only with the November 8 removal, even if no VMS was entered",()=>{
  const p=planCashVmsWindow([
    pickup("sept",1,100,{officialComparison:true}),
    pickup("nov8",8,867),
    pickup("nov9",9,638),
  ],"nov9");
  assert.equal(p.startAt,D(8));
  assert.equal(p.endAt,D(9));
  assert.equal(p.physicalCashTotal,638);
  assert.equal(p.canSave,true);
});

test("An earlier uncounted removal still defines the exact next comparison start",()=>{
  const p=planCashVmsWindow([
    pickup("nov8",8,867),
    pickup("nov9",9,null),
    pickup("nov12",12,2177),
  ],"nov12");
  assert.equal(p.startAt,D(9));
  assert.deepEqual(p.included.map(x=>x.id),["nov12"]);
  assert.deepEqual(p.missingCounts,[]);
  assert.equal(p.physicalCashTotal,2177);
  assert.equal(p.canSave,true);
  assert.ok(p.warnings.some(w=>w.includes("does NOT change")));
});

test("An earlier partial pickup still sets the boundary, with a provisional warning",()=>{
  const p=planCashVmsWindow([
    pickup("old",8,null,{removalType:"partial"}),
    pickup("new",9,638),
  ],"new");
  assert.equal(p.startAt,D(8));
  assert.equal(p.canSave,true);
  assert.equal(p.quality,"provisional");
  assert.deepEqual(p.partialRemovals,["old"]);
});

test("The selected uncounted removal is blocked, but only because its own physical count is missing",()=>{
  const p=planCashVmsWindow([pickup("old",9,null),pickup("new",12,null)],"new");
  assert.equal(p.startAt,D(9));
  assert.deepEqual(p.missingCounts,["new"]);
  assert.equal(p.canSave,false);
  assert.equal(p.physicalCashTotal,null);
});

test("The previous recorded removal is used even when a more distant pickup has a saved VMS record",()=>{
  const p=planCashVmsWindow([
    pickup("sept",1,300,{comparison:manual("earlier","sept",["sept"])}),
    pickup("nov8",8,null),
    pickup("nov9",9,638),
  ],"nov9");
  assert.equal(p.startPickup?.id,"nov8");
  assert.equal(p.physicalCashTotal,638);
  assert.equal(p.canSave,true);
});

test("An old grouped snapshot is preserved but marked as a different period for correction",()=>{
  const p=planCashVmsWindow([
    pickup("nov8",8,867),
    pickup("nov9",9,638),
    pickup("nov12",12,2177,{comparison:manual("nov8","nov12",["nov9","nov12"])}),
  ],"nov12");
  assert.equal(p.startAt,D(9));
  assert.equal(p.existingMatchesCurrentWindow,false);
  assert.ok(p.warnings.some(w=>w.includes("DIFFERENT interval")));
  assert.equal(p.canSave,true);
});

test("An adjacent already-saved comparison matches the current selected period",()=>{
  const saved={...manual("nov9","nov12",["nov12"]),
    start_at:D(9),end_at:D(12),physical_cash_lyd:2177};
  const p=planCashVmsWindow([
    pickup("nov9",9,638),
    pickup("nov12",12,2177,{comparison:saved}),
  ],"nov12");
  assert.equal(p.existingMatchesCurrentWindow,true);
  assert.equal(p.canSave,true);
});

test("Duplicate timestamps are flagged, not treated as a valid sales interval",()=>{
  const p=planCashVmsWindow([pickup("first",9,638),pickup("second",9,2177)],"second");
  assert.equal(p.canSave,false);
  assert.equal(p.physicalCashTotal,null);
  assert.ok(p.warnings.some(w=>w.includes("identical")));
});

test("Never construct a period between different machines",()=>{
  assert.throws(()=>planCashVmsWindow([
    pickup("one",8,123),pickup("two",9,456,{machineId:"other-machine"}),
  ],"two"),/different machines/);
});

test("UI and actions require adjacent pickups, and cannot post cash or fake official XY reconciliation",()=>{
  const action=readFileSync("src/lib/cash-vms-manual-actions.ts","utf8");
  const page=readFileSync("src/app/cash-collections/compare/page.tsx","utf8");
  assert.match(action,/manual_vms_group_comparison/);
  assert.match(action,/confirmed_cash_scope/);
  assert.doesNotMatch(action,/sync_cash_collection_to_financial_transaction|confirm_cash_count_auto_period|reconcile_cash_collection/);
  assert.match(page,/CASH transactions/);
  assert.match(page,/FROM — after this timestamp/);
  assert.match(page,/UNTIL — through this timestamp/);
  assert.match(page,/The selected removal’s physical cash count/);
  assert.match(page,/immediately previous removal/);
  assert.match(page,/savedForDifferentPeriod/);
});
