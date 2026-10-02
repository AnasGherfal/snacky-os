import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {suggestVmsProduct} from '../src/lib/vms-mapping-suggestions.ts';

test('XY mapping suggestions stay review-only and require confidence',()=>{
 const products=[
  {id:'kitkat',name:'KitKat',sku:'0040',barcode:null},
  {id:'haribo',name:'Haribo',sku:'0049',barcode:null},
  {id:'schweppes',name:'Schweppes',sku:'70bdbe11',barcode:null},
  {id:'doritos',name:'Doritos nacho',sku:'12b96290',barcode:null},
 ];
 assert.equal(suggestVmsProduct({vmsProductName:'Kitkat 2 fingers'},products)?.product.id,'kitkat');
 assert.equal(suggestVmsProduct({vmsProductName:'Haribo bears'},products)?.product.id,'haribo');
 assert.equal(suggestVmsProduct({vmsProductName:'Schweppes bullet'},products)?.product.id,'schweppes');
 assert.equal(suggestVmsProduct({vmsProductName:'Completely unrelated product'},products),null);
});

test('exact XY id to Snacky SKU outranks fuzzy names',()=>{
 const products=[{id:'a',name:'Something',sku:'0200',barcode:null},{id:'b',name:'Brioche Dinar',sku:'other',barcode:null}];
 const result=suggestVmsProduct({vmsProductId:'0200',vmsProductName:'Brioche Dinar'},products);
 assert.equal(result?.product.id,'a');
 assert.equal(result?.reason,'Exact XY ID / Snacky SKU');
});

test('mapping screens expose suggestion review but do not auto-confirm it',()=>{
 const list=fs.readFileSync('src/app/vms-mappings/page.tsx','utf8');
 const edit=fs.readFileSync('src/app/vms-mappings/[id]/edit/page.tsx','utf8');
 assert.match(list,/Suggested Match/);
 assert.match(list,/Review suggestion/);
 assert.match(edit,/preselected this product for review only/);
 assert.match(edit,/choose the final mapping status yourself/);
});

test('XY health diagnoses stale links separately from offline no-stock machines',()=>{
 const admin=fs.readFileSync('src/app/admin/vms-api/page.tsx','utf8');
 assert.match(admin,/Not returned by current official XY machine sync/);
 assert.match(admin,/currently offline and has no configured stock lanes/);
 assert.match(admin,/vms_last_synced_at/);
 assert.match(admin,/vms_online_status/);
});
