import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import * as planner from '../src/lib/self-dispatch.ts';
import * as workflow from '../src/lib/self-dispatch-workflow.ts';
import * as duties from '../src/lib/self-dispatch-duties.ts';

const M='11111111-1111-4111-8111-111111111111';
const P='22222222-2222-4222-8222-222222222222';
const O='33333333-3333-4333-8333-333333333333';
const R='44444444-4444-4444-8444-444444444444';
const actor={id:O,team_member_id:O,role:'operator',roles:['operator'],active_status:'active',must_change_password:false};

function fixture(overrides={}) {
  return {
    machines:[{id:M,name:'Khalij',machine_code:'XY1',status:'active',location_id:null,refill_open_days:[1,2,3,4,5,6,7]}],
    latest_vms_stock_by_slot:[{machine_id:M,slot_code:'001',product_id:P,current_qty:0,capacity:8,captured_at:new Date().toISOString(),source_provider:'xy'}],
    machine_slots:[{id:'slot',machine_id:M,slot_code:'001',active:true}],
    routes:[],route_stops:[],team_members:[],smart_route_machine_context:[],locations:[],
    products:[{id:P,name:'Chocolate',category:'chocolate',active:true}],
    route_storage_stock_by_product:[{product_id:P,quantity_on_hand:8}],
    route_stock_lines:[],smart_route_slot_product_rules:[],smart_route_location_product_rules:[],...overrides,
  };
}
function database(rows, failTable=null) {
  const calls=[];
  const db={calls,from(table){
    const filters=[];let start=0,end=Infinity;
    const query={
      select(){return query;},order(){return query;},
      eq(key,value){filters.push(row=>row[key]===value);return query;},
      in(key,values){filters.push(row=>values.includes(row[key]));return query;},
      range(a,b){start=a;end=b;return query;},
      then(resolve,reject){
        calls.push({table,start,end});
        const result=table===failTable?{data:null,error:{message:'fixture read failure'}}:
          {data:(rows[table]||[]).filter(row=>filters.every(f=>f(row))).slice(start,end===Infinity?undefined:end+1),error:null};
        return Promise.resolve(result).then(resolve,reject);
      },
    };
    for(const method of ['insert','update','upsert','delete','rpc']) query[method]=()=>{throw new Error('Unexpected write: '+method);};
    return query;
  }};
  return db;
}

