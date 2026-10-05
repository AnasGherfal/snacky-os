import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import * as planner from '../src/lib/smart-work-product-plan.ts';
import * as authz from '../src/lib/authz.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const profile={id:id(100),team_member_id:id(1),role:'operator',active_status:'active',must_change_password:false};
const person=(n=1,role='operator')=>({id:id(n),auth_user_id:id(100),role,roles:[role],active:true,active_status:'active'});
const duty=(n=21,m=11,owner=1)=>({id:id(n),machine_id:id(m),state:'required',priority:'urgent',owner_id:owner?id(owner):null,due_at:'2026-10-05T20:00:00Z',revision:1,blocker:null});
function fixture(extra={}){return {
  team_members:[person()],smart_work_duties:[duty()],machines:[{id:id(11),name:'Mall',machine_code:'M',status:'active',location_id:null}],routes:[],route_stops:[],route_stock_lines:[],
  products:[{id:id(41),name:'Chocolate',category:'chocolate',active:true}],route_storage_stock_by_product:[{product_id:id(41),quantity_on_hand:20}],
  machine_slots:[{id:id(31),machine_id:id(11),slot_code:'001',active:true}],
  latest_vms_stock_by_slot:[{machine_id:id(11),slot_code:'001',product_id:id(41),current_qty:0,capacity:8,captured_at:new Date().toISOString(),source_provider:'xy'}],
  smart_route_slot_product_rules:[],smart_route_location_product_rules:[],smart_route_machine_context:[],locations:[],...extra,
};}
async function harness({rows=fixture(),actor=profile,fail=null,onSecondActor=null}={}){
  const calls=[];let actorCalls=0;
  const db={from(table){const filters=[],orders=[];let from=0,to=Infinity;const q={
    select(fields){calls.push({table,fields});return q;},order(key){orders.push(key);return q;},range(a,b){from=a;to=b;return q;},
    eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},
    then(resolve,reject){let data=(rows[table]??[]).filter(r=>filters.every(f=>f(r)));for(const key of [...orders].reverse())data.sort((a,b)=>String(a[key]).localeCompare(String(b[key])));return Promise.resolve(table===fail?{data:null,error:{message:'denied'}}:{data:data.slice(from,to+1),error:null}).then(resolve,reject);},
  };for(const write of ['insert','update','delete','upsert','rpc'])q[write]=()=>{throw new Error('WRITE ATTEMPT');};return q;},rpc(){throw new Error('RPC WRITE ATTEMPT');}};
  const dependencies={'server-only':{},'node:crypto':{createHash},'@/lib/auth':{getCurrentProfile:async()=>{actorCalls++;if(actorCalls===2&&onSecondActor)onSecondActor(rows);return actor;}},'@/lib/authz':authz,'@/lib/supabase-server':{getSupabaseAdminClient:()=>db},'@/lib/route-workflow':{ROUTE_RESERVATION_STATUSES:['draft','assigned','in_progress','pickup_confirmed'],isRouteStopDoneStatus:s=>['completed','skipped'].includes(s)},'@/lib/smart-work-product-plan':planner,'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}}};
  const context=vm.createContext({Date,Intl,console,URL,TextDecoder,Uint8Array});
  async function module(path){const mod=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path,'utf8'),{mode:'transform'}),{context});await mod.link(async name=>{const values=dependencies[name];assert.ok(values,'unmocked '+name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});});await mod.evaluate();return mod.namespace;}
  const server=await module('src/lib/smart-work-products-server.ts');dependencies['@/lib/smart-work-products-server']=server;
  const api=await module('src/app/api/operator/product-plan/route.ts');
  return {calls,rows,server,api,post:(payload={dutyIds:[id(21)]},headers={})=>api.POST(new Request('https://snacky.test/api/operator/product-plan',{method:'POST',headers:{origin:'https://snacky.test','Content-Type':'application/json',...headers},body:typeof payload==='string'?payload:JSON.stringify(payload)}))};
}
test('real server and endpoint generate a plan without any writes',async()=>{const h=await harness(),before=JSON.stringify(h.rows),r=await h.post(),p=await r.json();assert.equal(r.status,200);assert.equal(p.plan.totalUnits,8);assert.equal(p.dispatchEnabled,false);assert.equal(JSON.stringify(h.rows),before);assert.ok(h.calls.every(c=>!c.fields.includes('*')));});
test('inactive unauthenticated wrong-role and password-change actors are denied',async()=>{for(const actor of [null,{...profile,role:'viewer'},{...profile,active_status:'inactive'},{...profile,must_change_password:true}]){const h=await harness({actor});const r=await h.post();assert.equal(r.status,403);assert.equal(h.calls.length,0);}});
test('current database identity is rechecked, not only cached profile',async()=>{const h=await harness({rows:fixture({team_members:[{...person(),active:false}]})});assert.equal((await h.post()).status,403);});
test('operator cannot preview another operator duty',async()=>{const h=await harness({rows:fixture({smart_work_duties:[duty(21,11,2)]})});assert.equal((await h.post()).status,403);assert.equal((await (await h.api.GET()).json()).choices.length,0);});
test('owner can preview unassigned requirements but cannot assign them through the endpoint',async()=>{const h=await harness({actor:{...profile,role:'owner'},rows:fixture({team_members:[person(1,'owner')],smart_work_duties:[duty(21,11,null)]})});assert.equal((await h.post()).status,200);assert.equal((await h.post({dutyIds:[id(21)],operatorId:id(1)})).status,400);assert.equal(h.rows.smart_work_duties[0].owner_id,null);});
test('one stop now leaves the remaining saved duties untouched and visible',async()=>{const h=await harness({rows:fixture({smart_work_duties:[duty(),duty(22,12),duty(23,13)]})}),before=JSON.stringify(h.rows.smart_work_duties);const r=await (await h.post()).json();assert.equal(r.otherRequired.length,2);assert.equal(JSON.stringify(h.rows.smart_work_duties),before);});
test('open existing route prevents a duplicate pickup preview',async()=>{const h=await harness({rows:fixture({routes:[{id:id(90),status:'assigned',operator_id:id(2)}],route_stops:[{id:id(91),route_id:id(90),machine_id:id(11),status:'pending'}]})});assert.equal((await h.post()).status,409);});
test('skipped stops do not block a new preview merely because their route is still active',async()=>{const h=await harness({rows:fixture({routes:[{id:id(90),status:'assigned',operator_id:id(2)}],route_stops:[{id:id(91),route_id:id(90),machine_id:id(11),status:'skipped'}]})});assert.equal((await h.post()).status,200);});
test('verification-pending and in-progress duties are not new trip candidates',async()=>{for(const state of ['verification_pending','in_progress']){const h=await harness({rows:fixture({smart_work_duties:[{...duty(),state}]})});assert.equal((await h.post()).status,409);}});
test('saved availability blocker is visible and prevents a product preview',async()=>{const h=await harness({rows:fixture({smart_work_duties:[{...duty(),blocker:'owner_unavailable_today'}]})});const menu=await (await h.api.GET()).json();assert.equal(menu.choices[0].unavailable,'owner_unavailable_today');assert.equal((await h.post()).status,409);});

