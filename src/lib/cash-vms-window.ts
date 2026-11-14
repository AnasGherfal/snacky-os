export type CashVmsComparisonSnapshot = {
  start_collection_id: string;
  end_collection_id: string;
  start_at: string;
  end_at: string;
  included_collection_ids: string[];
  physical_cash_lyd: number;
  vms_cash_lyd: number;
  difference_lyd: number;
  quality: "provisional" | "owner_reported_exact_window";
  payment_scope: "cash_successful_only";
  source: "owner_entered_xy_vms";
  source_note: string;
  saved_at: string;
  saved_by: string;
  submission_id: string;
};

export type CashVmsPickup = {
  id: string;
  machineId: string;
  machineName: string;
  machineCode: string | null;
  removedAt: string;
  removedBy: string | null;
  custodyStatus: string;
  removalType: string;
  compartments: string[];
  countedAmount: number | null;
  timeUncertain: boolean;
  fullClearanceUnverified: boolean;
  comparison: CashVmsComparisonSnapshot | null;
};

export type CashVmsWindow = {
  target: CashVmsPickup;
  startPickup: CashVmsPickup | null;
  startReason: "previous_removal" | "missing";
  startAt: string | null;
  endAt: string;
  included: CashVmsPickup[];
  physicalCashTotal: number | null;
  missingCounts: string[];
  partialRemovals: string[];
  quality: "provisional" | "owner_reported_exact_window";
  warnings: string[];
  canSave: boolean;
  fingerprint: string;
  existing: CashVmsComparisonSnapshot | null;
  existingMatchesCurrentWindow: boolean;
};

/**
 * Every XY period covers exactly ONE physical cash removal, from the immediately
 * preceding recorded machine removal (exclusive) through the selected one
 * (inclusive). Never use last "counted", last "VMS compared", or last "full"
 * pickup as the boundary. An earlier pickup need not be counted or reconciled.
 *
 * If either pickup was partial or its clock time/compartments uncertain, the
 * same date interval is displayed but flagged as provisional. This is NOT
 * a finding of missing cash.
 */
