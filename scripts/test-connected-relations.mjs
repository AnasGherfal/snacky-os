import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/lib/crm-workspace.ts';
import {canAccessPath,getDefaultPathForRole} from '../src/lib/authz.ts';
const read=file=>fs.readFileSync(file,'utf8');
const staff={id:'test',role:'crm',roles:['crm'],activeStatus:'active'};
test('customer relations has one home and no unrelated money/inventory/admin routes',()=>{
 assert.equal(getDefaultPathForRole(staff),'/my-work');
 for(const path of ['/my-work','/contacts','/relationships','/relationships/obligations','/follow-ups','/locations-pipeline','/issues'])assert.equal(canAccessPath(staff,path),true,path);
 for(const path of ['/finance','/inventory','/machines','/payroll','/settings','/team','/my-work/team'])assert.equal(canAccessPath(staff,path),false,path);
 assert.equal(canAccessPath({...staff,role:'operator',roles:['operator']},'/follow-ups'),true);
 assert.equal(canAccessPath({...staff,role:'investor',roles:['investor']},'/my-work'),false);
});
test('quick inputs preserve missing values, parse monetary fields and reject unsafe links',()=>{
 assert.deepEqual(domain.crmPayload({amount_involved_lyd:'5.50',machine_id:'',next_action_date:''}),{amount_involved_lyd:5.5,machine_id:null,next_action_date:null});
 assert.throws(()=>domain.crmPayload({amount_involved_lyd:'-1'}));
 assert.equal(domain.crmPhone('091 123 4567'),'218911234567');
 assert.equal(domain.crmContactLink('whatsapp','0911234567'),'https://wa.me/218911234567');
 assert.equal(domain.crmContactLink('email','bad address'),null);
 assert.equal(domain.crmHref('lead','bad/id'),'/locations-pipeline');
 assert.equal(domain.crmOverdue('2022-01-01',null,'2022-01-02','12:00','open'),true);
 assert.equal(domain.crmOverdue('2022-01-01',null,'2022-01-02','12:00','completed'),false);
});
function* walk(node){if(Array.isArray(node)){for(const item of node)yield*walk(item);return;}if(!node||typeof node!=='object')return;yield node;yield*walk(node.props?.children);}
function harness({stored,respond,locale='en',storageFails=false,action='issue.save',recordId=null,hidden={},stay=false}={}){
 const source=read('src/components/CrmForm.tsx');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const slots=[],effects=[];let cursor=0,sequence=0;
 const key=`snacky:crm-command:v2:user:${action}:${recordId??'new'}:${hidden.kind??'none'}:${hidden.related_id??'none'}`;
 const storage=new Map(stored?[[key,stored]]:[]),calls=[],navigation=[];
 const jsx=(type,props)=>({type,props});
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){slots[i]=deps;effects.push(effect);}}};
 const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'next/navigation':{useRouter:()=>({push:path=>navigation.push(path),refresh(){}})},'@/components/I18nProvider':{useLanguage:()=>({locale})},'@/lib/crm-workspace':domain};
 const exports={};vm.runInNewContext(code,{exports,console,AbortController,setTimeout,clearTimeout,crypto:{randomUUID:()=>`11111111-1111-4111-8111-${String(++sequence).padStart(12,'0')}`},localStorage:{getItem:k=>{if(storageFails)throw Error('Disabled');return storage.get(k)??null;},setItem:(k,v)=>{if(storageFails)throw Error('Disabled');storage.set(k,v);},removeItem:k=>storage.delete(k)},fetch:async(_url,options)=>{const request=JSON.parse(options.body);calls.push(request);return{json:async()=>respond?respond(request):{ok:true,commandId:request.id,id:request.recordId??'22222222-2222-4222-8222-222222222222',kind:action.split('.')[0]==='note'?hidden.kind:action.split('.')[0],href:'/issues/22222222-2222-4222-8222-222222222222'}};},require:name=>{assert.ok(imports[name],name);return imports[name];}});
 const render=()=>{cursor=0;const tree=exports.CrmForm({action,recordId,hidden,stay,userId:'user',fields:[{name:'description',label:'Problem',value:'Fixture problem'}],submitLabel:'Save'});for(const effect of effects.splice(0))effect();return tree;};
 render();
 return {calls,storage,key,navigation,render,submit:()=>render().props.action()};
}
test('actual quick form saves once and preserves exact request after an uncertain response',async()=>{
 const h=harness({respond:()=>({ok:false,message:'Uncertain'})});await h.submit();await h.submit();assert.equal(h.calls.length,2);assert.deepEqual(h.calls[0],h.calls[1]);assert.equal(h.storage.size,1);
 const restored=harness({stored:[...h.storage.values()][0]});await restored.submit();assert.deepEqual(restored.calls[0],h.calls[0]);assert.equal(restored.storage.size,0);await restored.submit();assert.equal(restored.calls.length,1);
});
test('corrupt saved requests stop duplicate writes and Arabic form uses RTL',async()=>{
 const h=harness({stored:'{bad'});await h.submit();assert.equal(h.calls.length,0);
 assert.equal(harness({locale:'ar'}).render().props.dir,'rtl');assert.equal(harness().render().props.dir,'ltr');
});
test('workspace links real records and keeps resolution separate from field completion',()=>{
 const ui=read('src/components/CrmWorkspace.tsx'),sql=read('supabase/migrations/20260915200100_connected_relations_commands.sql');
 assert.match(ui,/CrmFollowupForm/);assert.match(ui,/Activity history/);assert.match(ui,/Documents & proof/);assert.match(ui,/CrmRecordForm/);
 assert.match(sql,/Field action completed/);assert.match(sql,/Complete or cancel the pending field action before resolving/);
 assert.doesNotMatch(sql,/insert into public\.(financial_transactions|inventory_movements|payroll_runs)/i);
 assert.match(read('src/app/api/crm/documents/[id]/route.ts'),/private, no-store/);
});

