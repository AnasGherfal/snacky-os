export const LARGE_CASH_VARIANCE_LYD = 10;
export const CRITICAL_CASH_VARIANCE_LYD = 50;

export type CashCollectionStatus = "ok" | "needs_review" | "resolved";

export function calculateCashVariance(actualCash: number | null | undefined, expectedCash: number | null | undefined) {
  return Number(actualCash ?? 0) - Number(expectedCash ?? 0);
}

export function getCashCollectionStatus(status: string | null | undefined, variance: number | null | undefined): CashCollectionStatus {
  if (status === "resolved") return "resolved";
  if (status === "ok" || status === "needs_review") return status;

  return Math.abs(Number(variance ?? 0)) >= LARGE_CASH_VARIANCE_LYD ? "needs_review" : "ok";
}

export function isLargeCashVariance(variance: number | null | undefined) {
  return Math.abs(Number(variance ?? 0)) >= LARGE_CASH_VARIANCE_LYD;
}

export function isCriticalCashVariance(variance: number | null | undefined) {
  return Math.abs(Number(variance ?? 0)) >= CRITICAL_CASH_VARIANCE_LYD;
}
