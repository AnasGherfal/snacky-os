import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  sha256, photoArchiveReceiptKey, createPrivateBlobStore,
  storeVerifiedOriginal, readVerifiedOriginal,
  authorizedSchedulerToken,
} from "../src/lib/private-blob-originals.ts";
const old=process.env.BLOB_READ_WRITE_TOKEN;
process.env.BLOB_READ_WRITE_TOKEN="vercel_blob_rw_B6WU5UUlCwdX4xRg_inert_test_key";
const path="5a6df7c4-fdbf-4c52-9bb3-4845a1183234/camera.jpg";
const image=new Uint8Array([255,216,255,0,6,7,8,9]);
function mock(){
 const contents=new Map();
 const fakeFetch=async(raw,options={})=>{
   const u=new URL(raw),method=options.method??"GET";
   if(method==="PUT"){
     assert.equal(u.hostname,"vercel.com");
     assert.equal(options.headers["x-vercel-blob-access"],"private");
     assert.equal(options.headers["x-api-version"],"12");
     const key=u.searchParams.get("pathname");
     if(contents.has(key))return Response.json({error:"existing"},{status:409});
     contents.set(key,new Uint8Array(options.body));
     return Response.json({pathname:key,url:`https://B6WU5UUlCwdX4xRg.private.blob.vercel-storage.com/${key}`});
   }
   assert.equal(u.hostname,"b6wu5uulcwdx4xrg.private.blob.vercel-storage.com");
   const key=decodeURIComponent(u.pathname.slice(1));
   if(!contents.has(key))return new Response(null,{status:404});
   const bytes=contents.get(key);
   return new Response(bytes,{headers:{"content-length":String(bytes.length)}});
 };
 return {store:createPrivateBlobStore(fakeFetch),contents};
}
test("private path rejects traversal",()=>{
 assert.match(photoArchiveReceiptKey(path),/^snacky-photos\/v1\/receipts\/[0-9a-f]{64}\.json$/);
 assert.throws(()=>photoArchiveReceiptKey("../../oops"));
});
test("archive is immutable exact copy with verified readback",async()=>{
 const {store,contents}=mock(),meta={size:image.length,updatedAt:"2026-08-01T09:00:00.000Z",etag:"etag"};
 const receipt=await storeVerifiedOriginal(path,image,meta,store);
 assert.equal(receipt.sha256,sha256(image));
 assert.equal(contents.size,2);
 const result=await readVerifiedOriginal(path,store);
 assert.deepEqual(result.bytes,image);
 await storeVerifiedOriginal(path,image,meta,store);
 assert.equal(contents.size,2);
 await assert.rejects(()=>storeVerifiedOriginal(path,image,{...meta,etag:"different"},store),/archive_source_version_conflict/);
});
test("tampered archive is rejected",async()=>{
 const {store,contents}=mock(),meta={size:image.length,updatedAt:"2026-08-01T09:00:00.000Z",etag:"etag"};
 const r=await storeVerifiedOriginal(path,image,meta,store);
 contents.set(r.contentKey,new Uint8Array([255,216,255]));
 await assert.rejects(()=>readVerifiedOriginal(path,store),/archive_integrity_error/);
});
test("no owner token or missing receipt cannot expose anything",async()=>{
 assert.equal(authorizedSchedulerToken(""),false);
 assert.equal(authorizedSchedulerToken("Bearer wrong"),false);
 const {store}=mock();
 assert.equal(await readVerifiedOriginal(path,store),null);
});
test("release requires storage checks, a preserved exact copy and explicit opt-in",()=>{
 const s=readFileSync("src/app/api/ops/archive-refill-photo/route.ts","utf8");
 const reader=readFileSync("src/app/api/storage/[bucket]/[...path]/route.ts","utf8");
 for(const text of ["authorizedSchedulerToken","fileAgeEligible","ensureEligible(supabase,job)","source_version_conflict_before_release","readVerifiedOriginal(job.path,store)","if(!job.release)","bucket.remove([job.path])"])assert.ok(s.includes(text),text);
 assert.ok(reader.includes("storage.from(bucket).exists(objectPath)"));
 assert.ok(reader.includes("readVerifiedOriginal(objectPath)"));
});



