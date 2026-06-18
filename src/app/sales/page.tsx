import Link from "next/link";
import type { ReactNode } from "react";
import { BarList, KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { formatInteger, groupSum } from "@/lib/kpi";
import { cleanSearchParams, type SearchParamsRecord } from "@/lib/pagination";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import {
  applySalesBatchCoverage,
  batchCoverageDates,
  buildSalesFileContributions,
  formatSalesRangeLabel,
  querySalesRangeReconciliationDiagnostics,
  rangesOverlap,
  resolveSalesDashboardRange,
  salesBatchReconciliationById,
  type SalesBatchReconciliation,
  type SalesDashboardSearchParams,
} from "@/lib/sales-dashboard";
import {
  batchLastUpdatedAt,
  batchImportedRows,
  formatVmsDateTime,
  queryVmsDashboardBatches,
  vmsCoverageSummary,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

type SalesRow = {
  id: string;
  import_batch_id: string | null;
  machine_id: string | null;
  product_id: string | null;
  units_sold: number | string | null;
  net_sales_amount: number | string | null;
  gross_sales_amount: number | string | null;
  sale_date: string | null;
  sales_month: string | null;
  period_start: string | null;
  period_end: string | null;
  machine_name: string | null;
  location_name: string | null;
  product_name: string | null;
};

type SalesSummaryRow = {
  successful_sales_amount: number | string | null;
  successful_sales_count: number | string | null;
  successful_units_sold: number | string | null;
  failed_vend_count: number | string | null;
  failed_vend_amount: number | string | null;
  refund_count: number | string | null;
  refund_amount: number | string | null;
  failed_payment_count: number | string | null;
  needs_review_count: number | string | null;
  total_attempt_count: number | string | null;
  average_transaction: number | string | null;
  cash_payment_count: number | string | null;
  cash_payment_amount: number | string | null;
  card_payment_count: number | string | null;
  card_payment_amount: number | string | null;
  unknown_payment_count: number | string | null;
  unknown_payment_amount: number | string | null;
  payment_method_available: boolean | null;
  rows_used: number | string | null;
};

type SalesSummary = {
  successfulSalesAmount: number;
  successfulSalesCount: number;
  successfulUnitsSold: number;
  failedVendCount: number;
  failedVendAmount: number;
  refundCount: number;
  refundAmount: number;
  failedPaymentCount: number;
  needsReviewCount: number;
  totalAttemptCount: number;
  averageTransaction: number;
  cashPaymentCount: number;
  cashPaymentAmount: number;
  cardPaymentCount: number;
  cardPaymentAmount: number;
  unknownPaymentCount: number;
  unknownPaymentAmount: number;
  paymentMethodAvailable: boolean;
  rowsUsed: number;
};

type TransactionStatusRow = {
  batch_id: string | null;
  source_file_name: string | null;
  batch_status: string | null;
  is_active: boolean | null;
  deleted_at: string | null;
  uploaded_at: string | null;
  imported_at: string | null;
  metadata_report_start_date: string | null;
  metadata_report_end_date: string | null;
  metadata_detected_min_datetime: string | null;
  metadata_detected_max_datetime: string | null;
  metadata_imported_rows_total: number | string | null;
  metadata_rows_found_total: number | string | null;
  metadata_duplicate_rows_total: number | string | null;
  raw_row_count_total: number | string | null;
  raw_successful_rows_total: number | string | null;
  raw_failed_vend_rows_total: number | string | null;
  raw_refunded_rows_total: number | string | null;
  raw_failed_payment_rows_total: number | string | null;
  raw_needs_review_rows_total: number | string | null;
  raw_missing_datetime_rows_total: number | string | null;
  raw_missing_amount_rows_total: number | string | null;
  raw_successful_sales_amount_total: number | string | null;
  raw_failed_vend_amount_total: number | string | null;
  raw_refunded_amount_total: number | string | null;
  raw_units_sold_total: number | string | null;
  raw_min_transaction_at: string | null;
  raw_max_transaction_at: string | null;
  raw_min_sale_date: string | null;
  raw_max_sale_date: string | null;
  range_row_count: number | string | null;
  range_successful_rows: number | string | null;
  range_failed_vend_rows: number | string | null;
  range_refunded_rows: number | string | null;
  range_failed_payment_rows: number | string | null;
  range_needs_review_rows: number | string | null;
  range_successful_sales_amount: number | string | null;
  range_failed_vend_amount: number | string | null;
  range_refunded_amount: number | string | null;
  range_units_sold: number | string | null;
  range_transaction_count: number | string | null;
  range_min_transaction_at: string | null;
  range_max_transaction_at: string | null;
};

function chronologicalSales(rows: { label: string; value: number }[]) {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label));
}

function numericValue(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function activeFilterClass(active: boolean) {
  return active ? "btn-primary" : "btn-secondary";
}

function FilterPresetLink({
  active,
  href,
  label,
}: {
  active: boolean;
  href: string;
  label: string;
}) {
  return (
    <Link href={href} className={activeFilterClass(active)}>
      {label}
    </Link>
  );
}

function MetricValue({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "text-sm font-medium text-slate-600" : "text-3xl font-semibold text-slate-900"}>
      {children}
    </div>
  );
}

