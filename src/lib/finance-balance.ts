export type BalanceTransaction = {
  transaction_status?: string | null;
  review_status?: string | null;
  needs_review?: boolean | null;
  signed_amount?: number | string | null;
};

export function isBalanceAffectingTransaction(row: BalanceTransaction) {
  const status = row.transaction_status ?? "active";
  const reviewStatus = row.review_status ?? "confirmed";
  return status === "active" && !row.needs_review && (reviewStatus === "confirmed" || reviewStatus === "reviewed");
}

export function signedAmount(row: BalanceTransaction) {
  return Number(row.signed_amount ?? 0);
}
