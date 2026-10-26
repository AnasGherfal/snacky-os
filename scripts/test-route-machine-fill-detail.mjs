import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {summarizeRouteMachineFillMovements} from "../src/lib/route-machine-fill-detail.ts";
import {parseOperatorRouteStockFlow} from "../src/lib/operator-route-stock-flow.ts";

const add=(machine,product,qty)=>({
 from_entity_type:"operator_bag",to_entity_type:"machine",from_entity_id:"operator-a",to_entity_id:machine,
 product_id:product,quantity:qty,reason:"operator_bag_to_machine",
});
const correction=(machine,product,qty,reason="fill_correction")=>({
 from_entity_type:"machine",to_entity_type:"operator_bag",from_entity_id:machine,to_entity_id:"operator-a",
 product_id:product,quantity:qty,reason,
});

test("machine fill sums only actual bag-to-machine movements, net of fill corrections",()=>{
 const result=summarizeRouteMachineFillMovements([
  add("m1","water",10),add("m2","water",5),
  add("m1","water",3),correction("m1","water",2),
  {from_entity_type:"operator_bag",to_entity_type:"machine_storage",product_id:"water",quantity:4,to_entity_id:"m1"},
  {from_entity_type:"operator_bag",to_entity_type:"storage",product_id:"water",quantity:3,to_entity_id:"storage-a"},
  correction("m1","water",7,"returned_from_machine"),
 ],["m1","m2"]);
 assert.equal(result.verified,true);
 if(!result.verified) throw Error("not verified");
 assert.deepEqual(result.rows,[
  {machineId:"m1",productId:"water",filledQty:11},
  {machineId:"m2",productId:"water",filledQty:5},
 ]);
});

test("unknown machine, invalid/missing quantity, negative net fill never become verified detail",()=>{
 for(const item of [
  add("outsider","water",5),
  add("m1","water",null),
  add("m1","water",1.5),
  {...add("m1","water",5),to_entity_id:null},
 ]) {
  assert.equal(summarizeRouteMachineFillMovements([item],["m1"]).verified,false);
 }
 assert.equal(summarizeRouteMachineFillMovements([correction("m1","water",4)],["m1"]).verified,false);
});

const basePayload={
 ledgerToken:"b".repeat(32),descriptiveReconciliationAvailable:true,
 bagHistoryItems:[{productId:"water",productName:"Water",bagOwnerId:"operator-a",signedQuantity:2}],
 reconciliation:[{
  productId:"water",productName:"Water",loadedQty:11,filledQty:9,returnedQty:0,
  damagedQty:0,soldQty:0,compensatedQty:0,machineStorageQty:0,
  machineReturnQty:0,adjustmentQty:0,remainingQty:2,
 }],
 machineFillCoverageComplete:true,
 machineFills:[
  {machineId:"m1",machineName:"Mall One",machineCode:"S1",locationName:"Site A",productId:"water",productName:"Water",filledQty:4},
  {machineId:"m2",machineName:"Mall Two",machineCode:"S2",locationName:"Site B",productId:"water",productName:"Water",filledQty:5},
 ],
};

test("verified per-machine values reconcile with route-level filled totals",()=>{
 const flow=parseOperatorRouteStockFlow(basePayload);
 assert.equal(flow.state,"detailed");
 if(flow.state!=="detailed")throw Error("not detailed");
 assert.equal(flow.totalFilled,9);
 assert.deepEqual(flow.machineFills?.map(x=>x.filledQty),[4,5]);
 assert.equal(flow.machineFills?.[0].machineName,"Mall One");
});

test("missing or mismatched per-machine proof hides only machine detail, not canonical route values",()=>{
 for(const changed of [
  {...basePayload,machineFillCoverageComplete:false},
  {...basePayload,machineFills:null},
  {...basePayload,machineFills:[{...basePayload.machineFills[0],filledQty:8}]},
  {...basePayload,machineFills:[...basePayload.machineFills,basePayload.machineFills[0]]},
 ]) {
  const flow=parseOperatorRouteStockFlow(changed);
  assert.equal(flow.state,"detailed");
  if(flow.state!=="detailed")throw Error("not detailed");
  assert.equal(flow.totalRemaining,2);
  assert.equal(flow.totalFilled,9);
  assert.equal(flow.machineFills,null);
 }
});

test("descriptive movement pagination requires exact count and rejects server row-cap truncation",()=>{
 const api=readFileSync("src/app/api/operator/routes/[id]/picked-items/route.ts","utf8");
 assert.ok(api.includes("const pageSize = 400"));
 assert.ok(api.includes('count: "exact"'));
 assert.ok(api.includes("data.length !== expected"));
 assert.ok(api.includes("Route inventory movement page was truncated"));
 assert.ok(api.includes("Route inventory changed during descriptive movement read"));
 assert.ok(api.includes("seenIds.has(item.id)"));
 assert.ok(api.includes('descriptiveReconciliationAvailable: !routeMovementsError'));
});

test("existing authenticated route endpoint adds fill detail from SAME route movements, not another request",()=>{
 const api=readFileSync("src/app/api/operator/routes/[id]/picked-items/route.ts","utf8");
 const ui=readFileSync("src/components/operator/RouteBagStockFlow.tsx","utf8");
 assert.ok(api.includes("summarizeRouteMachineFillMovements(routeMovements, machineIds)"));
 assert.ok(api.includes("machineFillCoverageComplete: Boolean(fillDetail?.verified)"));
 assert.ok(api.includes("machineFills,"));
 assert.ok(ui.includes("What was filled at each machine"));
 assert.ok(ui.includes("ما تم تعبئته في كل جهاز"));
 assert.ok(ui.includes("machineGroups.map(machine =>"));
 assert.ok(ui.includes("not the machine's current slot stock"));
 assert.doesNotMatch(ui,/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
});