function latestTimestamp(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
    .at(-1) ?? null;
}

function normalizeSalesBatchReconciliationRows(rows: TransactionStatusRow[]) {
  return rows.map((row) => ({
    batchId: String(row.batch_id ?? ""),
    sourceFileName: String(row.source_file_name ?? "unknown file"),
    batchStatus: row.batch_status ?? null,
    isActive: row.is_active ?? null,
    deletedAt: row.deleted_at ?? null,
    uploadedAt: row.uploaded_at ?? null,
    importedAt: row.imported_at ?? null,
    metadataReportStartDate: row.metadata_report_start_date ?? null,
    metadataReportEndDate: row.metadata_report_end_date ?? null,
    metadataDetectedMinDateTime: row.metadata_detected_min_datetime ?? null,
    metadataDetectedMaxDateTime: row.metadata_detected_max_datetime ?? null,
    metadataImportedRowsTotal: numericValue(row.metadata_imported_rows_total),
    metadataRowsFoundTotal: numericValue(row.metadata_rows_found_total),
    metadataDuplicateRowsTotal: numericValue(row.metadata_duplicate_rows_total),
    rawRowCountTotal: numericValue(row.raw_row_count_total),
    rawSuccessfulRowsTotal: numericValue(row.raw_successful_rows_total),
    rawFailedVendRowsTotal: numericValue(row.raw_failed_vend_rows_total),
    rawRefundedRowsTotal: numericValue(row.raw_refunded_rows_total),
    rawFailedPaymentRowsTotal: numericValue(row.raw_failed_payment_rows_total),
    rawNeedsReviewRowsTotal: numericValue(row.raw_needs_review_rows_total),
    rawMissingDatetimeRowsTotal: numericValue(row.raw_missing_datetime_rows_total),
    rawMissingAmountRowsTotal: numericValue(row.raw_missing_amount_rows_total),
    rawSuccessfulSalesAmountTotal: numericValue(row.raw_successful_sales_amount_total),
    rawFailedVendAmountTotal: numericValue(row.raw_failed_vend_amount_total),
    rawRefundedAmountTotal: numericValue(row.raw_refunded_amount_total),
    rawUnitsSoldTotal: numericValue(row.raw_units_sold_total),
    rawMinTransactionAt: row.raw_min_transaction_at ?? null,
    rawMaxTransactionAt: row.raw_max_transaction_at ?? null,
    rawMinSaleDate: row.raw_min_sale_date ?? null,
    rawMaxSaleDate: row.raw_max_sale_date ?? null,
    rangeRowCount: numericValue(row.range_row_count),
    rangeSuccessfulRows: numericValue(row.range_successful_rows),
    rangeFailedVendRows: numericValue(row.range_failed_vend_rows),
    rangeRefundedRows: numericValue(row.range_refunded_rows),
    rangeFailedPaymentRows: numericValue(row.range_failed_payment_rows),
    rangeNeedsReviewRows: numericValue(row.range_needs_review_rows),
    rangeSuccessfulSalesAmount: numericValue(row.range_successful_sales_amount),
    rangeFailedVendAmount: numericValue(row.range_failed_vend_amount),
    rangeRefundedAmount: numericValue(row.range_refunded_amount),
    rangeUnitsSold: numericValue(row.range_units_sold),
    rangeTransactionCount: numericValue(row.range_transaction_count),
    rangeMinTransactionAt: row.range_min_transaction_at ?? null,
    rangeMaxTransactionAt: row.range_max_transaction_at ?? null,
  } satisfies SalesBatchReconciliation));
}

const EMPTY_SALES_SUMMARY: SalesSummary = {
  successfulSalesAmount: 0,
  successfulSalesCount: 0,
  successfulUnitsSold: 0,
  failedVendCount: 0,
  failedVendAmount: 0,
  refundCount: 0,
  refundAmount: 0,
  failedPaymentCount: 0,
  needsReviewCount: 0,
  totalAttemptCount: 0,
  averageTransaction: 0,
  cashPaymentCount: 0,
  cashPaymentAmount: 0,
  cardPaymentCount: 0,
  cardPaymentAmount: 0,
  unknownPaymentCount: 0,
  unknownPaymentAmount: 0,
  paymentMethodAvailable: false,
  rowsUsed: 0,
};

function normalizeSalesSummary(row?: SalesSummaryRow | null): SalesSummary {
  if (!row) return EMPTY_SALES_SUMMARY;
  return {
    successfulSalesAmount: numericValue(row.successful_sales_amount),
    successfulSalesCount: numericValue(row.successful_sales_count),
    successfulUnitsSold: numericValue(row.successful_units_sold),
    failedVendCount: numericValue(row.failed_vend_count),
    failedVendAmount: numericValue(row.failed_vend_amount),
    refundCount: numericValue(row.refund_count),
    refundAmount: numericValue(row.refund_amount),
    failedPaymentCount: numericValue(row.failed_payment_count),
    needsReviewCount: numericValue(row.needs_review_count),
    totalAttemptCount: numericValue(row.total_attempt_count),
    averageTransaction: numericValue(row.average_transaction),
    cashPaymentCount: numericValue(row.cash_payment_count),
    cashPaymentAmount: numericValue(row.cash_payment_amount),
    cardPaymentCount: numericValue(row.card_payment_count),
    cardPaymentAmount: numericValue(row.card_payment_amount),
    unknownPaymentCount: numericValue(row.unknown_payment_count),
    unknownPaymentAmount: numericValue(row.unknown_payment_amount),
    paymentMethodAvailable: Boolean(row.payment_method_available),
    rowsUsed: numericValue(row.rows_used),
  };
}

