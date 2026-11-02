import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { mergeOperatorXyLiveLayout } from "../src/lib/operator-xy-layout-reconciliation.ts";
import { reconcileRoutePlanogramToVerifiedXy } from "../src/lib/route-verified-xy-products.ts";
const read = (file) => fs.readFileSync(new URL("../"+file, import.meta.url), "utf8");
const XY = {
  luppo: "0157",twix: "0138",galaxy: "0139",snickers:"0145",
};
const ID = {
  luppo: "ee8c78aa-c80d-4fa6-930e-ee74c2862908",
  twix: "9c1c6d60-b8a2-4138-9016-056f1fd38e00",
  galaxy: "343d6dd5-f33d-4456-a4f1-ce04e3eb7acd",
};
const cached = (slotCode,vmsProductId,productId,productName,quantity,capacity) => ({
  slotCode,vmsProductId,productId,productName,vmsProductName:productName,
  imageUrl:"https://images.snacky.example/"+productId+".webp",
  currentQty:quantity,capacity,priceLyd:2,capturedAt:"2026-11-02T08:00:00Z",
  plannedProductId:productId,plannedProductName:productName,mismatch:false,
});
const live = (slotCode,vmsProductId,productId,productName,quantity,capacity) => ({
  slotCode,vmsProductId,productId,productName,imageUrl:null,
  currentQty:quantity,capacity,priceLyd:2,
});

