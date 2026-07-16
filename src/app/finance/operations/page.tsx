/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import {
  formatFinanceMoney,
  isBalanceAffectingTransaction,
  normalizeFinanceCurrency,
  signedAmount,
} from "@/lib/finance-balance";
import {
  FINANCE_TRANSACTIONS_TABLE,
  applyVisibleFinanceLedgerFilter,
  loadFinanceLedgerRows,
} from "@/lib/finance-ledger";
import {
  aggregateExpenseCategories,
  buildMachineCashReconciliation,
  canonicalExpenseCategory,
  isFinanceCashCollectionRow,
  isFinanceProductPurchaseRow,
  isReportableExpenseRow,
  resolveFinanceOperationsPeriod,
  sumActiveLedgerDirection,
  summarizeCashCollections,
  type FinanceCashCollectionRow,
  type FinanceOperationsLedgerRow,
  type FinanceOperationsSearchParams,
  type MachineIdentity,
  type VmsMachineSalesRow,
} from "@/lib/finance-operations";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import {
  isCompleteClosedMonthRange,
  monthlyMachineExpectedCash,
  reconcileMonthlyCash,
  resolveMonthlyCashExpectation,
} from "@/lib/monthly-cash-close";
import {
  isCompleteClosedMonthRange,
  monthlyMachineExpectedCash,
  reconcileMonthlyCash,
  resolveMonthlyCashExpectation,
} from "@/lib/monthly-cash-close";
import {
  isCompleteClosedMonthRange,
  monthlyMachineExpectedCash,
  reconcileMonthlyCash,
  resolveMonthlyCashExpectation,
} from "@/lib/monthly-cash-close";
import {
  isCompleteClosedMonthRange,
  monthlyMachineExpectedCash,
  reconcileMonthlyCash,
  resolveMonthlyCashExpectation,
} from "@/lib/monthly-cash-close";
import {
  resolveDetailedSalesDashboardSourceReportType,
  resolveSalesDashboardSourceReportType,
  type SalesDateRange,
  type SalesDashboardSourceMode,
} from "@/lib/sales-dashboard";
import { queryVmsDashboardBatches, type VmsDashboardBatch } from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

type SalesSummaryRow = {
  revenue_amount?: number | string | null;
  successful_sales_count?: number | string | null;
  units_sold?: number | string | null;
  cash_sales_amount?: number | string | null;
  card_sales_amount?: number | string | null;
  unknown_payment_sales_amount?: number | string | null;
  payment_method_available?: boolean | null;
  cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null;
  gross_margin_percent?: number | string | null;
};

type MachineRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location?: { id?: string | null; name?: string | null } | null;
};

type LocationRow = { id: string; name?: string | null };

type CashCollectionQueryRow = FinanceCashCollectionRow & {
  machine?: MachineRow | null;
};

