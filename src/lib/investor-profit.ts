import { type FinanceOperationsLedgerRow } from "@/lib/finance-operations";
import { investorExpenseSummary, type InvestorExpenseBreakdown, type InvestorLedgerRow } from "./investor-expenses.ts";

export type InvestorProfitBasis = "operating_profit" | "operating_profit_after_capex";
export type InvestorSalesRow = {
  net_sales_amount?: number | string | null; cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null; cost_missing?: boolean | null;
  source?: "vms" | "manual_route_sale" | string | null;
};
export type ManualRouteSaleForProfit = { id: string; machine_id?: string | null; total_amount_lyd?: number | string | null; inventory_movement_id?: string | null; sale_time?: string | null; status?: string | null };
export type ManualSaleCostMovement = { id: string; line_total_lyd?: number | string | null; unit_cost_lyd?: number | string | null };
export type InvestorMonthlyCalculation = {
  revenueLyd: number; cogsLyd: number; grossProfitLyd: number; vmsRevenueLyd: number;
  manualSalesRevenueLyd: number; manualSalesCogsLyd: number; operatingExpensesLyd: number;
  operatingProfitLyd: number; sharePercent: number; investorShareDueLyd: number;
  missingCostRows: number; complete: boolean; capitalPurchasesLyd: number;
  stockPurchasesLyd: number; distributionBasisLyd: number; profitBasis: InvestorProfitBasis;
  expenseBreakdown: InvestorExpenseBreakdown[]; accountingWarnings: string[];
};
const numeric = (value: number | string | null | undefined) => Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0;
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function manualRouteSalesAsProfitRows(sales: ManualRouteSaleForProfit[], movements: ManualSaleCostMovement[]): InvestorSalesRow[] {
  const movementById = new Map(movements.map((movement) => [movement.id, movement]));
  return sales.filter((sale) => String(sale.status ?? "confirmed").toLowerCase() === "confirmed").map((sale) => {
    const revenue = money(numeric(sale.total_amount_lyd));
    const movementId = String(sale.inventory_movement_id ?? "").trim();
    const movement = movementId ? movementById.get(movementId) : null;
    const cost = money(numeric(movement?.line_total_lyd));
    const costMissing = !movementId || !movement || cost <= 0;
    return { net_sales_amount: revenue, cogs_amount: costMissing ? 0 : cost, gross_profit_amount: costMissing ? 0 : money(revenue - cost), cost_missing: costMissing, source: "manual_route_sale" };
  });
}

export function isInvestorDistributionLedgerRow(row: FinanceOperationsLedgerRow) {
  const text = [row.transaction_kind, row.transaction_type, row.category, row.bucket, row.final_bucket, row.source_type, row.description].map((value) => String(value ?? "").trim().toLowerCase()).join(" | ");
  return text.includes("investor profit share") || text.includes("investor distribution") || text.includes("profit distribution") || String(row.source_type ?? "") === "investor_payment";
}

export function calculateInvestorMonth({ salesRows, ledgerRows, sharePercent, profitBasis = "operating_profit" }: {
  salesRows: InvestorSalesRow[]; ledgerRows: InvestorLedgerRow[]; sharePercent: number; profitBasis?: InvestorProfitBasis;
}): InvestorMonthlyCalculation {
  const revenueLyd = money(salesRows.reduce((sum, row) => sum + numeric(row.net_sales_amount), 0));
  const cogsLyd = money(salesRows.reduce((sum, row) => sum + numeric(row.cogs_amount), 0));
  // Use one identity for every statement. A conflicting supplied gross-profit
  // aggregate is a source warning, never a reason to silently change the basis.
  const grossProfitLyd = money(revenueLyd - cogsLyd);
  const vmsRevenueLyd = money(salesRows.filter((row) => row.source !== "manual_route_sale").reduce((sum, row) => sum + numeric(row.net_sales_amount), 0));
  const manualSalesRevenueLyd = money(salesRows.filter((row) => row.source === "manual_route_sale").reduce((sum, row) => sum + numeric(row.net_sales_amount), 0));
  const manualSalesCogsLyd = money(salesRows.filter((row) => row.source === "manual_route_sale").reduce((sum, row) => sum + numeric(row.cogs_amount), 0));
  const missingCostRows = salesRows.filter((row) => row.cost_missing || row.net_sales_amount == null || row.cogs_amount == null
    || !Number.isFinite(Number(row.net_sales_amount)) || !Number.isFinite(Number(row.cogs_amount))
    || Number(row.net_sales_amount)<0 || Number(row.cogs_amount)<0
    || (row.gross_profit_amount != null && (!Number.isFinite(Number(row.gross_profit_amount)) || Math.abs(money(Number(row.gross_profit_amount))-money(Number(row.net_sales_amount)-Number(row.cogs_amount)))>0.011))).length;
  const operatingLedger = ledgerRows.filter((row) => !isInvestorDistributionLedgerRow(row));
  const expenses = investorExpenseSummary(operatingLedger);
  const operatingExpensesLyd = expenses.operatingExpensesLyd;
  const operatingProfitLyd = money(grossProfitLyd - operatingExpensesLyd);
  const distributionBasisLyd = money(operatingProfitLyd - (profitBasis === "operating_profit_after_capex" ? expenses.capitalPurchasesLyd : 0));
  const normalizedShare = Math.min(100, Math.max(0, numeric(sharePercent)));
  const positiveProfit = profitBasis === "operating_profit" ? Math.max(0, operatingProfitLyd) : Math.max(0, distributionBasisLyd);
  const investorShareDueLyd = money(positiveProfit * normalizedShare / 100);
  const accountingWarnings = [...expenses.unresolved];
  if (missingCostRows) accountingWarnings.push(`${missingCostRows} sales/cost source rows are incomplete or inconsistent`);
  if (!Number.isFinite(sharePercent) || sharePercent<0 || sharePercent>100) accountingWarnings.push("Invalid agreement share percentage");
  if (!["operating_profit","operating_profit_after_capex"].includes(profitBasis)) accountingWarnings.push("Unrecognized profit basis");
  return {
    revenueLyd,cogsLyd,grossProfitLyd,vmsRevenueLyd,manualSalesRevenueLyd,manualSalesCogsLyd,
    operatingExpensesLyd,operatingProfitLyd,sharePercent:normalizedShare,investorShareDueLyd,missingCostRows,
    complete: accountingWarnings.length===0,capitalPurchasesLyd:expenses.capitalPurchasesLyd,stockPurchasesLyd:expenses.stockPurchasesLyd,
    distributionBasisLyd,profitBasis,expenseBreakdown:expenses.expenseBreakdown,accountingWarnings,
  };
}

export function monthBounds(monthValue: string) {
  const match = String(monthValue ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]);
  if (!Number.isInteger(year) || year<1900 || year>9998 || month<1 || month>12) return null;
  return { start: `${match[1]}-${match[2]}-01`, end: new Date(Date.UTC(year,month,0)).toISOString().slice(0,10) };
}
