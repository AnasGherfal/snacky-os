import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';

const read=p=>fs.readFileSync(p,'utf8');
function load(file,imports){
  const exports={};
  const output=ts.transpileModule(read(file),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(output,{exports,console,URLSearchParams,Intl,Date,require:name=>{assert.ok(name in imports,`Unexpected dependency: ${name}`);return imports[name];}});
  return exports;
}
const domain=load('src/lib/crm-workspace.ts',{});
const helpers=load('src/lib/crm-lead-list.ts',{'./crm-workspace':domain});
const styles=new Proxy({},{get:(_target,key)=>String(key)});
const Link=({children,href,...props})=>React.createElement('a',{href,...props},children);
const tableModule=load('src/components/CrmLeadTable.tsx',{'react/jsx-runtime':jsx,'next/link':{__esModule:true,default:Link},'@/components/CrmLeadQuickLink':{CrmLeadQuickLink:()=>null},'@/lib/crm-workspace':domain,'@/lib/crm-lead-list':helpers,'./CrmLeads.module.css':{__esModule:true,default:styles}});
const id='11111111-1111-4111-8111-111111111111',me='22222222-2222-4222-8222-222222222222';
const row={id,kind:'lead',title:'Example school مدرسة تجريبية',status:'interested',assigned_to:me,assigned_name:'Relations fixture',next_action:'Call the decision-maker',due_date:'2026-09-20',due_time:'09:30:00',overdue:false,data:{area:'Ain Zara',place_type:'school',contact_phone:'0911234567',contact_person_name:'Office contact'}};
const workspace=()=>({me,staff:true,manager:true,total:48,offset:0,page_size:40,rows:[row],directory:[{id:me,name:'Relations fixture'}]});
function harness({profile={id:me,role:'crm',roles:['crm'],active_status:'active'},result=workspace(),error=null,ar=false,session=true}={}){
  const calls=[];
  const component=load('src/components/CrmLeadsWorkspace.tsx',{
    'react/jsx-runtime':jsx,'next/link':{__esModule:true,default:Link},'next/navigation':{redirect:path=>{throw Error('redirect:'+path);}},
    '@/lib/auth':{getCurrentProfile:async()=>profile,getAuthenticatedSupabaseServerClient:async()=>session?{rpc:async(...args)=>{calls.push(args);return {data:result,error};}}:null},
    '@/lib/authz':{hasAnyRole:(p,roles)=>(p.roles??[p.role]).some(r=>roles.includes(r))},
    '@/lib/i18n/server':{getServerI18n:async()=>({locale:ar?'ar':'en'})},
    '@/components/CrmLeadFocusList':{CrmLeadFocusList:()=>null},
    '@/lib/crm-lead-focus':{leadFocusEnabled:false,missingLeadFocus:()=>false},
    '@/components/CrmLeadQuickPanel':{CrmLeadQuickPanel:()=>null},'@/components/CrmClientTools':{CrmRefresh:()=>null},'@/components/CrmLeadTable':tableModule,
    '@/components/CrmLeadQuickLink':{CrmLeadQuickLink:()=>null},'@/lib/crm-workspace':domain,'@/lib/crm-lead-list':helpers,'./CrmLeads.module.css':{__esModule:true,default:styles},
  });
  return {calls,async render(params={}){return renderToStaticMarkup(await component.CrmLeadsWorkspace({searchParams:params}));}};
}
test('filter links preserve search and scope, reset pagination and never accept external paths',()=>{
  const filters=helpers.leadFilters({q:' test ',scope:'mine',area:'طرابلس',offset:'40',evil:'https://evil.example',status:['open']});
  assert.equal(filters.q,'test');assert.equal(filters.evil,undefined);assert.equal(filters.status,undefined);
  const url=new URL(helpers.leadListHref(filters,{window:'overdue'}),'https://snacky.example');
  assert.equal(url.pathname,'/locations-pipeline');assert.equal(url.searchParams.has('offset'),false);assert.equal(url.searchParams.get('scope'),'mine');assert.equal(url.searchParams.get('area'),'طرابلس');
  assert.equal(new URL(helpers.leadListHref(filters,{offset:'80'}),'https://snacky.example').searchParams.get('offset'),'80');
  assert.equal(helpers.leadFilters({offset:'-1'}).offset,undefined);assert.equal(helpers.leadPageRange(48,40,8),'41–48 / 48');
});
test('date-only formatting cannot shift the due day across timezones',()=>{
  assert.match(helpers.leadDate('2026-09-20',false),/20.*Sept?.*2026/);
  assert.equal(helpers.leadDate('2026-02-30',false),'Invalid date');assert.equal(helpers.leadDate(null,true),'لم يُحدد');
});
test('flag-off list uses exactly the original scoped CRM RPC with filters and no mutation',async()=>{
  const h=harness();const html=await h.render({q:'School',assigned_to:me,offset:'40',area:'Ain Zara'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'snacky_crm_workspace_v1');
  assert.equal(h.calls[0][1].p_section,'lead');assert.equal(h.calls[0][1].p_id,null);assert.equal(h.calls[0][1].p_filters.assigned_to,me);assert.equal(h.calls[0][1].p_filters.offset,'40');
  assert.match(html,/<table/);assert.match(html,/<caption/);assert.equal((html.match(/scope="col"/g)??[]).length,6);assert.match(html,/scope="row"/);
  assert.match(html,/method="get"/);assert.match(html,/name="q"/);assert.match(html,/name="status"/);assert.match(html,/name="assigned_to"/);
  for(const name of ['type','area','window','archived','practice','created_from','created_to'])assert.match(html,new RegExp('name="'+name+'"'));
  assert.match(html,/rel="next"/);assert.match(html,/offset=40/);assert.doesNotMatch(html,/type="checkbox"[^>]*name="select/);
});
test('only authorized list roles can query; denied users do not touch the database',async()=>{
  for(const profile of [null,{id:me,role:'crm',active_status:'inactive'},{id:me,role:'operator',active_status:'active'},{id:me,role:'investor',active_status:'active'}]){
    const h=harness({profile});await assert.rejects(()=>h.render(),/redirect:\/unauthorized/);assert.equal(h.calls.length,0);
  }
});
test('read failure, missing session and malformed data are never shown as no matching leads',async()=>{
  for(const options of [{error:{code:'42501'}},{session:false},{result:null},{result:{...workspace(),rows:null}},{result:{...workspace(),rows:[{...row,id:'invalid'}]}},{result:{...workspace(),rows:[{...row,kind:'issue'}]}}]){
    const html=await harness(options).render({q:'Keep this',offset:'40'});assert.match(html,/Leads unavailable/);assert.match(html,/Retry/);assert.doesNotMatch(html,/<table|No matching leads|Add lead/);assert.match(html,/Keep\+this/);assert.match(html,/offset=40/);
  }
});
test('empty assigned work gives the employee an honest actionable empty state',async()=>{
  const html=await harness({result:{...workspace(),rows:[],total:0}}).render({scope:'mine'});
  assert.match(html,/No assigned leads/);assert.match(html,/0 \/ 0/);assert.doesNotMatch(html,/<table/);assert.match(html,/No matching leads/);
});
test('all displayed status, missing ownership and due indicators retain independent meanings',()=>{
  const html=renderToStaticMarkup(React.createElement(tableModule.CrmLeadTable,{rows:[{...row,overdue:true,assigned_to:null,assigned_name:null,next_action:null,priority:'high',is_practice:true,archived:true}],ar:false}));
  for(const text of ['Interested','Overdue','Unassigned','Set a next action','High priority','Practice','Archived'])assert.ok(html.includes(text),text);
  assert.equal(html.includes('Name unavailable'),false);
});
test('row names and content are escaped, links stay on existing record paths and contact URLs are safe',()=>{
  const html=renderToStaticMarkup(React.createElement(tableModule.CrmLeadTable,{rows:[{...row,title:'<script>alert(1)</script>',data:{contact_phone:'javascript:alert(1)',contact_whatsapp:'https://bad',contact_email:'bad'}}],ar:false}));
  assert.ok(html.includes('&lt;script&gt;'));assert.doesNotMatch(html,/<script|href="javascript:|href="https:\/\/bad/);assert.ok(html.includes('/locations-pipeline/'+id));
  const good=renderToStaticMarkup(React.createElement(tableModule.CrmLeadTable,{rows:[row],ar:false}));
  assert.match(good,/href="tel:\+218911234567"/);assert.match(good,/href="https:\/\/wa.me\/218911234567"/);assert.match(good,/rel="noopener noreferrer"/);
});
test('Arabic is RTL and unrecorded values never become fake dates or people',async()=>{
  const html=await harness({ar:true,result:{...workspace(),rows:[{...row,assigned_to:null,assigned_name:null,due_date:null,next_action:null}]}}).render();
  for(const text of ['dir="rtl"','الجهات والزيارات','غير مسند','لم يُحدد موعد','حدّد الخطوة القادمة'])assert.ok(html.includes(text),text);
});
test('pagination retains all filters and rendering does not reorder the server page',async()=>{
  const a={...row,id:'33333333-3333-4333-8333-333333333333',title:'Z comes first'},b={...row,title:'A comes second'};
  const html=await harness({result:{...workspace(),offset:40,rows:[a,b],total:83}}).render({q:'kept',status:'interested',assigned_to:me,area:'West',window:'week',offset:'40'});
  assert.ok(html.indexOf('Z comes first')<html.indexOf('A comes second'));assert.match(html,/rel="prev"/);assert.match(html,/rel="next"/);assert.match(html,/41–42 \/ 83/);
  const links=[...html.matchAll(/<a\b[^>]*\brel="(?:prev|next)"[^>]*>/g)].map(x=>x[0].match(/href="([^"]+)"/)[1].replaceAll('&amp;','&'));
  assert.equal(links.length,2);for(const href of links){const u=new URL(href,'https://snacky.example');for(const [k,v] of Object.entries({q:'kept',status:'interested',assigned_to:me,area:'West',window:'week'}))assert.equal(u.searchParams.get(k),v);}
});
test('the list entry changes only presentation; detail/create/edit and business writers remain native',()=>{
  assert.match(read('src/app/locations-pipeline/page.tsx'),/CrmLeadsWorkspace/);
  assert.match(read('src/app/locations-pipeline/[id]/page.tsx'),/CrmWorkspace/);
  assert.match(read('src/app/locations-pipeline/new/page.tsx'),/CrmWorkspace/);
  for(const file of ['src/components/CrmLeadsWorkspace.tsx','src/components/CrmLeadTable.tsx','src/lib/crm-lead-list.ts'])assert.doesNotMatch(read(file),/getSupabaseAdminClient|SUPABASE_SERVICE|\.from\(|\.insert\(|\.update\(|\.delete\(|dangerouslySetInnerHTML/);
});