test("partial direct XY response never erases Luppo or chocolate rolls known in latest verified XY stock",()=>{
  const previous=[
    cached("021",XY.twix,ID.twix,"Twix wafer roll",8,16),
    cached("022",XY.galaxy,ID.galaxy,"Galaxy wafer roll",10,16),
    cached("028",XY.luppo,ID.luppo,"Luppo",13,16),
  ];
  const fresh=[live("021",XY.twix,ID.twix,"Twix wafer roll",7,16)];
  const result=mergeOperatorXyLiveLayout(previous,fresh,[],"2026-11-02T10:40:00Z");
  assert.deepEqual(result.slots.map(s=>s.slotCode),["021","022","028"]);
  assert.deepEqual(result.fallbackSlotCodes,["022","028"]);
  assert.equal(result.slots[0].currentQty,7);
  assert.equal(result.slots[0].liveStockKnown,true);
  assert.equal(result.slots[1].productName,"Galaxy wafer roll");
  assert.equal(result.slots[1].currentQty,10);
  assert.equal(result.slots[1].liveStockKnown,false);
  assert.equal(result.slots[1].sourceState,"last_imported");
  assert.equal(result.slots[2].productId,ID.luppo);
  assert.equal(result.slots[2].imageUrl,previous[2].imageUrl);
  assert.equal(result.slots[2].currentQty,13);
});
test("a direct XY slot with blank vendor product identity does not look empty or lose its prior verified product",()=>{
  const previous=[cached("028",XY.luppo,ID.luppo,"Luppo",13,16)];
  const direct=[live("028",null,null,"",null,16)];
  const result=mergeOperatorXyLiveLayout(previous,direct,[],"2026-11-02T10:40:00Z");
  assert.equal(result.slots[0].productName,"Luppo");
  assert.equal(result.slots[0].vmsProductId,"0157");
  assert.equal(result.slots[0].sourceState,"last_imported");
  assert.equal(result.slots[0].liveStockKnown,false);
  assert.deepEqual(result.fallbackSlotCodes,["028"]);
});
test("a genuinely different vendor product never inherits the previous SKU, image or stock",()=>{
  const previous=[cached("028",XY.luppo,ID.luppo,"Luppo",13,16)];
  const direct=[live("028","0138",null,"Twix wafer roll",null,16)];
  const result=mergeOperatorXyLiveLayout(previous,direct,[],"2026-11-02T10:40:00Z");
  assert.equal(result.slots[0].vmsProductId,"0138");
  assert.equal(result.slots[0].productId,null);
  assert.equal(result.slots[0].productName,"Twix wafer roll");
  assert.equal(result.slots[0].imageUrl,null);
  assert.equal(result.slots[0].currentQty,0);
  assert.equal(result.slots[0].liveStockKnown,false);
  assert.deepEqual(result.fallbackSlotCodes,["028"]);
});
test("matching vendor ID can recover its verified Snacky product ID if an API mapping is temporarily missing",()=>{
  const previous=[cached("028",XY.luppo,ID.luppo,"Luppo",13,16)];
  const direct=[live("028",XY.luppo,null,"Luppo",12,16)];
  const result=mergeOperatorXyLiveLayout(previous,direct,[],"2026-11-02T10:40:00Z");
  assert.equal(result.slots[0].productId,ID.luppo);
  assert.equal(result.slots[0].imageUrl,previous[0].imageUrl);
  assert.equal(result.slots[0].currentQty,12);
  assert.equal(result.slots[0].liveStockKnown,true);
  assert.deepEqual(result.fallbackSlotCodes,[]);
});
test("complete vendor read uses its own matching product photograph and no stale catalog image",()=>{
  const previous=[cached("028",XY.luppo,ID.luppo,"Luppo",13,16)];
  const direct=[live("028",XY.twix,ID.twix,"Twix wafer roll",4,12)];
  const result=mergeOperatorXyLiveLayout(previous,direct,[{id:ID.twix,imageUrl:"https://images.snacky.example/twix.webp"}],"2026-11-02T10:40:00Z");
  assert.equal(result.slots[0].productId,ID.twix);
  assert.equal(result.slots[0].imageUrl,"https://images.snacky.example/twix.webp");
  assert.equal(result.slots[0].currentQty,4);
  assert.equal(result.slots[0].capacity,12);
  assert.equal(result.slots[0].mismatch,true);
});
test("vendor slot with no prior verified identity remains unverified, never falsely stocked",()=>{
  const result=mergeOperatorXyLiveLayout([],[live("036",null,null,"Brioche Dinar",null,8)],[],"2026-11-02T10:40:00Z");
  assert.equal(result.slots[0].productName,"Brioche Dinar");
  assert.equal(result.slots[0].liveStockKnown,false);
  assert.equal(result.slots[0].sourceState,"unverified");
});
test("route product picker displays today's assigned XY product, not obsolete planogram product",()=>{
  const rows=[{id:"slot",machine_id:"elite",slot_code:"028",product_id:ID.twix,par_qty:16,min_qty:2}];
  const stock=[{id:"xy",machine_id:"elite",slot_code:"028",product_id:ID.luppo,vms_product_name:"Luppo",current_qty:12,capacity:16}];
  const result=reconcileRoutePlanogramToVerifiedXy({planogram:rows,latestXy:stock});
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].product_id,ID.luppo);
  assert.equal(result.rows[0].par_qty,16);
  assert.deepEqual(result.unmapped,[]);
});
test("confirmed XY product without legacy planogram slot still appears in route candidate list",()=>{
  const stock=[{id:"xy",machine_id:"htland",slot_code:"021",product_id:ID.luppo,vms_product_name:"Luppo",current_qty:13,capacity:16}];
  const result=reconcileRoutePlanogramToVerifiedXy({planogram:[],latestXy:stock});
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].product_id,ID.luppo);
  assert.equal(result.rows[0].slot_code,"021");
});
test("unmapped XY slots are visible as unlinked, not mistaken for old planogram product",()=>{
  const old=[{id:"old",machine_id:"school",slot_code:"036",product_id:ID.twix,par_qty:8,min_qty:2}];
  const stock=[{id:"new",machine_id:"school",slot_code:"036",product_id:null,vms_product_name:"Brioche Dinar",current_qty:8,capacity:8}];
  const result=reconcileRoutePlanogramToVerifiedXy({planogram:old,latestXy:stock});
  assert.equal(result.rows[0].product_id,null);
  assert.deepEqual(result.unmapped,[{machineId:"school",slotCode:"036",xyProductName:"Brioche Dinar",currentQty:8,capacity:8}]);
});
test("live route and route creation use shared reconciled sources; full products no longer hidden",()=>{
  const stop=read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const create=read("src/app/routes/new/RouteCreateForm.tsx");
  const server=read("src/app/routes/new/page.tsx");
  assert.match(stop,/mergeOperatorXyLiveLayout/);
  assert.match(stop,/xyLiveState\.state === "partial"/);
  assert.match(server,/reconcileRoutePlanogramToVerifiedXy/);
  assert.match(server,/machinePlanogramRows=\{verifiedMachineProducts\.rows\}/);
  assert.match(server,/unmappedXyProductSlots=\{verifiedMachineProducts\.unmapped\}/);
  assert.match(create,/candidate\.sourceKinds\.has\("planogram"\)/);
  assert.match(create,/Assigned in XY · no refill suggested/);
  assert.match(create,/selectedUnmappedXyProductSlots/);
  assert.doesNotMatch(create,/otherConfiguredMachineProducts/);
  assert.match(create,/candidate\.recommendedQty > 0/);
});
