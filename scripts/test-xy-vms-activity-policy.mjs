import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  shouldLogXySyncStart,
  shouldLogXySyncFinish
} from "../src/lib/xy-vms-activity-policy.ts";

test("automatic XY sync starts avoid duplicate audit writes, manual starts are retained", () => {
  assert.equal(shouldLogXySyncStart(null), false);
  assert.equal(shouldLogXySyncStart(undefined), false);
  assert.equal(shouldLogXySyncStart({ id: "operator-1" }), true);
  assert.equal(shouldLogXySyncStart({ team_member_id: "owner" }), true);
});

test("automatic successful XY completion is represented once in canonical vms_sync_runs", () => {
  assert.equal(shouldLogXySyncFinish(null, "completed"), false);
  assert.equal(shouldLogXySyncFinish(undefined, "completed"), false);
});

test("warning, failed and unfamiliar sync states always retain independent audit evidence", () => {
  for (const status of ["completed_with_warnings", "failed", "unexpected_status", "running"]) {
    assert.equal(shouldLogXySyncFinish(null, status), true, status);
    assert.equal(shouldLogXySyncFinish(undefined, status), true, status);
  }
});

test("manual XY sync completions remain logged even when successful", () => {
  for (const status of ["completed", "completed_with_warnings", "failed"]) {
    assert.equal(shouldLogXySyncFinish({ id: "operator-1" }, status), true);
  }
});

test("a failed canonical DB update retains audit completion even on automated success", () => {
  assert.equal(shouldLogXySyncFinish(null, "completed", true), true);
  assert.equal(shouldLogXySyncFinish(undefined, "completed", true), true);
});

test("sync source retains every canonical run insert/update, status and error detail", () => {
  const src = fs.readFileSync("src/lib/xy-vms-sync.ts", "utf8");
  const create = src.slice(src.indexOf("async function createSyncRun("),src.indexOf("async function finishSyncRun("));
  const finish = src.slice(src.indexOf("async function finishSyncRun("),src.indexOf("function revalidateXyPages()"));
  assert.match(create,/\.from\("vms_sync_runs"\)/);
  assert.match(create,/status: "running"/);
  assert.match(create,/if \(shouldLogXySyncStart\(profile\)\)/);
  assert.match(finish,/\.from\("vms_sync_runs"\)/);
  assert.match(finish,/\.update\(\{/);
  assert.match(finish,/status,/);
  assert.match(finish,/errors: stats\.errors/);
  assert.match(finish,/if \(shouldLogXySyncFinish\(profile, status, Boolean\(error\)\)\)/);
  assert.match(finish,/action: status === "failed" \? "xy_vms_sync_failed"/);
  assert.doesNotMatch(src,/\.from\("vms_sync_runs"\)\.delete\(/);
});

test("cash, purchase and route logs are never filtered by this XY-specific policy", () => {
  const policy = fs.readFileSync("src/lib/xy-vms-activity-policy.ts", "utf8");
  const baseActivity = fs.readFileSync("src/lib/activity-log.ts", "utf8");
  assert.doesNotMatch(baseActivity,/shouldLogXySync/);
  assert.doesNotMatch(policy,/cash|purchase|route|inventory/i);
});
