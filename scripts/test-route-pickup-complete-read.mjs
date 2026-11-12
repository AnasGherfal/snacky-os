import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {readPickupRouteRows} from '../src/lib/route-pickup-read.ts';
function fixture({cap=200,failPage=false,changeCount=false}={}){
 const rows=Array.from({length:1500},(_,i)=>({id:`line-${i}`,route_id:'allowed',planned_quantity:1})),calls=[];
 return {calls,db:{from(table){const call={table};calls.push(call);return{
  select(fields,options){call.fields=fields;assert.equal(options.count,'exact');return this;},
  eq(field,value){assert.equal(field,'route_id');assert.equal(value,'allowed');return this;},
  order(field){(call.order??=[]).push(field);return this;},
  range(from,to){call.from=from;call.to=to;return this;},abortSignal(signal){call.signal=signal;return this;},
  then(resolve,reject){return Promise.resolve(failPage&&calls.length===2
   ?{data:null,count:null,error:{code:'42501',message:'blocked'}}
   :{data:rows.slice(call.from,Math.min(call.to+1,call.from+cap)),count:changeCount&&calls.length===2?1499:1500,error:null}).then(resolve,reject);}
 };}}};
}
test('operator pickup retains all 1,500 items even when the backend caps each response',async()=>{
 const {db,calls}=fixture();const signal=AbortSignal.timeout(1000);
 const r=await readPickupRouteRows(db,'route_stop_items','id,planned_quantity','allowed',signal);
 assert.equal(r.error,null);assert.equal(r.count,1500);assert.equal(r.data.length,1500);
 assert.equal(r.data.reduce((n,row)=>n+row.planned_quantity,0),1500);
 assert.deepEqual(calls.map(c=>c.from),[0,200,400,600,800,1000,1200,1400]);
 assert.ok(calls.every(c=>c.signal===signal));
});
test('later-page error or a changing row count never becomes an empty/partial pick list',async()=>{
 for(const config of [{failPage:true},{changeCount:true}]){
  const {db}=fixture(config);const r=await readPickupRouteRows(db,'route_pick_list_items','id','allowed',AbortSignal.timeout(1000));
  assert.equal(r.data,null);assert.ok(r.error);
 }
});
test('API checks authorization before complete reads and permits only missing-table compatibility',()=>{
 const s=readFileSync('src/app/api/operator/routes/[id]/pick-list/route.ts','utf8');
 assert.ok(s.indexOf('if (!operatorHasAccess)')<s.indexOf('const routeReadSignal'));
 assert.equal((s.match(/await readPickupRouteRows\(/g)??[]).length,6);
 assert.match(s,/stopItemsError && !isMissingTable\(stopItemsError, "route_stop_items"\)\) throw stopItemsError/);
 assert.match(s,/pickListError && !isMissingTable\(pickListError, "route_pick_list_items"\)\) throw pickListError/);
});
