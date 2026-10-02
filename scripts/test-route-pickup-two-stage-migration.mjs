import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const migrationPath = "supabase/migrations/202607150003_route_pickup_two_stage_workflow.sql";
const source = readFileSync(migrationPath, "utf8");

function sourceWindow(marker, length = 500) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `${migrationPath} should contain ${marker}`);
  return source.slice(index, index + length);
}

test("two-stage pickup migration renames the old RPC before redefining the wrapper", () => {
  assert.match(source, /alter function public\.confirm_route_pickup_batch\(\s*uuid,/);
  assert.match(source, /rename to confirm_route_pickup_batch_core;/);
  assert.match(sourceWindow("select *\n  into v_result\n  from public.confirm_route_pickup_batch_core("), /confirm_route_pickup_batch_core\(/);
  assert.equal(source.includes("from public.confirm_route_pickup_batch("), false);
});

test("two-stage pickup migration keeps the prepared snapshot fields", () => {
  assert.match(source, /add column if not exists prepared_at timestamptz/);
  assert.match(source, /add column if not exists prepared_by uuid references public\.team_members\(id\) on delete set null/);
  assert.match(source, /raise exception 'Every required pickup line must be checked before confirming pickup\.'/);
  assert.match(source, /raise exception 'Prepared pickup summary does not match the saved preparation snapshot\.'/);
});