test('blank optional URLs do not block quick leads and unsafe URLs are rejected before RPC',()=>{
 assert.deepEqual(domain.crmPayload({google_maps_url:'',website:''}),{google_maps_url:null,website:null});
 assert.throws(()=>domain.crmPayload({website:'javascript:alert(1)'}));
 assert.throws(()=>domain.crmPayload({website:'https://user:pass@example.com'}));
 assert.equal(domain.crmPayload({happened_at:'2025-01-01T12:30:10'}).happened_at,'2025-01-01T12:30:10+02:00');
});
test('new linked tasks cannot replay another parent record request',async()=>{
 const first=harness({action:'task.save',hidden:{kind:'issue',related_id:'22222222-2222-4222-8222-222222222222'},respond:()=>({ok:false,message:'Uncertain'})});
 await first.submit();const raw=[...first.storage.values()][0];
 const second=harness({action:'task.save',hidden:{kind:'issue',related_id:'33333333-3333-4333-8333-333333333333'},stored:raw});
 assert.notEqual(first.key,second.key);await second.submit();assert.equal(second.calls.length,0);
});
test('append-only notes require a deliberate new-entry action after success',async()=>{
 const h=harness({action:'note.add',recordId:'22222222-2222-4222-8222-222222222222',hidden:{kind:'issue'},stay:true});
 await h.submit();await h.submit();assert.equal(h.calls.length,1);
 const next=[...walk(h.render())].find(n=>n.type==='button'&&n.props.type==='button');assert.ok(next);next.props.onClick();
 await h.submit();assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].id,h.calls[1].id);
});
test('unavailable storage keeps an in-memory retry but corrupt storage never mints another request',async()=>{
 const h=harness({storageFails:true,respond:()=>({ok:false,message:'Uncertain'})});await h.submit();await h.submit();assert.equal(h.calls.length,2);assert.equal(h.calls[0].id,h.calls[1].id);
 const invalid=harness({respond:req=>({ok:true,commandId:'wrong',kind:'issue',id:req.id})});await invalid.submit();assert.equal(invalid.storage.size,1);
});
test('sidebar, operator entry, history paging, Finance selector and safe archive targets are connected',()=>{
 const sidebar=read('src/components/Sidebar.tsx'),ui=read('src/components/CrmWorkspace.tsx');
 assert.match(sidebar,/href: "\/my-work"/);assert.match(sidebar,/Customer issue tasks/);
 assert.match(read('src/app/operator/layout.tsx'),/Open customer tasks/);
 assert.match(ui,/history_offset/);assert.match(ui,/Older activity/);assert.match(ui,/finance_payments/);
 assert.match(ui,/open_issues/);assert.match(ui,/created_to/);assert.match(ui,/agreement_type/);
 assert.match(ui,/\['lead','issue','task','contact'\]\.includes\(section\)/);
});
