export type BalanceTransaction = {
  transaction_status?: string | null;
  signed_amount?: number | string | null;
};

export function isBalanceAffectingTransaction(row: BalanceTransaction) {
  const status = row.transaction_status ?? "active";
  return status === "active";
}

export function signedAmount(row: BalanceTransaction) {
  return Number(row.signed_amount ?? 0);
}
