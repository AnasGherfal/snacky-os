import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buyingPurchaseSource,parseBuyingPurchaseSource,buyingPurchaseQuantities} from '../src/lib/buying-purchase.ts';
import {validateBuyingCommand} from '../src/lib/buying-lists.ts';

const u=n=>`${n.toString().padStart(8,'0')}-1111-4111-8111-111111111111`;
const migration=readFileSync('supabase/migrations/20260924094936_buying_to_storage_v1.sql','utf8');
const action=readFileSync('src/lib/purchase-actions.ts','utf8');
const page=readFileSync('src/app/purchases/new/page.tsx','utf8');
const listPage=readFileSync('src/app/buying-lists/[id]/page.tsx','utf8');
const client=readFileSync('src/components/BuyingListClient.tsx','utf8');
const purchaseForm=readFileSync('src/components/PurchaseForm.tsx','utf8');
const api=readFileSync('src/app/api/buying-lists/route.ts','utf8');

test('purchase source round trips list and actual supplier identities',()=>{
 const source=buyingPurchaseSource(u(1),u(2));
 assert.deepEqual(parseBuyingPurchaseSource(source),{listId:u(1),supplierId:u(2)});
 for(const bad of ['',`buying:${u(1)}:no`,`restock:${u(1)}`])assert.equal(parseBuyingPurchaseSource(bad),null);
});

test('checked quantities derive exact units per actual store group',()=>{
 const group={supplier_id:u(2),store_name:'A',store_phone:null,item_count:2,bought_boxes:3,linked_purchase:{purchase_id:null,status:null,total_amount:null,received_at:null,receiving_storage_location_id:null,receipt_number:null,voided_at:null},items:[
  {product_id:u(3),name:'Water',bought_boxes:2,units_per_box:12,reference_unit_cost_lyd:1,reference_purchased_on:null,note:''},
  {product_id:u(4),name:'Juice',bought_boxes:1,units_per_box:24,reference_unit_cost_lyd:2,reference_purchased_on:null,note:''},
 ]};
 const quantities=buyingPurchaseQuantities(group);
 assert.equal(quantities.get(u(3)),24);assert.equal(quantities.get(u(4)),24);
});

test('buying item command requires actual supplier for bought or partial',()=>{
 const base={request_id:u(1),list_id:u(2),action:'item',revision:2,payload:{product_id:u(3),outcome:'bought',bought_boxes:2,note:'',actual_supplier_id:u(4)}};
 assert.doesNotThrow(()=>validateBuyingCommand(base));
 assert.throws(()=>validateBuyingCommand({...base,payload:{...base.payload,actual_supplier_id:null}}));
 assert.doesNotThrow(()=>validateBuyingCommand({...base,payload:{...base.payload,outcome:'unavailable',bought_boxes:0,note:'Out',actual_supplier_id:null}}));
});

test('actual store is limited to required or approved alternative in database command',()=>{
 assert.match(migration,/Record the store actually used/);
 assert.match(migration,/Choose the required store or approved alternative/);
 assert.match(migration,/source\.primary_store/);
 assert.match(migration,/source\.alternative_store/);
 assert.match(client,/Store actually used/);
 assert.match(client,/required/);
 assert.match(client,/alternative/);
});

test('bridge groups one real purchase per actual store and same buyer owns create and receive',()=>{
 assert.match(migration,/primary key\(list_id,supplier_id\)/i);
 assert.match(migration,/po\.created_by is distinct from me/i);
 assert.match(migration,/po\.received_by is distinct from me/i);
 assert.match(migration,/The same buyer must receive this purchase into storage/i);
 assert.match(listPage,/Each actual store becomes one purchase/);
});

test('link rejects quantity drift and duplicate replacement purchases',()=>{
 assert.match(migration,/Purchase quantities changed from the checked buying list/i);
 assert.match(migration,/full join actual/i);
 assert.match(migration,/already linked to another purchase/i);
 assert.match(migration,/pg_advisory_xact_lock/i);
});

test('bridge itself never writes inventory or Finance',()=>{
 assert.doesNotMatch(migration,/(?:insert\s+into|update|delete\s+from)\s+public\.(?:inventory_movements|financial_transactions|finance_opening_balances)\b/i);
 assert.match(action,/snacky_create_purchase_with_lines_v2/);
 assert.match(purchaseForm,/value="received"/);
 assert.match(purchaseForm,/Save and receive/);
});

test('buying purchase must match checked supplier and quantities before purchase RPC',()=>{
 assert.match(action,/supplier does not match the store used on the buying list/i);
 assert.match(action,/Purchase quantities changed from the checked buying list/i);
 assert.ok(action.indexOf('verifyBuyingPurchaseSource') < action.indexOf('supabase.rpc(PURCHASE_CREATE_RPC'));
 assert.match(action,/Enter the actual price paid for every item from the buying list/i);
});

test('successful purchase is linked back with same immutable submission identity',()=>{
 assert.match(action,/snacky_buying_purchase_link_v1/);
 assert.match(action,/request_id: clientSubmissionId/);
 assert.match(action,/do not create another purchase/i);
 assert.match(migration,/old\.actor<>auth\.uid\(\) or old\.request is distinct from p_command/i);
});

test('purchase page prefills supplier and checked boxes but leaves actual price blank',()=>{
 assert.match(page,/supplierId: group\.supplier_id/);
 assert.match(page,/boxesQty: item\.bought_boxes/);
 assert.match(page,/unitsPerBox: item\.units_per_box/);
 assert.match(page,/unitCost: 0/);
 assert.match(page,/unitCostBlank: true/);
 assert.match(page,/actual receipt prices/i);
});

test('completed list exposes purchase action without adding second-person handoff',()=>{
 assert.match(listPage,/Record purchase & put in storage/);
 assert.match(listPage,/same buyer/i);
 assert.doesNotMatch(migration,/received_by_required|warehouse_handoff|second_approver/i);
 assert.match(migration,/parent\.assigned_to<>me/i);
});

test('item API uses v2 actual-store command while all other checklist commands stay canonical',()=>{
 assert.match(api,/c\.action==='item'/);
 assert.match(api,/snacky_buying_item_result_v2/);
 assert.match(api,/snacky_buying_command_v1/);
});

test('new private tables are RLS protected with no direct authenticated grants',()=>{
 for(const table of ['item_result_commands','purchase_links','purchase_link_commands'])assert.match(migration,new RegExp(`alter table buying_private\\.${table} enable row level security`,'i'));
 assert.match(migration,/revoke all on buying_private\.item_result_commands,buying_private\.purchase_links,buying_private\.purchase_link_commands from public,anon,authenticated/i);
 assert.match(migration,/security invoker/i);
});

test('payment remains separate from buying and storage receipt',()=>{
 assert.match(action,/Save the purchase as unpaid, then record the actual supplier payment/i);
 assert.doesNotMatch(migration,/payment_status\s*=\s*'paid'|financial_transactions/i);
});
