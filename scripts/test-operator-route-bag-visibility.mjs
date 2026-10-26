import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {parseOperatorRouteStockFlow} from "../src/lib/operator-route-stock-flow.ts";

const token="a".repeat(32);
const line=(productId,overrides={})=>({
  productId,productName:productId,
  loadedQty:15,filledQty:9,returnedQty:1,damagedQty:0,soldQty:0,
  compensatedQty:0,machineStorageQty:2,machineReturnQty:0,
  adjustmentQty:0,remainingQty:3,...overrides,
});
const payload={
  ledgerToken:token,
  bagHistoryItems:[{productId:"water",productName:"Water",bagOwnerId:"operator-1",signedQuantity:3}],
  reconciliation:[line("water",{productName:"Water"})],
  descriptiveReconciliationAvailable:true,
};

test("picked, filled and canonical bag balance stay distinct across movements",()=>{
 const result=parseOperatorRouteStockFlow(payload);
 assert.equal(result.state,"detailed");
 if(result.state!=="detailed")throw Error("expected detailed");
 assert.equal(result.totalLoaded,15);
 assert.equal(result.totalFilled,9);
 assert.equal(result.totalRemaining,3);
 assert.equal(result.rows[0].returnedQty,1);
 assert.equal(result.rows[0].machineStorageQty,2);
 assert.notEqual(result.totalRemaining,result.totalLoaded-result.totalFilled,
  "bag must not be guessed from picked minus filled");
});

test("multiple custodians are aggregated per route, explicitly warning of handoff",()=>{
 const result=parseOperatorRouteStockFlow({
  ...payload,
  bagHistoryItems:[
   {productId:"water",productName:"Water",bagOwnerId:"operator-1",signedQuantity:2},
   {productId:"water",productName:"Water",bagOwnerId:"operator-2",signedQuantity:1},
  ],
  requiresManagerReconciliation:false, // owner/admin still sees mixed custody
 });
 assert.equal(result.state,"detailed");
 if(result.state==="unverified")throw Error("unexpected");
 assert.equal(result.balances.length,1);
 assert.equal(result.totalRemaining,3);
 assert.equal(result.custodyNeedsReview,true);
});

test("bag custody assigned to someone else is never presented as personal operator stock",()=>{
 const result=parseOperatorRouteStockFlow({
  ...payload,
  assignedBagOwnerId:"operator-1",
  bagHistoryItems:[{productId:"water",productName:"Water",bagOwnerId:"operator-2",signedQuantity:3}],
  requiresManagerReconciliation:false,
 });
 assert.equal(result.state,"detailed");
 if(result.state==="unverified")throw Error("unexpected");
 assert.equal(result.custodyNeedsReview,true);
});

test("missing signed canonical bag ledger token fails closed even with plausible movement data",()=>{
 const result=parseOperatorRouteStockFlow({...payload,ledgerToken:null});
 assert.deepEqual(result,{state:"unverified",reason:"canonical_bag_snapshot_unavailable"});
});

test("no movements or failed descriptive reads preserve bag amount but never invent zero picked/filled",()=>{
 for (const data of [
  {...payload,descriptiveReconciliationAvailable:false,reconciliation:[]},
  {...payload,descriptiveReconciliationAvailable:true,reconciliation:null},
  {...payload,reconciliation:[line("water",{remainingQty:4})]},
  {...payload,reconciliation:[line("water",{filledQty:null})]},
 ]) {
  const result=parseOperatorRouteStockFlow(data);
  assert.equal(result.state,"balance_only");
  if(result.state==="unverified")throw Error("unexpected");
  assert.equal(result.totalLoaded,null);
  assert.equal(result.totalFilled,null);
  assert.equal(result.totalRemaining,3);
 }
});

test("invalid signed custody or missing bag history never becomes a trusted zero",()=>{
 assert.equal(parseOperatorRouteStockFlow({...payload,bagHistoryItems:undefined}).state,"unverified");
 assert.equal(parseOperatorRouteStockFlow({
  ...payload,bagHistoryItems:[{productId:"water",signedQuantity:"NaN"}],
 }).state,"unverified");
 assert.equal(parseOperatorRouteStockFlow({
  ...payload,bagHistoryItems:[{productId:"water",signedQuantity:""}],
 }).state,"unverified");
});

test("negative signed bag balance remains visible for manager review",()=>{
 const result=parseOperatorRouteStockFlow({
  ...payload,
  bagHistoryItems:[{productId:"water",productName:"Water",signedQuantity:-2}],
  reconciliation:[line("water",{loadedQty:5,filledQty:7,returnedQty:0,machineStorageQty:0,remainingQty:-2})],
 });
 assert.equal(result.state,"detailed");
 if(result.state==="unverified")throw Error("unexpected");
 assert.equal(result.totalRemaining,-2);
 assert.equal(result.hasNegativeBalance,true);
});

test("UI reuses only existing authenticated route stock GET and never edits inventory",()=>{
 const ui=readFileSync("src/components/operator/RouteBagStockFlow.tsx","utf8");
 const page=readFileSync("src/app/operator/routes/[id]/page.tsx","utf8");
 const api=readFileSync("src/app/api/operator/routes/[id]/picked-items/route.ts","utf8");
 assert.ok(page.includes('<RouteBagStockFlow routeId={routeId} locale={locale} />'));
 assert.ok(page.includes("Number(item.picked_qty ?? 0)"));
 assert.ok(!page.includes("Number(item.picked_qty ?? item.planned_qty ?? 0)"));
 assert.ok(ui.includes("parseOperatorRouteStockFlow(payload)"));
 assert.ok(ui.includes("/picked-items"));
 assert.ok(ui.includes('method: "GET"'));
 assert.ok(ui.includes('cache: "no-store"'));
 assert.ok(ui.includes('aria-expanded={expanded}'));
 assert.ok(ui.includes("متبقي"));
 assert.ok(ui.includes("لم يتغير المخزون"));
 assert.doesNotMatch(ui,/\bfetch\([^)]*\{\s*method: "(?:POST|PATCH|PUT|DELETE)"/);
 assert.doesNotMatch(ui,/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
 assert.ok(api.includes("canAccessOperatorRoute"));
 assert.ok(api.includes("snacky_route_bag_snapshot"));
 assert.ok(api.includes("descriptiveReconciliationAvailable"));
 assert.ok(api.includes("reconciliation,"));
});
