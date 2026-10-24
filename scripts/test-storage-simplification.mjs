import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeStorageOverview } from "../src/lib/storage-overview.ts";

const MAIN = "11111111-1111-4111-8111-111111111111";
const QA = "22222222-2222-4222-8222-222222222222";
const locations = [
  { id: MAIN, name: "MAIN", active: true },
  { id: QA, name: "[TEST ONLY] QA virtual storage", active: false },
];
const products = [
  { id: "water", name: "Water", active: true, min_storage_qty: 0 },
  { id: "chips", name: "Chips", active: true, min_storage_qty: 0 },
  { id: "old", name: "Retired Product", active: false },
  { id: "no-stock", name: "Zero Product", active: true },
];
const active = { id: "route1", route_date: "2026-10-24", status: "in_progress" };
const later = { id: "route2", route_date: "2026-10-25", status: "assigned" };
const input = {
  products, locations,
  balances: [
    {product_id:"water",location_id:MAIN,quantity_on_hand:20},
    {product_id:"chips",location_id:MAIN,quantity_on_hand:-2},
    {product_id:"old",location_id:MAIN,quantity_on_hand:4},
    {product_id:"water",location_id:QA,quantity_on_hand:9999},
  ],
  routeLines: [
    {route_id:"route1",product_id:"water",planned_qty:12,picked_qty:3,routes:active},
    {route_id:"terminal",product_id:"chips",planned_qty:50,picked_qty:0,routes:{id:"terminal",status:"completed"}},
  ],
  stopNeeds: [
    {route_id:"route1",product_id:"water",planned_quantity:100,routes:active},
    {route_id:"route2",product_id:"water",planned_quantity:3,routes:later},
  ],
  reservationsVerified:true,
};
const row = (result,id) => result.rows.find(row=>row.productId===id);

test("Storage excludes QA, preserves negatives, and includes zero active and stocked inactive products", () => {
  const x=computeStorageOverview(input);
  assert.equal(x.physicalUnits,22);
  assert.equal(x.stockedProducts,2);
  assert.equal(row(x,"water").physical,20);
  assert.equal(row(x,"chips").physical,-2);
  assert.equal(row(x,"chips").status,"negative");
  assert.equal(row(x,"old").physical,4);
  assert.equal(row(x,"no-stock").physical,0);
  assert.equal(x.rows.length,4);
});

test("active route reservations subtract picked quantity and never double-count fallback stop rows",()=>{
  const x=computeStorageOverview(input);
  const water=row(x,"water");
  assert.equal(water.reserved,12);
  assert.equal(water.available,8);
  assert.deepEqual(water.reservations.map(x=>x.routeId),["route1","route2"]);
  assert.equal(x.availableUnits,12);
});

test("an overbooked shelf is flagged, not shown as negative pickable stock",()=>{
  const x=computeStorageOverview({...input,balances:[{product_id:"water",location_id:MAIN,quantity_on_hand:3}]});
  assert.equal(row(x,"water").status,"overbooked");
  assert.equal(row(x,"water").reserved,12);
  assert.equal(row(x,"water").available,0);
});

test("failed reservation reads show unknown availability, not false zero or unrestricted stock",()=>{
  const x=computeStorageOverview({...input,routeLines:[],stopNeeds:[],reservationsVerified:false});
  assert.equal(x.availableUnits,null);
  assert.equal(row(x,"water").reserved,null);
  assert.equal(row(x,"water").available,null);
  assert.equal(row(x,"water").status,"unverified");
  assert.equal(row(x,"chips").physical,-2);
  assert.equal(row(x,"chips").status,"negative");
});

test("inactive products with pending route stock still surface as shortages",()=>{
  const x=computeStorageOverview({
    ...input,
    products:[...products,{id:"inactive-reserved",name:"Old But Reserved",active:false}],
    routeLines:[...input.routeLines,{route_id:"route2",product_id:"inactive-reserved",planned_qty:5,picked_qty:0,routes:later}],
  });
  assert.equal(row(x,"inactive-reserved").physical,0);
  assert.equal(row(x,"inactive-reserved").reserved,5);
  assert.equal(row(x,"inactive-reserved").status,"overbooked");
});

test("no active warehouse or malformed quantities fail closed",()=>{
  assert.throws(()=>computeStorageOverview({...input,locations:[{id:QA,name:"[TEST ONLY] QA",active:true}]}));
  assert.throws(()=>computeStorageOverview({...input,balances:[{product_id:"water",location_id:MAIN,quantity_on_hand:"NaN"}]}));
});

test("Storage page no longer creates competing buying advice or loads unrelated workspaces",()=>{
  const page=readFileSync("src/app/inventory/page.tsx","utf8");
  const loader=readFileSync("src/lib/storage-overview-data.ts","utf8");
  assert.match(page,/loadStorageOverview/);
  assert.match(page,/href="\/restock-priority\/purchase-list"/);
  assert.match(page,/href="\/inventory\/stocktake"/);
  assert.match(page,/href="\/inventory\/movements"/);
  assert.match(page,/reservationWarning/);
  assert.doesNotMatch(page,/loadRestockPriorityData|suggestedBuyQty|filteredOperatorBagRows|filteredMovements/);
  assert.doesNotMatch(loader,/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  assert.match(loader,/routes!inner\(id,route_date,status\)/);
  assert.match(loader,/\.in\("routes.status", routeStatuses\)/);
});
