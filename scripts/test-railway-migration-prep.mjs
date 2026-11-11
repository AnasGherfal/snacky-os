import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const read = (name) => fs.readFileSync(name, "utf8");
const docker = read("Dockerfile.railway");
const cfg = read("next.config.ts");
const ignore = read(".dockerignore");
const vars = read("deployment/railway-staging.env.example");
const health = read("src/app/api/migration-health/route.ts");
const vercel = JSON.parse(read("vercel.json"));
const plan = read("docs/RAILWAY_STAGING_MIGRATION_PLAN.md");

test("migration branch does not opt into Vercel preview deployments", () => {
  const branch = "migration/railway-cost-review-20261111";
  assert.equal(vercel.git.deploymentEnabled["*"], false);
  assert.equal(vercel.git.deploymentEnabled.master, true);
  assert.ok(!["preview/", "qa/", "release/"].some(p => branch.startsWith(p)));
  assert.notEqual(branch, "staging");
});

test("Railway standalone switch does not affect current Vercel build", () => {
  assert.match(cfg, /process\.env\.SNACKY_RAILWAY_STANDALONE === "1"/);
  assert.match(cfg, /output: "standalone"/);
  assert.match(docker, /ENV SNACKY_RAILWAY_STANDALONE=1/);
  assert.match(docker, /RUN node scripts\/next-build\.mjs/);
  assert.match(docker, /RUN test -f \.next\/standalone\/server\.js/);
  assert.match(docker, /CMD \["node","server\.js"\]/);
  assert.match(docker, /EXPOSE 3000/);
  assert.match(docker, /HOSTNAME=0\.0\.0\.0/);
  assert.doesNotMatch(docker, /(?:NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|XY_VMS_SECRET|VAPID_PRIVATE_KEY)=/);
});

test("container excludes local secrets and repository metadata", () => {
  for (const line of [".git", ".env", ".env.*", "node_modules", ".next", ".vercel"]) {
    assert.ok(ignore.split("\n").includes(line), line);
  }
  assert.doesNotMatch(docker, /COPY\s+\.env/i);
});

test("staging env checklist enables no external write integrations", () => {
  for (const [name, value] of [
    ["XY_VMS_ENABLED", "false"],
    ["XY_WEB_ENABLED", "false"],
    ["XY_WEB_LIVE_SALES_ENABLED", "false"],
    ["SNACKY_PHOTO_ARCHIVE_RELEASE_ENABLED", "false"],
    ["SNACKY_PHOTO_ARCHIVE_MIGRATION_ENABLED", "false"],
  ]) assert.ok(vars.includes(name + "=" + value), name);
  assert.doesNotMatch(vars, /(?:supabase\.co|sk_live_|service_role=|Bearer )/i);
});

test("liveness route does not touch database or disclose internal env", () => {
  assert.match(health, /export function GET\(\)/);
  assert.match(health, /ok: true/);
  assert.match(health, /no-store/);
  assert.doesNotMatch(health, /supabase|process\.env|postgres|secret/i);
});

test("migration plan prohibits production DB operations and premature DNS cutover", () => {
  assert.match(plan, /zero services/i);
  assert.match(plan, /separate isolated/i);
  assert.match(plan, /Supabase Pro persists/i);
  assert.match(plan, /Keep Vercel rollback path/i);
  assert.match(plan, /not yet owned\/verified at Railway/i);
});
