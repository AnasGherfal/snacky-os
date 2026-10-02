import { aggregateExpenseCategories, canonicalExpenseCategory, isReportableExpenseRow, type FinanceOperationsLedgerRow } from "./finance-operations.ts";

export type InvestorLedgerRow = FinanceOperationsLedgerRow & { exchange_rate_usd_to_lyd?: number | string | null };
export type InvestorExpenseBreakdown = { key: string; label: string; amount: number; transactionCount: number };
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const words = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[_-]/g, " ");

export function isInvestorCapitalPurchase(row: InvestorLedgerRow) {
  const category = [row.category, row.final_bucket, row.transaction_type, row.bucket].map(words).join(" | ");
  const capital = /machine investment|machine purchase|equipment purchase|capital equipment|fixed asset|شراء ماكينة|شراء ماكينات|شراء الماكين|مشتريات الماكينات|أصول ثابتة/;
  if (capital.test(category)) return true;
  // A machine mentioned on a rent/repair/stock receipt is NOT a machine purchase.
  const categorized = canonicalExpenseCategory(row);
  if (!categorized.key.startsWith("other:")) return false;
  return capital.test(words(row.description));
}

export function investorExpenseSummary(rows: InvestorLedgerRow[]) {
  const operatingLedger: InvestorLedgerRow[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  let capitalPurchasesLyd = 0;
  let stockPurchasesLyd = 0;
  for (const row of rows) {
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);
    const currency = String(row.currency ?? "LYD").toUpperCase();
    if (!isReportableExpenseRow(row, currency)) continue;
    const funding = [row.category, row.transaction_type, row.source_type].map(words).join(" | ");
    if (/investor capital|capital return|investor contribution|investor payment|investor profit share|owner funding|owner withdrawal/.test(funding)) continue;
    const amount = Number(row.amount ?? NaN);
    const rate = currency === "LYD" ? 1 : currency === "USD" ? Number(row.exchange_rate_usd_to_lyd ?? NaN) : NaN;
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(rate) || rate <= 0) {
      unresolved.push(`${row.id ?? "entry"}: amount or USD-to-LYD rate missing`);
      continue;
    }
    const converted = money(amount * rate);
    const normalized = { ...row, currency: "LYD", amount: converted, signed_amount: -converted };
    if (isInvestorCapitalPurchase(row)) capitalPurchasesLyd += converted;
    else if (canonicalExpenseCategory(row).isProductPurchase || row.source_type === "purchase_payment" || row.transaction_kind === "product_purchase") stockPurchasesLyd += converted;
    else operatingLedger.push(normalized);
  }
  const totals = aggregateExpenseCategories(operatingLedger, "LYD");
  return {
    operatingExpensesLyd: totals.operatingExpenses,
    capitalPurchasesLyd: money(capitalPurchasesLyd),
    stockPurchasesLyd: money(stockPurchasesLyd),
    expenseBreakdown: totals.categories.map(({ key, label, amount, transactionCount }) => ({ key, label, amount, transactionCount })),
    unresolved,
  };
}