test('active reservations subtract only the unpicked units',async()=>{const h=await harness({rows:fixture({routes:[{id:id(90),status:'assigned',operator_id:id(2)}],route_stock_lines:[{id:id(91),route_id:id(90),product_id:id(41),planned_qty:17,picked_qty:2}]})});const r=await(await h.post()).json();assert.equal(r.plan.totalUnits,5);assert.equal(r.plan.status,'partial');});
test('picked quantities are not subtracted from warehouse twice',async()=>{const h=await harness({rows:fixture({routes:[{id:id(90),status:'in_progress',operator_id:id(2)}],route_stock_lines:[{id:id(91),route_id:id(90),product_id:id(41),planned_qty:20,picked_qty:20}]})});assert.equal((await(await h.post()).json()).plan.totalUnits,8);});
test('unknown reservation quantity withholds that product rather than inventing zero reserved',async()=>{const h=await harness({rows:fixture({routes:[{id:id(90),status:'assigned',operator_id:id(2)}],route_stock_lines:[{id:id(91),route_id:id(90),product_id:id(41),planned_qty:17,picked_qty:null}]})});assert.equal((await(await h.post()).json()).plan.totalUnits,0);});
test('changed reservation between reads rejects a stale preview',async()=>{const h=await harness({onSecondActor:rows=>rows.route_storage_stock_by_product[0].quantity_on_hand=1});assert.equal((await h.post()).status,409);});
test('ownership change between reads cannot leak another operators plan',async()=>{const h=await harness({onSecondActor:rows=>rows.smart_work_duties[0].owner_id=id(2)});assert.equal((await h.post()).status,403);});
test('failed storage, rule or snapshot read is an error, not empty safe data',async()=>{for(const fail of ['route_storage_stock_by_product','smart_route_slot_product_rules','latest_vms_stock_by_slot']){const h=await harness({fail});assert.equal((await h.post()).status,503);}});
test('catalog pagination includes the product on the second page',async()=>{const ps=Array.from({length:501},(_,i)=>({id:id(1000+i),name:'Item '+i,category:'chips',active:true}));const rows=fixture({products:ps,latest_vms_stock_by_slot:[{...fixture().latest_vms_stock_by_slot[0],product_id:id(1500)}],route_storage_stock_by_product:[{product_id:id(1500),quantity_on_hand:8}]});const h=await harness({rows});assert.equal((await(await h.post()).json()).plan.totalUnits,8);});
test('JSON fields cannot override quantities permissions or deadlines',async()=>{for(const extra of [{quantity:100},{operatorId:id(2)},{dueAt:'later'},{action:'start'}]){const h=await harness();assert.equal((await h.post({dutyIds:[id(21)],...extra})).status,400);}});
test('duplicate or missing selection and invalid UUIDs are rejected',async()=>{for(const dutyIds of [[],[id(21),id(21)],['not-a-uuid'],Array.from({length:7},(_,i)=>id(21+i))]){const h=await harness();assert.equal((await h.post({dutyIds})).status,400);}});
test('cross-origin and non-JSON requests are rejected before database reads',async()=>{const h=await harness();assert.equal((await h.post(undefined,{origin:'https://evil.test'})).status,403);assert.equal((await h.post(undefined,{'Content-Type':'text/plain'})).status,415);assert.equal(h.calls.length,0);});
test('oversized and malformed requests are rejected',async()=>{const h=await harness();assert.equal((await h.post('x'.repeat(5000))).status,413);assert.equal((await h.post('{no')).status,400);});
test('preview and menu responses prohibit caching',async()=>{const h=await harness();for(const r of [await h.post(),await h.api.GET()])assert.match(r.headers.get('cache-control'),/private, no-store/);});

test('unrecognized database roles fail closed using the real role normalizer',async()=>{const h=await harness({rows:fixture({team_members:[{...person(),role:'root',roles:['root']}]})});assert.equal((await h.post()).status,403);});
test('revoked execution roles reject a cached operator profile',async()=>{const h=await harness({rows:fixture({team_members:[{...person(),role:'viewer',roles:['viewer']}]})});assert.equal((await h.post()).status,403);});
test('database role arrays preserve legitimate operator access without granting manager scope',async()=>{const h=await harness({rows:fixture({team_members:[{...person(),role:'viewer',roles:['viewer','operator']}],smart_work_duties:[duty(),duty(22,12,2)]})});const r=await h.api.GET();const d=await r.json();assert.equal(r.status,200);assert.equal(d.scope,'mine');assert.equal(d.choices.length,1);});
test('execution role revoked during planning is rejected on recheck',async()=>{const h=await harness({onSecondActor:rows=>{rows.team_members[0].role='viewer';rows.team_members[0].roles=['viewer'];}});assert.equal((await h.post()).status,403);});
