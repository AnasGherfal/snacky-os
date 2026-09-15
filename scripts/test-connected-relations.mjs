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
function harness({stored,respond,locale='en'}={}){
 const source=read('src/components/CrmForm.tsx');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const slots=[],effects=[];let cursor=0;
 const key='snacky:crm-command:v1:user:issue.save:new',storage=new Map(stored?[[key,stored]]:[]),calls=[],navigation=[];
 const jsx=(type,props)=>({type,props});
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){slots[i]=deps;effects.push(effect);}}};
 const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'next/navigation':{useRouter:()=>({push:path=>navigation.push(path),refresh(){}})},'@/components/I18nProvider':{useLanguage:()=>({locale})},'@/lib/crm-workspace':domain};
 const exports={};vm.runInNewContext(code,{exports,console,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:async(_url,options)=>{const request=JSON.parse(options.body);calls.push(request);return{json:async()=>respond?respond(request):{ok:true,href:'/issues/11111111-1111-4111-8111-111111111111'}};},require:name=>{assert.ok(imports[name],name);return imports[name];}});
 const render=()=>{cursor=0;const tree=exports.CrmForm({action:'issue.save',userId:'user',fields:[{name:'description',label:'Problem',value:'Fixture problem'}],submitLabel:'Save'});for(const effect of effects.splice(0))effect();return tree;};
 render();
 return {calls,storage,navigation,render,submit:()=>render().props.action()};
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
