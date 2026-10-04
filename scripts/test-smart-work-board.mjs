import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as board from '../src/lib/smart-work-board.ts';
const now = new Date('2026-10-05T10:00:00Z');
const m = { id:'m',name:'Mall',expectedCodes:[],openDays:[1,2,3,4,5,6,7] };
const lane=(i,q=8,cap=8)=>({code:String(i).padStart(3,'0'),quantity:q,capacity:cap,capturedAt:now.toISOString(),productId:'p'});
const summary=(rows,machine=m)=>board.summarizeWorkMachine(machine,rows,now);
for(const [n,expected] of [[16,'today'],[19,'today'],[20,'urgent'],[24,'urgent'],[25,'immediate']]) {
  test(`${n} empty lanes use the approved ${expected} threshold`,()=>assert.equal(summary(Array.from({length:60},(_,i)=>lane(i+1,i<n?0:8))).priority,expected));
}
test('many low nonempty lanes elevate priority',()=>{const r=summary(Array.from({length:46},(_,i)=>lane(i+1,i<17?0:i<33?2:8)));assert.equal(r.priority,'urgent');assert.equal(r.low,16);});
test('an almost empty machine is immediate with no zero lanes',()=>assert.equal(summary(Array.from({length:40},(_,i)=>lane(i+1,1,16))).priority,'immediate'));
test('a single empty lane on a large machine is not immediate',()=>assert.equal(summary(Array.from({length:50},(_,i)=>lane(i+1,i?8:0))).priority,'monitor'));
test('smaller machines have ratio-based protection',()=>assert.equal(summary(Array.from({length:10},(_,i)=>lane(i+1,i<6?0:8))).priority,'immediate'));
test('missing expected lane is unknown, never healthy or zero',()=>{const r=summary([lane(1)],{...m,expectedCodes:['001','002']});assert.equal(r.unknown,1);assert.equal(r.empty,0);assert.equal(r.priority,'verify');assert.equal(r.averageLaneFullness,null);});
test('stale snapshots cannot look like current empty lanes',()=>{const r=summary([{...lane(1,0),capturedAt:'2026-10-04T10:00Z'}]);assert.equal(r.unknown,1);assert.equal(r.empty,0);assert.equal(r.priority,'verify');});
test('future timestamps are unknown',()=>assert.equal(summary([{...lane(1),capturedAt:'2026-10-05T12:00Z'}]).unknown,1));
test('synthetic historical VMS rows are excluded',()=>assert.equal(summary([lane(1),{...lane(2),code:'VMS-99'}]).lanes,1));
test('numeric lane aliases do not count twice',()=>assert.equal(summary([lane(1)],{...m,expectedCodes:['1','001']}).lanes,1));
test('conflicting duplicate observations do not look full or empty',()=>{const r=summary([lane(1,0),{...lane(1),code:'1'}]);assert.equal(r.unknown,1);assert.equal(r.empty,0);});
test('negative/null/over-capacity/nonfinite quantities remain unknown',()=>{for(const q of [null,undefined,-1,NaN,Infinity,9,true,'',[],{}])assert.equal(summary([{...lane(1),quantity:q}]).unknown,1);});
test('capacity must be positive and plausible',()=>{for(const cap of [null,0,-1,1001])assert.equal(summary([lane(1,0,cap)]).unknown,1);});
test('mapping and quantity uncertainty are distinct',()=>{const r=summary([{...lane(1),productId:null}]);assert.equal(r.unmapped,1);assert.equal(r.unknown,0);});
test('unknown lanes never inflate percentage-based urgency',()=>{const r=summary([lane(1,0)],{...m,expectedCodes:Array.from({length:50},(_,i)=>String(i+1))});assert.equal(r.priority,'verify');});
test('confirmed absolute urgency survives missing readings',()=>{const r=summary(Array.from({length:25},(_,i)=>lane(i+1,0)),{...m,expectedCodes:Array.from({length:100},(_,i)=>String(i+1))});assert.equal(r.priority,'immediate');assert.equal(r.unknown,75);});
test('unknown access days are not assumed open',()=>assert.equal(summary([lane(1)],{...m,openDays:null}).openToday,null));
test('closed sites retain visible urgency',()=>{const r=summary([lane(1,0)],{...m,openDays:[2]});assert.equal(r.openToday,false);assert.equal(r.priority,'immediate');});
test('Libya business day is independent of the phone timezone',()=>assert.equal(board.workDayInTripoli(new Date('2026-10-04T23:00Z')),'2026-10-05'));