export function planCashVmsWindow(rows: CashVmsPickup[], targetId: string): CashVmsWindow {
  const machineIds = new Set(rows.map((row) => row.machineId));
  if (machineIds.size > 1) throw new Error("Cannot compare pickups from different machines.");
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.removedAt) - Date.parse(b.removedAt) || a.id.localeCompare(b.id));
  const index = sorted.findIndex((row) => row.id === targetId);
  if (index < 0) throw new Error("The cash removal could not be found.");
  const target = sorted[index];
  const targetTime = Date.parse(target.removedAt);
  if (!Number.isFinite(targetTime)) throw new Error("The cash removal time is invalid.");

  // By design: the single immediately preceding non-voided removal, regardless
  // of amount, count status, XY reconciliation, or whether it was a full pickup.
  const startPickup = index > 0 ? sorted[index - 1] : null;
  const startAt = startPickup?.removedAt ?? null;
  const startTime = startAt ? Date.parse(startAt) : null;
  const invalidClock = startTime !== null && (!Number.isFinite(startTime) || startTime >= targetTime);
  const included = startPickup && !invalidClock ? [target] : [];
  const missingCounts = target.countedAmount === null ||
    !["counted", "reconciled", "banked"].includes(target.custodyStatus) ? [target.id] : [];
  const partialRemovals = [startPickup,target].filter((row):row is CashVmsPickup =>
    Boolean(row && row.removalType !== "full")).map((row) => row.id);
  const uncertainTimes = Boolean(startPickup?.timeUncertain || target.timeUncertain);
  const unverifiedClearance = Boolean(startPickup?.fullClearanceUnverified || target.fullClearanceUnverified);
  const provisional = uncertainTimes || unverifiedClearance || partialRemovals.length > 0;
  const quality:CashVmsWindow["quality"] = provisional ? "provisional" : "owner_reported_exact_window";

  const warnings:string[] = [];
  if (!startAt) warnings.push("No previous cash removal exists for this machine. The XY start is unknown; do not assume a month or previous comparison.");
  if (invalidClock) warnings.push("Two cash removals have an identical or invalid timestamp. Check the actual pickup times before comparing.");
  if (startPickup && startPickup.countedAmount === null)
    warnings.push("The previous removal has not been counted. That does NOT change this XY interval: it still starts at the preceding removal.");
  if (startPickup && !startPickup.comparison)
    warnings.push("The previous removal has no saved XY comparison. That does NOT change the start date or require an earlier comparison.");
  if (uncertainTimes)
    warnings.push("One of these pickup times is a historical approximation. This is a provisional comparison, not a verified shortage.");
  if (unverifiedClearance)
    warnings.push("The cash compartments were not independently verified as fully emptied. Use the displayed adjacent pickup timestamps, but treat any difference as provisional.");
  if (partialRemovals.length)
    warnings.push("A pickup was recorded as partial. The adjacent timestamps are still correct, but retained cash may affect the difference.");
  if (missingCounts.length) warnings.push("This selected removal has not been physically counted yet. Record its actual cash before comparing XY.");

  const existing = target.comparison;
  const existingMatchesCurrentWindow = Boolean(existing && startPickup &&
    existing.start_collection_id === startPickup.id &&
    existing.start_at === startPickup.removedAt &&
    existing.end_collection_id === target.id &&
    existing.end_at === target.removedAt &&
    existing.included_collection_ids.length === 1 &&
    existing.included_collection_ids[0] === target.id &&
    existing.physical_cash_lyd === target.countedAmount);
  if (existing && !existingMatchesCurrentWindow)
    warnings.push("An older XY report was saved for a DIFFERENT interval. Its amount is preserved, but must be rechecked for the period between these two consecutive removals.");

  const physicalCashTotal = included.length && !missingCounts.length ? target.countedAmount : null;
  const fingerprint = [target.id,startPickup?.id ?? "NO_START",
    startAt ?? "NO_TIME",target.removedAt, target.countedAmount ?? "UNC"].join("|");

  return {
    target,startPickup,startReason:startPickup ? "previous_removal" : "missing",
    startAt,endAt:target.removedAt,included,physicalCashTotal,
    missingCounts,partialRemovals,quality,warnings,
    // Earlier removal's counting status and XY comparison are NEVER blockers.
    canSave:Boolean(startAt && !invalidClock && included.length===1 && missingCounts.length===0),
    fingerprint,existing,existingMatchesCurrentWindow,
  };
}

export function readManualCashComparison(value: unknown): CashVmsComparisonSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<CashVmsComparisonSnapshot>;
  if (typeof v.end_collection_id !== "string" || typeof v.start_collection_id !== "string" ||
      typeof v.end_at !== "string" || typeof v.start_at !== "string" ||
      typeof v.vms_cash_lyd !== "number" || !Number.isFinite(v.vms_cash_lyd) ||
      !Array.isArray(v.included_collection_ids)) return null;
  return value as CashVmsComparisonSnapshot;
}


/**
 * The owner-entered XY cash total is deliberately a separate audit record,
 * NOT the formal single-bag VMS expected_cash_lyd. Read it consistently in
 * Cash Custody, the cash bag detail, and the action queue.
 * A grouped, multi-machine bag cannot safely show one machine's XY total.
 */
export function savedOwnerVmsForCollection(row: {
  id: string;
  machine_links?: unknown;
}): CashVmsComparisonSnapshot | null {
  const links = row.machine_links;
  if (!Array.isArray(links) || links.length !== 1) return null;
  const link: unknown = links[0];
  if (!link || typeof link !== "object" || Array.isArray(link)) return null;
  const meta: unknown = (link as Record<string, unknown>).expectation_metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const saved = readManualCashComparison((meta as Record<string, unknown>).manual_vms_group_comparison);
  if (!saved || saved.end_collection_id !== row.id) return null;
  // Prevent an inconsistent or stale metadata value from displaying as a valid
  // comparison on a different collection.
  return saved;
}
