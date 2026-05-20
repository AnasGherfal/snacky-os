export const LARGE_CASH_VARIANCE_LYD = 10;
export const CRITICAL_CASH_VARIANCE_LYD = 50;

export type CashCollectionStatus =
  | "pending_collection"
  | "collected_pending_count"
  | "counted_confirmed"
  | "variance_review"
  | "voided";

export function calculateCashVariance(countedCash: number | null | undefined, expectedCash: number | null | undefined) {
  if (countedCash === null || countedCash === undefined || expectedCash === null || expectedCash === undefined) return null;
  return Number(countedCash) - Number(expectedCash);
}

export function getCashCollectionStatus(status: string | null | undefined, variance: number | null | undefined): CashCollectionStatus {
  if (status === "voided") return "voided";
  if (status === "pending_collection") return "pending_collection";
  if (status === "collected_pending_count") return "collected_pending_count";
  if (status === "counted_confirmed") return "counted_confirmed";
  if (status === "variance_review") return "variance_review";
  if (status === "resolved" || status === "ok") return "counted_confirmed";
  if (status === "needs_review" || status === "review_required") return "variance_review";

  if (variance === null || variance === undefined) return "pending_collection";
  return Math.abs(Number(variance ?? 0)) >= LARGE_CASH_VARIANCE_LYD ? "variance_review" : "counted_confirmed";
}

export function isLargeCashVariance(variance: number | null | undefined) {
  if (variance === null || variance === undefined) return false;
  return Math.abs(Number(variance ?? 0)) >= LARGE_CASH_VARIANCE_LYD;
}

export function isCriticalCashVariance(variance: number | null | undefined) {
  if (variance === null || variance === undefined) return false;
  return Math.abs(Number(variance ?? 0)) >= CRITICAL_CASH_VARIANCE_LYD;
}

export function statusForConfirmedCash(variance: number | null | undefined): CashCollectionStatus {
  return isLargeCashVariance(variance) ? "variance_review" : "counted_confirmed";
}
