import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const path="5a6df7c4-fdbf-4c52-9bb3-4845a1183234/e0903198-3181-4afb-89be-e0ce8e542184-1785784616161.jpg";
const compiled=ts.transpileModule(fs.readFileSync("src/app/api/ops/purge-aged-refill-photos/route.ts","utf8"),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;

function harness(options={}){
 const calls=[];let removed=false;
 const info={size:265432,eTag:"a".repeat(32),createdAt:"2026-08-01T01:00:00.000Z",updatedAt:"2026-08-01T01:00:00.000Z",...(options.info??{})};
 const rows={
  machine_refill_history:options.noReference?[]:[{machine_photo_path:path,id:"history"}],
  route_stop_safety_checks:options.safety?[{proof_photo_path:path,compressor_confirmed:true,id:"safety"}]:[],
  route_stop_quantity_confirmations:options.quantity?[{evidence_files:[{photoPath:path}]}]:[],
 };
 const supabase={
  storage:{from(bucket){assert.equal(bucket,"refill-photos");return {
   async info(p){calls.push("info");assert.equal(p,path);return {data:removed?null:info,error:null};},
   async remove(paths){calls.push("remove");assert.deepEqual([...paths],[path]);removed=true;return {error:null};},
   async exists(p){calls.push("exists");assert.equal(p,path);return {data:!removed,error:null};},
  };}},
  from(table){
   assert.ok(Object.hasOwn(rows,table));const b={
    field:"",eqValue:null,containsValue:null,
    select(col){this.field=col;return this;},
    not(){return this;},order(){return this;},
    range(){calls.push("range:"+table);return Promise.resolve({data:rows[table].map(row=>({[this.field]:row[this.field]})),error:null});},
    eq(_key,v){this.eqValue=v;return this;},
    contains(_key,v){this.containsValue=v;return this;},
    limit(){
     calls.push("limit:"+table);
     let data=rows[table];
     if(this.eqValue!==null)data=data.filter(row=>Object.values(row).includes(this.eqValue));
     if(this.containsValue!==null&&table==="route_stop_quantity_confirmations"){
      data=options.quantity && JSON.stringify(data).includes(path)?data:[];
     }
     return Promise.resolve({data,error:null});
    },
   };return b;
  },
 };
 const profile=options.noOwner?{active_status:"active",role:"operator",roles:["operator"]}:{active_status:"active",role:"owner",roles:["owner"]};
 const exports={};
 const imports={
  "next/server":{NextResponse:{json:(value,opts)=>new Response(JSON.stringify(value),{status:opts.status,headers:opts.headers})}},
  "@/lib/auth":{getCurrentProfile:async()=>{calls.push("auth");return profile;}},
  "@/lib/supabase-server":{getSupabaseAdminClient:()=>{calls.push("admin");return supabase;}},
  "@/lib/private-blob-originals":{validatePath:p=>p},
 };
 vm.runInNewContext(compiled,{exports,require:id=>{assert.ok(imports[id],id);return imports[id];},
  URL,Response,Date,Set,Map,Promise,JSON,Number,String,Object,Array,Error,console});
 return {calls,async post(action="inspect",changes={}){
  const origin=changes.origin??"https://snacky.invalid";
  const r=await exports.POST(new Request("https://snacky.invalid/api/ops/purge-aged-refill-photos",{
   method:"POST",headers:{"content-type":"application/json","origin":origin,"sec-fetch-site":"same-origin"},
   body:JSON.stringify({action,acknowledgement:"DELETE OLD PHOTOS",...changes.body}),
  }));
  return {status:r.status,body:await r.json()};
 }};
}

test("cleanup rejects cross-site requests before any session or storage lookup",async()=>{
 const h=harness(),r=await h.post("delete",{origin:"https://attacker.invalid"});
 assert.equal(r.status,403);assert.equal(h.calls.length,0);
});

test("cleanup refuses non-owner even when a valid browser origin is supplied",async()=>{
 const h=harness({noOwner:true}),r=await h.post("delete");
 assert.equal(r.status,403);assert.equal(h.calls.includes("admin"),false);
});

test("inspect is read-only, checks age, type, and quantity references",async()=>{
 const h=harness(),r=await h.post();
 assert.equal(r.status,200);assert.equal(r.body.deleted,0);
 assert.equal(r.body.eligible,1);assert.equal(r.body.done,true);
 assert.equal(h.calls.includes("remove"),false);
 assert.ok(h.calls.includes("range:route_stop_quantity_confirmations"));
});

test("owner can delete one old machine overview through Storage API and verify absence",async()=>{
 const h=harness(),r=await h.post("delete");
 assert.equal(r.status,200);assert.equal(r.body.deleted,1);
 assert.equal(r.body.reclaimedBytes,265432);
 assert.equal(h.calls.filter(x=>x==="info").length,2);
 assert.ok(h.calls.includes("remove"));assert.ok(h.calls.includes("exists"));
});

test("request without explicit permanent-delete acknowledgement cannot remove a photo",async()=>{
 const h=harness(),r=await h.post("delete",{body:{acknowledgement:"no"}});
 assert.equal(r.status,400);assert.equal(h.calls.includes("admin"),false);
});

test("protected quantity proof, newer or modified photos and unlinked paths cannot be deleted",async()=>{
 for(const opts of [
  {quantity:true},
  {info:{createdAt:"2026-11-01T09:00:00.000Z"}},
  {info:{updatedAt:"2026-11-01T09:00:00.000Z"}},
  {noReference:true},
 ]){
  const h=harness(opts),r=await h.post("delete");
  assert.equal(r.status,200);assert.equal(r.body.deleted,0);
  assert.equal(h.calls.includes("remove"),false);
 }
});

test("owner cleanup is scoped to protected categories; current SQL is read-only",()=>{
 const route=fs.readFileSync("src/app/api/ops/purge-aged-refill-photos/route.ts","utf8");
 const sql=fs.readFileSync("scripts/sql/aged-refill-photo-cleanup-review.sql","utf8");
 assert.match(route,/minAgeMs = 30 \* 24 \* 60 \* 60 \* 1000/);
 assert.match(route,/profile\.role === "owner"/);
 assert.match(route,/originValid/);
 assert.match(route,/route_stop_quantity_confirmations/);
 assert.match(route,/machine_refill_history/);
 assert.match(route,/route_stop_safety_checks/);
 assert.match(route,/bucket\.remove\(\[entry\.path\]\)/);
 assert.match(sql,/BEGIN TRANSACTION READ ONLY/);
 assert.match(sql,/bucket_id = 'refill-photos'/);
 assert.match(sql,/position\(c\.path in coalesce\(q\.evidence_files::text/);
 assert.doesNotMatch(sql,/(?:^|\n)\s*(?:DELETE|UPDATE|INSERT|TRUNCATE|DROP|ALTER)\b/im);
});
