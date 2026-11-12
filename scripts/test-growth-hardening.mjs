import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readCompleteList } from '../src/lib/complete-list-read.ts';
import { getPagination, totalPages, supabaseLikePattern } from '../src/lib/pagination.ts';
import { classifyPaymentTender, xyTransactionIdentity, cashAmountCents, withinCashInterval, tripoliHourKey } from '../src/lib/cash-interval-model.ts';
const source = p => readFileSync(p, 'utf8');
const rows = n => Array.from({length:n},(_,i)=>({id:`id-${i}`,units:i%24}));
const reader = (data, cap=1000) => {
  const requests=[];
  return { requests, fetch: async ({from,to,signal}) => {
    requests.push({from,to,signal});
    return {data:data.slice(from,Math.min(to+1,from+cap)),count:data.length,error:null};
  }};
};
test('one verified empty list is zero; missing data or missing count are not zero', async()=>{
  const empty=await readCompleteList(async()=>({data:[],count:0,error:null}),{key:r=>r.id});
  assert.deepEqual(empty,{data:[],count:0,error:null});
  for(const bad of [{data:null,count:0,error:null},{data:[],count:null,error:null}]){
    const r=await readCompleteList(async()=>bad,{key:r=>r.id});
    assert.equal(r.data,null);assert.equal(r.error.code,'READ_UNVERIFIED');
  }
});
test('large 50-machine route retains all 1,500 product rows beyond first page',async()=>{
  const r=reader(rows(50*30));
  const result=await readCompleteList(r.fetch,{key:r=>r.id});
  assert.equal(result.error,null);assert.equal(result.data.length,1500);
  assert.deepEqual(r.requests.map(r=>r.from),[0,500,1000]);
});
test('short API-capped pages do not silently end an incomplete result',async()=>{
  const r=reader(rows(1203),200);
  const result=await readCompleteList(r.fetch,{key:r=>r.id});
  assert.equal(result.count,1203);assert.equal(result.data.length,1203);
  assert.deepEqual(r.requests.map(r=>r.from),[0,200,400,600,800,1000,1200]);
});
test('20 concurrent independent users, each with 50 machines, keep data isolated',async()=>{
  const result=await Promise.all(Array.from({length:20},async(_,user)=>{
    const data=rows(50*30).map(r=>({...r,id:`user-${user}-${r.id}`}));
    const result=await readCompleteList(reader(data,200).fetch,{key:r=>r.id});
    assert.equal(result.data.length,1500);
    assert.ok(result.data.every(r=>r.id.startsWith(`user-${user}-`)));
    return result;
  }));
  assert.equal(result.reduce((sum,r)=>sum+r.data.length,0),30000);
});
test('source changing total, duplicate rows and premature empty page fail closed',async()=>{
  for(const second of [
    {data:[{id:'b'}],count:3,error:null},
    {data:[{id:'a'}],count:2,error:null},
    {data:[],count:2,error:null},
  ]){
    let call=0;
    const r=await readCompleteList(async()=>++call===1?{data:[{id:'a'}],count:2,error:null}:second,{key:r=>r.id,pageSize:1});
    assert.equal(r.data,null);assert.ok(r.error);
  }
});
test('later-page failure never leaks a plausible partial quantity',async()=>{
  let call=0;const denied={code:'42501',message:'permission denied'};
  const r=await readCompleteList(async()=>++call===1?{data:[{id:'a'}],count:2,error:null}:{data:null,count:null,error:denied},{key:r=>r.id,pageSize:1});
  assert.equal(r.data,null);assert.equal(r.error,denied);
});
test('read deadline, oversized lists and invalid configuration are bounded',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const r=await readCompleteList(async()=>{calls++;return{data:[],count:0,error:null}},{key:r=>r.id,signal:controller.signal});
  assert.equal(calls,0);assert.equal(r.error.code,'READ_TIMEOUT');
  const oversized=await readCompleteList(async()=>({data:rows(5),count:21,error:null}),{key:r=>r.id,maxRows:20});
  assert.equal(oversized.error.code,'READ_TOO_LARGE');
  for(const pageSize of [0,-1,NaN,1001,1.5]){
    const invalid=await readCompleteList(async()=>{throw Error('must not query')},{key:r=>r.id,pageSize});
    assert.equal(invalid.error.code,'READ_CONFIGURATION');
  }
});
test('repeated capped pages cannot loop forever',async()=>{
  let calls=0;
  const r=await readCompleteList(async()=>({data:[{id:String(++calls)}],count:1000,error:null}),{key:r=>r.id});
  assert.equal(r.data,null);assert.equal(calls,200);
});
test('strict URL pagination rejects partial strings, absurd offsets and unsafe integers',()=>{
  for(const page of ['3abc','1e9','1.5','-1','0','Infinity','9007199254740993','10001']){
    assert.equal(getPagination({page}).page,1,page);
  }
  assert.deepEqual(getPagination({page:'3',pageSize:'50'}),{page:3,pageSize:50,from:100,to:149});
  assert.equal(getPagination({pageSize:'500000'}).pageSize,25);
  assert.equal(totalPages(Infinity,25),1);assert.equal(totalPages(100,0),1);
  assert.equal(totalPages(51,25),3);
  assert.equal(supabaseLikePattern('100%_test'),'%100\\%\\_test%');
});
test('cashless and electronic payments are never classified as physical cash',()=>{
  for(const value of ['Cashless','cash-less','cash less','Card','VISA','wallet','QR','WeChat','بطاقة']) assert.equal(classifyPaymentTender(value),'card',value);
  for(const value of ['Cash','coin','Banknote','Bank notes','نقدي','كاش']) assert.equal(classifyPaymentTender(value),'cash',value);
  for(const value of ['',null,undefined,'cash / card','cash and cashless','unidentified']) assert.equal(classifyPaymentTender(value),'unknown',String(value));
});
test('machine name alone never merges distinct orders; stable IDs deduplicate imports',()=>{
  const a={id:'a',machine_code:'50',order_number:null};
  const b={id:'b',machine_code:'50',order_number:null};
  assert.notEqual(xyTransactionIdentity(a),xyTransactionIdentity(b));
  assert.equal(xyTransactionIdentity({...a,order_number:'o'}),xyTransactionIdentity({...b,order_number:'o'}));
  assert.notEqual(xyTransactionIdentity({...a,order_number:'o'}),xyTransactionIdentity({...b,machine_code:'51',order_number:'o'}));
  assert.notEqual(xyTransactionIdentity({...a,third_party_transaction_number:'o'}),xyTransactionIdentity({...b,order_number:'o'}));
});
test('malformed money is unavailable while explicit numeric zero remains valid',()=>{
  for(const input of [null,undefined,'',true,false,{},'1,000','12 LYD','1e2','-1',Infinity]) assert.equal(cashAmountCents(input),null,String(input));
  assert.equal(cashAmountCents('0'),0);assert.equal(cashAmountCents(0),0);
  assert.equal(cashAmountCents('12.30'),1230);assert.equal(cashAmountCents(1.005),101);
});
test('same-day cash uses previous-exclusive and current-inclusive exact seconds',()=>{
  const start='2026-11-05T05:14:22Z',end='2026-11-06T06:46:53Z';
  assert.equal(withinCashInterval(start,start,end),false);
  assert.equal(withinCashInterval(end,start,end),true);
  assert.equal(withinCashInterval('2026-11-06T06:46:54Z',start,end),false);
  assert.equal(withinCashInterval('bad',start,end),false);
  assert.equal(withinCashInterval(end,end,start),false);
  assert.equal(tripoliHourKey('2026-10-31T22:10:00Z'),'2026-11-01 00:00');
  assert.ok(tripoliHourKey('2026-10-31T20:00:00Z')<tripoliHourKey('2026-11-01T20:00:00Z'));
});
test('route screen removes a missing legacy payroll query and fails closed on incomplete stock',()=>{
  const route=source('src/app/routes/[id]/page.tsx');
  assert.doesNotMatch(route,/\.from\("route_pay_breakdowns"\)/);
  assert.match(route,/criticalRouteReadError/);
  assert.ok((route.match(/readCompleteList<any>/g)??[]).length>=6);
  assert.match(route,/href="\/payroll\/periods"/);
});
test('comparison deduplicates latest state before success filter, excludes missing money',()=>{
  const page=source('src/app/cash-collections/interval-comparison/page.tsx');
  assert.doesNotMatch(page,/\.eq\("transaction_status", "successful_sale"\)/);
  assert.ok(page.indexOf('seen.add(key)')<page.indexOf('if (row.transaction_status !== "successful_sale")'));
  assert.match(page,/cashAmountCents\(row.payment_amount\)/);
  assert.match(page,/withinCashInterval\(time, start, end\)/);
});
test('growth changes cannot mutate inventory, finance, auth or product definitions',()=>{
  for(const file of ['src/lib/complete-list-read.ts','src/lib/cash-interval-model.ts','src/lib/route-list-support.ts','src/lib/storage-inventory-data.ts']){
    assert.doesNotMatch(source(file),/\.(insert|upsert|update|delete|rpc)\s*\(/,file);
  }
});

test('restock reads never mutate stock and only fetch current-month sales and active reservations',()=>{
  const report=source('src/lib/restock-priority-data.ts');
  assert.doesNotMatch(report,/\.(insert|upsert|update|delete|rpc)\s*\(/);
  assert.match(report,/\.eq\("sales_month",salesMonth\)/);
  assert.match(report,/\.in\("routes.status",activeStatuses\)/);
  assert.match(report,/if \(errors.products \|\| storage.error\) return \{items:\[\]/);
  assert.match(report,/readCompleteList/);
  assert.match(report,/read-only fallback/);
});
test('XY intervals verify complete counts and use a shared query deadline',()=>{
  const page=source('src/app/cash-collections/interval-comparison/page.tsx');
  assert.match(page,/readCompleteList<RawSale>/);
  assert.match(page,/signal:readSignal/);
  assert.doesNotMatch(page,/offset \+= 1000/);
});

test('purchase detail uses explicit product foreign key and blocks incomplete receipts',()=>{
  const purchase=source('src/app/purchases/[id]/page.tsx');
  assert.match(purchase,/product:products!purchase_order_lines_product_id_fkey/);
  assert.ok((purchase.match(/readCompleteList<any>/g)??[]).length>=2);
  assert.match(purchase,/if \(linesError \|\| movementsError\)/);
  assert.match(purchase,/This is not an empty purchase/);
});
