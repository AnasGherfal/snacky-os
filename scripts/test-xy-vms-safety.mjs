import assert from "node:assert/strict";
import test from "node:test";
import { assessXyLaneSnapshot } from "../src/lib/xy-vms-safety.ts";

const currentMachines = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];

test("a complete XY lane snapshot can activate while a new unconfigured machine stays empty", () => {
  const result = assessXyLaneSnapshot({
    configuredMachineCount: 8,
    successfulMachineFetches: 8,
    failedMachineIds: [],
    invalidLaneRows: 0,
    previouslyDisplayedMachineIds: currentMachines,
    snapshotMachineIds: currentMachines,
    snapshotCount: 297,
  });

  assert.equal(result.activationEligible, true);
  assert.deepEqual(result.blockers, []);
});

test("one failed XY machine preserves the previous verified snapshot", () => {
  const result = assessXyLaneSnapshot({
    configuredMachineCount: 8,
    successfulMachineFetches: 7,
    failedMachineIds: ["m4"],
    invalidLaneRows: 0,
    previouslyDisplayedMachineIds: currentMachines,
    snapshotMachineIds: currentMachines.filter((id) => id !== "m4"),
    snapshotCount: 250,
  });

  assert.equal(result.activationEligible, false);
  assert.ok(result.missingPreviouslyDisplayedMachines.includes("m4"));
});

test("invalid lanes or insufficient first-sync coverage cannot activate", () => {
  const invalid = assessXyLaneSnapshot({
    configuredMachineCount: 8,
    successfulMachineFetches: 8,
    failedMachineIds: [],
    invalidLaneRows: 1,
    previouslyDisplayedMachineIds: currentMachines,
    snapshotMachineIds: currentMachines,
    snapshotCount: 296,
  });
  const tooSmall = assessXyLaneSnapshot({
    configuredMachineCount: 8,
    successfulMachineFetches: 8,
    failedMachineIds: [],
    invalidLaneRows: 0,
    previouslyDisplayedMachineIds: [],
    snapshotMachineIds: ["m1"],
    snapshotCount: 40,
  });

  assert.equal(invalid.activationEligible, false);
  assert.equal(tooSmall.activationEligible, false);
  assert.equal(tooSmall.minimumMachineCoverage, 6);
});

