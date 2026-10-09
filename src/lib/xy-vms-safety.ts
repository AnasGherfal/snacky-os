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

/**
 * Use a previously verified XY value only when the vendor reports an
 * impossible quantity for the SAME product and physical capacity.
 *
 * The caller MUST retain the original captured_at and mark the selection
 * as stale: a fallback is not a fresh XY measurement.
 */
export function canCarryForwardVerifiedXyLane(args: {
  invalidReason: string;
  vmsProductId: string;
  reportedCapacity: number | null;
  previous: {
    vms_product_id: string | null;
    current_qty: number | null;
    capacity: number | null;
    captured_at: string | null;
  } | null | undefined;
  nowMs?: number;
}): boolean {
  if (args.invalidReason !== "current quantity exceeds capacity" || !args.previous) return false;
  const previous = args.previous;
  const previouslyVerifiedAt = Date.parse(String(previous.captured_at ?? ""));
  const qty = previous.current_qty;
  const capacity = previous.capacity;
  const ageMs = (args.nowMs ?? Date.now()) - previouslyVerifiedAt;
  return Boolean(
    args.vmsProductId
    && args.vmsProductId === previous.vms_product_id
    && qty !== null && Number.isSafeInteger(qty) && qty >= 0
    && capacity !== null && Number.isSafeInteger(capacity) && capacity > 0
    && qty <= capacity
    && args.reportedCapacity === capacity
    && Number.isFinite(ageMs) && ageMs >= 0
    && ageMs <= 48 * 60 * 60 * 1000
  );
}
