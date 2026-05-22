export const FINANCE_ACCOUNTS = [
  { id: "snacky_lyd", label: "Snacky LYD", owner: "snacky", currency: "LYD" },
  { id: "snacky_usd", label: "Snacky USD", owner: "snacky", currency: "USD" },
  { id: "owner_lyd", label: "Owner LYD", owner: "owner", currency: "LYD" },
  { id: "owner_usd", label: "Owner USD", owner: "owner", currency: "USD" },
] as const;

export type FinanceAccountId = (typeof FINANCE_ACCOUNTS)[number]["id"];
export type FinanceCurrency = "LYD" | "USD";
export type FinanceTransactionEffect = "income" | "expense" | "transfer" | "opening_balance";

export type FinanceBalances = Record<FinanceAccountId, number>;

export type BalanceTransaction = {
  transaction_status?: string | null;
  import_status?: string | null;
  needs_review?: boolean | null;
  direction?: string | null;
  amount?: number | string | null;
  signed_amount?: number | string | null;
  account_id?: string | null;
  currency?: string | null;
  transaction_effect?: string | null;
  source_account_id?: string | null;
  destination_account_id?: string | null;
};

export const ZERO_FINANCE_BALANCES: FinanceBalances = {
  snacky_lyd: 0,
  snacky_usd: 0,
  owner_lyd: 0,
  owner_usd: 0,
};

const excludedImportStatuses = new Set(["needs_review", "ignored", "skipped"]);

export function normalizeFinanceCurrency(value: unknown): FinanceCurrency {
  const currency = String(value ?? "LYD").trim().toUpperCase();
  return currency === "USD" ? "USD" : "LYD";
}

export function accountCurrency(accountId: string | null | undefined): FinanceCurrency {
  return String(accountId ?? "").endsWith("_usd") ? "USD" : "LYD";
}

export function accountLabel(accountId: string | null | undefined) {
  return FINANCE_ACCOUNTS.find((account) => account.id === accountId)?.label ?? "Snacky LYD";
}

export function financeAccountId(value: unknown, currencyFallback: unknown = "LYD"): FinanceAccountId {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "snacky_lyd" || raw === "business_lyd" || raw === "company_lyd") return "snacky_lyd";
  if (raw === "snacky_usd" || raw === "business_usd" || raw === "company_usd") return "snacky_usd";
  if (raw === "owner_lyd" || raw === "personal_lyd") return "owner_lyd";
  if (raw === "owner_usd" || raw === "personal_usd") return "owner_usd";
  return normalizeFinanceCurrency(currencyFallback) === "USD" ? "snacky_usd" : "snacky_lyd";
}

export function financeAccountFor(owner: "snacky" | "owner", currency: unknown): FinanceAccountId {
  if (owner === "owner") return normalizeFinanceCurrency(currency) === "USD" ? "owner_usd" : "owner_lyd";
  return normalizeFinanceCurrency(currency) === "USD" ? "snacky_usd" : "snacky_lyd";
}

function numeric(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export function signedAmount(row: BalanceTransaction) {
  const signed = numeric(row.signed_amount);
  if (signed !== 0) return signed;
  const amount = Math.abs(numeric(row.amount));
  return row.direction === "money_out" ? -amount : amount;
}

export function isBalanceAffectingTransaction(row: BalanceTransaction) {
  const status = row.transaction_status ?? "active";
  if (status !== "active") return false;
  if (row.needs_review) return false;
  if (excludedImportStatuses.has(String(row.import_status ?? "").toLowerCase())) return false;
  return true;
}

export function transactionImpacts(row: BalanceTransaction): Partial<FinanceBalances> {
  if (!isBalanceAffectingTransaction(row)) return {};
  const amount = Math.abs(numeric(row.amount || row.signed_amount));
  const effect = String(row.transaction_effect || (row.direction === "money_in" ? "income" : "expense"));

  if (effect === "transfer") {
    const source = financeAccountId(row.source_account_id, row.currency);
    const destination = financeAccountId(row.destination_account_id, accountCurrency(source));
    if (source === destination) return {};
    return {
      [source]: roundMoney(-(amount || Math.abs(signedAmount(row)))),
      [destination]: roundMoney(amount || Math.abs(signedAmount(row))),
    };
  }

  const account = financeAccountId(row.account_id, row.currency);
  const delta = effect === "opening_balance" ? signedAmount(row) : signedAmount(row);
  return { [account]: roundMoney(delta) };
}

export function computeFinanceBalances(rows: BalanceTransaction[], openingBalances: Partial<FinanceBalances> = {}): FinanceBalances {
  const balances: FinanceBalances = { ...ZERO_FINANCE_BALANCES, ...openingBalances };

  for (const row of rows) {
    const impacts = transactionImpacts(row);
    for (const account of FINANCE_ACCOUNTS) {
      balances[account.id] = roundMoney(balances[account.id] + numeric(impacts[account.id]));
    }
  }

  return balances;
}

export function financeTotalsByCurrency(balances: FinanceBalances) {
  return {
    LYD: roundMoney(balances.snacky_lyd + balances.owner_lyd),
    USD: roundMoney(balances.snacky_usd + balances.owner_usd),
  };
}

export function formatFinanceMoney(value: number | null | undefined, currency: string | null | undefined = "LYD") {
  const safeValue = Number(value ?? 0);
  const decimals = Math.abs(safeValue % 1) > 0 ? 2 : 0;
  return `${safeValue.toLocaleString("en-US", { maximumFractionDigits: decimals })} ${normalizeFinanceCurrency(currency)}`;
}

export function sumFinanceRows(rows: BalanceTransaction[], currency: FinanceCurrency, direction?: "money_in" | "money_out") {
  return rows.reduce((total, row) => {
    if (!isBalanceAffectingTransaction(row)) return total;
    if (normalizeFinanceCurrency(row.currency) !== currency) return total;
    if (direction && row.direction !== direction) return total;
    return roundMoney(total + signedAmount(row));
  }, 0);
}
