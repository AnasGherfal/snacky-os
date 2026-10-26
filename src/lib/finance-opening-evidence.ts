import {
  FINANCE_ACCOUNTS,
  FINANCE_RECONCILIATION_CUTOFF_DATE,
  type FinanceBalances,
} from "@/lib/finance-balance";

type OpeningRow = {
  account_id?: string | null;
  balance_date?: string | null;
  opening_balance?: number | string | null;
};
type OpeningSettings = {
  reconciliation_cutoff_date?: string | null;
  opening_balance_date?: string | null;
};

export type VerifiedFinanceOpening =
  | { verified: false; reason: string }
  | { verified: true; cutoffDate: string; openingBalances: FinanceBalances };

/** Fail closed on missing Finance opening records rather than invent the
 * opening balance used to compare a physical cash count with the ledger.
 */
export function verifyFinanceOpeningEvidence(
  settings: OpeningSettings | null,
  rows: OpeningRow[] | null,
): VerifiedFinanceOpening {
  if (!settings || !Array.isArray(rows)) {
    return { verified: false, reason: "Finance opening-balance settings or source are unavailable." };
  }
  const cutoffDate = String(
    settings.reconciliation_cutoff_date
      ?? settings.opening_balance_date
      ?? FINANCE_RECONCILIATION_CUTOFF_DATE,
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) {
    return { verified: false, reason: "Finance reconciliation cutoff date is invalid." };
  }
  const date = new Date(cutoffDate + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== cutoffDate) {
    return { verified: false, reason: "Finance reconciliation cutoff date is invalid." };
  }
  const balances: Partial<FinanceBalances> = {};
  const matching = rows.filter(row => row.balance_date === cutoffDate);
  if (matching.length !== FINANCE_ACCOUNTS.length) {
    return { verified: false, reason: "A complete dated opening balance for every Finance account is required." };
  }
  for (const account of FINANCE_ACCOUNTS) {
    const accountMatches = matching.filter(row => row.account_id === account.id);
    if (accountMatches.length !== 1) {
      return { verified: false, reason: "Finance opening account is missing or duplicated." };
    }
    const value = accountMatches[0].opening_balance;
    if (value === null || value === undefined || value === "") {
      return { verified: false, reason: "Finance opening account has no verified amount." };
    }
    const balance = Number(value);
    if (!Number.isFinite(balance)) {
      return { verified: false, reason: "Finance opening account amount is invalid." };
    }
    balances[account.id] = balance;
  }
  return { verified: true, cutoffDate, openingBalances: balances as FinanceBalances };
}
