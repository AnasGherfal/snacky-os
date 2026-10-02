import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildXyReqData} from '../src/lib/xy-vms-protocol.ts';
import {buildXySlotProductWriteParams,XY_SLOT_PRODUCT_WRITE_ENDPOINT,XY_SLOT_PRODUCT_WRITE_FIELDS} from '../src/lib/xy-slot-write-contract.ts';

const control=fs.readFileSync('src/lib/xy-vms-control.ts','utf8');
const productRoute=fs.readFileSync('src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts','utf8');
const swapRoute=fs.readFileSync('src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-swap/route.ts','utf8');
const probe=fs.readFileSync('src/app/api/internal/xy-write-contract/route.ts','utf8');

test('XY slot product write contract is exactly the required six business fields',()=>{
 const params=buildXySlotProductWriteParams({
  merchantId:'6591',
  vmsMachineId:'2509000370',
  slotCode:'015',
  vmsProductId:'0032',
  productName:'Almarai Chocolate',
  priceLyd:4,
 });
 assert.equal(XY_SLOT_PRODUCT_WRITE_ENDPOINT,'addInstructionSpxxByApi');
 assert.deepEqual(XY_SLOT_PRODUCT_WRITE_FIELDS,['shbh','jqbh','hdbh','spbh','spmc','spjg']);
 assert.deepEqual(params,{shbh:'6591',jqbh:'2509000370',hdbh:'015',spbh:'0032',spmc:'Almarai Chocolate',spjg:400});
 assert.equal(buildXyReqData(params),'hdbh=015&jqbh=2509000370&shbh=6591&spbh=0032&spjg=400&spmc=Almarai Chocolate');
});

test('XY slot product write contract fails closed if a required field is blank',()=>{
 assert.throws(()=>buildXySlotProductWriteParams({merchantId:'6591',vmsMachineId:'2509000370',slotCode:'015',vmsProductId:'0032',productName:'',priceLyd:4}),/product name/);
});

test('XY slot product writes use the Swagger slot-product/price endpoint',()=>{
 assert.match(control,/XY_SLOT_PRODUCT_WRITE_ENDPOINT/);
 assert.doesNotMatch(control,/fetch\(\`\$\{config\.baseUrl\}\/addInstructionByApi/);
 assert.match(control,/buildXySlotProductWriteParams/);
 assert.match(control,/merchantId: config\.merchantId/);
 assert.match(control,/productName: args\.productName/);
});

test('product change and swap both share the corrected fail-closed writer',()=>{
 assert.match(productRoute,/setXySlotProduct/);
 assert.match(productRoute,/XY_WRITE_REJECTED/);
 assert.match(swapRoute,/setXySlotProduct/);
 assert.match(swapRoute,/rollback/);
});

test('safe contract probe no longer treats generic instruction endpoint as equivalent',()=>{
 assert.match(probe,/XY_SLOT_PRODUCT_WRITE_ENDPOINT/);
 assert.match(probe,/productName: "SNACKY CONTRACT PROBE"/);
 assert.match(probe,/priceLyd: 0\.01/);
 assert.doesNotMatch(probe,/addInstructionByApi/);
});
