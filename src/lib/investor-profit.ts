import { aggregateExpenseCategories, type FinanceOperationsLedgerRow } from "@/lib/finance-operations";

export type InvestorSalesRow = {
  net_sales_amount?: number | string | null;
  cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null;
  cost_missing?: boolean | null;
};

export type InvestorMonthlyCalculation = {
  revenueLyd: number;
  cogsLyd: number;
  grossProfitLyd: number;
  operatingExpensesLyd: number;
  operatingProfitLyd: number;
  sharePercent: number;
  investorShareDueLyd: number;
  missingCostRows: number;
  complete: boolean;
};

function numeric(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

export function isInvestorDistributionLedgerRow(row: FinanceOperationsLedgerRow) {
  const text = [
    row.transaction_kind,
    row.transaction_type,
    row.category,
    row.bucket,
    row.final_bucket,
    row.source_type,
    row.description,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .join(" | ");
  return text.includes("investor profit share")
    || text.includes("investor distribution")
    || text.includes("profit distribution")
    || String(row.source_type ?? "") === "investor_payment";
}

export function calculateInvestorMonth({
  salesRows,
  ledgerRows,
  sharePercent,
}: {
  salesRows: InvestorSalesRow[];
  ledgerRows: FinanceOperationsLedgerRow[];
  sharePercent: number;
}): InvestorMonthlyCalculation {
  const revenueLyd = money(salesRows.reduce((sum, row) => sum + numeric(row.net_sales_amount), 0));
  const cogsLyd = money(salesRows.reduce((sum, row) => sum + numeric(row.cogs_amount), 0));
  const grossProfitFromRows = money(salesRows.reduce((sum, row) => sum + numeric(row.gross_profit_amount), 0));
  const grossProfitLyd = grossProfitFromRows !== 0 || revenueLyd === 0 ? grossProfitFromRows : money(revenueLyd - cogsLyd);
  const missingCostRows = salesRows.filter((row) => row.cost_missing).length;
  const operatingLedger = ledgerRows.filter((row) => !isInvestorDistributionLedgerRow(row));
  const operatingExpensesLyd = aggregateExpenseCategories(operatingLedger, "LYD").operatingExpenses;
  const operatingProfitLyd = money(grossProfitLyd - operatingExpensesLyd);
  const normalizedShare = Math.min(100, Math.max(0, numeric(sharePercent)));
  const investorShareDueLyd = money(Math.max(0, operatingProfitLyd) * (normalizedShare / 100));

  return {
    revenueLyd,
    cogsLyd,
    grossProfitLyd,
    operatingExpensesLyd,
    operatingProfitLyd,
    sharePercent: normalizedShare,
    investorShareDueLyd,
    missingCostRows,
    complete: missingCostRows === 0,
  };
}

export function monthBounds(monthValue: string) {
  const match = String(monthValue ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  const start = `${match[1]}-${match[2]}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}
