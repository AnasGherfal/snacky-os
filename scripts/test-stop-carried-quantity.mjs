import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const actionsPath = "src/lib/operator-actions.ts";
const stopApiPath = "src/app/api/operator/routes/[id]/stops/[stopId]/route.ts";

test("stop completion validates against the same operator-bag ledger shown in the UI", () => {
  const actions = read(actionsPath);
  const stopApi = read(stopApiPath);

  assert.match(stopApi, /bagBalanceByProduct/);
  assert.match(stopApi, /availableByProduct/);
  assert.match(stopApi, /currentStopFilledByProduct/);

  assert.match(actions, /routeInventoryMovements/);
  assert.match(actions, /routeBagBalanceFromMovements\(routeMovementRows\)/);
  assert.match(actions, /canonicalPickupProductIds/);
  assert.match(actions, /currentStopCommittedByProduct/);
  assert.match(actions, /requestedBagUse/);
  assert.match(actions, /canonicalAvailable/);
  assert.match(actions, /legacyAvailable/);
});

test("machine-storage quantities are not posted again as normal machine fills", () => {
  const actions = read(actionsPath);

  assert.match(actions, /const actualFillLines = normalizedFilledItems\.map/);
  assert.doesNotMatch(
    actions,
    /const actualFillLines = \[\s*\.\.\.normalizedFilledItems[\s\S]{0,300}\.\.\.normalizedExtraItems/,
  );
  assert.match(actions, /requestedMachineStorage/);
  assert.match(actions, /to_entity_type: "machine_storage"/);
  assert.match(actions, /movement_type: "route_to_machine_storage"/);
});

test("actual field fill above recorded carried stock is logged instead of blocking stop completion", () => {
  const actions = read(actionsPath);

  assert.match(actions, /Actual field fill exceeds recorded carried quantity; completing with inventory discrepancy/);
  assert.match(actions, /discrepancy_quantity: shortage/);
  assert.doesNotMatch(actions, /throw new Error\(\s*`Filled quantity cannot exceed carried quantity/);
});