async function harness(rows=fixture(),profile=actor,failTable=null) {
  const db=database(rows,failTable);
  const context=vm.createContext({console,Date,Intl,URL,Request,Response,setTimeout,clearTimeout});
  const authz={canExecuteRoutes:p=>Boolean(p&&['operator','owner','admin','supervisor'].includes(p.role)),canManageOperations:p=>['owner','admin','supervisor'].includes(p.role)};
  const modules={
    'server-only':{},
    '@/lib/auth':{getCurrentProfile:async()=>profile},
    '@/lib/authz':authz,
    '@/lib/supabase-server':{getSupabaseAdminClient:()=>db},
    '@/lib/operator-route-access':{loadAccessibleOperatorIds:async()=>[O]},
    '@/lib/route-workflow':{ROUTE_RESERVATION_STATUSES:['draft','assigned','in_progress','pickup_confirmed'],isRouteStopDoneStatus:s=>['completed','skipped'].includes(s)},
    '@/lib/self-dispatch':planner,
    '@/lib/self-dispatch-workflow':workflow,
    '@/lib/self-dispatch-duties':duties,
    'next/server':{NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),{status:options.status||200,headers:options.headers})}},
  };
  async function load(path) {
    const source=stripTypeScriptTypes(fs.readFileSync(path,'utf8'),{mode:'transform'});
    const module=new vm.SourceTextModule(source,{context,identifier:path});
    await module.link(async name=>{
      const values=modules[name];
      if(!values)throw new Error('Unmocked import '+name);
      const keys=Object.keys(values);
      return new vm.SyntheticModule(keys,function(){for(const key of keys)this.setExport(key,values[key]);},{context});
    });
    await module.evaluate();return module.namespace;
  }
  const server=await load('src/lib/today-work-server.ts');
  modules['@/lib/today-work-server']=server;
  const api=await load('src/app/api/operator/today-work/route.ts');
  return {db,server,api};
}
const request=body=>new Request('https://snacky.test/api/operator/today-work',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://snacky.test'},body:JSON.stringify(body)});

test('board GET is authenticated and explicitly not a dispatch authorization',async()=>{
  const {api}=await harness();const response=await api.GET();const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.dispatchEnabled,false);assert.equal(body.mode,'read_only_preview');
  assert.equal(body.board[0].empty,1);assert.ok(response.headers.get('Cache-Control').includes('no-store'));
  assert.equal(body.dailyCoverage.mode,'daily_coverage_preview');
  assert.equal(body.dailyCoverage.coordinatorEnabled,false);
  assert.equal('products' in body,false);assert.equal('routes' in body,false);
});
test('anonymous, disabled, viewer and password-reset accounts cannot preview',async()=>{
  for(const profile of [null,{...actor,active_status:'inactive'},{...actor,role:'viewer'},{...actor,must_change_password:true}]) {
    const {api}=await harness(fixture(),profile);assert.equal((await api.GET()).status,403);assert.equal((await api.POST(request({machineIds:[M]}))).status,403);
  }
});
test('preview returns a pickup list but makes no assignment or inventory change',async()=>{
  const rows=fixture(),before=JSON.stringify(rows);const {api}=await harness(rows);
  const response=await api.POST(request({machineIds:[M]}));const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.plan.totalUnits,8);assert.equal(body.plan.emptyAfter,0);
  assert.equal(body.dispatchEnabled,false);assert.equal(JSON.stringify(rows),before);
});
test('unknown machines, duplicate selections, extra quantities and operator overrides are rejected',async()=>{
  const {api}=await harness();
  for(const body of [{machineIds:[M,M]},{machineIds:[M],quantity:100},{machineIds:[M],operatorId:'other'},{machineIds:['bad']},{machineIds:[]}])assert.equal((await api.POST(request(body))).status,400);
  assert.equal((await api.POST(request({machineIds:['55555555-5555-4555-8555-555555555555']}))).status,409);
});
test('a newly assigned machine cannot be previewed as available work',async()=>{
  const rows=fixture({routes:[{id:R,operator_id:'other',status:'assigned',route_date:'2026-10-04'}],route_stops:[{id:'s',route_id:R,machine_id:M,status:'pending',stop_order:1}]});
  const {api}=await harness(rows);const board=await (await api.GET()).json();
  assert.equal(board.board[0].assignments.length,1);assert.equal(board.board[0].assignments[0].routeId,null);
  assert.equal((await api.POST(request({machineIds:[M]}))).status,409);
});
test('completed stops do not stay locked merely because the route has another open stop',async()=>{
  const {api}=await harness(fixture({routes:[{id:R,operator_id:O,status:'in_progress',route_date:'2026-10-04'}],route_stops:[{id:'s',route_id:R,machine_id:M,status:'completed',stop_order:1}]}));
  const body=await (await api.GET()).json();assert.equal(body.board[0].assignments.length,0);
});
test('active reservations reduce available preview quantities; completed routes do not',async()=>{
  for(const [status,expected] of [['assigned',3],['completed',8]]) {
    const {api}=await harness(fixture({routes:[{id:R,operator_id:O,status,route_date:'2026-10-04'}],route_stock_lines:[{id:'rsl',route_id:R,product_id:P,planned_qty:5,picked_qty:0}]}));
    const body=await (await api.POST(request({machineIds:[M]}))).json();assert.equal(body.plan.totalUnits,expected);
  }
});
test('unknown storage is not turned into usable stock',async()=>{
  const {api}=await harness(fixture({route_storage_stock_by_product:[{product_id:P,quantity_on_hand:null}]}));
  const body=await (await api.POST(request({machineIds:[M]}))).json();assert.equal(body.plan.totalUnits,0);assert.equal(body.plan.emptyAfter,1);
});
test('a failed read does not masquerade as zero stock',async()=>{
  const {api}=await harness(fixture(),actor,'route_storage_stock_by_product');
  assert.equal((await api.POST(request({machineIds:[M]}))).status,503);
});
test('pagination includes the second page rather than silently dropping lanes',async()=>{
  const slots=Array.from({length:501},(_,i)=>({id:String(i),machine_id:M,slot_code:String(i+1).padStart(3,'0'),active:true}));
  const {api,db}=await harness(fixture({machine_slots:slots}));
  const body=await (await api.GET()).json();assert.equal(body.board[0].lanes,501);assert.equal(body.board[0].unknown,500);
  assert.ok(db.calls.some(c=>c.table==='machine_slots' && c.start===500));
});
test('cross-origin preview requests are rejected',async()=>{
  const {api}=await harness();
  const response=await api.POST(new Request('https://snacky.test/api/operator/today-work',{method:'POST',headers:{Origin:'https://other.test'},body:JSON.stringify({machineIds:[M]})}));
  assert.equal(response.status,403);
});

test('GET exposes all required machines and does not treat a preview as a day assignment',async()=>{
  const M2='66666666-6666-4666-8666-666666666666';
  const base=fixture();
  base.machines.push({...base.machines[0],id:M2,name:'HT Mall'});
  base.machine_slots.push({id:'slot2',machine_id:M2,slot_code:'001',active:true});
  base.latest_vms_stock_by_slot.push({...base.latest_vms_stock_by_slot[0],machine_id:M2});
  const {api}=await harness(base);
  await api.POST(request({machineIds:[M]}));
  const response=await (await api.GET()).json();
  assert.equal(response.dailyCoverage.total,2);assert.equal(response.dailyCoverage.uncovered,2);
  assert.ok(response.dailyCoverage.rows.every(r=>r.deadline===null));
});
