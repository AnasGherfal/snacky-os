import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPickupAcknowledgementDiagnostics,
  buildServerCanonicalAcknowledgedPickupLineIds,
  normalizePickupLineIds,
} from "../src/lib/pickup-acknowledgement.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const actionPath = path.join(repoRoot, "src/lib/operator-actions.ts");
const migrationPath = path.join(repoRoot, "supabase/migrations/202607150008_snacky_confirm_route_pickup_batch_v2.sql");

const actionSource = fs.readFileSync(actionPath, "utf8");
const migrationSource = fs.readFileSync(migrationPath, "utf8");

test("server canonical acknowledgement ids are derived from the final checked submitted rows and ignore zero-quantity rows", () => {
  const rows = [
    { route_stop_item_id: "manual-generated-line", is_checked: true, planned_qty: 4 },
    { route_stop_item_id: "required-1", is_checked: true, planned_qty: 3 },
    { route_stop_item_id: "required-1", is_checked: true, planned_qty: 3 },
    { route_stop_item_id: "zero-quantity-line", is_checked: true, planned_qty: 0 },
    { route_stop_item_id: "unchecked-line", is_checked: false, planned_qty: 2 },
    { route_stop_item_id: null, is_checked: true, planned_qty: 2 },
  ];

  assert.deepEqual(buildServerCanonicalAcknowledgedPickupLineIds(rows), ["manual-generated-line", "required-1"]);
});

test("pickup acknowledgement diagnostics preserve browser ids but compute canonical ids from rows", () => {
  const diagnostics = buildPickupAcknowledgementDiagnostics({
    clientAcknowledgedPickupLineIds: ["required-1", "required-1", "stale-browser-line"],
    pickListRows: [
      { route_stop_item_id: "required-1", is_checked: true, planned_qty: 2 },
      { route_stop_item_id: "manual-generated-line", is_checked: true, planned_qty: 5 },
      { route_stop_item_id: "zero-quantity-line", is_checked: true, planned_qty: 0 },
    ],
    requiredPickupLineIds: ["required-1", "required-2"],
  });

  assert.deepEqual(diagnostics.clientAcknowledgedPickupLineIds, ["required-1", "stale-browser-line"]);
  assert.deepEqual(diagnostics.serverCanonicalAcknowledgedPickupLineIds, ["manual-generated-line", "required-1"]);
  assert.deepEqual(diagnostics.checkedPickupLineIds, ["manual-generated-line", "required-1"]);
  assert.deepEqual(diagnostics.requiredPickupLineIds, ["required-1", "required-2"]);
  assert.deepEqual(diagnostics.missingRequiredPickupLineIds, ["required-2"]);
  assert.deepEqual(diagnostics.extraServerCanonicalPickupLineIds, ["manual-generated-line"]);
  assert.deepEqual(diagnostics.clientMissingFromCanonicalPickupLineIds, ["manual-generated-line"]);
  assert.deepEqual(diagnostics.clientExtraBeyondCanonicalPickupLineIds, ["stale-browser-line"]);
});

test("line-id normalisation removes duplicates and blanks", () => {
  assert.deepEqual(normalizePickupLineIds(["a", "b", "a", "", "  ", null, undefined, "c"]), ["a", "b", "c"]);
});

test("operator action calls only the new single-signature pickup RPC", () => {
  assert.match(actionSource, /buildServerCanonicalAcknowledgedPickupLineIds/);
  assert.match(actionSource, /serverCanonicalAcknowledgedPickupLineIds/);
  assert.match(actionSource, /p_acknowledged_pickup_line_ids:\s*serverCanonicalAcknowledgedPickupLineIds/);
  assert.match(actionSource, /snacky_confirm_route_pickup_batch_v3/);
  assert.doesNotMatch(actionSource, /p_acknowledged_pickup_line_ids:\s*\[\]/);
  assert.doesNotMatch(actionSource, /confirm_route_pickup_batch\("/);
  assert.doesNotMatch(actionSource, /confirm_route_pickup_batch_core\("/);
  assert.doesNotMatch(actionSource, /acknowledgement compatibility mismatch/);
});

test("new RPC migration has one unambiguous signature and soft-retires pick-list rows", () => {
  assert.match(migrationSource, /create or replace function public\.snacky_confirm_route_pickup_batch_v2\(/);
  assert.doesNotMatch(migrationSource, /default\s+/i);
  assert.doesNotMatch(migrationSource, /confirm_route_pickup_batch_core\(/i);
  assert.doesNotMatch(migrationSource, /confirm_route_pickup_batch\(/i);
  assert.match(migrationSource, /update public\.route_pick_list_items\s+set\s+is_active = false/i);
  assert.doesNotMatch(migrationSource, /\bdelete\s+from\s+public\.route_pick_list_items\b/i);
  assert.match(migrationSource, /select pg_notify\('pgrst', 'reload schema'\);/i);
});
