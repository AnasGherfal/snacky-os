import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPickupAcknowledgementDiagnostics,
  buildServerCanonicalAcknowledgedPickupLineIds,
  isExactPickupAcknowledgementMismatchError,
  normalizePickupLineIds,
} from "../src/lib/pickup-acknowledgement.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const actionPath = path.join(repoRoot, "src/lib/operator-actions.ts");
const pagePath = path.join(repoRoot, "src/app/operator/routes/[id]/pick-list/page.tsx");
const migrationPath = path.join(repoRoot, "supabase/migrations/202607150005_route_pickup_acknowledgement_canonicalization.sql");

const actionSource = fs.readFileSync(actionPath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const migrationSource = fs.readFileSync(migrationPath, "utf8");

test("server canonical acknowledgement ids are derived from the final checked submitted rows", () => {
  const rows = [
    { route_stop_item_id: "manual-generated-line", is_checked: true },
    { route_stop_item_id: "required-1", is_checked: true },
    { route_stop_item_id: "required-1", is_checked: true },
    { route_stop_item_id: "zero-quantity-line", is_checked: false },
    { route_stop_item_id: "stale-browser-line", is_checked: false },
    { route_stop_item_id: null, is_checked: true },
  ];

  assert.deepEqual(buildServerCanonicalAcknowledgedPickupLineIds(rows), ["manual-generated-line", "required-1"]);
});

test("pickup acknowledgement diagnostics preserve browser ids but compute canonical ids from rows", () => {
  const diagnostics = buildPickupAcknowledgementDiagnostics({
    clientAcknowledgedPickupLineIds: ["required-1", "required-1", "stale-browser-line"],
    pickListRows: [
      { route_stop_item_id: "required-1", is_checked: true },
      { route_stop_item_id: "manual-generated-line", is_checked: true },
      { route_stop_item_id: "zero-quantity-line", is_checked: false },
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

test("only the exact acknowledgement mismatch message triggers the compatibility retry", () => {
  assert.equal(
    isExactPickupAcknowledgementMismatchError({ message: "Pickup checklist acknowledgements do not match the submitted checked lines" }),
    true,
  );
  assert.equal(
    isExactPickupAcknowledgementMismatchError({ message: "Pickup checklist acknowledgements do not match the submitted checked lines.", details: "wrapped by Postgres" }),
    true,
  );
  assert.equal(
    isExactPickupAcknowledgementMismatchError({ message: "Pickup checklist acknowledgements do not match the submitted checked lines", details: "Every required pickup line must be checked before confirming pickup." }),
    true,
  );
  assert.equal(
    isExactPickupAcknowledgementMismatchError({ message: "Every required pickup line must be checked before confirming pickup." }),
    false,
  );
});

test("line-id normalisation removes duplicates and blanks", () => {
  assert.deepEqual(normalizePickupLineIds(["a", "b", "a", "", "  ", null, undefined, "c"]), ["a", "b", "c"]);
});

test("operator action uses the server canonical acknowledgement ids and compatibility retry path", () => {
  assert.match(actionSource, /buildServerCanonicalAcknowledgedPickupLineIds/);
  assert.match(actionSource, /serverCanonicalAcknowledgedPickupLineIds/);
  assert.match(actionSource, /p_acknowledged_pickup_line_ids:\s*serverCanonicalAcknowledgedPickupLineIds/);
  assert.match(actionSource, /p_acknowledged_pickup_line_ids:\s*\[\]/);
  assert.match(actionSource, /isExactPickupAcknowledgementMismatchError/);
  assert.match(actionSource, /used_acknowledgement_compatibility_retry/);
});

test("pickup page still exposes the retry confirmation affordance", () => {
  assert.match(pageSource, /Retry confirmation/);
  assert.match(pageSource, /acknowledgedPickupLineIds,\s*stage: "confirm"/);
});

test("canonicalisation migration still documents the server-side wrapper behavior", () => {
  assert.match(migrationSource, /Harmless extra acknowledgement IDs are ignored/);
  assert.match(migrationSource, /server-generated manual line IDs/);
  assert.match(migrationSource, /create or replace function public\.confirm_route_pickup_batch/);
});