test("archive quantity proofs use JSONB containment with serialized objects, never cast filters",()=>{
 const source=readFileSync("src/app/api/ops/archive-refill-photo/route.ts","utf8");
 assert.doesNotMatch(source,/\.filter\("evidence_files::text"/);
 assert.match(source,/\.contains\("evidence_files",JSON\.stringify\(\[\{photoPath:path\}\]\)\)/);
 assert.match(source,/\.contains\("evidence_files",JSON\.stringify\(\[\{photoUrl:proxy\}\]\)\)/);
 assert.match(source,/quantityPath\.error\|\|quantityUrl\.error/);
 assert.match(source,/quantityPath\.data\?\.length\|\|quantityUrl\.data\?\.length/);
});
test("source release stays off without a separate owner-controlled environment gate",()=>{
 const source=readFileSync("src/app/api/ops/archive-refill-photo/route.ts","utf8");
 assert.match(source,/job\.release===true&&process\.env\.SNACKY_PHOTO_ARCHIVE_RELEASE_ENABLED!=="true"/);
 assert.match(source,/source_release_disabled/);
 assert.match(source,/if\(!job\.release\)/);
 assert.match(source,/source_version_conflict_before_release/);
});

/** Exercise the real POST handler without network or production credentials. */
function archiveHandlerHarness(options = {}) {
 const observed = [];
 const routePath = "10000000-0000-4000-8000-000000000001/machine.jpg";
 const encoded = ts.transpileModule(readFileSync("src/app/api/ops/archive-refill-photo/route.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
 }).outputText;
 const outputs = {};
 const supabase = {
  from(table) {
   const filters = [];
   const builder = {
    select() { return this; },
    eq(key,value) { filters.push({method:"eq",key,value}); return this; },
    contains(key,value) { filters.push({method:"contains",key,value}); return this; },
    limit() {
     observed.push({table,filters});
     if(table==="machine_refill_history") return Promise.resolve({data:[{id:"h",route_id:"r",route_stop_id:"s",machine_id:"m",machine_photo_url:"/api/storage/refill-photos/"+routePath,issues_found:false,linked_issue_id:null}],error:null});
     if(table==="route_stop_safety_checks")return Promise.resolve({data:[],error:null});
     if(table==="route_stop_quantity_confirmations"){
      const serialized=filters.find(x=>x.method==="contains")?.value;
      const parsed=JSON.parse(serialized);
      const isPath=Object.hasOwn(parsed[0],"photoPath");
      return Promise.resolve({data:isPath?options.pathMatches??[]:options.urlMatches??[],error:isPath?options.pathError??null:options.urlError??null});
     }
     throw Error("Unexpected query "+table);
    },
   };
   return builder;
  },
  storage:{from(){throw Error("Should not reach Storage while quantity evidence unresolved");}},
 };
 const imports = {
  "next/server": {NextResponse:{json:(data,init)=>new Response(JSON.stringify(data),{status:init.status,headers:init.headers})}},
  "@/lib/supabase-server": {getSupabaseAdminClient:()=>{observed.push({admin:true});return supabase;}},
  "@/lib/private-blob-originals": {
   authorizedSchedulerToken:()=>true,
   createPrivateBlobStore:()=>{throw Error("Archive not expected");},
   photoArchiveReceiptKey:()=>"",readVerifiedOriginal:async()=>null,sha256:()=>"",
   storeVerifiedOriginal:async()=>{throw Error("Archive not expected");},
   validatePath:value=>value,
  },
 };
 const env={SNACKY_PHOTO_ARCHIVE_MIGRATION_ENABLED:"true"};
 if(options.releaseEnabled)env.SNACKY_PHOTO_ARCHIVE_RELEASE_ENABLED="true";
 vm.runInNewContext(encoded,{
  exports:outputs,require:id=>{assert.ok(Object.hasOwn(imports,id),id);return imports[id];},
  process:{env},Request,Response,Date,Promise,JSON,String,Number,Error,console,
 });
 return {
  observed,
  async post(release=false){
   const response=await outputs.POST(new Request("https://snacky.invalid/api/ops/archive-refill-photo",{
    method:"POST",headers:{"authorization":"Bearer valid","content-type":"application/json"},
    body:JSON.stringify({path:routePath,expectedSize:400000,expectedUpdatedAt:"2026-09-01T12:00:00.000Z",expectedEtag:"a".repeat(32),release}),
   }));
   return {status:response.status,body:await response.json()};
  },
  routePath,
 };
}

test("archiver rejects actual quantity image paths before any archive write",async()=>{
 const h=archiveHandlerHarness({pathMatches:[{id:"quantity-proof"}]});
 const response=await h.post();
 assert.equal(response.status,409);
 assert.equal(response.body.error,"quantity_screenshot_protected");
 const containment=h.observed.filter(x=>x.table==="route_stop_quantity_confirmations")
  .flatMap(x=>x.filters).filter(x=>x.method==="contains");
 assert.equal(containment.length,2);
 assert.deepEqual(containment.map(x=>JSON.parse(x.value)),[
  [{photoPath:h.routePath}],
  [{photoUrl:"/api/storage/refill-photos/"+h.routePath}],
 ]);
});

test("archiver rejects quantity evidence linked by photoUrl alone",async()=>{
 const h=archiveHandlerHarness({urlMatches:[{id:"photo-url"}]});
 const response=await h.post();
 assert.equal(response.status,409);
 assert.equal(response.body.error,"quantity_screenshot_protected");
});

test("archiver fails closed if either JSONB quantity query returns an error",async()=>{
 for(const changes of [{pathError:{code:"PGRST"},urlError:null},{pathError:null,urlError:{code:"PGRST"}}]){
  const h=archiveHandlerHarness(changes);
  const response=await h.post();
  assert.equal(response.status,409);
  assert.equal(response.body.error,"photo_reference_check_failed");
 }
});

test("unconfigured source release cannot invoke Storage even with an accepted release request",async()=>{
 const h=archiveHandlerHarness();
 const response=await h.post(true);
 assert.equal(response.status,409);
 assert.equal(response.body.error,"source_release_disabled");
 assert.equal(h.observed.length,0);
});

test("photo canary query is read-only and cannot silently approve a source release",()=>{
 const sql=readFileSync("scripts/sql/refill-photo-canary-review.sql","utf8");
 assert.match(sql,/BEGIN TRANSACTION READ ONLY/);
 assert.doesNotMatch(sql, /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/im);
 assert.match(sql,/REVIEW_REQUIRED/);
 assert.match(sql,/source_release_approved/);
 assert.match(sql,/photoPath/);
 assert.match(sql,/photoUrl/);
 assert.match(sql,/route_stop_safety_checks/);
 assert.match(sql,/machine_photo_path/);
 assert.ok(sql.includes("later.refill_at"));
 assert.ok(sql.includes("resolved_at IS NULL AND i.archived_at IS NULL"));
});
