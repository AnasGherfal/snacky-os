import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read=(file)=>fs.readFileSync(file,"utf8");
function files(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>
    entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
}

test("No live Snacky OS app source routes a user or API call to the legacy Vercel host",()=>{
  const runtime=files("src").filter(f=>/\.(ts|tsx|js|mjs)$/.test(f));
  assert.ok(runtime.length>500,"Expected complete app tree rather than a sample");
  const offending=runtime.filter(f=>/snacky-os\.vercel\.app/i.test(read(f)));
  assert.deepEqual(offending,[],"Runtime app source must not contain old browser/API host");
});

test("Railway is the documented public app origin and diagnostic environment",()=>{
  const env=read(".env.example");
  const docs=read("README.md");
  const diagnostics=read("src/app/admin/diagnostics/page.tsx");
  const layout=read("src/app/layout.tsx");
  assert.match(env,/NEXT_PUBLIC_APP_URL=https:\/\/your-service\.up\.railway\.app/);
  assert.doesNotMatch(env,/your-vercel-domain/);
  assert.match(docs,/snacky-os-staging-staging\.up\.railway\.app/);
  assert.match(diagnostics,/RAILWAY_ENVIRONMENT_NAME/);
  assert.doesNotMatch(diagnostics,/VERCEL_ENV/);
  assert.match(layout,/NEXT_PUBLIC_APP_URL/);
});

test("CI no longer tests Vercel when checking live CRM activation",()=>{
  const ci=read(".github/workflows/crm-activation-smoke.yml");
  assert.match(ci,/SNACKY_ACTIVATION_ORIGIN/);
  assert.match(ci,/snacky-os-staging-staging\.up\.railway\.app/);
  assert.doesNotMatch(ci,/snacky-os\.vercel\.app/);
  assert.match(ci,/parts\.scheme != 'https'/);
});

test("Only Railway deployment is enabled; obsolete Vercel cron is disabled in source",()=>{
  const conf=JSON.parse(read("vercel.json"));
  assert.deepEqual(conf.git.deploymentEnabled,{"*":false});
  assert.equal("crons" in conf,false);
  assert.match(conf.ignoreCommand,/vercel-build-gate/);
});

test("Supabase cron and wake workers use private Vault destinations, not hardcoded Vercel",()=>{
  const sql=read("supabase/migrations/20261122091500_railway_notification_dispatch_vault_url.sql");
  const cutover=read("scripts/sql/railway-staging-supabase-vault-url-cutover.sql");
  assert.match(sql,/snacky_assignment_dispatch_url/);
  assert.match(sql,/snacky_assignment_worker_token/);
  assert.match(sql,/up\[.\]railway\[.\]app\/api\/notifications\/dispatch/);
  assert.match(sql,/security definer/);
  assert.doesNotMatch(sql,/perform net\.http_post\([\s\S]*url := 'https:\/\/snacky-os\.vercel\.app/i);
  assert.match(cutover,/xy_vms_scheduler_url/);
  assert.match(cutover,/vault\.update_secret/);
  assert.match(cutover,/vault\.create_secret/);
  assert.match(cutover,/snacky-os-staging-staging\.up\.railway\.app/);
});

test("Operator cash removal and optional photo AI use Railway-safe, cross-site-denying same-origin guard",()=>{
  const cash=read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
  const ai=read("src/app/api/admin/xy-photo-gallery-test/route.ts");
  const shared=read("src/lib/cash-handover.ts");
  assert.match(cash,/cashSameOrigin\(request\)/);
  assert.match(ai,/cashSameOrigin\(request\)/);
  assert.match(shared,/originHeader/);
  assert.match(shared,/x-forwarded-proto/);
  assert.match(shared,/sec-fetch-site/);
  assert.doesNotMatch(ai,/origin !== new URL\(request\.url\)\.origin/);
});

test("Other Vercel names in runtime are OPTIONAL vendors, not runtime hosting",()=>{
  const blob=read("src/lib/private-blob-originals.ts");
  const gallery=read("src/lib/photo-ai-connection.ts");
  assert.match(blob,/private\.blob\.vercel-storage\.com/);
  assert.match(gallery,/ai-gateway\.vercel\.sh/);
  assert.match(gallery,/OPENAI_API_KEY/);
  assert.match(gallery,/AI_GATEWAY_API_KEY/);
});
