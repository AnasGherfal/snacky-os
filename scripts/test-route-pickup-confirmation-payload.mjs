import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const pageSource = readFileSync("src/app/operator/routes/[id]/pick-list/page.tsx", "utf8");
const actionSource = readFileSync("src/lib/operator-actions.ts", "utf8");

test("pickup page passes checked pickup line ids into both prepare and confirm calls", () => {
  const expectedFragment = "acknowledgedPickupLineIds";
  assert.equal(pageSource.includes(expectedFragment), true, "pickup page should pass acknowledged pickup line ids");
  assert.match(pageSource, /acknowledgedPickupLineIds,\s*stage: "prepare"/);
  assert.match(pageSource, /acknowledgedPickupLineIds,\s*stage: "confirm",\s*preparedBatchId: activePreparedBatch\.id/);
  assert.match(pageSource, /filter\(\(item\) => item\.isChecked && item\.routeStopItemId\)\.map\(\(item\) => item\.routeStopItemId as string\)/);
});

test("pickup action exposes checklist validation failures instead of hiding them behind the generic fallback", () => {
  assert.match(actionSource, /pickup checklist acknowledgements do not match the submitted checked lines/);
  assert.match(actionSource, /every required pickup line must be checked/);
  assert.match(actionSource, /pickupPublicError\(error\)/);
});
