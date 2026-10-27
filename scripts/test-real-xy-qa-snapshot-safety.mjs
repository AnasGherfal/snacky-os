import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRealMachineTrainingFixture } from "../src/lib/qa-real-machine-fixture.ts";

const slot = (slotCode, overrides = {}) => ({
  slotCode, productId: "cola", productName: "Cola",
  currentQty: 0, capacity: 10, priceLyd: 3.5, capturedAt: "2026-10-27T10:00:00Z",
  ...overrides,
});
const source = slots => ({
  ok: true, capturedAt: "2026-10-27T10:00:00Z",
  machines: [{id:"machine-1",name:"Training Machine",machineCode:"SNK-QA",slots}],
});

test("known zero remains zero; null/invalid quantity, capacity and price never become invented training stock", () => {
  const result = buildRealMachineTrainingFixture(source([
    slot("001"), slot("002", { currentQty: null }),
    slot("003", { capacity: null }), slot("004", {currentQty: 11}),
    slot("005", {priceLyd: 0}), slot("006", {currentQty: -1}),
    slot("007", {productId:null,productName:"Unknown product",currentQty:2}),
  ]));
  assert.deepEqual(result.stops[0].lanes.map(l=>l.code),["001","007"]);
  assert.equal(result.stops[0].lanes[0].initialQty,0);
  assert.equal(result.stops[0].lanes[0].xyQty,0);
  assert.equal(result.stops[0].lanes[0].capacity,10);
  assert.equal(result.stops[0].lanes[0].priceLyd,3.5);
  assert.equal(result.stops[0].lanes[0].plannedAdd,6);
  assert.equal(result.stops[0].lanes[1].plannedAdd,0,"Unmapped product cannot be recommended for pickup");
  assert.deepEqual(result.omitted.map(x=>[x.slotCode,x.reason]),[
    ["002","unknown_quantity"],["003","unknown_capacity"],
    ["004","invalid_stock"],["005","unknown_price"],["006","unknown_quantity"],
  ]);
});
test("capacity, stock and prices remain observed—not defaults or clamps",()=>{
  const result=buildRealMachineTrainingFixture(source([slot("001",{currentQty:12,capacity:20,priceLyd:6.75})]));
  const lane=result.stops[0].lanes[0];
  assert.deepEqual([lane.initialQty,lane.capacity,lane.xyQty,lane.priceLyd],[12,20,12,6.75]);
  assert.equal(lane.plannedAdd,6);
});
test("all unverified lanes fail closed instead of returning fake zero-stock exercise",()=>{
  assert.throws(()=>buildRealMachineTrainingFixture(source([slot("001",{currentQty:null})])),/No verified XY selection/);
  assert.throws(()=>buildRealMachineTrainingFixture({ok:true,capturedAt:null,machines:[]}),/No verified machines/);
});
test("source JSON keeps unknown distinct from zero and rejects partial row cap; only owner may open QA",()=>{
  const api=readFileSync("src/app/api/admin/qa-real-route-snapshot/route.ts","utf8");
  const ui=readFileSync("src/components/testing-lab/RealMachineRouteLoader.tsx","utf8");
  assert.match(api,/hasRole\(profile, "owner"\)/);
  assert.match(api,/slot\.current_qty === null \|\| slot\.current_qty === undefined \? null/);
  assert.match(api,/current !== null && Number\.isSafeInteger\(current\)/);
  assert.match(api, /\{ count: "exact" \}/);
  assert.match(api, /stock\.length !== stockCount/);
  assert.match(ui, /state\.data\.omitted\.length > 0/);
  assert.match(ui, /not treated as zero stock/);
  assert.doesNotMatch(ui,/Number\(slot\.currentQty \?\? 0\)|Number\(slot\.capacity \?\? 10\)/);
  assert.doesNotMatch(api,/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
});
