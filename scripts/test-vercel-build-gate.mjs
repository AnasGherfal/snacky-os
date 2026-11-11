import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { skipProductionBuildForChanges } from "./vercel-build-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gate = resolve(root, "scripts/vercel-build-gate.mjs");

function runGate(environment, branch) {
  const env = { ...process.env };
  delete env.VERCEL_ENV;
  delete env.VERCEL_GIT_COMMIT_REF;
  if (environment !== undefined) env.VERCEL_ENV = environment;
  if (branch !== undefined) env.VERCEL_GIT_COMMIT_REF = branch;
  const result = spawnSync(process.execPath, [gate], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined, result.stderr);
  return result;
}

test("production skips docs-only, CI-only and migration-only changes", () => {
  for (const paths of [
    ["README.md"], [".github/workflows/check.yml"],
    ["docs/README.md", "scripts/test-foo.mjs"],
    ["supabase/migrations/202611110001_example.sql"],
    ["scripts/sql/archive-preflight.sql", "AGENTS.md"],
  ]) assert.equal(skipProductionBuildForChanges(paths), true, paths.join(","));
});

test("runtime or ambiguous production changes always build", () => {
  for (const paths of [
    [], ["src/app/page.tsx"], ["src/lib/cash-ledger.ts"],
    ["package.json"], ["next.config.ts"], ["vercel.json"],
    ["scripts/next-build.mjs"], ["public/brand/snacky-logo.png"],
    ["docs/README.md", "src/app/api/route.ts"],
    ["scripts/vercel-build-gate.mjs"], ["unknown/new.file"],
  ]) assert.equal(skipProductionBuildForChanges(paths), false, paths.join(","));
});

test("production master fails open when git history is unavailable", () => {
  const env = { ...process.env, VERCEL_ENV:"production",
    VERCEL_GIT_COMMIT_REF:"master", PATH:"" };
  const result = spawnSync(process.execPath, [gate], {
    env, encoding:"utf8", timeout:10_000,
  });
  assert.equal(result.status, 1);
});

test("production is preserved even if a ref is unusual", () => {
  assert.equal(runGate("production", "feature/test").status, 1);
});

test("explicit preview, QA, release and staging builds are allowed", () => {
  for (const ref of ["preview/cost-test", "qa/stocktake", "release/2026-11", "staging"]) {
    assert.equal(runGate("preview", ref).status, 1, ref);
  }
});

test("routine feature branches do not build on Vercel", () => {
  for (const ref of ["fix/inventory", "feature/stocks", "docs/update", "master", "preview", "release"]) {
    assert.equal(runGate("preview", ref).status, 0, ref);
  }
});

test("unknown environment and unknown branch fail open rather than blocking a production release", () => {
  assert.equal(runGate(undefined, "master").status, 1);
  assert.equal(runGate("production", undefined).status, 1);
  assert.equal(runGate("preview", undefined).status, 1);
  assert.equal(runGate("unexpected", "feature/test").status, 1);
});

test("vercel.json preserves production cron, region and branch configuration", () => {
  const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
  assert.equal(vercel.ignoreCommand, "node scripts/vercel-build-gate.mjs");
  assert.equal(vercel.git.deploymentEnabled.master, true);
  assert.equal(vercel.git.deploymentEnabled["*"], false);
  assert.equal(vercel.git.deploymentEnabled["preview/**"], true);
  assert.equal(vercel.regions[0], "dub1");
  assert.deepEqual(vercel.crons, [{ path: "/api/cron/xy-vms", schedule: "0 4 * * *" }]);
});
