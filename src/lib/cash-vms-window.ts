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
  startReason: "previous_saved_comparison" | "previous_full_removal" | "missing";
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
};

function roundedCents(value: number) {
  return Math.round(value * 100);
}

/**
 * Window rule:
 * - From the last saved machine-specific XY comparison, exclusive; or
 * - For a first comparison, from the preceding recorded full cash removal,
 *   explicitly labelled as NOT previously VMS-compared.
 * - Through this machine's selected removal, inclusive.
 * - Count all intervening pickups, not just the selected cash bag.
 */
export function planCashVmsWindow(rows: CashVmsPickup[], targetId: string): CashVmsWindow {
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.removedAt) - Date.parse(b.removedAt) || a.id.localeCompare(b.id));
  const target = sorted.find((row) => row.id === targetId);
  if (!target) throw new Error("The cash removal could not be found.");
  const targetTime = Date.parse(target.removedAt);
  if (!Number.isFinite(targetTime)) throw new Error("The cash removal time is invalid.");
  const earlier = sorted.filter((row) => Date.parse(row.removedAt) < targetTime);
  const latestSaved = [...earlier].reverse().find((row) => row.comparison && row.comparison.end_collection_id === row.id);
  const latestFull = [...earlier].reverse().find((row) => row.removalType === "full");
  const startPickup = latestSaved ?? latestFull ?? null;
  const startReason: CashVmsWindow["startReason"] = latestSaved ? "previous_saved_comparison" :
    latestFull ? "previous_full_removal" : "missing";
  const startAt = startPickup?.removedAt ?? null;
  const included = startPickup ? sorted.filter((row) => {
    const time = Date.parse(row.removedAt);
    return time > Date.parse(startPickup.removedAt) && time <= targetTime;
  }) : [];
  const missingCounts = included.filter((row) => row.countedAmount === null ||
    !["counted", "reconciled", "banked"].includes(row.custodyStatus)).map((row) => row.id);
  const partialRemovals = included.filter((row) => row.removalType !== "full").map((row) => row.id);
  const unknownCutoff = included.some((row) => row.timeUncertain);
  const uncertainStart = Boolean(startPickup?.timeUncertain || startPickup?.fullClearanceUnverified);
  const previousComparisonProvisional = Boolean(latestSaved?.comparison?.quality === "provisional");
  const quality: CashVmsWindow["quality"] = (startReason === "previous_full_removal" ||
    uncertainStart || unknownCutoff || previousComparisonProvisional ||
    included.some((row) => row.fullClearanceUnverified)) ? "provisional" : "owner_reported_exact_window";
  const warnings: string[] = [];
  if (!startAt) warnings.push("No earlier full pickup or saved XY comparison exists. Do not guess a starting timestamp.");
  if (startReason === "previous_full_removal")
    warnings.push("No previous saved VMS comparison exists for this machine. Start is its preceding FULL removal, NOT a previous verified XY comparison.");
  if (uncertainStart) warnings.push("The starting pickup time or full cash clearance is not independently verified (historical placeholder or missing compartment evidence). This comparison is provisional.");
  if (unknownCutoff) warnings.push("At least one included removal time is approximate. The exact XY sales cutoff cannot be certified.");
  if (previousComparisonProvisional) warnings.push("The previous owner-entered XY comparison was provisional. Review that earlier period separately.");
  if (missingCounts.length) warnings.push("One or more removals within this window have not been physically counted. Count them before comparing.");
  if (partialRemovals.length) warnings.push("A partial cash removal appears in this window; remaining float or money needs separate verification.");
  const later = sorted.some((row) => Date.parse(row.removedAt) > targetTime &&
    row.comparison?.included_collection_ids?.includes(targetId));
  if (later) warnings.push("This removal is already included in a later saved XY comparison. Correct the later record first to prevent double counting.");
  const physicalCashTotal = !startAt || missingCounts.length ? null :
    included.reduce((sum, row) => sum + roundedCents(row.countedAmount ?? 0), 0) / 100;
  const fingerprint = [target.id, startPickup?.id ?? "NO_START",
    ...included.map((row) => row.id + ":" + (row.countedAmount ?? "UNC")),
  ].join("|");
  return {
    target, startPickup, startReason, startAt, endAt: target.removedAt,
    included, physicalCashTotal, missingCounts, partialRemovals, quality, warnings,
    canSave: Boolean(startAt && included.length && missingCounts.length === 0 &&
      partialRemovals.length === 0 && !later),
    fingerprint, existing: target.comparison,
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
