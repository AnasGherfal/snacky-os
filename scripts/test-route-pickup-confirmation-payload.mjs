import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const directPickupSource = readFileSync("src/lib/direct-pickup-actions.ts", "utf8");
const actionSource = readFileSync("src/lib/operator-actions.ts", "utf8");

test("direct pickup canonicalizes acknowledged line ids for both prepare and confirm calls", () => {
  assert.match(directPickupSource, /canonicalItems = pickedItems\.map\(\(item\) => \(\{ \.\.\.item, isChecked: true \}\)\)/);
  assert.match(directPickupSource, /const acknowledgedPickupLineIds = Array\.from\(/);
  assert.match(directPickupSource, /\.map\(\(item\) => String\(item\.routeStopItemId \?\? ""\)\.trim\(\)\)/);
  assert.match(directPickupSource, /acknowledgedPickupLineIds,\s*stage: "prepare"/);
  assert.match(directPickupSource, /preparedBatchId: pickupBatchId,\s*acknowledgedPickupLineIds,\s*stage: "confirm"/);
});

test("pickup action exposes checklist validation failures instead of hiding them behind the generic fallback", () => {
  assert.match(actionSource, /pickup checklist acknowledgements do not match the submitted checked lines/);
  assert.match(actionSource, /every required pickup line must be checked/);
  assert.match(actionSource, /pickupPublicError\(error\)/);
});
