import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {operatorReturnReadiness} from "../src/lib/operator-return-readiness.ts";

const row=(key,ledgerQty,enteredQty,confirmed=false)=>({key,ledgerQty,enteredQty,confirmed});
const base={
  rows:[row("op:water",10,10),row("op:chips",5,5)],
  emptyBagConfirmed:false,
  reconciliationReason:"", cancellationReason:"",cancelMode:false,
  storageLocationId:"warehouse-1",storageLocationCount:2,
  pendingDraft:false,inventoryFinalizationAvailable:true,
};

test("ledger prefills do not count as physical confirmation, even when quantities match",()=>{
 const r=operatorReturnReadiness(base);
 assert.equal(r.countTotal,2);
 assert.equal(r.countConfirmed,0);
 assert.equal(r.countRemaining,2);
 assert.equal(r.enteredTotal,15);
 assert.equal(r.confirmedTotal,0);
 assert.equal(r.physicalCountComplete,false);
 assert.equal(r.canSubmit,false);
 assert.deepEqual(r.nextStep,{kind:"count",anchor:"bag-count-0"});
});

test("row-by-row physical confirmations unlock only when all other checks are satisfied",()=>{
 const partially=operatorReturnReadiness({...base,rows:[
  row("op:water",10,10,true),row("op:chips",5,5,false),
 ]});
 assert.equal(partially.countConfirmed,1);
 assert.equal(partially.confirmedTotal,10);
 assert.deepEqual(partially.nextStep,{kind:"count",anchor:"bag-count-1"});
 const complete=operatorReturnReadiness({...base,rows:base.rows.map(x=>({...x,confirmed:true}))});
 assert.equal(complete.countConfirmed,2);
 assert.equal(complete.physicalCountComplete,true);
 assert.equal(complete.canSubmit,true);
 assert.equal(complete.nextStep,null);
});

test("changing a quantity invalidates confirmation and prompts a variance reason when different",()=>{
 const changed=operatorReturnReadiness({...base,rows:[
  row("op:water",10,7,true),row("op:chips",5,5,true),
 ]});
 assert.equal(changed.countConfirmed,2);
 assert.equal(changed.possibleVariance,true);
 assert.equal(changed.canSubmit,false);
 assert.deepEqual(changed.nextStep,{kind:"variance_reason",anchor:"return-variance-reason"});
 const explained=operatorReturnReadiness({...base,rows:[
  row("op:water",10,7,true),row("op:chips",5,5,true),
 ],reconciliationReason:"Physically counted 7"});
 assert.equal(explained.canSubmit,true);
 assert.equal(explained.enteredTotal,12);
});

test("negative signed ledger remains visible but requires physical variance review",()=>{
 const result=operatorReturnReadiness({...base,rows:[row("op:water",-2,0,true)]});
 assert.equal(result.possibleVariance,true);
 assert.equal(result.canSubmit,false);
 assert.equal(result.nextStep?.kind,"variance_reason");
});

test("returns must specify actual handoff storage when multiple destinations, or block if none exists",()=>{
 const counted=base.rows.map(x=>({...x,confirmed:true}));
 for(const storageLocationCount of [0,2]){
  const result=operatorReturnReadiness({...base,rows:counted,storageLocationCount,storageLocationId:""});
  assert.equal(result.canSubmit,false);
  assert.equal(result.nextStep?.kind,"return_destination");
 }
 assert.equal(operatorReturnReadiness({...base,rows:counted,storageLocationCount:1,storageLocationId:""}).canSubmit,true);
});

test("empty recorded bag requires explicit physical check before route closeout",()=>{
 const noRows=operatorReturnReadiness({...base,rows:[],storageLocationId:""});
 assert.equal(noRows.canSubmit,false);
 assert.equal(noRows.nextStep?.anchor,"bag-empty-confirmation");
 assert.equal(operatorReturnReadiness({...base,rows:[],emptyBagConfirmed:true,storageLocationId:""}).canSubmit,true);
});

test("cancel mode needs a reason and restored draft blocks release",()=>{
 const rows=base.rows.map(x=>({...x,confirmed:true}));
 const cancel=operatorReturnReadiness({...base,rows,cancelMode:true});
 assert.equal(cancel.canSubmit,false);
 assert.equal(cancel.nextStep?.anchor,"route-cancellation-reason");
 assert.equal(operatorReturnReadiness({...base,rows,cancelMode:true,cancellationReason:"Site inaccessible"}).canSubmit,true);
 assert.equal(operatorReturnReadiness({...base,rows,pendingDraft:true}).canSubmit,false);
 assert.equal(operatorReturnReadiness({...base,rows,inventoryFinalizationAvailable:false}).canSubmit,false);
});

test("readiness refuses noninteger, negative and overflowed entered counts",()=>{
 const rows=[
  row("op:water",10,-1,true),
  row("op:chips",5,0.2,true),
 ];
 const bad=operatorReturnReadiness({...base,rows});
 assert.equal(bad.canSubmit,false);
 assert.equal(bad.countConfirmed,0);
 assert.equal(bad.nextStep?.kind,"count");
 assert.equal(operatorReturnReadiness({...base,rows:[
  row("op:water",10,Number.MAX_SAFE_INTEGER,true),
  row("op:chips",5,2,true),
 ]}).canSubmit,false);
});

test("operator closeout uses anchored bilingual physical progress and preserves atomic writer",()=>{
 const page=readFileSync("src/app/operator/routes/[id]/leftovers/page.tsx","utf8");
 const component=readFileSync("src/components/operator/RouteReturnProgress.tsx","utf8");
 assert.ok(page.includes("const returnReadiness = operatorReturnReadiness({"));
 assert.ok(page.includes("<RouteReturnProgress"));
 assert.ok(page.includes('id={"bag-count-" + displayItems.findIndex'));
 for(const anchor of ["bag-empty-confirmation","return-storage-location","route-cancellation-reason","return-variance-reason"]){
  assert.ok(page.includes('id="'+anchor+'"'),anchor);
 }
 assert.ok(page.includes("confirmed: confirmedCountKeys.includes(custodyKey(item))"));
 assert.ok(page.includes("returnReadiness.physicalCountComplete"));
 assert.ok(page.includes("inventoryServiceReady={inventoryFinalizationAvailable}"));
 assert.ok(component.includes("Verified inventory closeout is unavailable"));

 assert.ok(page.includes('id="bag-empty-confirmation"'));
 assert.ok(page.includes('id="return-storage-location"'));
 assert.ok(page.includes('id="route-cancellation-reason"'));
 assert.ok(page.includes('id="return-variance-reason"'));
 assert.ok(page.includes('returnReadiness.nextStep.anchor'));
 assert.ok(page.includes('Optional: detailed route stock movements'));
 assert.ok(page.includes('View stops'));
 assert.ok(page.indexOf("<RouteReturnProgress") < page.indexOf("<SectionCard>"));
 assert.ok(page.includes('Prefill ledger quantities — still count physically'));

 assert.ok(page.includes("finalizeRouteInventory({"));
 assert.ok(page.includes("ledgerToken,"));
 assert.ok(page.includes("const unconfirmedRows = displayItems.filter"));
 assert.ok(component.includes("الكميات المقترحة أدناه من سجل سناكي"));
 assert.ok(component.includes('href={"#" + nextStep.anchor}'));
 assert.ok(component.includes('aria-valuenow={countConfirmed}'));
 for(const file of [component,readFileSync("src/lib/operator-return-readiness.ts","utf8")]){
  assert.doesNotMatch(file,/\.from\(|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\bfetch\(/);
 }
});
