import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHash, timingSafeEqual } from "node:crypto";

const branch="maintenance/purge-old-machine-compressor-20261102";
const secret="s".repeat(64);
const path="5a6df7c4-fdbf-4c52-9bb3-4845a1183234/e0903198-3181-4afb-89be-e0ce8e542184-1785784616161.jpg";
const etag="a".repeat(32);
const data={kind:"compressor",path,expectedSize:265432,expectedEtag:etag,expectedUpdatedAt:"2026-08-01T01:00:00.000Z"};
const compiled=ts.transpileModule(fs.readFileSync("src/app/api/ops/purge-aged-refill-photos/route.ts","utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;

function harness(changes={}) {
 const events=[],env={
  VERCEL_ENV:"preview",VERCEL_GIT_COMMIT_REF:branch,
  SNACKY_OLD_PHOTO_PURGE_ENABLED:"true",SNACKY_OLD_PHOTO_PURGE_TOKEN:secret,
  ...(changes.env??{}),
 };
 const info={
  size:data.expectedSize,eTag:etag,
  createdAt:"2026-08-01T01:00:00.000Z",updatedAt:data.expectedUpdatedAt,
  ...(changes.info??{}),
 };
 let removed=false;
 const bucket={
  async info(x){events.push("info");assert.equal(x,path);return {data:removed?null:info,error:null};},
  async remove(xs){events.push("remove");assert.deepEqual([...xs],[path]);removed=true;return {error:null};},
  async exists(x){events.push("exists");assert.equal(x,path);return {data:!removed,error:null};},
 };
 const supabase={
  storage:{from:b=>{assert.equal(b,"refill-photos");return bucket;}},
  from(table) {
   const builder={
    select(){return this;},
    eq(key,value){events.push("ref:"+table+":"+key);assert.equal(typeof value,"string");return this;},
    contains(key,value){assert.equal(key,"evidence_files");assert.ok(typeof value==="string");events.push("quantity:"+value);return this;},
    limit(){const evidence=table==="route_stop_quantity_confirmations";
      const query=events.at(-1);
      const quantityMatch=evidence && (
        changes.quantityPath && query?.includes("photoPath") ||
        changes.quantityUrl && query?.includes("photoUrl")
      );
      const match=table==="machine_refill_history" ? changes.kind==="machine" :
                  table==="route_stop_safety_checks" ? changes.kind!=="machine" : !!quantityMatch;
      return Promise.resolve({data:match?[{id:"ref"}]:[],error:changes.lookupError?{code:"PGRST"}:null});
    },
   };
   return builder;
  },
 };
 const outputs={};
 const imports={
  "node:crypto":{createHash,timingSafeEqual},
  "next/server":{NextResponse:{json:(v,init)=>new Response(JSON.stringify(v),{status:init.status,headers:init.headers})}},
  "@/lib/supabase-server":{getSupabaseAdminClient:()=>supabase},
  "@/lib/private-blob-originals":{validatePath:p=>p},
 };
 vm.runInNewContext(compiled,{exports:outputs,require:id=>{assert.ok(imports[id],id);return imports[id];},
  process:{env},Buffer,Date,Promise,Number,String,JSON,Object,Set,Error,console,Response});
 return {
  events,
  async post(action="inspect",extras={},header=secret){
    const res=await outputs.POST(new Request("https://snacky.invalid/api/ops/purge-aged-refill-photos",{
      method:"POST",headers:{"authorization":"Bearer "+header,"Content-Type":"application/json"},
      body:JSON.stringify({action,jobs:[{...data,kind:changes.kind??"compressor"}],confirmed:true,...extras}),
    }));
    return {status:res.status,body:await res.json()};
  },
 };
}

test("the maintenance route requires branch-isolated opt-in and a bearer credential",async()=>{
 for(const env of [{VERCEL_ENV:"production"},{VERCEL_GIT_COMMIT_REF:"master"},
                   {SNACKY_OLD_PHOTO_PURGE_ENABLED:"false"},{SNACKY_OLD_PHOTO_PURGE_TOKEN:""}]) {
  const h=harness({env});const res=await h.post("delete");
  assert.equal(res.status,401);assert.equal(h.events.length,0);
 }
 const h=harness();assert.equal((await h.post("delete",{},"not-secret")).status,401);
 assert.equal(h.events.length,0);
});

test("inspect is read-only and confirms historical compressor proof with exact metadata",async()=>{
 const h=harness(),r=await h.post();
 assert.equal(r.status,200);assert.equal(r.body.results[0].status,"eligible_not_deleted");
 assert.equal(h.events.includes("remove"),false);
 assert.ok(h.events.some(x=>x.includes("quantity:")));
});

test("confirmed one-photo deletion goes through Storage API and verifies disappearance",async()=>{
 const h=harness(),r=await h.post("delete");
 assert.equal(r.status,200);assert.equal(r.body.deleted,1);assert.equal(r.body.reclaimedBytes,data.expectedSize);
 assert.equal(r.body.results[0].status,"deleted_and_verified");
 assert.ok(h.events.includes("remove"));assert.ok(h.events.includes("exists"));
 assert.equal(h.events.filter(x=>x==="info").length,2);
});

test("unconfirmed request cannot delete",async()=>{
 const h=harness(),r=await h.post("delete",{confirmed:false});
 assert.equal(r.status,400);assert.equal(h.events.length,0);
});

test("quantity evidence by path or proxy URL cannot be deleted",async()=>{
 for(const flag of ["quantityPath","quantityUrl"]) {
  const h=harness({[flag]:true}),r=await h.post("delete");
  assert.equal(r.status,200);assert.equal(r.body.deleted,0);
  assert.equal(r.body.results[0].status,"quantity_evidence_protected");
  assert.equal(h.events.includes("remove"),false);
 }
});

test("recent or altered source and failed reference check always block deletion",async()=>{
 for(const changes of [
  {info:{updatedAt:"2026-11-01T01:00:00.000Z"}},
  {info:{createdAt:"2026-11-01T01:00:00.000Z"}},
  {info:{eTag:"b".repeat(32)}},
  {info:{size:999}},
  {lookupError:true},
 ]) {
  const h=harness(changes),r=await h.post("delete");
  assert.equal(r.body.deleted,0);
  assert.equal(h.events.includes("remove"),false);
 }
});

test("overview class is eligible only with a machine history and without safety classification",async()=>{
 const h=harness({kind:"machine"}),r=await h.post("inspect");
 assert.equal(r.body.results[0].status,"eligible_not_deleted");
 const sql=fs.readFileSync("src/app/api/ops/purge-aged-refill-photos/route.ts","utf8");
 assert.match(sql,/machine_photo_path/);
 assert.match(sql,/proof_photo_path/);
 assert.match(sql,/quantity_evidence_protected/);
 assert.match(sql,/const AGE_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
 assert.match(sql,/bucket\.remove\(\[job\.path\]\)/);
 assert.doesNotMatch(sql,/storage\.objects.*(?:DELETE|delete)/s);
});