const actor={id:'u',role:'operator',active_status:'active',must_change_password:false};
function fixture(extra={}) {return {
  machines:[{id:'m',name:'Mall',machine_code:'xy',status:'active',refill_open_days:[1,2,3,4,5,6,7]}],
  machine_slots:[{id:'s',machine_id:'m',slot_code:'001',active:true}],
  latest_vms_stock_by_slot:[{machine_id:'m',slot_code:'001',product_id:'p',current_qty:0,capacity:8,captured_at:now.toISOString(),source_provider:'xy'}],
  routes:[],route_stops:[],team_members:[],...extra,
};}
async function harness(rows=fixture(),profile=actor,fail=null) {
  const calls=[];
  const db={from(table){const filters=[];let start=0,end=Infinity;const q={
    select(fields){calls.push({table,fields});return q;}, order(){return q;},
    eq(key,value){filters.push(r=>r[key]===value);return q;},in(key,values){filters.push(r=>values.includes(r[key]));return q;},range(a,b){start=a;end=b;return q;},
    then(resolve,reject){return Promise.resolve(table===fail?{data:null,error:{message:'failed'}}:{data:(rows[table]||[]).filter(r=>filters.every(f=>f(r))).slice(start,end+1),error:null}).then(resolve,reject);},
  };for(const op of ['insert','upsert','update','delete','rpc'])q[op]=()=>{throw new Error('WRITE ATTEMPT');};return q;}};
  const deps={'server-only':{},'@/lib/auth':{getCurrentProfile:async()=>profile},'@/lib/authz':{canExecuteRoutes:p=>['operator','owner','admin','supervisor'].includes(p.role),canManageOperations:p=>['owner','admin','supervisor'].includes(p.role)},'@/lib/supabase-server':{getSupabaseAdminClient:()=>db},'@/lib/operator-route-access':{loadAccessibleOperatorIds:async()=>['noury']},'@/lib/route-workflow':{ROUTE_RESERVATION_STATUSES:['draft','assigned','in_progress','pickup_confirmed'],isRouteStopDoneStatus:s=>['completed','skipped'].includes(s)},'@/lib/smart-work-board':board};
  const context=vm.createContext({Date,Intl,console});
  const source=stripTypeScriptTypes(fs.readFileSync('src/lib/smart-work-board-server.ts','utf8'),{mode:'transform'});
  const mod=new vm.SourceTextModule(source,{context});
  await mod.link(async name=>{const values=deps[name];assert.ok(values,'unmocked import '+name);return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});});
  await mod.evaluate();return {read:()=>mod.namespace.loadSmartWorkBoard(now),calls};
}
const activeRoute=(op='noury',status='assigned')=>({id:'r',operator_id:op,status,route_date:'2026-10-04'});
const activeStop=(status='pending')=>({id:'rs',route_id:'r',machine_id:'m',status});
const person=(id='noury',active=true)=>({id,full_name:id,active,active_status:active?'active':'inactive'});
test('loader never writes or returns product/finance/cash data',async()=>{const rows=fixture(),before=JSON.stringify(rows),h=await harness(rows),r=await h.read();assert.equal(r.mode,'read_only');assert.equal(r.totals.uncovered,1);assert.equal(JSON.stringify(rows),before);assert.ok(h.calls.every(c=>!c.fields.includes('*')));assert.equal('products'in r,false);assert.equal('routes'in r,false);});
test('unauthorized actors cause no privileged reads',async()=>{for(const p of [null,{...actor,role:'viewer'},{...actor,role:'crm'},{...actor,active_status:'inactive'},{...actor,must_change_password:true}]){const h=await harness(fixture(),p);await assert.rejects(h.read);assert.equal(h.calls.length,0);}});
test('failed stock reads do not look like healthy machines',async()=>{const h=await harness(fixture(),actor,'latest_vms_stock_by_slot');await assert.rejects(h.read);});
test('ownerless draft is still uncovered',async()=>{const h=await harness(fixture({routes:[activeRoute(null,'draft')],route_stops:[activeStop()]}));assert.equal((await h.read()).totals.uncovered,1);});
test('inactive operator is not counted as human coverage',async()=>{const h=await harness(fixture({routes:[activeRoute()],route_stops:[activeStop()],team_members:[person('noury',false)]}));assert.equal((await h.read()).totals.uncovered,1);});
test('current route owner is shown with previous-date followup',async()=>{const h=await harness(fixture({routes:[activeRoute()],route_stops:[activeStop()],team_members:[person()]}));const r=await h.read();assert.equal(r.totals.uncovered,0);assert.equal(r.board[0].assignments[0].href,'/operator/routes/r');assert.equal(r.board[0].assignments[0].previousDate,true);});
test('other operator route IDs are not exposed',async()=>{const h=await harness(fixture({routes:[activeRoute('basheer')],route_stops:[activeStop()],team_members:[person('basheer')]}));assert.equal((await h.read()).board[0].assignments[0].href,null);});
test('skipped/completed stops do not count as still assigned',async()=>{for(const status of ['skipped','completed','cancelled']){const h=await harness(fixture({routes:[activeRoute()],route_stops:[activeStop(status)],team_members:[person()]}));assert.equal((await h.read()).totals.uncovered,1);}});
test('disabled physical slots are excluded',async()=>{const h=await harness(fixture({machine_slots:[{id:'s',machine_id:'m',slot_code:'001',active:false}]}));assert.equal((await h.read()).board[0].lanes,0);});
test('pagination reads all expected physical lanes',async()=>{const slots=Array.from({length:501},(_,i)=>({id:String(i),machine_id:'m',slot_code:String(i+1),active:true}));const h=await harness(fixture({machine_slots:slots}));const r=await h.read();assert.equal(r.board[0].lanes,501);assert.equal(r.board[0].unknown,500);});
test('part one has no Start Trip, form action, scheduler, model call or migration dependency',()=>{const s=fs.readFileSync('src/lib/smart-work-board-server.ts','utf8'),p=fs.readFileSync('src/app/operator/today-work/page.tsx','utf8');assert.doesNotMatch(s,/\.(insert|update|upsert|delete|rpc)\(/);assert.doesNotMatch(p,/Start Trip|<form|"use server"/);});