async function fetchSalesRowsForRange({
  end,
  start,
  supabase,
}: {
  end: string;
  start: string;
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
}) {
  const rows: SalesRow[] = [];

  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("vms_sales_clean")
      .select("id, import_batch_id, machine_id, product_id, units_sold, net_sales_amount, gross_sales_amount, sale_date, sales_month, period_start, period_end, machine_name, location_name, product_name")
      .gte("sale_date", start)
      .lte("sale_date", end)
      .order("sale_date", { ascending: true })
      .range(from, from + 999);

    if (error) throw error;
    if (!data?.length) break;

    rows.push(...(data as SalesRow[]));
    if (data.length < 1000) break;
  }

  return {
    count: rows.length,
    data: rows,
    error: null,
  };
}

async function SalesDashboardPageContent({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord & SalesDashboardSearchParams>;
}) {
  const profile = await requireCurrentProfileForPath("/sales");
  const params = cleanSearchParams(await searchParams) as SearchParamsRecord & SalesDashboardSearchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  const renderedAt = new Date();

  if (!supabase) {
    return (
      <>
        <PageHeader
          title="Sales Dashboard"
          subtitle="Detailed VMS Order Details drive Snacky sales analytics. Connect Supabase to activate filters and data-source tracking."
        />
        <EmptyState title="Connect Supabase to activate sales analytics" body="Add environment variables and restart the app." />
      </>
    );
  }

  const [batchResult, fullReconciliationResult] = await Promise.all([
    safeSupabaseQuery<VmsDashboardBatch>({
      label: "sales.vms_import_batches",
      promise: queryVmsDashboardBatches(supabase, {
        reportTypes: ["vms_order_details_weekly", "sales"],
        orderBy: "uploaded_at",
        ascending: false,
      }),
    }),
    safeSupabaseQuery<TransactionStatusRow>({
      label: "sales.sales_dashboard_batch_reconciliation.all",
      promise: supabase.rpc("sales_dashboard_batch_reconciliation"),
    }),
  ]);

  const batches = batchResult.data as VmsDashboardBatch[];
  const fullReconciliationRows = normalizeSalesBatchReconciliationRows(fullReconciliationResult.data as TransactionStatusRow[]);
  const fullReconciliationByBatchId = salesBatchReconciliationById(fullReconciliationRows);
  const coverageAwareBatches = applySalesBatchCoverage(batches, fullReconciliationByBatchId);
  const selectedRange = resolveSalesDashboardRange(params, coverageAwareBatches, renderedAt);
  const selectedRangeLabel = formatSalesRangeLabel(selectedRange);
  const showAdminReconciliation = isOwnerAdminRole(profile);

  const [salesSummaryResult, salesResult, filteredReconciliationResult, adminReconciliationDiagnostics] = await Promise.all([
    safeSupabaseQuery<SalesSummaryRow>({
      label: "sales.sales_dashboard_summary.filtered",
      promise: supabase.rpc("sales_dashboard_summary", {
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
    }),
    safeSupabaseQuery<SalesRow>({
      label: "sales.vms_sales_clean.filtered",
      promise: fetchSalesRowsForRange({
        end: selectedRange.end,
        start: selectedRange.start,
        supabase,
      }),
    }),
    safeSupabaseQuery<TransactionStatusRow>({
      label: "sales.sales_dashboard_batch_reconciliation.filtered",
      promise: supabase.rpc("sales_dashboard_batch_reconciliation", {
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
    }),
    showAdminReconciliation
      ? querySalesRangeReconciliationDiagnostics({
          batches,
          range: selectedRange,
          supabase,
        }).catch((error) => {
          console.error("[sales] Admin reconciliation diagnostics failed", error);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const salesSummary = normalizeSalesSummary((salesSummaryResult.data as SalesSummaryRow[])[0]);
  const sales = salesResult.data as SalesRow[];
  const filteredReconciliationRows = normalizeSalesBatchReconciliationRows(filteredReconciliationResult.data as TransactionStatusRow[]);
  const filteredReconciliationByBatchId = salesBatchReconciliationById(filteredReconciliationRows);
  const fileContributions = buildSalesFileContributions({
    batches,
    reconciliationByBatchId: filteredReconciliationByBatchId,
    range: selectedRange,
  });
  const contributingFiles = fileContributions.filter((row) => row.included);
  const ignoredFiles = fileContributions.filter((row) => !row.included);
  const detailedFiles = batches.filter((batch) => batch.report_type === "vms_order_details_weekly");
  const summaryOnlyFiles = fileContributions.filter((row) => row.batch.report_type === "sales");
  const overlappingSummaryFiles = summaryOnlyFiles.filter((row) => {
    const coverage = batchCoverageDates(row.batch);
    return Boolean(
      coverage.start
      && coverage.end
      && rangesOverlap({ start: coverage.start, end: coverage.end }, { start: selectedRange.start, end: selectedRange.end }),
    );
  });
  const coverage = vmsCoverageSummary(coverageAwareBatches);
  const missingPeriods = coverage.gaps.filter((gap) => rangesOverlap(gap, { start: selectedRange.start, end: selectedRange.end }));
  const totalSales = salesSummary.successfulSalesAmount;
  const totalUnits = salesSummary.successfulUnitsSold;
  const totalTransactions = salesSummary.successfulSalesCount;
  const totalCash = salesSummary.cashPaymentAmount;
  const totalCard = salesSummary.cardPaymentAmount;
  const totalUnknownPayment = salesSummary.unknownPaymentAmount;
  const hasTenderBreakdown = salesSummary.paymentMethodAvailable;
  const statusTotals = {
    failedVendCount: salesSummary.failedVendCount,
    failedVendAmount: salesSummary.failedVendAmount,
    refundCount: salesSummary.refundCount,
    refundAmount: salesSummary.refundAmount,
    failedPaymentCount: salesSummary.failedPaymentCount,
    needsReviewCount: salesSummary.needsReviewCount,
  };
  const failedVendRate = salesSummary.totalAttemptCount > 0
    ? `${((statusTotals.failedVendCount / salesSummary.totalAttemptCount) * 100).toFixed(1)}%`
    : "0.0%";
  const revenue = (row: SalesRow) => numericValue(row.net_sales_amount ?? row.gross_sales_amount);
  const byDay = chronologicalSales(groupSum(sales, (row) => row.sale_date ?? "Unknown", revenue));
  const byMonth = chronologicalSales(groupSum(sales, (row) => String(row.sales_month ?? "Unknown").slice(0, 7), revenue));
  const byHour = chronologicalSales(groupSum(sales, (row) => {
    const date = row.period_start ? new Date(row.period_start) : null;
    if (!date || Number.isNaN(date.getTime())) return "Unknown";
    return `${String(date.getHours()).padStart(2, "0")}:00`;
  }, revenue));
  const byMachine = groupSum(sales, (row) => row.machine_name ?? "Unknown / not mapped", revenue).slice(0, 10);
  const byLocation = groupSum(sales, (row) => row.location_name ?? "Unknown location", revenue).slice(0, 10);
  const byProduct = groupSum(sales, (row) => row.product_name ?? "Unknown / not mapped", revenue).slice(0, 10);
  const unitsByProduct = sales.reduce((map, row) => {
    const key = row.product_name ?? "Unknown / not mapped";
    map.set(key, (map.get(key) ?? 0) + numericValue(row.units_sold));
    return map;
  }, new Map<string, number>());
  const latestIncludedTransaction = latestTimestamp(sales.map((row) => row.period_end ?? row.period_start ?? row.sale_date));
  const rawRowsInRange = filteredReconciliationRows.reduce((sum, row) => sum + row.rangeRowCount, 0);
  const rawSuccessfulRowsInRange = filteredReconciliationRows.reduce((sum, row) => sum + row.rangeSuccessfulRows, 0);
  const rawSuccessfulSalesInRange = filteredReconciliationRows.reduce((sum, row) => sum + row.rangeSuccessfulSalesAmount, 0);
  const rawUnitsSoldInRange = filteredReconciliationRows.reduce((sum, row) => sum + row.rangeUnitsSold, 0);
  const inactiveRowsInRange = filteredReconciliationRows
    .filter((row) => {
      const batch = batches.find((candidate) => candidate.id === row.batchId);
      return batch ? !["imported", "imported_with_warnings", "partially_imported"].includes(String(batch.status ?? "")) || batch.is_active === false || Boolean(batch.deleted_at) : false;
    })
    .reduce((sum, row) => sum + row.rangeRowCount, 0);
  const duplicateRowsIgnored = fullReconciliationRows.reduce((sum, row) => sum + row.metadataDuplicateRowsTotal, 0);
  const missingDatetimeRows = fullReconciliationRows.reduce((sum, row) => sum + row.rawMissingDatetimeRowsTotal, 0);
  const missingAmountRows = fullReconciliationRows.reduce((sum, row) => sum + row.rawMissingAmountRowsTotal, 0);
  const statusBreakdownRows = [
    { label: "successful_sale", count: rawSuccessfulRowsInRange, amount: rawSuccessfulSalesInRange },
    { label: "failed_vend", count: statusTotals.failedVendCount, amount: statusTotals.failedVendAmount },
    { label: "refunded", count: statusTotals.refundCount, amount: statusTotals.refundAmount },
    { label: "failed_payment", count: statusTotals.failedPaymentCount, amount: 0 },
    { label: "needs_review", count: statusTotals.needsReviewCount, amount: 0 },
  ].filter((row) => row.count > 0 || row.amount > 0);
  const rawVsDashboardSalesDelta = rawSuccessfulSalesInRange - totalSales;
  const rawVsDashboardRowsDelta = rawSuccessfulRowsInRange - totalTransactions;
  const paymentBreakdownTotal = totalCash + totalCard + totalUnknownPayment;
  const paymentBreakdownCountTotal = salesSummary.cashPaymentCount + salesSummary.cardPaymentCount + salesSummary.unknownPaymentCount;
  const paymentBreakdownAmountDelta = Number((totalSales - paymentBreakdownTotal).toFixed(2));
  const paymentBreakdownCountDelta = totalTransactions - paymentBreakdownCountTotal;
  const hasRawSuccessfulRows = rawSuccessfulRowsInRange > 0;
  const hasDashboardSalesRows = totalTransactions > 0;

  return (
    <>
      <PageHeader
        title="Sales Dashboard"
        subtitle="Detailed VMS Order Details drive Snacky sales KPIs. Date filters use business date, while transaction timestamps stay available for audit and hour-level analysis."
      />

      <div className="space-y-6">
        <section className="surface-card space-y-4">
          <div className="flex flex-wrap gap-2">
            <FilterPresetLink active={selectedRange.key === "default"} href="/sales" label="Latest available" />
            <FilterPresetLink active={selectedRange.key === "today"} href="/sales?range=today" label="Today" />
            <FilterPresetLink active={selectedRange.key === "yesterday"} href="/sales?range=yesterday" label="Yesterday" />
            <FilterPresetLink active={selectedRange.key === "this_week"} href="/sales?range=this_week" label="This week" />
            <FilterPresetLink active={selectedRange.key === "this_month"} href="/sales?range=this_month" label="This month" />
            <FilterPresetLink active={selectedRange.key === "last_month"} href="/sales?range=last_month" label="Last month" />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <form className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Specific month</div>
              <p className="mt-1 text-sm text-slate-500">Filter KPIs and file contributions to one business-date calendar month.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="hidden" name="range" value="month" />
                <input name="month" type="month" defaultValue={selectedRange.monthValue} className="field-input" />
                <button className="btn-secondary">Apply month</button>
              </div>
            </form>

            <form className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Specific date</div>
              <p className="mt-1 text-sm text-slate-500">Inspect one business day without carrying older totals forward.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="hidden" name="range" value="date" />
                <input name="date" type="date" defaultValue={selectedRange.dateValue} className="field-input" />
                <button className="btn-secondary">Apply date</button>
              </div>
            </form>

            <form className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Custom range</div>
              <p className="mt-1 text-sm text-slate-500">Use an exact business-date start and end for investigations or partial-period review.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="range" value="custom" />
                <input name="date_from" type="date" defaultValue={selectedRange.dateFromValue} className="field-input" />
                <input name="date_to" type="date" defaultValue={selectedRange.dateToValue} className="field-input" />
                <button className="btn-secondary">Apply range</button>
              </div>
            </form>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Selected range</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">Showing sales for business dates {selectedRangeLabel}</div>
            <p className="mt-1 text-sm text-slate-500">{selectedRange.helperText}</p>
          </div>
        </section>

        <KpiSection
          title="Data Source Summary"
          subtitle="Sales dashboard totals use detailed VMS Order Details rows where transaction_status = successful_sale. Business date controls day, month, and range totals; timestamps remain separate for audit."
        >
          <KpiLoadWarning message={batchResult.error} />
          <KpiLoadWarning message={fullReconciliationResult.error} />
          <KpiLoadWarning message={salesSummaryResult.error} />

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
              <div>
                <div className="font-semibold text-slate-900">Selected date range</div>
                <div>{selectedRangeLabel}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Detailed VMS rows used</div>
                <div>{formatInteger(rawSuccessfulRowsInRange)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">KPI source</div>
                <div>`sales_dashboard_summary()` over active imported Order Details rows</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Files contributing data</div>
                <div>{formatInteger(contributingFiles.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Uploaded detailed files</div>
                <div>{formatInteger(detailedFiles.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Ignored files</div>
                <div>{formatInteger(ignoredFiles.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Latest included transaction</div>
                <div>{formatVmsDateTime(latestIncludedTransaction)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Raw detailed rows in selected range</div>
                <div>{formatInteger(rawRowsInRange)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">KPI filtered rows used</div>
                <div>{formatInteger(salesSummary.rowsUsed)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Last dashboard refresh</div>
                <div>{formatVmsDateTime(renderedAt.toISOString())}</div>
              </div>
            </div>

            {overlappingSummaryFiles.length ? (
              <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
                {formatInteger(overlappingSummaryFiles.length)} summary sales file(s) overlap this period, but they are not used in Sales Dashboard totals. Upload finalized Order Details XLS files for those dates if you need detailed dashboard coverage.
              </div>
            ) : null}

            {missingPeriods.length ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {missingPeriods.map((gap) => (
                  <p key={`${gap.start}-${gap.end}`}>
                    Missing detailed sales data from {gap.start} to {gap.end}. Sales from those dates are not included in this dashboard. Upload Order Details XLS for that period.
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          {fileContributions.length ? (
            <div className="mt-4">
              <DataTable
                headers={[
                  "File name",
                  "Uploaded at",
                  "Business date coverage",
                  "Imported raw rows total",
                  "Rows inside selected filter",
                  "Successful sale rows in filter",
                  "Sales amount inside selected filter",
                  "Active",
                  "Status",
                  "Included now",
                  "Reason",
                ]}
              >
                {fileContributions.map((row) => (
                  <tr key={row.batch.id}>
                    <td className="max-w-xs">
                      <Link href={`/vms-import/${row.batch.id}`} className="link-secondary font-medium text-slate-900">
                        {row.fileName}
                      </Link>
                      <div className="mt-1 text-xs text-slate-500">
                        {row.batch.report_type === "sales" ? "Summary sales file" : "Detailed Order Details file"}
                      </div>
                    </td>
                    <td className="text-sm">
                      <div>{formatVmsDateTime(row.uploadedAt)}</div>
                      <div className="mt-1 text-xs text-slate-500">Updated {formatVmsDateTime(batchLastUpdatedAt(row.batch))}</div>
                    </td>
                    <td className="text-sm">
                      <div>{row.actualCoverageLabel}</div>
                      {row.metadataCoverageLabel !== "-" && row.metadataCoverageLabel !== row.actualCoverageLabel ? (
                        <div className="mt-1 text-xs text-slate-500">Expected report range: {row.metadataCoverageLabel}</div>
                      ) : null}
                      {row.timestampCoverageStart || row.timestampCoverageEnd ? (
                        <div className="mt-1 text-xs text-slate-500">
                          Timestamp range: {formatVmsDateTime(row.timestampCoverageStart)} to {formatVmsDateTime(row.timestampCoverageEnd)}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-sm">
                      <div>{formatInteger(row.importedRowsTotal)}</div>
                      {row.batch.report_type === "vms_order_details_weekly" ? (
                        <div className="mt-1 text-xs text-slate-500">
                          Batch metadata: {formatInteger(batchImportedRows(row.batch))}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatInteger(row.rowsInRange)}</td>
                    <td>{formatInteger(row.successfulRowsInRange)}</td>
                    <td>{lyd(row.salesAmountInRange)}</td>
                    <td>{row.isActive ? "Yes" : "No"}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td>{row.included ? "Yes" : "No"}</td>
                    <td className="max-w-md text-sm text-slate-600">{row.reason}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No VMS import batches are available yet.</p>
          )}

          {showAdminReconciliation ? (
            <details className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-900">Reconciliation details</summary>
              {adminReconciliationDiagnostics ? (
                <>
                  <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <div className="font-semibold text-slate-900">Parsed successful rows</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.parsedSuccessfulCount)}</div>
                      <div className="text-xs text-slate-500">{lyd(adminReconciliationDiagnostics.parsedSuccessfulAmount)}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">Inserted successful rows</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.importedSuccessfulCount)}</div>
                      <div className="text-xs text-slate-500">{lyd(adminReconciliationDiagnostics.importedSuccessfulAmount)}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">Dashboard-counted rows</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.dashboardSuccessfulCount)}</div>
                      <div className="text-xs text-slate-500">{lyd(adminReconciliationDiagnostics.dashboardSuccessfulAmount)}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">Excluded successful rows</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.excludedSuccessfulCount)}</div>
                      <div className="text-xs text-slate-500">{lyd(adminReconciliationDiagnostics.excludedSuccessfulAmount)}</div>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <div className="font-semibold text-slate-900">Parsed rows missing product mapping</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.parsedMissingProductCount)}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">Parsed rows missing machine mapping</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.parsedMissingMachineCount)}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">Parsed rows missing business date</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.parsedMissingBusinessDateCount)}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">Duplicate rows seen in parsed file</div>
                      <div>{formatInteger(adminReconciliationDiagnostics.parsedSuccessfulDuplicateRows)}</div>
                    </div>
                  </div>
                </>
              ) : null}

              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                <div>
                  <div className="font-semibold text-slate-900">Selected date range</div>
                  <div>{selectedRangeLabel}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Raw rows in range</div>
                  <div>{formatInteger(rawRowsInRange)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Successful sale rows in range</div>
                  <div>{formatInteger(rawSuccessfulRowsInRange)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Rows excluded by status</div>
                  <div>{formatInteger(rawRowsInRange - rawSuccessfulRowsInRange)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Rows excluded by inactive batch</div>
                  <div>{formatInteger(inactiveRowsInRange)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Duplicate rows skipped during import</div>
                  <div>{formatInteger(duplicateRowsIgnored)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Rows missing datetime</div>
                  <div>{formatInteger(missingDatetimeRows)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Successful rows missing amount</div>
                  <div>{formatInteger(missingAmountRows)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Sales formula</div>
                  <div>Sum `successful_sale.payment_amount` by business date, even when machine/product mapping is still unknown.</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Raw successful sales</div>
                  <div>{lyd(rawSuccessfulSalesInRange)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">KPI successful sales</div>
                  <div>{lyd(totalSales)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Raw vs KPI sales delta</div>
                  <div>{lyd(rawVsDashboardSalesDelta)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Raw successful units sold</div>
                  <div>{formatInteger(rawUnitsSoldInRange)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">KPI successful rows</div>
                  <div>{formatInteger(totalTransactions)}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Raw vs KPI row delta</div>
                  <div>{formatInteger(rawVsDashboardRowsDelta)}</div>
                </div>
              </div>

              {Math.abs(rawVsDashboardSalesDelta) > 0.005 || rawVsDashboardRowsDelta !== 0 ? (
                <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                  Dashboard cards do not match raw filtered transactions.
                </div>
              ) : (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  Dashboard cards match raw filtered transactions for this selected business-date range.
                </div>
              )}

              {statusBreakdownRows.length ? (
                <div className="mt-4">
                  <DataTable headers={["Normalized status", "Rows", "Amount"]}>
                    {statusBreakdownRows.map((row) => (
                      <tr key={row.label}>
                        <td className="font-medium">{row.label}</td>
                        <td>{formatInteger(row.count)}</td>
                        <td>{lyd(row.amount)}</td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              ) : null}

              {hasTenderBreakdown ? (
                <div className="mt-4">
                  <DataTable headers={["Payment type", "Successful rows", "Amount"]}>
                    {[
                      { label: "cash", count: salesSummary.cashPaymentCount, amount: totalCash },
                      { label: "card", count: salesSummary.cardPaymentCount, amount: totalCard },
                      { label: "unknown", count: salesSummary.unknownPaymentCount, amount: totalUnknownPayment },
                      { label: "total", count: paymentBreakdownCountTotal, amount: paymentBreakdownTotal },
                    ].map((row) => (
                      <tr key={row.label}>
                        <td className="font-medium">{row.label}</td>
                        <td>{formatInteger(row.count)}</td>
                        <td>{lyd(row.amount)}</td>
                      </tr>
                    ))}
                  </DataTable>
                  {Math.abs(paymentBreakdownAmountDelta) > 0.005 || paymentBreakdownCountDelta !== 0 ? (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      Payment breakdown does not add back to total sales. Check payment-method normalization for this file set.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  Payment method not available in selected Order Details files.
                </div>
              )}

              {adminReconciliationDiagnostics?.statusGroups.length ? (
                <div className="mt-4">
                  <DataTable headers={["Raw shipping status", "Raw refund status", "Normalized status", "Rows", "Amount"]}>
                    {adminReconciliationDiagnostics.statusGroups.map((row) => (
                      <tr key={`${row.rawShippingStatus}:${row.rawRefundStatus}:${row.normalizedStatus}`}>
                        <td className="font-medium">{row.rawShippingStatus}</td>
                        <td>{row.rawRefundStatus}</td>
                        <td>{row.normalizedStatus}</td>
                        <td>{formatInteger(row.count)}</td>
                        <td>{lyd(row.amount)}</td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              ) : null}

              {adminReconciliationDiagnostics?.excludedSuccessfulRows.length ? (
                <div className="mt-4">
                  <DataTable headers={["Row", "File", "Order id", "Business date", "Machine", "Product", "Slot", "Raw status", "Amount", "Reason"]}>
                    {adminReconciliationDiagnostics.excludedSuccessfulRows.map((row) => (
                      <tr key={`${row.batchId}:${row.rowNumber}`}>
                        <td className="font-medium">{formatInteger(row.rowNumber)}</td>
                        <td className="text-sm">{row.sourceFileName}</td>
                        <td className="text-sm">{row.orderId ?? "-"}</td>
                        <td className="text-sm">{row.businessDate ?? "-"}</td>
                        <td className="text-sm">{row.machineLabel}</td>
                        <td className="text-sm">{row.productLabel}</td>
                        <td className="text-sm">{row.slot ?? "-"}</td>
                        <td className="text-sm">{row.rawShippingStatus ?? "-"}</td>
                        <td className="text-sm">
                          <div>{lyd(row.parsedAmount)}</div>
                          {row.rawAmount ? <div className="text-xs text-slate-500">Raw: {row.rawAmount}</div> : null}
                        </td>
                        <td className="max-w-md text-sm text-slate-600">
                          <div>{row.exclusionReason}</div>
                          {row.validationStatus ? <div className="text-xs text-slate-500">Audit status: {row.validationStatus}</div> : null}
                          {row.validationErrors.length ? <div className="text-xs text-slate-500">{row.validationErrors.join("; ")}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              ) : null}

              {adminReconciliationDiagnostics?.statusFilteredRows.length ? (
                <div className="mt-4">
                  <DataTable headers={["Row", "File", "Order id", "Business date", "Machine", "Product", "Slot", "Raw status", "Amount", "Status reason"]}>
                    {adminReconciliationDiagnostics.statusFilteredRows.map((row) => (
                      <tr key={`status:${row.batchId}:${row.rowNumber}`}>
                        <td className="font-medium">{formatInteger(row.rowNumber)}</td>
                        <td className="text-sm">{row.sourceFileName}</td>
                        <td className="text-sm">{row.orderId ?? "-"}</td>
                        <td className="text-sm">{row.businessDate ?? "-"}</td>
                        <td className="text-sm">{row.machineLabel}</td>
                        <td className="text-sm">{row.productLabel}</td>
                        <td className="text-sm">{row.slot ?? "-"}</td>
                        <td className="text-sm">{row.rawShippingStatus ?? "-"}</td>
                        <td className="text-sm">
                          <div>{lyd(row.parsedAmount)}</div>
                          {row.rawAmount ? <div className="text-xs text-slate-500">Raw: {row.rawAmount}</div> : null}
                        </td>
                        <td className="max-w-md text-sm text-slate-600">{row.exclusionReason}</td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              ) : null}
            </details>
          ) : null}
        </KpiSection>

        <KpiLoadWarning message={salesSummaryResult.error} />
        <KpiLoadWarning message={salesResult.error} />
        <KpiLoadWarning message={filteredReconciliationResult.error} />

        {!hasDashboardSalesRows ? (
          <EmptyState
            title={hasRawSuccessfulRows ? "Successful-sale rows exist, but none reached the dashboard view." : "No detailed sales rows found for this date range."}
            body={hasRawSuccessfulRows
              ? "Check the reconciliation details below. The raw Order Details rows are inside the selected range, but the dashboard view excluded them before KPI rendering."
              : "Summary-only files, preview batches, inactive batches, and files outside the selected range do not feed these KPIs. Adjust the filter or upload finalized Order Details XLS files for the missing period."}
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiSection title="Total sales"><MetricValue>{lyd(totalSales)}</MetricValue></KpiSection>
              <KpiSection title="Units sold"><MetricValue>{formatInteger(totalUnits)}</MetricValue></KpiSection>
              <KpiSection title="Average transaction"><MetricValue>{totalTransactions ? lyd(salesSummary.averageTransaction || (totalSales / totalTransactions)) : "Unknown / not mapped"}</MetricValue></KpiSection>
              <KpiSection title="Failed vend rate"><MetricValue>{failedVendRate}</MetricValue></KpiSection>
              <KpiSection title="Cash sales"><MetricValue compact={!hasTenderBreakdown}>{hasTenderBreakdown ? lyd(totalCash) : "Payment method unavailable"}</MetricValue></KpiSection>
              <KpiSection title="Card sales"><MetricValue compact={!hasTenderBreakdown}>{hasTenderBreakdown ? lyd(totalCard) : "Payment method unavailable"}</MetricValue></KpiSection>
              <KpiSection title="Unknown payment"><MetricValue compact={!hasTenderBreakdown}>{hasTenderBreakdown ? lyd(totalUnknownPayment) : "Payment method unavailable"}</MetricValue></KpiSection>
              <KpiSection title="Failed vend amount"><MetricValue>{lyd(statusTotals.failedVendAmount)}</MetricValue></KpiSection>
              <KpiSection title="Refund amount"><MetricValue>{lyd(statusTotals.refundAmount)}</MetricValue></KpiSection>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <KpiSection title="Sales by day" subtitle={selectedRangeLabel}>
                <BarList rows={byDay} valueFormatter={lyd} />
              </KpiSection>
              <KpiSection title="Monthly sales trend" subtitle={selectedRangeLabel}>
                <BarList rows={byMonth} valueFormatter={lyd} />
              </KpiSection>
              <KpiSection title="Sales by hour" subtitle={selectedRangeLabel}>
                <BarList rows={byHour} valueFormatter={lyd} />
              </KpiSection>
              <KpiSection title="Sales by machine" subtitle={selectedRangeLabel}>
                <BarList rows={byMachine} valueFormatter={lyd} />
              </KpiSection>
              <KpiSection title="Sales by location" subtitle={selectedRangeLabel}>
                <BarList rows={byLocation} valueFormatter={lyd} />
              </KpiSection>
            </div>

            {hasTenderBreakdown ? (
              <KpiSection title="Cash vs card" subtitle={selectedRangeLabel}>
                <BarList rows={[{ label: "Cash", value: totalCash }, { label: "Card", value: totalCard }, { label: "Unknown", value: totalUnknownPayment }]} valueFormatter={lyd} />
              </KpiSection>
            ) : (
              <EmptyState title="No cash vs card split available" body="Payment method is not available in the selected detailed Order Details files, so Snacky OS shows total sales only." />
            )}

            <KpiSection title="Sales by product" subtitle={selectedRangeLabel}>
              <DataTable headers={["Product", "Units", "Revenue"]}>
                {byProduct.map((row) => (
                  <tr key={row.label}>
                    <td className="font-medium">{row.label}</td>
                    <td>{formatInteger(unitsByProduct.get(row.label) ?? 0)}</td>
                    <td>{lyd(row.value)}</td>
                  </tr>
                ))}
              </DataTable>
            </KpiSection>
          </>
        )}
      </div>
    </>
  );
}

function isNextNavigationSignal(error: unknown) {
  const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE";
}

export default async function SalesDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord & SalesDashboardSearchParams>;
}) {
  try {
    return await SalesDashboardPageContent({ searchParams });
  } catch (error) {
    if (isNextNavigationSignal(error)) throw error;
    console.error("[sales] Page-level render guard caught an unexpected error", error);
    return (
      <>
        <PageHeader
          title="Sales Dashboard"
          subtitle="Detailed sales analytics from active VMS Order Details files."
        />
        <EmptyState title="Something did not load" body="Snacky OS recovered from a sales dashboard load error. Please retry after the latest import finishes; technical details are in the server logs." />
      </>
    );
  }
}
