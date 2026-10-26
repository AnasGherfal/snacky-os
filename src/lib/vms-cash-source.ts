/**
 * Cash-expectation SQL accepts raw transactions only from non-deleted,
 * imported batches with one of these statuses.
 *
 * Kept in sync with snacky_private.calculate_cash_expectation_impl.
 * Being in an eligible batch does NOT by itself certify interval completeness:
 * mapping, timestamps, payment methods and contiguous import coverage still
 * require review before a cash shortage can be accepted.
 */
export const CASH_ELIGIBLE_VMS_BATCH_STATUSES = [
  "imported",
  "imported_with_warnings",
  "partially_imported",
] as const;

export type CashSourceBatch = { status?: string | null; deleted_at?: string | null };

/** Unknown/deleted source metadata never grants cash-transaction eligibility. */
export function isEligibleCashSourceBatch(batch: CashSourceBatch | null | undefined): boolean {
  return Boolean(batch && batch.deleted_at === null
    && CASH_ELIGIBLE_VMS_BATCH_STATUSES.includes(batch.status as (typeof CASH_ELIGIBLE_VMS_BATCH_STATUSES)[number]));
}
