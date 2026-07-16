export type MonthlyCashExpectationSource = "vms_cash_split" | "cash_only_total_sales" | "unavailable";

export type MonthlyCashExpectation = {
  expectedCash: number | null;
  source: MonthlyCashExpectationSource;
  note: string;
};

function numeric(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function parseDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function resolveMonthlyCashExpectation({
  paymentSplitAvailable,
  vmsCashSales,
  vmsRevenue,
  assumeCashOnlyWhenSplitMissing = true,
}: {
  paymentSplitAvailable: boolean;
  vmsCashSales: number | string | null | undefined;
  vmsRevenue: number | string | null | undefined;
  assumeCashOnlyWhenSplitMissing?: boolean;
}): MonthlyCashExpectation {
  if (paymentSplitAvailable) {
    return {
      expectedCash: roundMoney(numeric(vmsCashSales)),
      source: "vms_cash_split",
      note: "Expected cash comes from the VMS cash-payment total for the selected month.",
    };
  }

  if (assumeCashOnlyWhenSplitMissing) {
    return {
      expectedCash: roundMoney(numeric(vmsRevenue)),
      source: "cash_only_total_sales",
      note: "The VMS report has no payment split, so total VMS sales are used as expected cash under Snacky's current cash-only machine workflow.",
    };
  }

  return {
    expectedCash: null,
    source: "unavailable",
    note: "Expected cash is unavailable because the VMS report does not separate cash from card payments.",
  };
}

export function reconcileMonthlyCash(countedCash: number, expectation: MonthlyCashExpectation) {
  const counted = roundMoney(numeric(countedCash));
  const expected = expectation.expectedCash;
  return {
    countedCash: counted,
    expectedCash: expected,
    variance: expected === null ? null : roundMoney(counted - expected),
    accuracy: expected && expected > 0 ? counted / expected : null,
  };
}

export function isCompleteClosedMonthRange(start: string, end: string, now = new Date()) {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);
  if (!startDate || !endDate) return false;
  const monthStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const monthEnd = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return startDate.getTime() === monthStart.getTime()
    && endDate.getTime() === monthEnd.getTime()
    && endDate.getTime() < today.getTime();
}

export function monthlyMachineExpectedCash({
  paymentSplitAvailable,
  vmsSalesAmount,
}: {
  paymentSplitAvailable: boolean;
  vmsSalesAmount: number;
}) {
  return paymentSplitAvailable ? null : roundMoney(vmsSalesAmount);
}
