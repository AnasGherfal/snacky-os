import {
  computeFinanceBalancesFromCutoff,
  FINANCE_RECONCILIATION_CUTOFF_DATE,
  isFinanceLedgerTransaction,
  type BalanceTransaction,
  type FinanceBalances,
} from "@/lib/finance-balance";

export type FinanceCashReconciliation =
  | { verified: false; reason: "invalid_count" | "invalid_date" | "before_opening_balance" | "undated_active_entry" }
  | {
      verified: true;
      asOfDate: string;
      ledgerSnackyLyd: number;
      differenceFromCashAndBankLyd: number;
      differenceIncludingCustodyLyd: number;
      basis: "date_only";
    };

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Read-only, date-level comparison. An owner's count of physical money is not
 * an adjusting Finance entry. The ledger may include money held by others,
 * and posting timing may differ within a calendar day. Therefore gaps must
 * never be labeled theft/loss or automatically posted as balancing entries.
 */
export function compareOwnerCashCountToLedger({
  rows,
  asOfDate,
  directlyAccessibleLyd,
  custodyLyd,
  openingBalances,
  cutoffDate = FINANCE_RECONCILIATION_CUTOFF_DATE,
}: {
  rows: BalanceTransaction[];
  asOfDate: string;
  directlyAccessibleLyd: number;
  custodyLyd: number;
  openingBalances?: Partial<FinanceBalances>;
  cutoffDate?: string;
}): FinanceCashReconciliation {
  if (!Number.isFinite(directlyAccessibleLyd) || directlyAccessibleLyd < 0
    || !Number.isFinite(custodyLyd) || custodyLyd < 0) {
    return { verified: false, reason: "invalid_count" };
  }
  if (!validDate(asOfDate) || !validDate(cutoffDate)) {
    return { verified: false, reason: "invalid_date" };
  }
  if (asOfDate < cutoffDate) return { verified: false, reason: "before_opening_balance" };
  if (rows.some(row => isFinanceLedgerTransaction(row, cutoffDate) && !row.transaction_date)) {
    return { verified: false, reason: "undated_active_entry" };
  }

  const asOfRows = rows.filter(row => row.transaction_date && row.transaction_date <= asOfDate);
  const ledgerSnackyLyd = computeFinanceBalancesFromCutoff({
    rows: asOfRows,
    openingBalances,
    cutoffDate,
  }).snacky_lyd;

  return {
    verified: true,
    asOfDate,
    ledgerSnackyLyd,
    differenceFromCashAndBankLyd: round(ledgerSnackyLyd - directlyAccessibleLyd),
    differenceIncludingCustodyLyd: round(ledgerSnackyLyd - directlyAccessibleLyd - custodyLyd),
    basis: "date_only",
  };
}
