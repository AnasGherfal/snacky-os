import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {operationSections,parseOperationData,loadOperationSection,loadOperations,waitingMinutes} from '../src/lib/owner-operations.ts';
const read=p=>fs.readFileSync(p,'utf8');
const id='11111111-1111-4111-8111-111111111111';
const valid=section=>({version:1,section,checked_at:'2026-09-26T10:00:00Z',offset:0,page_size:25,total:0,counts:{},rows:[],...(section==='notifications'?{diagnostics:{notifications_enabled:true,escalation_enabled:false,last_scan_at:null}}:{})});
const row={id,title:'Test record',context:null,person:'Test operator',state:'cash_count',since:'2026-09-26T09:00:00Z',due_at:null,href:'/cash-handling?id='+id};

test('known empty queue is different from failed data',async()=>{
 const empty=await loadOperationSection(async()=>valid('cash'),'cash');assert.equal(empty.status,'ready');assert.equal(empty.data.total,0);
 for(const value of [null,{},[],{rows:[]}]){const bad=await loadOperationSection(async()=>value,'cash');assert.equal(bad.status,'unavailable');assert.equal('data' in bad,false);}
});
test('one failed module does not hide four successful modules',async()=>{
 const result=await loadOperations(async section=>{if(section==='stocktakes')throw Error('Missing function');return valid(section);});
 assert.equal(result.length,5);assert.equal(result.filter(x=>x.status==='ready').length,4);assert.equal(result.find(x=>x.section==='stocktakes').status,'unavailable');
});
test('deadline aborts a hanging read without an empty success',async()=>{
 let aborted=false;const result=await loadOperationSection((_section,_offset,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('abort'));})),'cash',0,10);
 assert.equal(result.status,'unavailable');assert.equal(aborted,true);
});
test('correct pagination preserves full total and exact page size',()=>{
 const rows=Array.from({length:25},()=>({...row}));const v={...valid('cash'),total:27,counts:{cash_count:27},rows};assert.equal(parseOperationData(v,'cash').total,27);
 const second={...v,offset:25,rows:rows.slice(0,2)};assert.equal(parseOperationData(second,'cash',25).rows.length,2);
 assert.throws(()=>parseOperationData({...v,rows:rows.slice(0,24)},'cash'));
 assert.throws(()=>parseOperationData({...v,counts:{cash_count:26}},'cash'));
});
test('cross-module states and offsite links are rejected',()=>{
 for(const change of [{state:'crm_open'},{href:'https://evil.example/'+id},{href:'javascript:alert(1)'},{id:'not-an-id'},{since:'bad-date'}])assert.throws(()=>parseOperationData({...valid('cash'),total:1,counts:{cash_count:1},rows:[{...row,...change}]},'cash'));
});
test('unknown readiness is not counted as a working device',()=>{
 assert.throws(()=>parseOperationData({...valid('notifications'),diagnostics:undefined},'notifications'));
 assert.equal(parseOperationData(valid('notifications'),'notifications').diagnostics.escalation_enabled,false);
});
test('age uses the verified snapshot and never makes up negative elapsed time',()=>{
 assert.equal(waitingMinutes(row.since,'2026-09-26T10:00:00Z'),60);assert.equal(waitingMinutes(null,'2026-09-26T10:00:00Z'),null);assert.equal(waitingMinutes('2027-01-01T00:00:00Z','2026-09-26T10:00:00Z'),null);
});
function load(path,stubs){const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(name in stubs)return stubs[name];throw Error('Unexpected import '+name);},URL,AbortController,console});return module.exports;}
test('owner context denies staff/inactive accounts before obtaining a database client',async()=>{
 for(const profile of [null,{role:'operator',active_status:'active'},{role:'crm',active_status:'active'},{role:'warehouse',active_status:'active'},{role:'supervisor',active_status:'active'},{role:'owner',active_status:'inactive'}]){
  let calls=0;const mod=load('src/lib/owner-operations-server.ts',{'server-only':{},'@/lib/auth':{getCurrentProfile:async()=>profile,getAuthenticatedSupabaseServerClient:async()=>{calls++;throw Error('Denied account touched DB');}},'@/lib/authz':{isOwnerAdminRole:p=>['owner','admin'].includes(p?.role)}});
  assert.equal((await mod.ownerOperationsContext()).authorized,false);assert.equal(calls,0);
 }
});
test('endpoint refuses unauthorized reads before executing any reader',async()=>{
 let reads=0;const route=load('src/app/api/owner-operations/route.ts',{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200,headers:init.headers})}},'@/lib/owner-operations-server':{ownerOperationsContext:async()=>({authorized:false})},'@/lib/owner-operations':{isOperationSection:()=>true,loadOperations:async()=>{reads++;},loadOperationSection:async()=>{reads++;}}});
 assert.equal((await route.GET(new Request('https://os.test/api/owner-operations'))).status,403);assert.equal(reads,0);assert.equal(route.POST,undefined);
});
test('new database reader has no business mutations, ledger access or role grants',()=>{
 const sql=read('supabase/migrations/20260926104413_owner_operations_overview_v1.sql');
 assert.doesNotMatch(sql,/\b(insert into|update public\.|delete from|financial_transactions|count_denominations|unit_cost|total_amount)\b/i);
 assert.match(sql,/stable security definer/);assert.match(sql,/security invoker/);assert.match(sql,/array\['owner','admin'\]/);assert.match(sql,/limit 25 offset p_offset/);
 const server=read('src/lib/owner-operations-server.ts');assert.doesNotMatch(server,/getSupabaseAdminClient|SERVICE_ROLE/);assert.match(server,/active_status!=='active'/);
 const api=read('src/app/api/owner-operations/route.ts');assert.match(api,/private, no-store/);assert.doesNotMatch(api,/export async function (POST|PATCH|PUT|DELETE)/);
});
test('dashboard failure wording and real-record links remain explicit',()=>{
 const ui=read('src/components/OwnerOperationsOverview.tsx');assert.match(ui,/Their pending counts are unknown—not zero/);assert.match(ui,/This is not an empty queue/);assert.match(ui,/href=\{row.href\}/);assert.match(ui,/Number|metric\(/);assert.equal(operationSections.length,5);
});
