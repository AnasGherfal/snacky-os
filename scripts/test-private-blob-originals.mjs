import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
