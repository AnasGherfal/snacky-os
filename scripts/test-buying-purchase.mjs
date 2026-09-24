import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {receiptCents,receiptFileMatches,validateBuyingReceiptCommand,buyingReceiptResultMatches} from '../src/lib/buying-purchase.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const migration=read('supabase/migrations/20260924112418_buying_purchase_link_v1.sql');
const api=read('src/app/api/buying-lists/purchases/route.ts');
const ui=read('src/components/BuyingPurchaseClient.tsx');
const id='11111111-1111-4111-8111-111111111111';
const command=()=>({request_id:id,list_id:id,revision:1,action:'create',payload:{supplier_id:id,order_date:'2026-09-24',receipt_number:'TEST',lines:[{product_id:id,boxes:1,loose:0,line_total_cents:1250}],storage_id:null,placed_in_storage:false,note:'',receipt_sha256:'a'.repeat(64),receipt_mime:'image/png',receipt_name:'receipt.png'}});

test('money entry is exact cents, not floating-point guessing',()=>{
 assert.equal(receiptCents('12.50'),1250);assert.equal(receiptCents('0.10'),10);assert.equal(receiptCents('86'),8600);
 for(const value of ['','0','-1','1.111','NaN','1e3','12,50','0x12'])assert.throws(()=>receiptCents(value));
});
test('receipt command accepts same-person draft or explicitly confirmed storage',()=>{
 const c=command();assert.deepEqual(validateBuyingReceiptCommand(c),c);
 c.payload.placed_in_storage=true;assert.throws(()=>validateBuyingReceiptCommand(c));c.payload.storage_id=id;assert.deepEqual(validateBuyingReceiptCommand(c),c);
});
test('unknown fields and unauthorised extra payment parameters are rejected',()=>{
 const c=command();c.payload.payment_status='paid';assert.throws(()=>validateBuyingReceiptCommand(c));
 const extra=command();extra.actor_user_id=id;assert.throws(()=>validateBuyingReceiptCommand(extra));
});
test('null confirmations, fractional quantities and duplicate products fail closed',()=>{
 const c=command();c.payload.placed_in_storage=null;assert.throws(()=>validateBuyingReceiptCommand(c));
 const q=command();q.payload.lines[0].boxes=1.5;assert.throws(()=>validateBuyingReceiptCommand(q));
 const dup=command();dup.payload.lines.push({...dup.payload.lines[0]});assert.throws(()=>validateBuyingReceiptCommand(dup));
});
test('actual receipt date and actual line costs are required',()=>{
 const c=command();c.payload.order_date='2026-02-30';assert.throws(()=>validateBuyingReceiptCommand(c));
 const q=command();q.payload.lines[0].line_total_cents=0;assert.throws(()=>validateBuyingReceiptCommand(q));
});
test('receive command requires purchase version and positive physical confirmation',()=>{
 const c={request_id:id,list_id:id,revision:2,action:'receive',payload:{purchase_id:id,version:'2026-09-24 12:00:00+00',storage_id:id,confirmed:true}};
 assert.deepEqual(validateBuyingReceiptCommand(c),c);c.payload.confirmed=false;assert.throws(()=>validateBuyingReceiptCommand(c));
});
test('server verifies file signatures, not only browser-provided MIME',()=>{
 assert.equal(receiptFileMatches(new Uint8Array([137,80,78,71,13,10,26,10]),'image/png'),true);
 assert.equal(receiptFileMatches(new TextEncoder().encode('<html>not a receipt</html>'),'image/png'),false);
 assert.equal(receiptFileMatches(new TextEncoder().encode('%PDF-1.4'),'application/pdf'),true);
 assert.equal(receiptFileMatches(new Uint8Array([255,216,255,0]),'image/jpeg'),true);
});
test('only a matching canonical reply can clear a pending submission',()=>{
 const c=command(),r={ok:true,request_id:id,list_id:id,action:'create',revision:2,purchase_id:id,status:'received'};
 assert.equal(buyingReceiptResultMatches(c,r),true);assert.equal(buyingReceiptResultMatches(c,{...r,revision:3}),false);assert.equal(buyingReceiptResultMatches(c,{...r,action:'receive'}),false);
});
test('purchase and receiving use existing atomic writers, never direct stock inserts',()=>{
 assert.match(migration,/public\.snacky_create_purchase_with_lines_v2/);assert.match(migration,/public\.snacky_receive_purchase_v1/);
 assert.doesNotMatch(migration,/insert into public\.(inventory_movements|financial_transactions|purchase_orders|purchase_order_lines)\s*\(/i);
 assert.doesNotMatch(migration,/record_purchase_payment\s*\(/i);
});
test('source bridge checks assignee, approved supplier, bought units and stale versions',()=>{
 for(const fragment of ['l.assigned_to=buying_private.member()','l.revision<>rev','src.alternative_store','buying_private.invoiced_units','item.bought_boxes*item.units_per_box','po.updated_at::text'])assert.ok(migration.includes(fragment),fragment);
});
test('private data, canonical replies and evidence are protected',()=>{
 assert.match(migration,/purchase_links enable row level security/);assert.match(migration,/purchase_requests enable row level security/);
 assert.match(migration,/security invoker/);assert.match(migration,/prior\.request is distinct from p_command/);
 assert.match(api,/upsert:false/);assert.match(api,/createHash\('sha256'\)/);assert.match(api,/readCompanyBody/);
});
test('new invoice quantities are immutable without changing ordinary purchase writers',()=>{
 assert.match(migration,/exists\(select 1 from buying_private\.purchase_links where purchase_id=pid\)/);
 assert.match(migration,/Linked buying receipt quantities and prices are immutable/);
 assert.match(migration,/Recorded receipt quantities exceed this checklist change/);
});
test('screen separates buying, actual storage, and payment; protects uncertain requests',()=>{
 for(const text of ['No second employee is required.','Save purchase — not yet stored','Confirm placement in storage','Payments remain in the existing payment workflow','Retry same request','localStorage.setItem'])assert.ok(ui.includes(text),text);
 assert.match(ui,/dir=\{ar\?'rtl':'ltr'\}/);assert.match(ui,/receiptCents\(d\.total\)/);
});

test('store and storage controls expose distinct accessible names without option text',()=>{
 assert.ok(ui.includes('aria-label={ar?\'المتجر الفعلي\':\'Actual store\'}'));
 assert.ok(ui.includes('aria-label={ar?\'أين وضعت المنتجات؟\':\'Where did you place the goods?\'}'));
});
