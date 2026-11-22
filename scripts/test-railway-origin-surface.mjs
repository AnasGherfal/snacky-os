import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,readdirSync } from "node:fs";
import { join } from "node:path";
import { strictSameOrigin,optionalSameOrigin } from "../src/lib/request-origin.ts";

const headers={
 origin:"https://snacky-os-staging-staging.up.railway.app",
 host:"snacky-os-staging-staging.up.railway.app",
 "x-forwarded-proto":"https",
 "sec-fetch-site":"same-origin",
};
const req=(hs={},url="http://internal:8080/api/example")=>
 new Request(url,{method:"POST",headers:{...headers,...hs}});

test("Railway public HTTPS origin is accepted though Next sees internal HTTP URL",()=>{
 assert.equal(strictSameOrigin(req()),true);
 assert.equal(optionalSameOrigin(req()),true);
 assert.equal(strictSameOrigin(new Request("https://snacky-os-staging-staging.up.railway.app/api/example",{method:"POST",headers:{origin:headers.origin}})),true);
});

test("spoofed host, mixed forwarded protocol and cross-site origin are rejected",()=>{
 for(const h of [
  {origin:"https://attacker.example"},
  {origin:"https://snacky-os-staging-staging.up.railway.app.attacker.example"},
  {host:"attacker.example"},
  {"x-forwarded-proto":"http"},
  {"x-forwarded-proto":"https,http"},
  {"sec-fetch-site":"cross-site"},
  {origin:"null"},
  {origin:"https://snacky-os-staging-staging.up.railway.app/path"},
 ]){assert.equal(strictSameOrigin(req(h)),false,JSON.stringify(h));}
});

test("Strict actions require Origin; legacy optional actions permit missing origin but not explicit cross-site",()=>{
 const noOrigin=new Request('http://internal:8080/api/example',{method:'POST',headers:{host:headers.host,'x-forwarded-proto':'https','sec-fetch-site':'same-origin'}});
 assert.equal(strictSameOrigin(noOrigin),false);
 assert.equal(optionalSameOrigin(noOrigin),true);
 assert.equal(optionalSameOrigin(new Request('http://internal:8080/api/example',{method:'POST',headers:{host:headers.host,'x-forwarded-proto':'https','sec-fetch-site':'cross-site'}})),false);
});

test("All formerly misrouted owner, CRM, operator, buying, push and stocktake APIs use Railway-safe guard",()=>{
 const paths=[
  "src/app/api/data-health/operator-bag-reconcile/route.ts",
  "src/app/api/data-health/action/route.ts",
  "src/app/api/crm/location-payment-schedule/route.ts",
  "src/app/api/crm/lead-focus/route.ts",
  "src/app/api/crm/collaboration/route.ts",
  "src/app/api/crm/obligation-admin/route.ts",
  "src/app/api/crm/routines/route.ts",
  "src/app/api/settings/smart-work-coverage/route.ts",
  "src/app/api/ops/purge-aged-refill-photos/route.ts",
  "src/app/api/operator/start-trip/route.ts",
  "src/app/api/operator/product-plan/route.ts",
  "src/app/api/operator/smart-work-duties/route.ts",
  "src/lib/buying-lists.ts",
  "src/lib/push-subscription.ts",
  "src/lib/crm-dispatch.ts",
  "src/lib/company-hub.ts",
  "src/lib/storage-stocktake.ts",
  "src/lib/crm-workspace.ts",
 ];
 for(const path of paths){
  const s=readFileSync(path,"utf8");
  assert.match(s,/(strictSameOrigin|optionalSameOrigin)\(request\)/,path);
  assert.doesNotMatch(s,/origin\s*!==\s*new URL\(request\.url\)\.origin/,path);
  assert.doesNotMatch(s,/origin\s*===\s*new URL\(request\.url\)\.origin/,path);
 }
});

test("No stale host comparison remains in any app API; exceptions are reviewed in the shared guard",()=>{
 function walk(dir){
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
 }
 const bad=walk("src/app/api").filter(path=>/\.(ts|tsx)$/.test(path)&&/new URL\(request\.url\)\.origin/.test(readFileSync(path,"utf8")));
 assert.deepEqual(bad,[],"Remaining direct URL-origin compares will reject Railway POSTs");
});
