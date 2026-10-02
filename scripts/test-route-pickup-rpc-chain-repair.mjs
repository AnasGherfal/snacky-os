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
const bridgeMigrationPath = path.join(
  repoRoot,
  "supabase/migrations/202607150006_route_pickup_rpc_chain_repair.sql",
);
const disambiguationMigrationPath = path.join(
  repoRoot,
  "supabase/migrations/202607150007_route_pickup_core_overload_disambiguation.sql",
);

const brokenMigration = fs.readFileSync(brokenMigrationPath, "utf8");
const bridgeMigration = fs.readFileSync(bridgeMigrationPath, "utf8");
const disambiguationMigration = fs.readFileSync(disambiguationMigrationPath, "utf8");

function normalize(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function validateRequiredChecked({ required, checked }) {
  const checkedSet = new Set(normalize(checked));
  return normalize(required).filter((id) => !checkedSet.has(id));
}

test("documents the original 15-position call into a defaulted 16-argument core", () => {
  assert.match(
    brokenMigration,
    /rename to confirm_route_pickup_batch_core/i,
    "the two-stage migration renamed the acknowledgement wrapper to core",
  );
  assert.match(
    brokenMigration,
    /from public\.confirm_route_pickup_batch_core\([\s\S]*p_selected_stop_ids,[\s\S]*p_selected_machine_ids[\s\S]*\);/i,
    "the replacement wrapper passed only 15 positional values",
  );
});

test("compatibility bridge explains the 15-vs-16 contract", () => {
  assert.match(bridgeMigration, /15-vs-16 argument pickup RPC call/i);
  assert.match(bridgeMigration, /create or replace function public\.confirm_route_pickup_batch_core\(/i);
});

test("final repair preserves every existing public-function default", () => {
  assert.match(disambiguationMigration, /p_replace_pick_list boolean default false/i);
  assert.match(disambiguationMigration, /p_pickup_batch jsonb default null/i);
  assert.match(disambiguationMigration, /p_batch_stop_ids uuid\[\] default '\{\}'::uuid\[\]/i);
  assert.match(disambiguationMigration, /p_acknowledged_pickup_line_ids uuid\[\] default '\{\}'::uuid\[\]/i);
  assert.match(disambiguationMigration, /p_selected_machine_ids uuid\[\] default '\{\}'::uuid\[\]/i);
});

test("final repair selects the unique 16-argument core by named notation", () => {
  assert.match(
    disambiguationMigration,
    /from public\.confirm_route_pickup_batch_core\([\s\S]*p_route_id\s*=>\s*p_route_id/i,
  );
  assert.match(
    disambiguationMigration,
    /p_acknowledged_pickup_line_ids\s*=>\s*v_checked_pickup_line_ids/i,
  );
  assert.match(
    disambiguationMigration,
    /p_selected_machine_ids\s*=>\s*p_selected_machine_ids/i,
  );
  assert.doesNotMatch(
    disambiguationMigration,
    /from public\.confirm_route_pickup_batch_core\(\s*p_route_id\s*,/i,
    "the final wrapper must never call an overloaded core positionally",
  );
});

test("redundant browser acknowledgements cannot block a valid route", () => {
  assert.doesNotMatch(
    disambiguationMigration,
    /Pickup checklist acknowledgements do not match the submitted checked lines/i,
  );
  assert.match(
    disambiguationMigration,
    /redundant[\s\S]*acknowledgement array is not a second route-blocking source/i,
  );
  assert.match(
    disambiguationMigration,
    /Every required pickup line must be checked before confirming pickup/i,
  );
});

test("required-line validation remains strict", () => {
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

test("zero-quantity rows are excluded and prepared snapshots stay protected", () => {
  assert.match(disambiguationMigration, /coalesce\(rsi\.planned_quantity, 0\) > 0/i);
  assert.match(disambiguationMigration, /Prepared pickup summary does not match the saved preparation snapshot/i);
  assert.match(disambiguationMigration, /Prepared pickup stops do not match the current confirmation payload/i);
  assert.match(disambiguationMigration, /for update/i);
});

test("migration is data-safe and reloads PostgREST", () => {
  assert.doesNotMatch(disambiguationMigration, /\btruncate\b/i);
  assert.doesNotMatch(disambiguationMigration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(disambiguationMigration, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(disambiguationMigration, /\bcascade\b/i);
  assert.match(disambiguationMigration, /select pg_notify\('pgrst', 'reload schema'\);/i);
});
