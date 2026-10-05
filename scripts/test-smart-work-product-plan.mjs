import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProductPlan, planLaneCode, planWhole} from '../src/lib/smart-work-product-plan.ts';
const now=new Date('2026-10-05T10:00:00Z');
const machine=(id='m',priority=1)=>({id,name:id,priority,locationId:'loc',locationType:'school'});
const product=(id='p',available=100)=>({id,name:id,category:'chocolate',available});
const slot=(n=1,m='m')=>({id:`${m}-${n}`,machineId:m,code:String(n).padStart(3,'0'),active:true});
const stock=(n=1,q=0,p='p',cap=8,m='m')=>({machineId:m,code:slot(n).code,productId:p,quantity:q,capacity:cap,capturedAt:now.toISOString()});
const fit=(n=1,p='q',cap=8,m='m')=>({slotId:slot(n,m).id,productId:p,rule:'allowed',capacity:cap});
const input=(patch={})=>({machines:[machine()],slots:[slot()],stock:[stock()],products:[product()],fits:[],rules:[],now,...patch});
const run=(patch={})=>buildProductPlan(input(patch));
function invariant(plan,products){
  for(const p of plan.pickup)assert.ok(p.quantity<=(products.find(x=>x.id===p.productId)?.available??0));
  for(const l of plan.lanes){assert.ok(l.take>=0);if(l.after!==null)assert.ok(l.after>=0&&l.after<=l.target);if(l.action==='replace'&&l.current>0)assert.equal(l.after,l.target);}
  assert.equal(plan.totalUnits,plan.lanes.reduce((n,l)=>n+l.take,0));
  assert.equal(plan.totalUnits,plan.pickup.reduce((n,p)=>n+p.quantity,0));
  assert.equal(plan.dispatchEnabled,false);
}
test('refills the current mapped product to actual lane capacity',()=>{const r=run();assert.equal(r.status,'complete');assert.equal(r.totalUnits,8);assert.equal(r.lanes[0].action,'refill');});
test('full lane needs no pickup',()=>{const r=run({stock:[stock(1,8)]});assert.equal(r.status,'nothing_to_load');assert.equal(r.totalUnits,0);});
test('missing expected lane stays unknown, not silently omitted',()=>{const r=run({slots:[slot(),slot(2)]});assert.equal(r.lanes.length,2);assert.equal(r.unknownAfter,1);assert.equal(r.status,'blocked');});
test('duplicate numeric aliases block the lane',()=>{const r=run({stock:[stock(),{...stock(),code:'1'}]});assert.equal(r.lanes.length,1);assert.equal(r.unknownAfter,1);assert.equal(r.totalUnits,0);});
test('duplicate physical slot definitions block the lane',()=>{assert.equal(run({slots:[slot(),{...slot(),id:'other',code:'1'}]}).unknownAfter,1);});
test('historical synthetic and inactive lanes are not counted empty',()=>{const r=run({slots:[slot(),{...slot(2),active:false},{...slot(3),code:'VMS-3'}],stock:[stock(),stock(2),{...stock(3),code:'VMS-3'}]});assert.equal(r.lanes.length,1);});
test('raw XY lane without a physical slot is unknown',()=>{assert.equal(run({slots:[]}).unknownAfter,1);});
test('stale and future readings cannot become pickup quantities',()=>{for(const date of ['2026-10-04T10:00:00Z','2026-10-05T10:02:00Z']){const r=run({stock:[{...stock(),capturedAt:date}]});assert.equal(r.totalUnits,0);assert.equal(r.status,'blocked');}});
for(const q of [null,undefined,'',true,NaN,Infinity,-1,9])test(`invalid quantity ${String(q)} is unknown`,()=>{assert.equal(run({stock:[{...stock(),quantity:q}]}).unknownAfter,1);});
test('unmapped and inactive catalog products are explicit exceptions',()=>{for(const p of [null,'not-active'])assert.equal(run({stock:[stock(1,0,p)]}).unknownAfter,1);});
test('unknown storage never creates availability',()=>{const r=run({products:[product('p',null)]});assert.equal(r.totalUnits,0);assert.equal(r.emptyAfter,1);assert.equal(r.lanes[0].reason,'stock_unknown');});
test('a category match does not prove substitute fit',()=>{const r=run({products:[product('p',0),product('q',100)]});assert.equal(r.emptyAfter,1);});
test('an allow rule without replacement capacity is insufficient',()=>{const r=run({products:[product('p',0),product('q')],fits:[fit(1,'q',null)]});assert.equal(r.emptyAfter,1);});
test('substitute uses its own approved capacity',()=>{const r=run({products:[product('p',0),product('q')],fits:[fit(1,'q',5)]});assert.equal(r.totalUnits,5);assert.equal(r.lanes[0].target,5);assert.equal(r.replacements,1);});
test('hard venue prohibition wins over narrow preference and lane approval',()=>{const r=run({products:[product('p',0),product('q')],fits:[fit()],rules:[{productId:'q',machineId:null,locationId:null,locationType:'school',rule:'prohibited'},{productId:'q',machineId:'m',locationId:null,locationType:null,rule:'preferred'}]});assert.equal(r.emptyAfter,1);});
test('hard lane prohibition wins over a conflicting allow',()=>{assert.equal(run({products:[product('p',0),product('q')],fits:[fit(),{...fit(),rule:'prohibited'}]}).emptyAfter,1);});
test('a full lane with prohibited current stock is not healthy',()=>{const r=run({stock:[stock(1,8)],rules:[{machineId:'m',locationId:null,locationType:null,productId:'p',rule:'prohibited'}]});assert.equal(r.status,'blocked');});
test('unavailable original can change before empty with adequate replacement stock',()=>{const r=run({stock:[stock(1,3)],products:[product('p',0),product('q',8)],fits:[fit()]});assert.equal(r.status,'complete');assert.equal(r.lanes[0].removeExpected,3);assert.equal(r.lanes[0].take,8);});
test('do not clear three old units for an undersupplied substitute',()=>{const r=run({stock:[stock(1,3)],products:[product('p',0),product('q',1)],fits:[fit()]});assert.equal(r.lanes[0].removeExpected,0);assert.equal(r.lanes[0].after,3);assert.equal(r.status,'partial');});
test('removed old units are never made available for another lane',()=>{const r=run({slots:[slot(),slot(2)],stock:[stock(1,3),stock(2)],products:[product('p',0),product('q',8)],fits:[fit()]});assert.equal(r.emptyAfter,1);assert.ok(r.pickup.every(p=>p.productId!=='p'));});
test('empty lanes receive coverage before stocked-lane replacements',()=>{const r=run({slots:[slot(),slot(2)],stock:[stock(1,0,'q'),stock(2,3)],products:[product('p',0),product('q',8)],fits:[fit(2)]});assert.equal(r.emptyAfter,0);assert.equal(r.lanes.find(l=>l.code==='002').removeExpected,0);});
test('three machines share limited stock without a false complete label',()=>{const products=[product('p',3)],r=run({machines:[machine('a'),machine('b'),machine('c')],slots:['a','b','c'].map(x=>slot(1,x)),stock:['a','b','c'].map(x=>stock(1,0,'p',8,x)),products});assert.equal(r.emptyAfter,0);assert.equal(r.underfilled,3);assert.equal(r.status,'partial');invariant(r,products);});
test('augmenting allocation moves a flexible choice to keep every feasible lane covered',()=>{const products=[product('p',0),product('a',1),product('b',1),product('c',1)],r=run({slots:[slot(),slot(2),slot(3)],stock:[stock(),stock(2),stock(3)],products,fits:[fit(1,'a'),fit(1,'b'),fit(2,'a'),fit(2,'c'),fit(3,'a'),fit(3,'c')]});assert.equal(r.emptyAfter,0);assert.equal(r.totalUnits,3);invariant(r,products);});
test('actual shortage stays empty and cannot be labelled complete',()=>{const r=run({slots:[slot(),slot(2)],stock:[stock(),stock(2)],products:[product('p',1)]});assert.equal(r.emptyAfter,1);assert.equal(r.status,'partial');});
test('input arrays and inventory are not mutated',()=>{const v=input(),before=JSON.stringify(v);buildProductPlan(v);assert.equal(JSON.stringify(v),before);});
test('preview expiration is limited by the oldest usable snapshot',()=>{const r=run({stock:[{...stock(),capturedAt:'2026-10-05T09:31:00Z'}]});assert.equal(r.expiresAt,'2026-10-05T10:01:00.000Z');});
test('empty machine configuration is blocked, not a complete plan',()=>{assert.equal(run({stock:[],slots:[]}).status,'blocked');});
test('invalid machine selections are rejected',()=>{assert.throws(()=>run({machines:[]}));assert.throws(()=>run({machines:[machine(),machine()]}));});
test('normalization does not coerce booleans or empty objects',()=>{assert.equal(planLaneCode('01'),'001');for(const n of [true,{},[],NaN,''])assert.equal(planWhole(n),null);});
test('randomized plans preserve stock limits and full nonempty replacements',()=>{
  let seed=731;const rand=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
  for(let j=0;j<250;j++){
    const count=2+rand(12),products=[product('p',rand(35)),product('q',rand(35)),product('r',rand(35))];
    const slots=Array.from({length:count},(_,i)=>slot(i+1));const rows=slots.map((_,i)=>stock(i+1,rand(9)));
    const fits=slots.flatMap((_,i)=>[fit(i+1,'q'),fit(i+1,'r')]);const r=run({slots,stock:rows,products,fits});invariant(r,products);
    if(r.status==='complete')assert.equal(r.emptyAfter+r.unknownAfter+r.underfilled,0);
  }
});
