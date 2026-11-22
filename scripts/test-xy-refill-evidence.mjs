import test from 'node:test';import assert from 'node:assert/strict';
import {calculateXyRefillEvidence as calc} from '../src/lib/xy-refill-evidence.ts';
const m='m',p='water';const base={machineIds:[m],products:[{id:p,name:'Water'}],
 slots:[{machine_id:m,slot_code:'001',product_id:p,current_qty:1,capacity:8,captured_at:'2026-11-22T00:00:00.000Z'}],
 layout:[{machine_id:m,slot_code:'001',product_id:p,capacity:8,active:true}],
 availableByProduct:new Map([[p,100]]),at:'2026-11-22T02:00:00.000Z',planned:[{machineId:m,productId:p,quantity:7}]};
test('exact XY gap is separate from selected, not an invented take quantity',()=>{const d=calc(base).machines[0];assert.equal(d.lines[0].xyMissing,7);assert.equal(d.lines[0].extraAboveXy,0);assert.equal(d.status,'verified')});
test('owner 95 waters vs XY gap 24 is shown as 71 extra not auto-filled',()=>{
 const slots=['001','002','003'].map(slot_code=>({...base.slots[0],slot_code,current_qty:0,capacity:8}));
 const layout=['001','002','003'].map(slot_code=>({...base.layout[0],slot_code,capacity:8}));
 const input={...base,slots,layout,planned:[{machineId:m,productId:p,quantity:95}],
  history:[{machine_id:m,product_id:p,planned_quantity:95,filled_quantity:null,created_at:'2026-11-21T20:00:00Z',updated_at:'2026-11-22T00:20:00Z',route_date:'2026-11-22',route_status:'assigned'}]};
 const x=calc(input).machines[0].lines[0];assert.equal(x.xyMissing,24);assert.equal(x.extraAboveXy,71);
 assert.equal(x.previousPlanned,95);assert.equal(x.previousEdited,true);assert.equal(x.previousIsCompleted,false);assert.equal(x.status,'review');
});
test('missing XY slot never becomes zero stock',()=>{const a=calc({...base,slots:[]}).machines[0];assert.equal(a.totalMissing,null);assert.equal(a.lines[0].xyMissing,null);assert.equal(a.status,'blocked');});
test('stale or mismatched slot cannot be silently considered fresh',()=>{const a=calc({...base,at:'2026-11-24T00:00:00Z'}).machines[0];assert.equal(a.lines[0].xyMissing,null);assert.equal(a.status,'blocked');});
test('partly occupied unavailable lane is not a safe replacement suggestion',()=>{const a=calc({...base,availableByProduct:new Map([[p,0]])}).machines[0].lines[0];assert.equal(a.status,'blocked');assert.ok(a.issues.some(x=>x.includes('unreserved MAIN')));});
test('hidden physical lanes not counted as missing configured data',()=>{const a=calc({...base,slots:[],hiddenLanes:[{machine_id:m,slot_code:'001'}]}).machines[0];assert.equal(a.missingLanes.length,0);assert.equal(a.status,'blocked');});
test('duplicate or unknown current slot quantity fails closed',()=>{for(const s of [[base.slots[0],base.slots[0]],[{...base.slots[0],current_qty:null}],[{...base.slots[0],current_qty:9}]]){const a=calc({...base,slots:s}).machines[0];assert.equal(a.totalMissing,null);}});

test('route-wide shortage is caught even if each machine alone fits warehouse stock',()=>{
 const input={...base,machineIds:['m','n'],planned:[{machineId:'m',productId:'water',quantity:7},{machineId:'n',productId:'water',quantity:7}],slots:[base.slots[0],{...base.slots[0],machine_id:'n'}],layout:[base.layout[0],{...base.layout[0],machine_id:'n'}],availableByProduct:new Map([['water',10]])};
 const audit=calc(input);assert.equal(audit.machines.length,2);assert.ok(audit.machines.every(m=>m.lines[0].status==='blocked'));
});

test('missing configured lane blocks AI approval even when selected other lanes are mapped',()=>{
 const audit=calc({...base,layout:[...base.layout,{...base.layout[0],slot_code:'002'}]});
 assert.equal(audit.machines[0].missingLanes.length,1);assert.equal(audit.machines[0].status,'blocked');
});
test('selected product not mapped to a verified XY lane cannot be AI-approved',()=>{
 const audit=calc({...base,products:[...base.products,{id:'chip',name:'Chips'}],
  planned:[{machineId:m,productId:'chip',quantity:3}],availableByProduct:new Map([['water',100],['chip',100]])});
 const line=audit.machines[0].lines.find(x=>x.productId==='chip');
 assert.equal(line?.status,'blocked');assert.equal(audit.machines[0].status,'blocked');
});
