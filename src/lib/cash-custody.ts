export const CASH_DENOMINATIONS = [0.25, 0.5, 1, 5, 10, 20, 50] as const;

export type CashDenomination = (typeof CASH_DENOMINATIONS)[number];
export type CashCustodyStatus = "removed" | "in_storage" | "counted" | "reconciled" | "banked" | "voided";
export type CashAlertSeverity = "warning" | "critical";

export type CashCustodyAlert = {
  severity: CashAlertSeverity;
  label: string;
  detail: string;
};

export type CashCustodyAlertInput = {
  custody_status?: string | null;
  reconciliation_status?: string | null;
  collected_at?: string | null;
  storage_received_at?: string | null;
  counted_at?: string | null;
  reconciled_at?: string | null;
  storage_seal_condition?: string | null;
  count_seal_condition?: string | null;
};

export function denominationKey(denomination: CashDenomination) {
  return String(denomination);
}

export function denominationFieldName(denomination: CashDenomination) {
  return `denomination_${denominationKey(denomination).replace(".", "_")}`;
}

export function calculateDenominationTotal(counts: Record<string, number>, otherAmount = 0) {
  const counted = CASH_DENOMINATIONS.reduce((total, denomination) => {
    const quantity = Math.max(0, Math.trunc(Number(counts[denominationKey(denomination)] ?? 0)));
    return total + denomination * quantity;
  }, 0);
  return Math.round((counted + Math.max(0, Number(otherAmount) || 0)) * 100) / 100;
}

export function missingCashAmount(actualCash: number | null | undefined, expectedCash: number | null | undefined) {
  if (actualCash === null || actualCash === undefined || expectedCash === null || expectedCash === undefined) return null;
  return Math.round(Math.max(Number(expectedCash) - Number(actualCash), 0) * 100) / 100;
}

export function combinedCashPosition(rows: Array<{
  actual_cash_collected?: number | string | null;
  vms_expected_cash?: number | string | null;
}>) {
  let actualCash = 0;
  let expectedCash = 0;
  let batchCount = 0;

  for (const row of rows) {
    if (row.actual_cash_collected === null || row.actual_cash_collected === undefined
      || row.vms_expected_cash === null || row.vms_expected_cash === undefined) continue;
    const actual = Number(row.actual_cash_collected);
    const expected = Number(row.vms_expected_cash);
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) continue;
    actualCash += actual;
    expectedCash += expected;
    batchCount += 1;
  }

  actualCash = Math.round(actualCash * 100) / 100;
  expectedCash = Math.round(expectedCash * 100) / 100;
  const difference = Math.round((actualCash - expectedCash) * 100) / 100;
  return {
    actualCash,
    expectedCash,
    difference,
    missingCash: Math.max(-difference, 0),
    overageCash: Math.max(difference, 0),
    batchCount,
  };
}

export function cashCustodyStatusLabel(status: string | null | undefined) {
  const labels: Record<string, string> = {
    removed: "Removed — handoff due",
    in_storage: "In storage — count due",
    counted: "Counted — reconciliation due",
    reconciled: "Reconciled — bank deposit due",
    banked: "Banked",
    voided: "Voided",
  };
  return labels[String(status ?? "")] ?? "Unknown";
}

function hoursSince(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 3_600_000);
}

function ageLabel(hours: number) {
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = Math.floor(hours % 24);
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function getCashCustodyAlerts(row: CashCustodyAlertInput, now = new Date()): CashCustodyAlert[] {
  const alerts: CashCustodyAlert[] = [];
  const status = row.custody_status;

  if (row.reconciliation_status === "variance_review") {
    alerts.push({ severity: "critical", label: "Owner review required", detail: "The combined batch total or custody evidence has an unresolved exception." });
  }
  if ([row.storage_seal_condition, row.count_seal_condition].some((condition) => condition && condition !== "intact")) {
    alerts.push({ severity: "critical", label: "Seal exception", detail: "A broken or mismatched seal must be resolved by an owner or admin." });
  }

  const threshold = status === "removed"
    ? { date: row.collected_at, hours: 2, label: "Storage handoff overdue" }
    : status === "in_storage"
      ? { date: row.storage_received_at, hours: 24, label: "Cash count overdue" }
      : status === "counted"
        ? { date: row.counted_at, hours: 24, label: "Reconciliation overdue" }
        : status === "reconciled"
          ? { date: row.reconciled_at, hours: 48, label: "Bank deposit overdue" }
          : null;

  if (threshold) {
    const age = hoursSince(threshold.date, now);
    if (age !== null && age >= threshold.hours) {
      alerts.push({
        severity: status === "removed" || status === "reconciled" ? "critical" : "warning",
        label: threshold.label,
        detail: `This stage has been open for ${ageLabel(age)}; target is ${threshold.hours} hours.`,
      });
    }
  }

  return alerts;
}