function numeric(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumeric(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Not available";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function dateOnly(value: string | null | undefined) {
  return value ? String(value).slice(0, 10) : "-";
}

function statusForMachine(row: {
  collectionCount: number;
  monthlyExpectedCash: number | null;
  monthlyVariance: number | null;
  vmsSalesAmount: number;
}, closedMonth: boolean) {
  if (!closedMonth) return "provisional month";
  if (row.monthlyExpectedCash === null) return "cash split unavailable";
  if (row.collectionCount === 0 && row.vmsSalesAmount > 0) return "no cash counted";
  if (Math.abs(row.monthlyVariance ?? 0) >= 10) return "variance review";
  return "reconciled";
}

function StatCard({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "positive" | "negative" | "warn" | "strong";
}) {
  const classes = tone === "positive"
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : tone === "negative"
      ? "border-rose-200 bg-rose-50 text-rose-950"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-950"
        : "border-slate-200 bg-white text-slate-950";
  return (
    <div className={`rounded-2xl border p-4 ${classes}`}>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {note ? <div className="mt-2 text-xs leading-5 opacity-75">{note}</div> : null}
    </div>
  );
}

function financeAccess(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return Boolean(profile && canViewFinancials({
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  }));
}

function salesRangeForFinance(period: ReturnType<typeof resolveFinanceOperationsPeriod>): SalesDateRange {
  return {
    key: period.key,
    label: period.label,
    helperText: "Finance Operations selected range",
    start: period.start,
    end: period.end,
    monthValue: period.start.slice(0, 7),
    yearValue: period.start.slice(0, 4),
    dateValue: period.end,
    dateFromValue: period.start,
    dateToValue: period.end,
  };
}

function expenseCounterparty(row: FinanceOperationsLedgerRow) {
  return row.counterparty_text || row.paid_to_text || row.payee_text || row.description || "-";
}

export default async function FinanceOperationsPage({
  searchParams,
}: {
  searchParams: Promise<FinanceOperationsSearchParams>;
}) {
  const profile = await getCurrentProfile();
  if (!financeAccess(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const period = resolveFinanceOperationsPeriod(params);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return <ErrorState title="Finance Operations unavailable" body="Supabase is not configured, so cash and expense reconciliation cannot load." />;
  }

  const startTimestamp = `${period.start}T00:00:00.000Z`;
  const endTimestamp = `${period.end}T23:59:59.999Z`;

  const [
    machineResult,
    locationResult,
    countedCashResult,
    pendingCashResult,
    ledgerResult,
    batchResult,
    monthlyProfitTableCheck,
  ] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").order("name"),
    supabase.from("locations").select("id, name").order("name"),
    supabase
      .from("cash_collections")
      .select("id, machine_id, collected_at, counted_at, vms_expected_cash, actual_cash_collected, variance, review_status, machine:machines(id, name, machine_code, location:locations(id, name))")
      .not("counted_at", "is", null)
      .gte("collected_at", startTimestamp)
      .lte("collected_at", endTimestamp)
      .order("counted_at", { ascending: false })
      .limit(10000),
    supabase
      .from("cash_collections")
      .select("id, machine_id, collected_at, review_status")
      .in("review_status", ["pending_collection", "collected_pending_count"])
      .gte("collected_at", startTimestamp)
      .lte("collected_at", endTimestamp)
      .limit(10000),
    loadFinanceLedgerRows({
      label: "finance operations dashboard",
      buildQuery: (columns, level) => {
        const query = supabase
          .from(FINANCE_TRANSACTIONS_TABLE)
          .select(columns.join(", "))
          .gte("transaction_date", period.start)
          .lte("transaction_date", period.end)
          .order("transaction_date", { ascending: false })
          .limit(10000);
        return applyVisibleFinanceLedgerFilter(query, level);
      },
    }),
    queryVmsDashboardBatches(supabase, {
      reportTypes: ["monthly_product_profit", "monthly_transaction_details", "vms_order_details_weekly"],
      orderBy: "uploaded_at",
      ascending: false,
    }),
    supabase.from("vms_monthly_product_profit").select("id", { head: true, count: "exact" }).limit(1),
  ]);

  if (machineResult.error || countedCashResult.error || pendingCashResult.error) {
    console.error("[finance-operations] Core data query failed", {
      machines: machineResult.error,
      cash: countedCashResult.error,
      pending: pendingCashResult.error,
    });
    return (
      <>
        <PageHeader title="Finance Operations" subtitle="Cash reconciliation, expenses, rent, and product buying." />
        <ErrorState title="Finance Operations could not load" body="The machine or cash collection query failed. No records were changed." action={<SecondaryButton href="/finance/operations">Retry</SecondaryButton>} />
      </>
    );
  }

  const batches = (batchResult.data ?? []) as VmsDashboardBatch[];
  const salesRange = salesRangeForFinance(period);
  const monthlyProfitTableAvailable = !monthlyProfitTableCheck.error;
  const sourceReportType = monthlyProfitTableAvailable
    ? resolveSalesDashboardSourceReportType(batches, salesRange)
    : resolveDetailedSalesDashboardSourceReportType(batches, salesRange);
  const sourceMode: SalesDashboardSourceMode = sourceReportType === "monthly_product_profit" ? "monthly" : "detailed";
  const summaryRpc = sourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";
  const breakdownRpc = sourceMode === "monthly" ? "sales_dashboard_monthly_breakdown" : "sales_dashboard_breakdown";

  const [salesSummaryResult, machineSalesResult] = await Promise.all([
    supabase.rpc(summaryRpc, { p_date_from: period.start, p_date_to: period.end }),
    supabase.rpc(breakdownRpc, { p_dimension: "machine", p_date_from: period.start, p_date_to: period.end }),
  ]);

  if (salesSummaryResult.error) console.error("[finance-operations] VMS summary failed", salesSummaryResult.error);
  if (machineSalesResult.error) console.error("[finance-operations] VMS machine breakdown failed", machineSalesResult.error);

  const salesSummary = ((salesSummaryResult.data ?? [])[0] ?? {}) as SalesSummaryRow;
  const vmsMachineRows = (machineSalesResult.data ?? []) as VmsMachineSalesRow[];
  const machines = (machineResult.data ?? []) as MachineRow[];
  const machineIdentities: MachineIdentity[] = machines.map((machine) => ({
    id: machine.id,
    name: machine.name,
    machine_code: machine.machine_code,
    location_name: machine.location?.name ?? null,
  }));
  const countedCashRows = (countedCashResult.data ?? []) as CashCollectionQueryRow[];
  const ledgerRows = (ledgerResult.data ?? []) as FinanceOperationsLedgerRow[];
  const locations = new Map(((locationResult.data ?? []) as LocationRow[]).map((location) => [location.id, location.name || "Unknown location"]));

  const cashSummary = summarizeCashCollections(countedCashRows);
  const baseMachineRows = buildMachineCashReconciliation({
    machines: machineIdentities,
    cashCollections: countedCashRows,
    vmsRows: vmsMachineRows,
  });
  const expenses = aggregateExpenseCategories(ledgerRows, "LYD");
  const cashFinanceRows = ledgerRows.filter(isFinanceCashCollectionRow);
  const postedCash = sumActiveLedgerDirection(cashFinanceRows, "money_in", "LYD");
  const totalMoneyIn = sumActiveLedgerDirection(ledgerRows, "money_in", "LYD");
  const totalMoneyOut = sumActiveLedgerDirection(ledgerRows, "money_out", "LYD");
  const netCashMovement = totalMoneyIn - totalMoneyOut;

  const vmsRevenue = numeric(salesSummary.revenue_amount);
  const vmsCashSales = numeric(salesSummary.cash_sales_amount);
  const vmsCardSales = numeric(salesSummary.card_sales_amount);
  const vmsUnknownSales = numeric(salesSummary.unknown_payment_sales_amount);
  const paymentSplitAvailable = Boolean(salesSummary.payment_method_available);
  const monthlyExpectation = resolveMonthlyCashExpectation({
    paymentSplitAvailable,
    vmsCashSales,
    vmsRevenue,
  });
  const monthlyClose = reconcileMonthlyCash(cashSummary.countedCash, monthlyExpectation);
  const closedMonth = isCompleteClosedMonthRange(period.start, period.end);
  const machineRows = baseMachineRows.map((row) => {
    const monthlyExpectedCash = monthlyMachineExpectedCash({ paymentSplitAvailable, vmsSalesAmount: row.vmsSalesAmount });
    const monthlyVariance = monthlyExpectedCash === null ? null : row.countedCash - monthlyExpectedCash;
    return {
      ...row,
      monthlyExpectedCash,
      monthlyVariance,
      monthlyAccuracy: monthlyExpectedCash && monthlyExpectedCash > 0 ? row.countedCash / monthlyExpectedCash : null,
    };
  });
  const vmsCogs = nullableNumeric(salesSummary.cogs_amount);
  const vmsGrossProfit = nullableNumeric(salesSummary.gross_profit_amount);
  const vmsMargin = nullableNumeric(salesSummary.gross_margin_percent);
  const operatingResult = vmsGrossProfit === null ? null : vmsGrossProfit - expenses.operatingExpenses;
  const financePostingDifference = cashSummary.countedCash - postedCash;

  const rentRows = ledgerRows.filter((row) => isReportableExpenseRow(row, "LYD") && canonicalExpenseCategory(row).key === "rent");
  const rentBySite = new Map<string, { label: string; amount: number; transactionCount: number }>();
  for (const row of rentRows) {
    const label = (row.related_location_id ? locations.get(row.related_location_id) : null) || row.location || expenseCounterparty(row) || "Unassigned rent";
    const current = rentBySite.get(label) ?? { label, amount: 0, transactionCount: 0 };
    current.amount += Math.abs(signedAmount(row));
    current.transactionCount += 1;
    rentBySite.set(label, current);
  }
  const rentSiteRows = Array.from(rentBySite.values()).sort((left, right) => right.amount - left.amount || left.label.localeCompare(right.label));

  const productPurchaseRows = ledgerRows
    .filter((row) => isReportableExpenseRow(row, "LYD") && isFinanceProductPurchaseRow(row))
    .sort((left, right) => String(right.transaction_date ?? "").localeCompare(String(left.transaction_date ?? "")))
    .slice(0, 20);

  const periodLinks = [
    { key: "this_month", label: "This month", href: "/finance/operations?period=this_month" },
    { key: "last_month", label: "Last month", href: "/finance/operations?period=last_month" },
    { key: "this_year", label: "This year", href: "/finance/operations?period=this_year" },
    { key: "all_time", label: "All time", href: "/finance/operations?period=all_time" },
  ];

  return (
    <>
      <PageHeader
        title="Finance Operations"
        subtitle={`Professional cash control and expense reporting for ${period.start} to ${period.end}.`}
        breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: "Operations dashboard" }]}
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            <SecondaryButton href="/cash-collections">Cash collections</SecondaryButton>
            <SecondaryButton href="/finance/transactions">Transactions</SecondaryButton>
            <PrimaryButton href="/finance/transactions/new">Add money in/out</PrimaryButton>
          </div>
        }
      />

      {ledgerResult.warning || ledgerResult.error || salesSummaryResult.error || machineSalesResult.error ? (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-semibold">Some dashboard data needs attention.</div>
          <div className="mt-1 leading-6">
            {ledgerResult.error ? "Finance ledger rows could not load. " : ledgerResult.warning ? `${ledgerResult.warning} ` : ""}
            {salesSummaryResult.error || machineSalesResult.error ? "VMS comparison is temporarily incomplete." : ""}
          </div>
        </div>
      ) : null}

      <section className="surface-card mb-6 space-y-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900">Reporting period</div>
            <div className="mt-1 text-sm text-slate-500">{period.label}: {period.start} to {period.end}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {periodLinks.map((link) => (
              <Link key={link.key} href={link.href} className={period.key === link.key ? "btn-primary" : "btn-secondary"}>{link.label}</Link>
            ))}
          </div>
        </div>
        <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <input type="hidden" name="period" value="custom" />
          <input name="date_from" type="date" defaultValue={period.key === "custom" ? period.start : ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={period.key === "custom" ? period.end : ""} className="field-input" />
          <button className={period.key === "custom" ? "btn-primary" : "btn-secondary"}>Apply custom range</button>
        </form>
      </section>

      <section className="mb-6">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-slate-950">Cash control</h2>
          <p className="mt-1 text-sm text-slate-500">Every pickup records only physical counted cash. Expected cash, shortage/overage, and accuracy are calculated for the complete selected month.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Cash counted for selected month" value={formatFinanceMoney(monthlyClose.countedCash, "LYD")} note={`${cashSummary.countedRows.length} pickup(s) added together`} tone="strong" />
          <StatCard label="Monthly VMS expected cash" value={monthlyClose.expectedCash === null ? "Not available" : formatFinanceMoney(monthlyClose.expectedCash, "LYD")} note={monthlyExpectation.note} tone={monthlyClose.expectedCash === null ? "warn" : "default"} />
          <StatCard label="Monthly shortage / overage" value={monthlyClose.variance === null ? "Not available" : formatFinanceMoney(monthlyClose.variance, "LYD")} note="Total counted cash minus monthly expected cash" tone={monthlyClose.variance === null ? "warn" : monthlyClose.variance < 0 ? "negative" : monthlyClose.variance > 0 ? "warn" : "positive"} />
          <StatCard label="Monthly cash accuracy" value={percent(monthlyClose.accuracy)} note={closedMonth ? "Closed calendar month" : "Provisional until the month is fully closed and remaining cash is counted"} tone={!closedMonth ? "warn" : monthlyClose.variance !== null && Math.abs(monthlyClose.variance) >= 10 ? "warn" : "positive"} />
          <StatCard label="Posted cash in finance" value={formatFinanceMoney(postedCash, "LYD")} note="Active cash-collection money-in transactions" tone="positive" />
          <StatCard label="Posting difference" value={formatFinanceMoney(financePostingDifference, "LYD")} note="Counted cash minus finance-posted cash" tone={Math.abs(financePostingDifference) > 0.01 ? "warn" : "positive"} />
          <StatCard label="Pending cash counts" value={String((pendingCashResult.data ?? []).length)} note="Collected records not counted yet" tone={(pendingCashResult.data ?? []).length ? "warn" : "positive"} />
          <StatCard label="Machines with counted cash" value={String(machineRows.filter((row) => row.collectionCount > 0).length)} note={`${machineRows.filter((row) => row.vmsSalesAmount > 0).length} machine(s) have VMS sales`} />
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-slate-950">VMS sales and operating result</h2>
          <p className="mt-1 text-sm text-slate-500">VMS source: {sourceReportType.replaceAll("_", " ")}. Product purchases are inventory cash out and are not subtracted again from gross profit.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="VMS revenue" value={formatFinanceMoney(vmsRevenue, "LYD")} note="All successful sales methods" tone="strong" />
          <StatCard label="VMS COGS" value={vmsCogs === null ? "Not available" : formatFinanceMoney(vmsCogs, "LYD")} note="Product cost assigned to sold units" />
          <StatCard label="VMS gross profit" value={vmsGrossProfit === null ? "Not available" : formatFinanceMoney(vmsGrossProfit, "LYD")} note={`Gross margin ${percent(vmsMargin)}`} tone={vmsGrossProfit !== null && vmsGrossProfit < 0 ? "negative" : "positive"} />
          <StatCard label="Operating expenses" value={formatFinanceMoney(expenses.operatingExpenses, "LYD")} note="Rent, salaries, shipping, ads, maintenance, and other running costs" tone="negative" />
          <StatCard label="Operating result" value={operatingResult === null ? "Not available" : formatFinanceMoney(operatingResult, "LYD")} note="VMS gross profit minus operating expenses; product purchases excluded to prevent double counting" tone={operatingResult !== null && operatingResult < 0 ? "negative" : "positive"} />
          <StatCard label="Product purchases" value={formatFinanceMoney(expenses.productPurchases, "LYD")} note="Inventory cash out, shown separately from operating expenses" tone="negative" />
          <StatCard label="Finance cash-flow net" value={formatFinanceMoney(netCashMovement, "LYD")} note={`${formatFinanceMoney(totalMoneyIn, "LYD")} in minus ${formatFinanceMoney(totalMoneyOut, "LYD")} out`} tone={netCashMovement < 0 ? "negative" : "positive"} />
          <StatCard label="VMS payment split" value={paymentSplitAvailable ? `${formatFinanceMoney(vmsCashSales, "LYD")} cash` : "Cash-only assumption"} note={paymentSplitAvailable ? `${formatFinanceMoney(vmsCardSales, "LYD")} card • ${formatFinanceMoney(vmsUnknownSales, "LYD")} unknown` : "The report has no payment split, so monthly total sales are treated as expected cash for Snacky's current cash-only machines."} />
        </div>
      </section>

      <section className="surface-card mb-6">
        <div className="border-b border-slate-200 pb-4">
          <h2 className="text-base font-semibold text-slate-950">Machine cash reconciliation</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">All pickups counted during the selected month are added per machine. When VMS has no payment split, total machine sales are used as expected cash under the cash-only workflow. Current-month results remain provisional until the final month-end cash is removed and counted.</p>
        </div>
        {machineRows.length ? (
          <div className="mt-4">
            <DataTable
              sortable
              showSummary
              headers={["Machine", "Location", "VMS sales", "Units sold", "Monthly expected cash", "Cash counted in month", "Monthly variance", "Monthly accuracy", "Pickups", "Latest count", "Status"]}
            >
              {machineRows.map((row) => (
                <tr key={row.key}>
                  <td className="font-medium">
                    <div>{row.machineLabel}</div>
                    <div className="mt-1 text-xs text-slate-500">{row.machineCode ?? row.machineId ?? "Unmatched VMS row"}</div>
                  </td>
                  <td>{row.locationLabel}</td>
                  <td>{formatFinanceMoney(row.vmsSalesAmount, "LYD")}</td>
                  <td>{row.unitsSold.toLocaleString("en-US")}</td>
                  <td>{row.monthlyExpectedCash === null ? "Not available" : formatFinanceMoney(row.monthlyExpectedCash, "LYD")}</td>
                  <td>{formatFinanceMoney(row.countedCash, "LYD")}</td>
                  <td className={row.monthlyVariance === null ? "text-slate-500" : row.monthlyVariance < 0 ? "font-semibold text-rose-700" : row.monthlyVariance > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700"}>{row.monthlyVariance === null ? "Not available" : formatFinanceMoney(row.monthlyVariance, "LYD")}</td>
                  <td>{percent(row.monthlyAccuracy)}</td>
                  <td>{row.collectionCount}</td>
                  <td>{formatDateTime(row.latestCountedAt)}</td>
                  <td><StatusBadge status={statusForMachine(row, closedMonth)} /></td>
                </tr>
              ))}
            </DataTable>
          </div>
        ) : <EmptyState title="No machine reconciliation rows" body="Import VMS sales or count machine cash for the selected period." />}
      </section>

      <section className="surface-card mb-6">
        <div className="border-b border-slate-200 pb-4">
          <h2 className="text-base font-semibold text-slate-950">Expenses by category</h2>
          <p className="mt-1 text-sm text-slate-500">Active LYD money-out transactions only. Transfers, opening balances, and owner funding movements are excluded.</p>
        </div>
        {expenses.categories.length ? (
          <div className="mt-4">
            <DataTable sortable showSummary headers={["Category", "Transactions", "Amount", "Share of cash out", "Average transaction", "Accounting treatment"]}>
              {expenses.categories.map((row) => (
                <tr key={row.key}>
                  <td className="font-medium">{row.label}</td>
                  <td>{row.transactionCount}</td>
                  <td>{formatFinanceMoney(row.amount, "LYD")}</td>
                  <td>{percent(row.shareOfCashOut)}</td>
                  <td>{formatFinanceMoney(row.averageTransaction, "LYD")}</td>
                  <td><StatusBadge status={row.isProductPurchase ? "inventory cash out" : "operating expense"} /></td>
                </tr>
              ))}
            </DataTable>
          </div>
        ) : <EmptyState title="No expenses in this period" body="Rent, product buying, salaries, shipping, and other active money-out transactions will appear here." />}
      </section>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <section className="surface-card">
          <div className="border-b border-slate-200 pb-4">
            <h2 className="text-base font-semibold text-slate-950">Rent by site</h2>
            <p className="mt-1 text-sm text-slate-500">Rent and lease payments grouped by linked location or transaction location text.</p>
          </div>
          {rentSiteRows.length ? (
            <div className="mt-4">
              <DataTable sortable showSummary headers={["Site", "Payments", "Rent paid"]}>
                {rentSiteRows.map((row) => (
                  <tr key={row.label}>
                    <td className="font-medium">{row.label}</td>
                    <td>{row.transactionCount}</td>
                    <td>{formatFinanceMoney(row.amount, "LYD")}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          ) : <EmptyState title="No rent rows" body="Categorize rent transactions as Rent and link a location for a complete site view." />}
        </section>

        <section className="surface-card">
          <div className="border-b border-slate-200 pb-4">
            <h2 className="text-base font-semibold text-slate-950">Recent product buying</h2>
            <p className="mt-1 text-sm text-slate-500">Purchase cash out is listed separately because inventory buying is not the same as COGS.</p>
          </div>
          {productPurchaseRows.length ? (
            <div className="mt-4">
              <DataTable sortable headers={["Date", "Supplier / description", "Amount", "Payment", "Source"]}>
                {productPurchaseRows.map((row) => {
                  const purchaseId = row.related_purchase_id || row.linked_purchase_id || (row.source_type === "purchase" ? row.source_id : null);
                  return (
                    <tr key={row.id ?? `${row.transaction_date}-${expenseCounterparty(row)}`}>
                      <td>{dateOnly(row.transaction_date)}</td>
                      <td className="font-medium">{expenseCounterparty(row)}</td>
                      <td>{formatFinanceMoney(Math.abs(signedAmount(row)), normalizeFinanceCurrency(row.currency))}</td>
                      <td>{row.payment_method?.replaceAll("_", " ") || "-"}</td>
                      <td>{purchaseId ? <Link href={`/purchases/${purchaseId}`} className="link-secondary">Open purchase</Link> : "Manual finance row"}</td>
                    </tr>
                  );
                })}
              </DataTable>
            </div>
          ) : <EmptyState title="No product purchases" body="Paid purchase orders and Product Restocking finance rows will appear here." />}
        </section>
      </div>

      <section className="surface-card mb-6">
        <div className="border-b border-slate-200 pb-4">
          <h2 className="text-base font-semibold text-slate-950">Recent cash counts</h2>
          <p className="mt-1 text-sm text-slate-500">Physical cash records used in the reconciliation above.</p>
        </div>
        {countedCashRows.length ? (
          <div className="mt-4">
            <DataTable sortable showSummary headers={["Counted at", "Machine", "Expected", "Counted", "Variance", "Status", "Record"]}>
              {countedCashRows.slice(0, 50).map((row) => {
                const machine = row.machine ?? machines.find((candidate) => candidate.id === row.machine_id) ?? null;
                const expected = numeric(row.vms_expected_cash);
                const counted = numeric(row.actual_cash_collected);
                const variance = counted - expected;
                return (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.counted_at)}</td>
                    <td className="font-medium">{formatMachineDisplayName(machine as any, { includeArea: true })}</td>
                    <td>{formatFinanceMoney(expected, "LYD")}</td>
                    <td>{formatFinanceMoney(counted, "LYD")}</td>
                    <td className={variance < 0 ? "font-semibold text-rose-700" : variance > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700"}>{formatFinanceMoney(variance, "LYD")}</td>
                    <td><StatusBadge status={row.review_status?.replaceAll("_", " ") || "counted"} /></td>
                    <td><Link href={`/cash-collections/${row.id}`} className="link-secondary">Open</Link></td>
                  </tr>
                );
              })}
            </DataTable>
          </div>
        ) : <EmptyState title="No counted cash in this period" body="Confirmed cash counts will appear here." />}
      </section>

      <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
        <div className="font-semibold">Reconciliation basis</div>
        <p className="mt-1">VMS revenue is grouped by sale date. Physical cash is grouped by counted date. The exact shortage/overage source is the expected cash saved on each collection record. For envelope-level auditing, each future cash collection should also store its VMS period start and end.</p>
      </section>
    </>
  );
}
