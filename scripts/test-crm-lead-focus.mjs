import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
const read=p=>fs.readFileSync(p,'utf8');
function load(file,imports,globals={}){const exports={};const code=ts.transpileModule(read(file),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{exports,console,URL,URLSearchParams,Intl,Date,TextDecoder,Uint8Array,process:{env:{}},...globals,require:n=>{assert.ok(n in imports,`Unknown import ${n}`);return imports[n];}});return exports;}
const domain=load('src/lib/crm-workspace.ts',{}),focus=load('src/lib/crm-lead-focus.ts',{'./crm-workspace':domain}),helpers=load('src/lib/crm-lead-list.ts',{'./crm-workspace':domain});
const id='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222';
const command=()=>({request_id:id,action:'set',items:[{id,version:'2026-09-19 10:00:00+00',focus_revision:0}],assigned_to:person,until:'2026-09-25',next_action:'Find the decision-maker'});
const row={id,kind:'lead',title:'Research example',status:'want_to_contact',focused:true,focus_revision:1,focus_until:'2026-09-25',needs_research:true,assigned_to:person,assigned_name:'Fixture employee',data:{version:'2026-09-19 10:00:00+00'}};
const styles=new Proxy({},{get:(_t,k)=>String(k)}),Link=({children,...p})=>React.createElement('a',p,children);
const table=load('src/components/CrmLeadTable.tsx',{'react/jsx-runtime':jsx,'next/link':{__esModule:true,default:Link},'@/lib/crm-workspace':domain,'@/lib/crm-lead-list':helpers,'./CrmLeads.module.css':{__esModule:true,default:styles}});
test('focus is date-based, inclusive seven-day default, and can be switched off',()=>{
 assert.equal(focus.focusDefaultEnd('2026-09-19'),'2026-09-25');assert.equal(focus.focusDefaultEnd('2026-12-28'),'2027-01-03');assert.equal(focus.focusDate('2026-02-30'),false);
 assert.equal(load('src/lib/crm-lead-focus.ts',{'./crm-workspace':domain},{process:{env:{NEXT_PUBLIC_SNACKY_LEAD_FOCUS_ENABLED:'false'}}}).leadFocusEnabled,false);
});
test('focus request requires exact bounded selection and rejects duplicate or malformed records',()=>{
 assert.equal(focus.validateLeadFocusCommand(command()).items.length,1);
 for(const change of [{items:[]},{items:Array(21).fill(command().items[0])},{items:[command().items[0],command().items[0]]},{action:'delete'},{assigned_to:'no'},{until:'2026-02-30'},{next_action:'x'.repeat(1001)},{items:[{...command().items[0],focus_revision:-1}]},{items:[{...command().items[0],version:''}]},{unknown:true}])assert.throws(()=>focus.validateLeadFocusCommand({...command(),...change}));
 assert.doesNotThrow(()=>focus.validateLeadFocusCommand({...command(),action:'clear',assigned_to:null,until:null,next_action:null}));assert.throws(()=>focus.validateLeadFocusCommand({...command(),action:'clear'}));
});
test('success receipt must identify the exact request, action and every selected record',()=>{
 const c=command(),r={ok:true,request_id:c.request_id,action:c.action,count:1,ids:[id]};assert.equal(focus.confirmedFocusReceipt(c,r),true);
 for(const change of [{ok:false},{action:'clear'},{request_id:person},{ids:[person]},{count:0},{ids:[id,id]}])assert.equal(focus.confirmedFocusReceipt(c,{...r,...change}),false);
});
test('only a genuinely missing new RPC permits legacy fallback, never permission or network errors',()=>{
 assert.equal(focus.missingLeadFocus({code:'PGRST202',message:'Missing public.snacky_crm_lead_desk_v1'}),true);
 for(const error of [{code:'42501',message:'snacky_crm_lead_desk_v1'},{code:'PGRST202',message:'other function'},{code:'57014'},null])assert.equal(focus.missingLeadFocus(error),false);
});
test('focus and outcome filters persist across server pages rather than sorting a local page',()=>{
 const u=new URL(helpers.leadListHref({group:'active',focus:'active',scope:'mine',q:'school'},{offset:'40'}),'https://example.invalid');assert.equal(u.searchParams.get('focus'),'active');assert.equal(u.searchParams.get('group'),'active');assert.equal(u.searchParams.get('offset'),'40');
});
test('real table distinguishes employee assignment, focus, missing details and closed stages',()=>{
 const html=renderToStaticMarkup(React.createElement(table.CrmLeadTable,{rows:[row,{...row,id:person,status:'machine_placed',focused:false,needs_research:false}],ar:false,selection:{items:[],locked:false,toggle(){}}}));
 for(const text of ['Assigned to','Focus through','Contact details needed','Installed / operating'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/scope="col"/g)??[]).length,7);assert.match(html,/type="checkbox"[^>]*disabled=""/);assert.doesNotMatch(html,/>Owner</);
});
function workspace({enabled=true,error=null,result,firstMissing=false}={}){
 const calls=[],data=result??{me:person,staff:true,manager:true,today:'2026-09-19',focus_ready:true,focus_assignees:[{id:person,name:'Employee'}],rows:[row],directory:[{id:person,name:'Employee'}],total:1,offset:0,page_size:40};
 const c=load('src/components/CrmLeadsWorkspace.tsx',{'react/jsx-runtime':jsx,'next/link':{__esModule:true,default:Link},'next/navigation':{redirect:()=>{throw Error('denied');}},'@/lib/auth':{getCurrentProfile:async()=>({id:person,roles:['owner'],active_status:'active'}),getAuthenticatedSupabaseServerClient:async()=>({rpc:async(...args)=>{calls.push(args);return firstMissing&&calls.length===1?{error:{code:'PGRST202',message:'snacky_crm_lead_desk_v1'}}:{data,error};}})},'@/lib/authz':{hasAnyRole:()=>true},'@/lib/i18n/server':{getServerI18n:async()=>({locale:'en'})},'@/components/CrmClientTools':{CrmRefresh:()=>null},'@/components/CrmLeadTable':table,'@/components/CrmLeadFocusList':{CrmLeadFocusList:()=>React.createElement('p',null,'focus-selection')},'@/lib/crm-workspace':domain,'@/lib/crm-lead-list':helpers,'@/lib/crm-lead-focus':{...focus,leadFocusEnabled:enabled},'./CrmLeads.module.css':{__esModule:true,default:styles}});
 return {calls,render:async(params={})=>renderToStaticMarkup(await c.CrmLeadsWorkspace({searchParams:params}))};
}
test('enabled workspace asks the server for focus/global ordering and shows explicit outcome tabs',async()=>{
 const h=workspace(),html=await h.render({focus:'active',scope:'mine'});assert.equal(h.calls[0][0],'snacky_crm_lead_desk_v1');assert.equal(h.calls[0][1].p_filters.focus,'active');assert.match(html,/Agreed — awaiting placement|Agreed — awaiting/);assert.match(html,/Installed/);assert.match(html,/Declined/);assert.match(html,/focus-selection/);
});
test('absent migration retains standard list, but cannot silently ignore a focus filter',async()=>{
 const data={me:person,staff:true,manager:true,rows:[row],directory:[],total:1,offset:0,page_size:40};
 const h=workspace({firstMissing:true,result:data});const html=await h.render();assert.equal(h.calls.length,2);assert.equal(h.calls[1][0],'snacky_crm_workspace_v1');assert.match(html,/standard list/);
 const explicit=workspace({firstMissing:true});assert.match(await explicit.render({focus:'active'}),/Leads unavailable/);assert.equal(explicit.calls.length,1);
 const denied=workspace({error:{code:'42501'}});assert.match(await denied.render(),/Leads unavailable/);assert.equal(denied.calls.length,1);
 const disabled=workspace({enabled:false});assert.match(await disabled.render({focus:'active'}),/Leads unavailable/);assert.equal(disabled.calls.length,0);
});
const body=load('src/lib/company-request.ts',{});
function api({role='owner',dbError=null,badReceipt=false}={}){
 const calls=[],profile={id:person,roles:[role],active_status:'active'};
 const route=load('src/app/api/crm/lead-focus/route.ts',{'next/server':{NextResponse:{json:(data,{status=200,...rest}={})=>({data,status,...rest})}},'next/cache':{revalidatePath(){}},'@/lib/auth':{getCurrentProfile:async()=>profile,getAuthenticatedSupabaseServerClient:async()=>({rpc:async(name,args)=>{calls.push({name,args});return {error:dbError,data:{request_id:badReceipt?person:args.p_request_id,action:args.p_action,count:args.p_items.length,ids:args.p_items.map(x=>x.id)}};}})},'@/lib/authz':{hasAnyRole:(p,roles)=>roles.includes(p.roles[0])},'@/lib/company-request':body,'@/lib/crm-lead-focus':focus});
 return {calls,post:(c=command(),origin='https://snacky.example')=>route.POST(new Request('https://snacky.example/api/crm/lead-focus',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(c)}))};
}
test('actual command endpoint enforces origin and role before any mutation',async()=>{
 const foreign=api();assert.equal((await foreign.post(command(),'https://evil.example')).status,403);assert.equal(foreign.calls.length,0);
 for(const role of ['crm','operator','investor','viewer']){const h=api({role});assert.equal((await h.post()).status,403);assert.equal(h.calls.length,0);}
});
test('actual command endpoint uses authenticated RPC and distinguishes stale/error/uncertain success',async()=>{
 const h=api();assert.equal((await h.post()).status,200);assert.equal(h.calls[0].name,'snacky_crm_lead_focus_command_v1');assert.equal(h.calls[0].args.p_items[0].id,id);
 for(const [code,status] of [['42501',403],['40001',409],['23505',409],['22023',400],['PGRST202',503],['57014',503]])assert.equal((await api({dbError:{code}}).post()).status,status);
 assert.equal((await api({badReceipt:true}).post()).status,503);
 const large=api();assert.equal((await large.post({...command(),next_action:'x'.repeat(25000)})).status,413);assert.equal(large.calls.length,0);
});
test('name-only creation remains valid; native completion and relationship stages are not duplicated',()=>{
 const form=read('src/components/CrmRecordForms.tsx');assert.match(form,/A name is enough to start/);assert.match(form,/advanced:!row/);assert.match(form,/if\(d\.converted_location_id\)statusOptions.push/);
 assert.match(read('src/components/CrmRecordForms.tsx'),/A result is required before completing the task/);
 const migration=read('supabase/migrations/20260919162204_crm_lead_focus.sql');assert.doesNotMatch(migration,/create or replace function public\.snacky_crm_(?:command_v1|workspace_v1)|insert into public\.(?:crm_tasks|financial_transactions|inventory_movements|routes)/i);
 assert.match(migration,/result:=public\.snacky_crm_command_v1/);assert.match(migration,/order by importance,focus_until/);assert.match(migration,/crm_lead_private\.focus enable row level security/);
});
