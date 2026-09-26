import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {personalSections,parsePersonalResult,loadPersonalSection,loadPersonalWork,personalHref,firstWorkSection,personalOverdue} from '../src/lib/personal-work.ts';
import {canAccessPath,getDefaultPathForRole} from '../src/lib/authz.ts';
const uid=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const stamp='2026-09-26T12:00:00Z';
const empty=(section='cash',view='active',offset=0)=>({version:1,section,view,status:'ready',checked_at:stamp,offset,page_size:5,total:0,actions:0,totals:{active:0,upcoming:0,history:0},rows:[]});
const row=(n=1)=>({id:uid(n),target_id:uid(n),title:'Test box '+n,context:null,state:'cash_count',since:stamp,due_at:null,done:null,total:null,rank:1,actionable:true});
const page=(n=1,offset=0)=>({...empty('cash','active',offset),total:n,actions:n,totals:{active:n,upcoming:0,history:0},rows:Array.from({length:Math.min(5,Math.max(0,n-offset))},(_,i)=>row(offset+i+1))});
const read=p=>fs.readFileSync(p,'utf8');
function load(path,stubs){const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(name in stubs)return stubs[name];throw Error('Unexpected import '+name);},URL,AbortController,console});return module.exports;}
test('empty, restricted and unavailable remain distinct',async()=>{
 const ok=await loadPersonalSection(async()=>empty(),'cash');assert.equal(ok.status,'ready');assert.equal(ok.data.total,0);
 for(const raw of [null,{},[],{rows:[]}])assert.equal((await loadPersonalSection(async()=>raw,'cash')).status,'unavailable');
 const denied=await loadPersonalSection(async()=>({...empty('storage'),status:'restricted'}),'storage');assert.equal(denied.status,'restricted');assert.equal('data' in denied,false);
});
test('one failed module never hides the other personal queues',async()=>{
 const r=await loadPersonalWork(async s=>{if(s==='buying')throw Error('Missing source');return empty(s);});assert.equal(r.filter(x=>x.status==='ready').length,3);assert.equal(r.find(x=>x.section==='buying').status,'unavailable');
});
test('hanging reads time out and abort without fake zero counts',async()=>{
 let aborted=false;const r=await loadPersonalSection((_s,_v,_o,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));})),'cash','active',0,10);
 assert.equal(r.status,'unavailable');assert.equal(aborted,true);
});
test('five-row pagination preserves full totals and rejects short or duplicate pages',()=>{
 assert.equal(parsePersonalResult(page(7),'cash','active').data.total,7);
 assert.equal(parsePersonalResult(page(7,5),'cash','active',5).data.rows.length,2);
 for(const bad of [{...page(7),rows:page(7).rows.slice(1)},{...page(7),rows:[row(),row(),row(3),row(4),row(5)]},{...page(),totals:{active:0,upcoming:0,history:0}},{...page(),actions:2}])assert.throws(()=>parsePersonalResult(bad,'cash','active'));
});
test('responses are tied to view, section and offset',()=>{
 assert.throws(()=>parsePersonalResult(empty('cash','history'),'cash','active'));assert.throws(()=>parsePersonalResult(empty('buying'),'cash','active'));assert.throws(()=>parsePersonalResult(empty('cash','active',5),'cash','active',0));
});
test('private extras are never forwarded and unsafe targets fail',()=>{
 const v=page();v.rows[0].private_amount=12345;v.rows[0].customer_phone='secret';v.rows[0].href='https://evil.example';
 const parsed=parsePersonalResult(v,'cash','active');assert.equal('private_amount' in parsed.data.rows[0],false);assert.equal('href' in parsed.data.rows[0],false);
 assert.throws(()=>personalHref('cash','../finance'));
 for(const change of [{target_id:'javascript:evil'},{state:'stock_count'},{due_at:'yesterday'},{done:3,total:2},{actionable:'true'}])assert.throws(()=>parsePersonalResult({...page(),rows:[{...row(),...change}]},'cash','active'));
});
test('original controlled records are the only link destinations',()=>{
 assert.equal(personalHref('cash',uid(1)),'/cash-handling?id='+uid(1));assert.equal(personalHref('storage',uid(2)),'/buying-lists/'+uid(2));assert.equal(personalHref('stocktakes',uid(3)),'/inventory/stocktake?id='+uid(3));
});
test('priority selects actionable overdue work ahead of waiting records',()=>{
 const cash=parsePersonalResult(page(),'cash','active');const buy={...empty('buying'),total:1,actions:1,totals:{active:1,upcoming:0,history:0},rows:[{...row(2),state:'buying_shop',rank:0,due_at:'2026-09-25T22:00:00Z'}]};
 assert.equal(firstWorkSection([cash,parsePersonalResult(buy,'buying','active')]),'buying');
 assert.equal(personalOverdue(buy.rows[0],buy),true);assert.equal(personalOverdue({...buy.rows[0],actionable:false},buy),false);
 assert.equal(personalOverdue(buy.rows[0],{...buy,view:'history'}),false);
});
test('new path does not change existing finance, CRM or route landing permissions',()=>{
 for(const role of ['owner','admin','supervisor','operator','warehouse','purchasing'])assert.equal(canAccessPath({id:uid(1),role},'/my-day'),true);
 for(const role of ['crm','finance','viewer','investor'])assert.equal(canAccessPath({id:uid(1),role},'/my-day'),false);
 assert.equal(canAccessPath({id:uid(1),role:'warehouse',activeStatus:'inactive'},'/my-day'),false);
 assert.equal(getDefaultPathForRole('operator'),'/operator/routes');assert.equal(getDefaultPathForRole('warehouse'),'/inventory');assert.equal(getDefaultPathForRole('crm'),'/my-work');
 assert.equal(canAccessPath({id:uid(1),role:'operator',roles:['operator','warehouse']},'/finance'),false);
});
function context(profile){let calls=0;const mod=load('src/lib/personal-work-server.ts',{'server-only':{},'@/lib/auth':{getCurrentProfile:async()=>profile,getAuthenticatedSupabaseServerClient:async()=>{calls++;return null;}},'@/lib/authz':{hasAnyRole:(p,roles)=>roles.includes(p.role)},'@/lib/personal-work':{personalWorkRoles:['owner','admin','supervisor','operator','warehouse','purchasing']}});return {mod,calls:()=>calls};}
test('server denies inactive and non-operational sessions before database lookup',async()=>{
 for(const profile of [null,{role:'crm',active_status:'active'},{role:'investor',active_status:'active'},{role:'warehouse',active_status:'inactive'}]){const c=context(profile);assert.equal((await c.mod.personalWorkContext()).authorized,false);assert.equal(c.calls(),0);}
});
function api(authorized=true){let reads=0;const r=load('src/app/api/personal-work/route.ts',{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200,headers:init.headers})}},'@/lib/personal-work-server':{personalWorkContext:async()=>({authorized,read:()=>{}})},'@/lib/personal-work':{isPersonalSection:v=>personalSections.includes(v),isPersonalView:v=>['active','upcoming','history'].includes(v),loadPersonalSection:async(_reader,section,view)=>{reads++;return {section,view,status:'unavailable'};}}});return {r,reads:()=>reads};}
test('GET-only API rejects account selectors, duplicate keys, off-grid offsets and invalid views',async()=>{
 const {r,reads}=api();for(const query of ['section=cash&user_id='+uid(2),'section=cash&assigned_to='+uid(2),'section=cash&section=buying','section=cash&offset=1','section=cash&offset=-5','section=cash&view=all','section=finance'])assert.equal((await r.GET(new Request('https://os.test/api/personal-work?'+query))).status,400);
 assert.equal(reads(),0);assert.equal(r.POST,undefined);assert.equal(r.PUT,undefined);assert.equal(r.DELETE,undefined);
 const failure=await r.GET(new Request('https://os.test/api/personal-work?section=cash'));assert.equal(failure.status,503);assert.equal(failure.headers['Cache-Control'],'private, no-store');
});
test('unauthorized API calls perform no personal work reads',async()=>{
 const {r,reads}=api(false);assert.equal((await r.GET(new Request('https://os.test/api/personal-work?section=cash'))).status,403);assert.equal(reads(),0);
});
test('read-only database projection has no employee parameter, business mutations or table grants',()=>{
 const sql=read('supabase/migrations/20260926134530_personal_work_today_v1.sql');
 assert.doesNotMatch(sql,/\b(create table|insert into|update public\.|delete from|grant select|financial_transactions)\b/i);
 assert.match(sql,/actor uuid:=auth.uid\(\)/);assert.match(sql,/where a.assigned_to=actor/);assert.match(sql,/where l.assigned_to=member_id/);assert.match(sql,/link.buyer_id=member_id/);assert.match(sql,/security invoker/);assert.match(sql,/stable security definer set search_path=''/);
 const server=read('src/lib/personal-work-server.ts');assert.doesNotMatch(server,/getSupabaseAdminClient|SERVICE_ROLE|p_user|p_employee/);assert.match(server,/getAuthenticatedSupabaseServerClient/);
});
test('interface opens records without creating commands or duplicate task actions',()=>{
 const ui=read('src/components/PersonalWorkToday.tsx');assert.doesNotMatch(ui,/method:\s*['"](?:POST|PATCH|DELETE|PUT)|snacky_.*command/);assert.match(ui,/unknown—not zero/);assert.match(ui,/waiting on someone else/);assert.match(ui,/personalHref\(selected,row.target_id\)/);assert.match(ui,/requests.current.get\(section\)===controller/);
 assert.match(read('src/components/Sidebar.tsx'),/href: "\/my-day"/);assert.match(read('src/components/Topbar.tsx'),/pathname === "\/my-day"/);
});
