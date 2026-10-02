import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/lib/crm-recurring.ts';
const id='11111111-1111-4111-8111-111111111111';
const input=()=>({title:'Monthly relationship check',instructions:'Record outcome',target_kind:'none',target_id:'',assigned_to:id,cadence:'months',every:1,start_on:'2027-01-31',end_on:'',notice_days:3});
test('monthly dates remain anchored through February, leap years and year rollover',()=>{
 assert.deepEqual(domain.routinePreview(input()),['2027-01-31','2027-02-28','2027-03-31']);
 assert.equal(domain.nextRoutineDate('2028-01-31','months',1,'2028-01-31'),'2028-02-29');
 assert.equal(domain.nextRoutineDate('2027-12-31','months',1,'2027-01-31'),'2028-01-31');
 assert.equal(domain.nextRoutineDate('2027-12-31','weeks',2,'2027-01-31'),'2028-01-14');
 assert.deepEqual(domain.routinePreview({...input(),end_on:'2027-02-28'}),['2027-01-31','2027-02-28']);
});
test('invalid dates, unsafe identities, unexpected fields and invalid intervals are rejected',()=>{
 for(const p of [{start_on:'2027-02-29'},{every:1.5},{every:0},{every:366},{notice_days:31},{notice_days:-1},{title:''},{target_kind:'location'},{assigned_to:'broken'},{end_on:'2020-01-01'},{cadence:'seconds'},{title:'x'.repeat(241)},{instructions:'x'.repeat(4001)},{extra:'ignore'}])assert.throws(()=>domain.validateRoutine({...input(),...p}));
 assert.equal(domain.validateRoutine(input()).title,input().title);
});
test('only known commands with exact stable identities are accepted',()=>{
 const c={request_id:id,id,action:'save',revision:0,payload:input()};assert.deepEqual(domain.validateRoutineCommand(c),c);
 for(const p of [{action:'delete'},{revision:-1},{id:'bad'},{request_id:'bad'}])assert.throws(()=>domain.validateRoutineCommand({...c,...p}));
});
function harness({stored,reply,storageFails=false}={}){
 const slots=[],effects=[],store=new Map(),calls=[];let cursor=0,sequence=0;
 const key=`snacky:crm-routine:v1:user:${id}:save:0`;if(stored)store.set(key,stored);
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,j)=>slots[i][j]!==d)){slots[i]=deps;effects.push(fn);}}};
 const exports={};const jsx=(type,props)=>({type,props});
 const imports={'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'next/navigation':{useRouter:()=>({refresh(){}})},'@/lib/crm-recurring':domain};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/CrmRoutineEditor.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,AbortController,setTimeout,clearTimeout,window:{confirm:()=>true},crypto:{randomUUID:()=>`22222222-2222-4222-8222-${String(++sequence).padStart(12,'0')}`},sessionStorage:{getItem:k=>{if(storageFails)throw Error();return store.get(k)??null;},setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},fetch:async(_url,options)=>{const c=JSON.parse(options.body);calls.push(c);return{json:async()=>reply?await reply(c):{ok:true,id:c.id,request_id:c.request_id}};},require:name=>{assert.ok(name in imports,name);return imports[name];}});
 const render=()=>{cursor=0;const result=exports.useRoutineCommand('user',id,'save',0,false);for(const effect of effects.splice(0))effect();return result;};render();return {render,calls,store,key,submit:()=>render().submit(input())};
}
test('actual form retains the exact save through response loss and reload',async()=>{
 const h=harness({reply:()=>({ok:false,retryable:true,code:'uncertain'})});await h.submit();await h.submit();assert.deepEqual(h.calls[0],h.calls[1]);
 const reload=harness({stored:h.store.get(h.key)});await reload.submit();assert.deepEqual(reload.calls[0],h.calls[0]);assert.equal(reload.store.size,0);await reload.submit();assert.equal(reload.calls.length,1);
});
test('actual form rejects corrupted/wrong-parent requests and prevents double submission',async()=>{
 for(const stored of ['{bad',JSON.stringify({request_id:id,id:'33333333-3333-4333-8333-333333333333',action:'save',revision:0,payload:input()})]){const h=harness({stored});await h.submit();assert.equal(h.calls.length,0);}
 const missing=harness({storageFails:true});await missing.submit();assert.equal(missing.calls.length,0);
 let resolve;const gate=new Promise(r=>resolve=r);const h=harness({reply:()=>gate});const first=h.submit();await h.submit();assert.equal(h.calls.length,1);resolve({ok:false,retryable:true});await first;
});
test('actual form does not accept mismatched receipts; stale data cannot silently resubmit',async()=>{
 const h=harness({reply:c=>({ok:true,id:c.id,request_id:'wrong'})});await h.submit();assert.equal(h.store.size,1);assert.equal(h.render().done,false);
 const stale=harness({reply:()=>({ok:false,code:'conflict',retryable:false})});await stale.submit();await stale.submit();assert.equal(stale.calls.length,1);
});
test('read-only overview and isolated recurrence never write financial or inventory records',()=>{
 const sql=fs.readFileSync('supabase/migrations/20260916214951_crm_recurring_management.sql','utf8');
 assert.doesNotMatch(sql,/(insert into|update|delete from) public\.(financial_transactions|inventory_movements|routes|location_admin_obligations)/i);
 assert.match(sql,/insert into public\.crm_tasks/);assert.match(sql,/primary key\(routine_id,due_on\)/);
 assert.match(sql,/pg_try_advisory_xact_lock/);assert.match(sql,/for update skip locked/);
 assert.doesNotMatch(sql,/create or replace function public\.snacky_crm_(?:command_v1|workspace_v1|api_request_guard)/);
 assert.doesNotMatch(sql,/cron\.schedule\(/);assert.match(sql,/enabled boolean not null default false/);
});
