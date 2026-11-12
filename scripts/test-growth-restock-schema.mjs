import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as completeList from '../src/lib/complete-list-read.ts';
import * as safeQuery from '../src/lib/safe-supabase-query.ts';
import * as routeWorkflow from '../src/lib/route-workflow.ts';
import * as restockPriority from '../src/lib/restock-priority.ts';

// Actual loader with its IO dependency injected. Never contacts production.
const source = readFileSync('src/lib/restock-priority-data.ts', 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}}).outputText;
const module = {exports:{}};
const dependencies = {
  'server-only': {},
  '@/lib/complete-list-read': completeList,
  '@/lib/safe-supabase-query': safeQuery,
  '@/lib/route-workflow': routeWorkflow,
  '@/lib/restock-priority': restockPriority,
  '@/lib/supabase-server': {getSupabaseAdminClient:()=>null},
};
new Function('require','module','exports',compiled)(name=>{
  assert.ok(Object.hasOwn(dependencies,name), `Unexpected dependency: ${name}`);
  return dependencies[name];
},module,module.exports);
const {loadRestockPriorityData} = module.exports;

// Enum snapshot checked read-only against the live schema on 2026-11-12.
const routeEnum = new Set(['draft','assigned','in_progress','completed','reviewed',
  'cancelled','pickup_confirmed','available','ready','started','machine_filling','canceled','filling']);
function fixture({missingSummary=false,failTable=null}={}) {
  const tables = {
    products:[{id:'p1',name:'Snack',active:true}],
    route_storage_stock_by_product:[{product_id:'p1',quantity_on_hand:100}],
    refill_recommendations:[],
    route_stock_lines:[{id:'l1',route_id:'r1',product_id:'p1',planned_qty:10,picked_qty:2,routes:{status:'assigned'}}],
    route_stop_items:missingSummary?[{id:'s2',route_id:'r2',product_id:'p1',planned_quantity:4,routes:{status:'assigned'}}]:[],
    machine_slots:[],latest_vms_stock_by_slot:[],kpi_product_monthly:[],
  };
  const filters=[];
  const reads=[];
  const client={from(table){
    reads.push(table);
    assert.ok(Object.hasOwn(tables,table),`Unexpected table: ${table}`);
    let range=[0,499];
    const query={
      select(_fields,options){assert.equal(options.count,'exact');return this;},
      eq(){return this;},order(){return this;},
      range(from,to){range=[from,to];return this;},
      abortSignal(signal){assert.ok(signal instanceof AbortSignal);return this;},
      in(field,values){
        filters.push({table,field,values});
        if(field==='routes.status') for(const status of values){
          if(!routeEnum.has(status))throw Error(`invalid input value for enum route_status: ${status}`);
        }
        return this;
      },
      then(resolve,reject){
        const result=table===failTable?{data:null,count:null,error:{code:'57014',message:'read timed out'}}
          :{data:tables[table].slice(range[0],range[1]+1),count:tables[table].length,error:null};
        return Promise.resolve(result).then(resolve,reject);
      },
    };
    for(const mutation of ['insert','upsert','update','delete','rpc']){
      query[mutation]=()=>{assert.fail(`Report attempted ${mutation} on ${table}`);};
    }
    return query;
  }};
  return {client,filters,reads};
}
test('restock loader queries only valid database statuses and keeps actual route demand',async()=>{
  const {client,filters}=fixture();
  const result=await loadRestockPriorityData(client);
  assert.deepEqual(result.errors,{});
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].activeRouteNeedQty,8);
  assert.equal(result.items[0].storageQty,100);
  assert.equal(filters.length,2);
  for(const {values} of filters){assert.ok(values.includes('pickup_confirmed'));assert.ok(!values.includes('completed'));}
});
test('missing route summaries use a disclosed in-memory fallback, never a database repair',async()=>{
  const {client}=fixture({missingSummary:true});
  const result=await loadRestockPriorityData(client,{repairMissingRouteStockLines:true});
  assert.equal(result.items[0].activeRouteNeedQty,12);
  assert.match(result.errors.routeStockRepair,/read-only fallback/);
});
test('failed storage reads withhold recommendations rather than invent zero stock',async()=>{
  const {client}=fixture({failTable:'route_storage_stock_by_product'});
  const result=await loadRestockPriorityData(client);
  assert.deepEqual(result.items,[]);
  assert.equal(result.storageLoaded,false);
  assert.match(result.errors.storage,/timed out/);
});

test('dashboard recommendation promise is reused without a second recommendation query',async()=>{
  const {client,reads}=fixture();
  const recommendations=[{product_id:'p1',product_name:'Snack',machine_id:'m1',machine_name:'Fixture',current_qty:0,suggested_qty:12,final_qty_to_take:12,priority:'high'}];
  const result=await loadRestockPriorityData(client,{recommendationsPromise:Promise.resolve(recommendations)});
  assert.deepEqual(result.errors,{});
  assert.equal(reads.filter(table=>table==='refill_recommendations').length,0);
  assert.equal(result.items.length,1);
  assert.ok(result.items[0].recommendedRefillQty>=12);
});
test('dedicated restock query occurs exactly once for a single-page source',async()=>{
  const {client,reads}=fixture();
  const result=await loadRestockPriorityData(client);
  assert.deepEqual(result.errors,{});
  assert.equal(reads.filter(table=>table==='refill_recommendations').length,1);
});
