import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {sameQuickProductRequest} from "../src/lib/quick-product-retry.ts";

const id="1880f1cd-f2d3-41c6-9a4a-a07f40f00360";
const request={
  id,name:"Mineral Water",requestedSku:null,barcode:"1234567891234",
  brand:"Company",category:"drink",sellingPrice:2.5,
};
const saved={
  id,name:"Mineral Water",sku:"SNK-P-0102",barcode:"1234567891234",
  brand:"Company",category:"drink",selling_price:"2.50",
};

test("identical product request with same UUID is a safe replay",()=>{
  assert.equal(sameQuickProductRequest(saved,request),true);
  assert.equal(sameQuickProductRequest(saved,{...request,requestedSku:"SNK-P-0102"}),true);
});

test("different product details must never be accepted under a prior request ID",()=>{
  for(const candidate of [
    {...request,id:"other"},
    {...request,name:"Mineral Water 500ml"},
    {...request,barcode:"another barcode"},
    {...request,brand:"Different company"},
    {...request,category:"snack"},
    {...request,sellingPrice:3},
    {...request,requestedSku:"OTHER-SKU"},
  ])assert.equal(sameQuickProductRequest(saved,candidate),false,JSON.stringify(candidate));
});

test("server checks existing UUID before generating SKU and uses database PK for concurrent writes",()=>{
  const server=readFileSync("src/lib/inventory-actions.ts","utf8");
  const section=server.slice(server.indexOf("export async function createQuickProduct("),
    server.indexOf("function simpleReason(",server.indexOf("export async function createQuickProduct(")));
  assert.match(section,/client_product_id/);
  assert.match(section,/sameQuickProductRequest/);
  assert.match(section,/if \(await findCommittedQuickProduct\(\)\)/);
  assert.ok(section.indexOf("if (await findCommittedQuickProduct())")
    < section.indexOf("await resolveProductSku("),
    "Retry must not create another generated SKU");
  assert.match(section,/id: clientProductId/);
  assert.match(section,/error\?\.code === "23505"/);
  assert.match(section,/idempotencyKey: clientProductId/);
  assert.doesNotMatch(section,/\.upsert\(/);
});

test("stock adjustment and product Add forms use synchronous locks and frozen request on retry",()=>{
  const ui=readFileSync("src/components/StockMovementForm.tsx","utf8");
  assert.match(ui,/if \(quickAddInFlightRef\.current \|\| quickAddRecoveryBlocked\) return/);
  assert.match(ui,/quickAddInFlightRef\.current = true/);
  assert.match(ui,/quickAddInFlightRef\.current = false/);
  assert.match(ui,/quickAddFrozenRequestRef\.current = formData/);
  assert.match(ui,/formData\.set\("client_product_id", clientProductId\)/);
  assert.match(ui,/createQuickProduct\(quickAddFrozenRequestRef\.current!\)/);
  assert.match(ui,/Retry saved product request/);
  assert.match(ui,/disabled=\{isPending \|\| Boolean\(quickAddFrozenRequestRef\.current\)\}/);
  assert.match(ui,/if \(adjustmentInFlightRef\.current \|\| adjustmentCompletedRef\.current\) return/);
  assert.match(ui,/aria-busy=\{adjustmentSaving\}/);
  assert.match(ui,/Saving storage adjustment/);
  assert.match(ui,/client_submission_id/);
});

test("a lost Quick Add response survives browser reload for the same signed-in owner",()=>{
  const page=readFileSync("src/app/inventory/movements/new/page.tsx","utf8");
  const ui=readFileSync("src/components/StockMovementForm.tsx","utf8");
  assert.match(page,/userId=\{profile\.id\}/);
  assert.match(ui,/snacky:stock-quick-product:v1:\$\{userId\}/);
  assert.match(ui,/sessionStorage\.getItem\(quickAddStorageKey\)/);
  assert.match(ui,/sessionStorage\.setItem\(quickAddStorageKey, JSON\.stringify/);
  assert.match(ui,/sessionStorage\.removeItem\(quickAddStorageKey\)/);
  assert.match(ui,/immutable\.set\("client_product_id", id\)/);
  assert.match(ui,/quickAddFrozenRequestRef\.current = immutable/);
  assert.match(ui,/quickAddRecoveryBlocked/);
  assert.match(ui,/Saved product request could not be recovered/);
  assert.match(ui,/String\(quickAddFrozenRequestRef\.current\.get\("name"\)/);
  assert.match(ui,/router\.refresh\(\)/);
  assert.match(ui,/Start a different product request/);
  assert.match(ui,/window\.confirm\("Check Products/);
});
