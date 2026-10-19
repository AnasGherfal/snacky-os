import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read=p=>fs.readFileSync(p,'utf8');
const schema=read('supabase/migrations/20261019102000_repair_cashbox_manual_sales.sql');
const cash=read('supabase/migrations/20261019102500_repair_cashbox_reconciliation.sql');
const ui=read('src/components/RepairManualSales.tsx');
const api=read('src/app/api/operator/repair-sales/route.ts');
const id='11111111-1111-4111-8111-111111111111';
const task='22222222-2222-4222-8222-222222222222';
const product='33333333-3333-4333-8333-333333333333';
const sale='44444444-4444-4444-8444-444444444444';
const command=()=>({request_id:id,task_id:task,product_id:product,quantity:2,unit_price_lyd:5,stock_source:'machine',cash_in_machine:true,new_unrecorded_payment:true,notes:''});
function harness(options={}){
 const calls=[],paths=[];
 const profile=options.profile===undefined?{id,team_member_id:id,role:'operator',roles:['operator'],active_status:'active'}:options.profile;
 const db={rpc:async(name,args)=>{calls.push({name,args});return options.result??{data:{ok:true,request_id:id,task_id:task,sale_id:sale,cash_destination:'machine_cashbox',total_lyd:10},error:null};}};
 const imports={
  'next/server':{NextResponse:{json:(data,init)=>new Response(JSON.stringify(data),{...init,headers:{...init?.headers,'Content-Type':'application/json'}})}},
  'next/cache':{revalidatePath:p=>paths.push(p)},
  '@/lib/auth':{getCurrentProfile:async()=>profile,getAuthenticatedSupabaseServerClient:async()=>db},
  '@/lib/authz':{hasAnyRole:(p,roles)=>roles.some(r=>p.roles.includes(r))},
  '@/lib/crm-dispatch':{crmDispatchSameOrigin:r=>!r.headers.get('origin')||new URL(r.headers.get('origin')).origin===new URL(r.url).origin},
 };
 const exports={};vm.runInNewContext(ts.transpileModule(api,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:k=>{assert.ok(k in imports,k);return imports[k];},URL,Response,console});
 return {exports,calls,paths};
}
const request=(body,origin='https://snacky.test')=>new Request('https://snacky.test/api/operator/repair-sales',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});

test('repair entries extend the existing sales ledger rather than create another revenue source',()=>{
 assert.match(schema,/alter table public\.route_manual_sales/);
 assert.match(schema,/manual_sale_route_or_repair_scope/);
 assert.match(schema,/repair_task_id is null and route_id is not null and route_stop_id is not null/);
 assert.match(schema,/cash_destination='machine_cashbox'/);
 assert.doesNotMatch(schema,/insert into public\.financial_transactions|insert into public\.cash_collections|insert into public\.operator_debts/i);
});
test('sale and inventory posting share a transaction with exact immutable retry identity',()=>{
 for(const text of ['pg_advisory_xact_lock','repair_request is distinct from p_command','inventory_movements','repair_manual_sale','stock_source','v_balance<v_quantity'])assert.ok(schema.includes(text),text);
 assert.match(schema,/v_task\.assigned_to is distinct from v_me/);
 assert.match(schema,/repair_sales_no_direct_insert/);
 assert.match(schema,/repair_sales_no_direct_update/);
 assert.match(schema,/repair_source_route_id/);
});
test('cash is counted only in the corresponding machine interval and only once per calculation',()=>{
 assert.match(cash,/s\.machine_id=p_machine/);
 assert.match(cash,/s\.cash_deposited_at>p_start and s\.cash_deposited_at<=p_end/);
 assert.match(cash,/s\.status='confirmed'/);
 assert.match(cash,/v_total_manual_cash numeric\(12,2\):=0/);
 assert.match(cash,/if v_expected is not null then/);
 assert.match(cash,/manual_repair_cash_lyd/);
 assert.ok(!/set vms_expected_cash\s*=\s*vms_expected_cash\s*\+/i.test(cash));
});
test('repair UI confirms new payment and cash placed, and preserves uncertain request before network call',()=>{
 assert.ok(ui.indexOf('localStorage.setItem(key, JSON.stringify(command))')<ui.indexOf('fetch("/api/operator/repair-sales", {'));
 for(const text of ['cashConfirmed','newPayment','Retry saved sale','not already recorded in XY','this machine\'s cashbox','stock_source','recorded in XY'])assert.ok(ui.includes(text),text);
 assert.match(ui,/this form does not send an XY quantity command/);
});
test('unauthenticated user cannot create a sale',async()=>{
 const h=harness({profile:null});const r=await h.exports.POST(request(command()));assert.equal(r.status,403);assert.equal(h.calls.length,0);
});
test('another origin cannot submit a sale',async()=>{
 const h=harness();const r=await h.exports.POST(request(command(),'https://other.test'));assert.equal(r.status,403);assert.equal(h.calls.length,0);
});
for(const [name,patch] of [['cash not placed',{cash_in_machine:false}],['already paid',{new_unrecorded_payment:false}],['fractional units',{quantity:1.5}],['negative units',{quantity:-1}],['invalid source',{stock_source:'storage'}],['invalid price',{unit_price_lyd:0}],['missing task',{task_id:''}]])test(`invalid repair sale rejected: ${name}`,async()=>{
 const h=harness();const r=await h.exports.POST(request({...command(),...patch}));assert.equal(r.status,400);assert.equal(h.calls.length,0);
});
test('verified cashbox receipt is accepted and revalidates sales and inventory',async()=>{
 const h=harness();const r=await h.exports.POST(request(command()));assert.equal(r.status,200);assert.equal(h.calls[0].name,'snacky_create_repair_manual_sale_v1');assert.equal(h.calls[0].args.p_command.cash_in_machine,true);assert.ok(h.paths.includes('/sales'));assert.ok(h.paths.includes('/inventory/movements'));assert.ok(h.paths.includes(`/follow-ups/${task}`));
});
test('wrong cash destination receipt remains uncertain, never shows success',async()=>{
 const h=harness({result:{data:{ok:true,request_id:id,task_id:task,sale_id:sale,cash_destination:'operator'},error:null}});const r=await h.exports.POST(request(command()));assert.equal(r.status,503);assert.equal((await r.json()).retryable,true);
});
test('database validation rollback unlocks editing; unknown failure preserves the request',async()=>{
 for(const [code,status,retryable] of [['23514',409,false],['40001',409,false],['42883',503,true],['23505',503,true]]){
  const h=harness({result:{data:null,error:{code,message:'fixture'}}});const r=await h.exports.POST(request(command()));assert.equal(r.status,status);assert.equal((await r.json()).retryable,retryable);
 }
});
test('repair sale entry is in the authorized field task and operational revenue includes repairs',()=>{
 assert.match(read('src/app/follow-ups/[id]/page.tsx'),/RepairManualSales/);
 const summary=read('src/components/OperationalSalesSummary.tsx');
 assert.match(summary,/repair_task_id/);assert.match(summary,/machine_cashbox/);assert.match(summary,/props\.vmsRevenue \+ enteredRevenue/);
});
