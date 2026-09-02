export type XyLaneActivationInput = {
  configuredMachineCount: number;
  successfulMachineFetches: number;
  failedMachineIds: string[];
  invalidLaneRows: number;
  previouslyDisplayedMachineIds: string[];
  snapshotMachineIds: string[];
  snapshotCount: number;
};

export function assessXyLaneSnapshot(input: XyLaneActivationInput) {
  const previousMachineIds = new Set(input.previouslyDisplayedMachineIds.filter(Boolean));
  const currentMachineIds = new Set(input.snapshotMachineIds.filter(Boolean));
  const missingPreviouslyDisplayedMachines = Array.from(previousMachineIds)
    .filter((machineId) => !currentMachineIds.has(machineId));
  const minimumMachineCoverage = previousMachineIds.size > 0
    ? previousMachineIds.size
    : Math.max(1, Math.ceil(input.configuredMachineCount * 0.75));
  const blockers: string[] = [];

  if (input.failedMachineIds.length > 0 || input.successfulMachineFetches !== input.configuredMachineCount) {
    blockers.push("Not every configured XY machine responded successfully.");
  }
  if (input.invalidLaneRows > 0) blockers.push("XY returned one or more invalid configured lanes.");
  if (missingPreviouslyDisplayedMachines.length > 0) {
    blockers.push("One or more previously displayed XY machines are missing from the new snapshot.");
  }
  if (currentMachineIds.size < minimumMachineCoverage) blockers.push("The new XY snapshot has insufficient machine coverage.");
  if (input.snapshotCount <= 0) blockers.push("The new XY snapshot contains no configured lanes.");

  return {
    activationEligible: blockers.length === 0,
    blockers,
    minimumMachineCoverage,
    missingPreviouslyDisplayedMachines,
    snapshotMachineCount: currentMachineIds.size,
  };
}

