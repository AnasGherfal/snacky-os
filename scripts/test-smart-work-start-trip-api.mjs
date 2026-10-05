import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as authz from '../src/lib/authz.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const productClient=fs.readFileSync('src/app/operator/product-plan/ProductPlanClient.tsx','utf8');
const actor={id:id(101),team_member_id:id(201),role:'operator',active_status:'active',must_change_password:false};
const person={id:id(201),auth_user_id:id(101),role:'operator',roles:['operator'],active:true,active_status:'active',must_change_password:false};
const fingerprint='a'.repeat(64);
const input=()=>({dutyIds:[id(301)],inputFingerprint:fingerprint,requestId:id(401)});
const plan=()=>({status:'complete',lanes:[{take:5}],emptyAfter:0,unknownAfter:0,underfilled:0,totalUnits:5,errors:[],generatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+240000).toISOString()});
class PlanError extends Error {constructor(message,status){super(message);this.status=status;}}
async function harness(o={}) {
 const calls=[],previews=[],receipts=o.receipts??[];
 const env={SMART_WORK_START_TRIP_ENABLED:o.enabled===false?'false':'true'};
 const rows={team_members:o.people??[person],smart_work_trip_requests:receipts,smart_work_dispatch_control:o.controls??[{id:1,enabled:true}]};
 const db={from(table){const filters=[];calls.push({read:table});const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},async maybeSingle(){return o.readFailure===table?{data:null,error:{message:'SECRET should not leak'}}:{data:rows[table].find(r=>filters.every(f=>f(r)))??null,error:null};}};for(const k of ['insert','update','delete','upsert'])q[k]=()=>{throw new Error('Unexpected direct write');};return q;},async rpc(name,params){calls.push({rpc:name,params});if(o.sqlError)return {data:null,error:{code:o.sqlError,message:'SECRET SQL details'}};const result={routeId:id(501),href:'https://untrusted.test',stopCount:params.p_duty_ids.length,reservedUnits:5,replayed:false};receipts.push({auth_user_id:params.p_auth_user,request_id:params.p_request,actor_id:params.p_actor,duty_ids:[...params.p_duty_ids].sort(),input_fingerprint:params.p_fingerprint,result});return o.lostResponse?{data:null,error:{code:'network'}}:{data:o.invalidReceipt?{}:result,error:null};}};
 const dependencies={'server-only':{},'@/lib/auth':{getCurrentProfile:async()=>o.actor===undefined?actor:o.actor},'@/lib/authz':authz,'@/lib/supabase-server':{getSupabaseAdminClient:()=>db},'@/lib/smart-work-products-server':{ProductPlanError:PlanError,previewRequiredProducts:async r=>{previews.push(r);if(o.planError)throw new PlanError('Plan changed.',o.planError);return {inputFingerprint:o.fingerprint??fingerprint,plan:{...plan(),...o.plan}};}}};
 const context=vm.createContext({Date,Response,URL,TextDecoder,Uint8Array,console,process:{env}});
 async function load(path){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path,'utf8'),{mode:'transform'}),{context});await m.link(async name=>{const values=dependencies[name];assert.ok(values,'Unexpected import '+name);return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});});await m.evaluate();return m.namespace;}
 const server=await load('src/lib/smart-work-start-trip-server.ts');dependencies['@/lib/smart-work-start-trip-server']=server;
 const api=await load('src/app/api/operator/start-trip/route.ts');
 const post=(body=input(),headers={})=>api.POST(new Request('https://snacky.test/api/operator/start-trip',{method:'POST',headers:{Origin:'https://snacky.test','Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}));
 return {post,server,api,env,calls,previews,receipts,rpcCalls:()=>calls.filter(c=>c.rpc)};
}
test('routine operator starts using one server transaction, not owner approval',async()=>{const h=await harness(),r=await h.post(),d=await r.json();assert.equal(r.status,201);assert.equal(h.rpcCalls().length,1);assert.equal(h.rpcCalls()[0].params.p_actor,id(201));assert.equal(h.rpcCalls()[0].params.p_auth_user,id(101));assert.equal(h.rpcCalls()[0].params.p_plan.totalUnits,5);assert.equal(d.href,'/operator/routes/'+id(501));});
test('repeated request returns saved route without rerunning the planner or reserving twice',async()=>{const h=await harness();await h.post();const r=await h.post(),d=await r.json();assert.equal(r.status,200);assert.equal(d.replayed,true);assert.equal(h.previews.length,1);assert.equal(h.rpcCalls().length,1);});
test('lost response is resolved with the same request ID',async()=>{const h=await harness({lostResponse:true});const first=await h.post();assert.equal(first.status,503);assert.equal((await first.json()).retryable,true);assert.equal((await h.post()).status,200);assert.equal(h.rpcCalls().length,1);});
test('pausing new dispatch still permits resolving a successful prior request',async()=>{const h=await harness();await h.post();h.env.SMART_WORK_START_TRIP_ENABLED='false';assert.equal((await h.post()).status,200);assert.equal(h.rpcCalls().length,1);});
test('order of selected duties is preserved for the input fingerprint',async()=>{const h=await harness(),ids=[id(303),id(301)];assert.equal((await h.post({...input(),dutyIds:ids})).status,201);assert.deepEqual([...h.previews[0].dutyIds],ids);assert.deepEqual([...h.rpcCalls()[0].params.p_duty_ids],ids);assert.equal((await h.post({...input(),dutyIds:ids})).status,200);});
test('request key reuse for different duties or fingerprint is rejected',async()=>{const h=await harness();await h.post();assert.equal((await h.post({...input(),dutyIds:[id(302)]})).status,409);assert.equal((await h.post({...input(),inputFingerprint:'b'.repeat(64)})).status,409);assert.equal(h.rpcCalls().length,1);});
test('feature disabled never plans or writes',async()=>{const h=await harness({enabled:false});assert.equal((await h.post()).status,503);assert.equal(h.previews.length,0);assert.equal(h.rpcCalls().length,0);});
test('availability needs both code and database release gates',async()=>{for(const o of [{enabled:false},{controls:[]},{controls:[{id:1,enabled:false}]},{readFailure:'smart_work_dispatch_control'}]){const h=await harness(o);assert.equal((await(await h.api.GET()).json()).enabled,false);assert.equal(h.rpcCalls().length,0);}});
test('unauthenticated inactive wrong-role or password-change profile cannot read privileged data',async()=>{for(const profile of [null,{...actor,active_status:'inactive'},{...actor,role:'viewer'},{...actor,must_change_password:true}]){const h=await harness({actor:profile});assert.equal((await h.post()).status,403);assert.equal(h.calls.length,0);}});
test('current database identity revocation overrides cached profile',async()=>{for(const p of [{...person,active:false},{...person,role:'viewer',roles:['viewer']},{...person,must_change_password:true},{...person,auth_user_id:id(102)}]){const h=await harness({people:[p]});assert.equal((await h.post()).status,403);assert.equal(h.rpcCalls().length,0);}});
test('client-supplied quantity actor deadline and plan overrides are rejected',async()=>{for(const extra of [{actorId:id(202)},{quantity:99},{plan:plan()},{dueAt:'tomorrow'},{admin:true}]){const h=await harness();assert.equal((await h.post({...input(),...extra})).status,400);assert.equal(h.calls.length,0);}});
test('invalid duplicate and excessive selected duties are rejected before reads',async()=>{for(const dutyIds of [null,[],[id(301),id(301)],['invalid'],Array.from({length:7},(_,i)=>id(301+i))]){const h=await harness();assert.equal((await h.post({...input(),dutyIds})).status,400);assert.equal(h.calls.length,0);}});
test('fingerprint change prevents any commit',async()=>{const h=await harness({fingerprint:'b'.repeat(64)});assert.equal((await h.post()).status,409);assert.equal(h.rpcCalls().length,0);});
test('partial blocked expired unknown and underfilled plans never commit',async()=>{for(const p of [{status:'partial'},{status:'blocked'},{emptyAfter:1},{unknownAfter:1},{underfilled:1},{errors:['missing slot']},{expiresAt:'invalid'},{expiresAt:new Date(0).toISOString()},{totalUnits:0}]){const h=await harness({plan:p});assert.equal((await h.post()).status,409);assert.equal(h.rpcCalls().length,0);}});
test('changed plan authorization is preserved',async()=>{const h=await harness({planError:403});assert.equal((await h.post()).status,403);assert.equal(h.rpcCalls().length,0);});
test('uncertain prior save never tries to start again blindly',async()=>{const h=await harness({readFailure:'smart_work_trip_requests'});const r=await h.post();assert.equal(r.status,503);assert.equal((await r.json()).retryable,true);assert.equal(h.rpcCalls().length,0);});
for(const [code,status,retryable] of [['42501',403,false],['40001',409,true],['55P03',409,true],['40P01',409,true],['23514',409,false],['23505',409,false],['22023',409,false],['55000',503,false],['network',503,true]])test(`SQL ${code} is returned safely`,async()=>{const h=await harness({sqlError:code});const r=await h.post(),d=await r.json();assert.equal(r.status,status);assert.equal(d.retryable,retryable);assert.doesNotMatch(d.error,/SECRET/);});
test('unconfirmed receipt directs retry instead of announcing success',async()=>{const h=await harness({invalidReceipt:true}),r=await h.post();assert.equal(r.status,503);assert.equal((await r.json()).retryable,true);});
test('cross-origin missing-origin and non-JSON requests cannot reach storage',async()=>{const h=await harness();assert.equal((await h.post(undefined,{Origin:'https://evil.test'})).status,403);assert.equal((await h.post(undefined,{Origin:''})).status,403);assert.equal((await h.post(undefined,{'Content-Type':'text/plain'})).status,415);assert.equal(h.calls.length,0);});
test('oversized streamed body and invalid JSON are rejected without reads',async()=>{const h=await harness();assert.equal((await h.post(' '.repeat(5000))).status,413);assert.equal((await h.post('{invalid')).status,400);assert.equal(h.calls.length,0);});
test('responses are private and never cached',async()=>{const h=await harness();for(const r of [await h.post(),await h.api.GET()])assert.match(r.headers.get('Cache-Control'),/no-store/);});


test('product plan UI exposes Start Trip only through the gated API contract',()=>{
  assert.match(productClient,/fetch\('\/api\/operator\/start-trip',\{cache:'no-store'\}\)/);
  assert.match(productClient,/Start Trip & reserve products/);
  assert.match(productClient,/dispatch\.enabled/);
  assert.match(productClient,/status==='complete'/);
  assert.match(productClient,/!expired/);
  assert.match(productClient,/!result\.higherPriorityRemaining/);
  assert.match(productClient,/allSelectedMine/);
  assert.match(productClient,/result\.plan\.totalUnits>0/);
});

test('product plan UI reuses one request ID across uncertain retries and never accepts browser quantities',()=>{
  assert.match(productClient,/startRequest=useRef/);
  assert.match(productClient,/crypto\.randomUUID\(\)/);
  assert.match(productClient,/requestId:request\.requestId/);
  assert.match(productClient,/inputFingerprint:request\.fingerprint/);
  assert.match(productClient,/dutyIds:request\.dutyIds/);
  assert.match(productClient,/if\(!data\.retryable\)startRequest\.current=null/);
  assert.doesNotMatch(productClient,/quantity:\s*result\.plan/);
});

test('successful UI start opens only the server-confirmed operator route',()=>{
  assert.match(productClient,/window\.location\.assign\(data\.href\)/);
  assert.match(productClient,/if\(!data\.href\|\|!data\.routeId\)/);
  assert.match(productClient,/href: `\/operator\/routes\/\$\{r\.routeId\}`/);
});
