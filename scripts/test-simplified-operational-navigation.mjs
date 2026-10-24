import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config=readFileSync("src/components/module-tabs-config.ts","utf8");
const storage=readFileSync("src/app/inventory/page.tsx","utf8");
const buying=readFileSync("src/app/restock-priority/purchase-list/page.tsx","utf8");
const reconciliation=readFileSync("src/app/inventory/reconciliation/page.tsx","utf8");
const stocktake=readFileSync("src/app/inventory/stocktake/page.tsx","utf8");
const movements=readFileSync("src/app/inventory/movements/page.tsx","utf8");

const group=(name)=>{
  const begin=config.indexOf(`const ${name}: ModuleTab[] = [`);
  assert.ok(begin>=0,name);
  const end=config.indexOf("\n];",begin);
  assert.ok(end>begin,name);
  return [...config.slice(begin,end).matchAll(/href: "([^"]+)"/g)].map(x=>x[1]);
};
test("Daily Stock has one recommendation page and only actionable tools",()=>{
  const routes=group("stockTabs");
  assert.deepEqual(routes.slice(0,4),["/inventory","/restock-priority/purchase-list","/purchases","/products"]);
  assert.equal(routes.includes("/restock-priority"),false,"Legacy recommendation dashboard should not compete with buying list");
  assert.equal(routes.includes("/inventory/stock-check"),false,"Monthly review should not appear as second stock count");
  assert.equal(routes.includes("/inventory/machine-storage"),false,"Machine stock remains diagnostic not the storage landing page");
  assert.equal(routes.includes("/inventory/movements/new"),false,"Manual corrections should be reachable from audit workflow, not main menu");
  assert.equal(routes.includes("/inventory/reconciliation"),true);
  assert.equal(routes.includes("/inventory/stocktake"),true);
  assert.equal(routes.includes("/inventory/movements"),true);
  assert.equal(routes.includes("/suppliers"),true);
});
test("Storage cards contain physical stock only; buying logic stays on the purchase page",()=>{
  const mobile=storage.slice(storage.indexOf("<MobileCardList>"),storage.indexOf("</MobileCardList>")+17);
  for(const label of ['"In storage"','"Reserved in storage"','"Available — no route"'])
    assert.ok(mobile.includes(label),label);
  assert.doesNotMatch(mobile,/MobileField label=\{tr\("Suggested buy"|MobileField label=\{tr\("Velocity"|MobileField label=\{tr\("Last cost"/);
  assert.doesNotMatch(storage,/Products with reservations/);
  assert.match(storage,/href="\/restock-priority\/purchase-list"/);
  assert.match(buying,/loadPurchaseListData/);
  assert.match(buying,/salesUnavailable/);
  assert.match(buying,/storageLoaded/);
  assert.match(buying,/Last month/);
  assert.match(buying,/This month/);
});
test("Inventory auditing and operator custody are preserved, not deleted",()=>{
  assert.match(storage,/Operator bag stock/);
  assert.match(storage,/Recent stock movements/);
  assert.match(storage,/reservation\.routeId/);
  assert.match(reconciliation,/Stock Reconciliation|Stock reconciliation/);
  assert.match(stocktake,/StorageStocktakeWorkspace/);
  assert.match(movements,/PageHeader/);
});
test("CRM and Reports keep core pages without extra duplicate dashboards",()=>{
  assert.deepEqual(group("crmTabs").slice(0,4),["/my-work","/issues","/locations-pipeline","/relationships"]);
  assert.deepEqual(group("reportsTabs"),["/reports","/sales","/reports/cash-reconciliation","/reports/route-performance","/reports/route-product-activity"]);
});
