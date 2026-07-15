import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const brokenMigrationPath = path.join(
  repoRoot,
  "supabase/migrations/202607150003_route_pickup_two_stage_workflow.sql",
);
const repairMigrationPath = path.join(
  repoRoot,
  "supabase/migrations/202607150006_route_pickup_rpc_chain_repair.sql",
);

const brokenMigration = fs.readFileSync(brokenMigrationPath, "utf8");
const repairMigration = fs.readFileSync(repairMigrationPath, "utf8");

function normalize(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function validateRequiredChecked({ required, checked }) {
  const checkedSet = new Set(normalize(checked));
  return normalize(required).filter((id) => !checkedSet.has(id));
}

test("documents the original wrapper-to-wrapper positional-call defect", () => {
  assert.match(
    brokenMigration,
    /rename to confirm_route_pickup_batch_core/i,
    "the two-stage migration renamed the acknowledgement wrapper to core",
  );
  assert.match(
    brokenMigration,
    /from public\.confirm_route_pickup_batch_core\([\s\S]*p_selected_stop_ids,[\s\S]*p_selected_machine_ids[\s\S]*\);/i,
    "the replacement wrapper passed 15 positional values to the renamed 16-argument wrapper",
  );
});

test("repair gives the original 15-argument atomic function a unique name", () => {
  assert.match(repairMigration, /RENAME TO confirm_route_pickup_batch_atomic_core/i);
  assert.match(
    repairMigration,
    /to_regprocedure\([\s\S]*confirm_route_pickup_batch_atomic_core\(uuid,public\.route_status/i,
  );
});

test("both public contracts delegate only to the unique atomic core", () => {
  const atomicCalls = repairMigration.match(/FROM public\.confirm_route_pickup_batch_atomic_core\(/g) ?? [];
  assert.equal(atomicCalls.length, 2, "15- and 16-argument wrappers must each call the atomic core once");
  assert.doesNotMatch(
    repairMigration,
    /FROM public\.confirm_route_pickup_batch_core\(/,
    "the repair must never call the accidentally renamed acknowledgement wrapper",
  );
});

test("the 16-argument contract no longer blocks on the redundant browser acknowledgement array", () => {
  assert.doesNotMatch(
    repairMigration,
    /Pickup checklist acknowledgements do not match the submitted checked lines/i,
  );
  assert.match(
    repairMigration,
    /p_acknowledged_pickup_line_ids remains in the API for compatibility and[\s\S]*not a second route-blocking source of truth/i,
  );
  assert.match(
    repairMigration,
    /Every required pickup line must be checked before confirming pickup/i,
  );
});

test("required-line validation remains strict while duplicate and extra acknowledgement ids are irrelevant", () => {
  assert.deepEqual(
    validateRequiredChecked({
      required: ["line-a", "line-b", "line-b"],
      checked: ["line-a", "line-b", "manual-new-line"],
    }),
    [],
  );
  assert.deepEqual(
    validateRequiredChecked({
      required: ["line-a", "line-b"],
      checked: ["line-a", "manual-new-line"],
    }),
    ["line-b"],
  );
});

test("zero-quantity and spare-stock rows are excluded from the persisted required set", () => {
  assert.match(repairMigration, /COALESCE\(rsi\.planned_quantity, 0\) > 0/);
  assert.match(repairMigration, /Zero-quantity lines and unassigned spare-stock rows do not/);
});

test("the repair preserves prepared snapshot and selected-stop validation", () => {
  assert.match(repairMigration, /Prepared pickup summary does not match the saved preparation snapshot/);
  assert.match(repairMigration, /Prepared pickup stops do not match the current confirmation payload/);
  assert.match(repairMigration, /FOR UPDATE/);
});

test("migration is data-safe and reloads PostgREST", () => {
  assert.doesNotMatch(repairMigration, /\btruncate\b/i);
  assert.doesNotMatch(repairMigration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(repairMigration, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(repairMigration, /\bcascade\b/i);
  assert.match(repairMigration, /SELECT pg_notify\('pgrst', 'reload schema'\);/);
});
