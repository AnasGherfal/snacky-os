import Link from "next/link";
import type { ReactNode } from "react";
import { BarList, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { formatInteger } from "@/lib/kpi";
import { cleanSearchParams, type SearchParamsRecord } from "@/lib/pagination";
import { supabaseQueryErrorMessage } from "@/lib/safe-supabase-query";
import {
  applySalesBatchCoverage,
  batchCoverageDates,
  buildSalesFileContributions,
  formatSalesRangeLabel,
  normalizeSalesBreakdownRows,
  rangesOverlap,
  resolveSalesDashboardRange,
  salesBatchReconciliationById,
  type NormalizedSalesDashboardBreakdownRow,
  type SalesBatchReconciliation,
  type SalesDashboardBreakdownRow,
  type SalesDashboardSearchParams,
} from "@/lib/sales-dashboard";
import {
  batchLastUpdatedAt,
  formatVmsDateTime,
  queryVmsDashboardBatches,
  vmsCoverageSummary,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

type SalesSummaryRow = {
  revenue_amount: number | string | null;
  successful_sales_count: number | string | null;
  units_sold: number | string | null;
  average_transaction: number | string | null;
  failed_vend_count: number | string | null;
  failed_vend_amount: number | string | null;
  refund_count: number | string | null;
  refund_amount: number | string | null;
  total_attempt_count: number | string | null;
  failed_vend_rate: number | string | null;
  cash_sales_amount: number | string | null;
  card_sales_amount: number | string | null;
  unknown_payment_sales_amount: number | string | null;
  payment_method_available: boolean | null;
  rows_used: number | string | null;
  failed_payment_count: number | string | null;
  needs_review_count: number | string | null;
  cash_payment_count: number | string | null;
  card_payment_count: number | string | null;
  unknown_payment_count: number | string | null;
  cogs_amount: number | string | null;
  gross_profit_amount: number | string | null;
  gross_margin_percent: number | string | null;
  missing_cost_sales_count: number | string | null;
  missing_cost_revenue_amount: number | string | null;
  estimated_cost_sales_count: number | string | null;
  estimated_cost_revenue_amount: number | string | null;
};

type SalesSummary = {
  revenueAmount: number;
  successfulSalesCount: number;
  successfulUnitsSold: number;
  averageTransaction: number;
  failedVendCount: number;
  failedVendAmount: number;
  refundCount: number;
  refundAmount: number;
  totalAttemptCount: number;
  failedVendRate: number;
  cashPaymentAmount: number;
  cardPaymentAmount: number;
  unknownPaymentAmount: number;
  paymentMethodAvailable: boolean;
  rowsUsed: number;
  failedPaymentCount: number;
  needsReviewCount: number;
  cashPaymentCount: number;
  cardPaymentCount: number;
  unknownPaymentCount: number;
  cogsAmount: number | null;
  grossProfitAmount: number | null;
  grossMarginPercent: number | null;
  missingCostSalesCount: number;
  missingCostRevenueAmount: number;
  estimatedCostSalesCount: number;
  estimatedCostRevenueAmount: number;
};

type SalesBreakdownRow = NormalizedSalesDashboardBreakdownRow;

type SalesProfitBreakdownRow = {
  bucket_key?: string | null;
  bucket_label?: string | null;
  sort_key?: string | null;
  revenue_amount?: number | string | null;
  successful_sales_count?: number | string | null;
  units_sold?: number | string | null;
  rows_used?: number | string | null;
  cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null;
  gross_margin_percent?: number | string | null;
  missing_cost_sales_count?: number | string | null;
  missing_cost_revenue_amount?: number | string | null;
  estimated_cost_sales_count?: number | string | null;
  estimated_cost_revenue_amount?: number | string | null;
  cost_status?: string | null;
};

type NormalizedSalesProfitBreakdownRow = {
  bucketKey: string;
  bucketLabel: string;
  sortKey: string;
  revenueAmount: number;
  successfulSalesCount: number;
  unitsSold: number;
  rowsUsed: number;
  cogsAmount: number;
  grossProfitAmount: number;
  grossMarginPercent: number | null;
  missingCostSalesCount: number;
  missingCostRevenueAmount: number;
  estimatedCostSalesCount: number;
  estimatedCostRevenueAmount: number;
  costStatus: string;
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

type SupabaseSectionError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

type SupabaseSectionResult<T> = {
  data?: T[] | null;
  count?: number | null;
  error?: SupabaseSectionError | null;
};

type LoggedSalesSectionResult<T> = {
  count: number;
  data: T[];
  elapsedMs: number;
  error: string | null;
  errorCode: string | null;
  loadedAt: string;
  rpcName: string | null;
  sectionName: string;
};

const EMPTY_SALES_SUMMARY: SalesSummary = {
  revenueAmount: 0,
  successfulSalesCount: 0,
  successfulUnitsSold: 0,
  averageTransaction: 0,
  failedVendCount: 0,
  failedVendAmount: 0,
  refundCount: 0,
  refundAmount: 0,
  totalAttemptCount: 0,
  failedVendRate: 0,
  cashPaymentAmount: 0,
  cardPaymentAmount: 0,
  unknownPaymentAmount: 0,
  paymentMethodAvailable: false,
  rowsUsed: 0,
  failedPaymentCount: 0,
  needsReviewCount: 0,
  cashPaymentCount: 0,
  cardPaymentCount: 0,
  unknownPaymentCount: 0,
  cogsAmount: null,
  grossProfitAmount: null,
  grossMarginPercent: null,
  missingCostSalesCount: 0,
  missingCostRevenueAmount: 0,
  estimatedCostSalesCount: 0,
  estimatedCostRevenueAmount: 0,
};

function numericValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumericValue(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chronologicalBarRows(rows: SalesBreakdownRow[]) {
  return [...rows]
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.bucketLabel.localeCompare(right.bucketLabel))
    .map((row) => ({
      label: row.bucketLabel,
      value: row.successfulSalesAmount,
      detail: row.rowsUsed ? `${formatInteger(row.rowsUsed)} rows` : undefined,
    }));
}

function valueRankedBarRows(rows: SalesBreakdownRow[]) {
  return [...rows]
    .sort((left, right) => right.successfulSalesAmount - left.successfulSalesAmount || left.bucketLabel.localeCompare(right.bucketLabel))
    .map((row) => ({
      label: row.bucketLabel,
      value: row.successfulSalesAmount,
      detail: `${formatInteger(row.unitsSold)} units`,
    }));
}

function formatMarginPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "Not available";
  return `${(value * 100).toFixed(1)}%`;
}

function activeFilterClass(active: boolean) {
  return active
    ? "rounded-full border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-medium text-white transition"
    : "rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900";
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
}: {
  children: ReactNode;
}) {
  return <div className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-[1.9rem]">{children}</div>;
}

function MetricCard({
  helper,
  label,
  tone = "default",
  value,
}: {
  helper?: string;
  label: string;
  tone?: "default" | "warn";
  value: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${tone === "warn" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
      <div className={`text-sm font-medium ${tone === "warn" ? "text-amber-900" : "text-slate-600"}`}>{label}</div>
      <div className="mt-2">{value}</div>
      {helper ? <div className={`mt-2 text-xs leading-5 ${tone === "warn" ? "text-amber-900/80" : "text-slate-500"}`}>{helper}</div> : null}
    </div>
  );
}

function SectionInlineMessage({
  body,
  title,
}: {
  body: string;
  title: string;
}) {
  return <EmptyState title={title} body={body} />;
}

function compactStatusLabel(status: string) {
  switch (status) {
    case "historical_cost":
      return "Historical cost";
    case "current_cost_fallback":
      return "Current cost fallback";
    case "historical_and_fallback":
      return "Historical + fallback";
    case "missing_cost":
      return "Missing cost";
    case "unmapped_product":
      return "Unmapped product";
    default:
      return status.replaceAll("_", " ");
  }
}

function businessContributionReason(row: { status: string; reason: string }) {
  switch (row.status) {
    case "included":
      return "Used in the selected sales totals.";
    case "summary_file_only":
      return "Summary-only file. Revenue uses detailed Order Details files.";
    case "preview_only":
      return "Preview file. Finalize import before it can feed sales.";
    case "inactive_batch":
      return "Inactive batch. Not used in dashboard totals.";
    case "failed_import":
      return "Import failed. No dashboard totals were taken from this file.";
    case "outside_selected_date_range":
      return "Outside the selected business dates.";
    case "rows_excluded_by_status":
      return "Rows exist in range, but they were not successful sales.";
    case "missing_transaction_datetime":
      return "Rows were saved, but their business date could not be resolved.";
    case "metadata_without_raw_rows":
      return "Import metadata exists, but detailed transaction rows were not available.";
    case "duplicate_rows_ignored":
      return "Rows were already loaded from older detailed files.";
    default:
      return row.reason;
  }
}

function rangeDayCount(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  return Math.max(1, diff + 1);
}

function normalizeSalesSummary(row?: SalesSummaryRow | null): SalesSummary {
  if (!row) return EMPTY_SALES_SUMMARY;
  return {
    revenueAmount: numericValue(row.revenue_amount),
    successfulSalesCount: numericValue(row.successful_sales_count),
    successfulUnitsSold: numericValue(row.units_sold),
    averageTransaction: numericValue(row.average_transaction),
    failedVendCount: numericValue(row.failed_vend_count),
    failedVendAmount: numericValue(row.failed_vend_amount),
    refundCount: numericValue(row.refund_count),
    refundAmount: numericValue(row.refund_amount),
    totalAttemptCount: numericValue(row.total_attempt_count),
    failedVendRate: nullableNumericValue(row.failed_vend_rate) ?? 0,
    cashPaymentAmount: numericValue(row.cash_sales_amount),
    cardPaymentAmount: numericValue(row.card_sales_amount),
    unknownPaymentAmount: numericValue(row.unknown_payment_sales_amount),
    paymentMethodAvailable: Boolean(row.payment_method_available),
    rowsUsed: numericValue(row.rows_used),
    failedPaymentCount: numericValue(row.failed_payment_count),
    needsReviewCount: numericValue(row.needs_review_count),
    cashPaymentCount: numericValue(row.cash_payment_count),
    cardPaymentCount: numericValue(row.card_payment_count),
    unknownPaymentCount: numericValue(row.unknown_payment_count),
    cogsAmount: nullableNumericValue(row.cogs_amount),
    grossProfitAmount: nullableNumericValue(row.gross_profit_amount),
    grossMarginPercent: nullableNumericValue(row.gross_margin_percent),
    missingCostSalesCount: numericValue(row.missing_cost_sales_count),
    missingCostRevenueAmount: numericValue(row.missing_cost_revenue_amount),
    estimatedCostSalesCount: numericValue(row.estimated_cost_sales_count),
    estimatedCostRevenueAmount: numericValue(row.estimated_cost_revenue_amount),
  };
}

function normalizeSalesProfitBreakdownRows(rows: SalesProfitBreakdownRow[]) {
  return rows.map((row) => ({
    bucketKey: String(row.bucket_key ?? ""),
    bucketLabel: String(row.bucket_label ?? row.bucket_key ?? "Unknown"),
    sortKey: String(row.sort_key ?? row.bucket_key ?? row.bucket_label ?? ""),
    revenueAmount: numericValue(row.revenue_amount),
    successfulSalesCount: numericValue(row.successful_sales_count),
    unitsSold: numericValue(row.units_sold),
    rowsUsed: numericValue(row.rows_used),
    cogsAmount: numericValue(row.cogs_amount),
    grossProfitAmount: numericValue(row.gross_profit_amount),
    grossMarginPercent: nullableNumericValue(row.gross_margin_percent),
    missingCostSalesCount: numericValue(row.missing_cost_sales_count),
    missingCostRevenueAmount: numericValue(row.missing_cost_revenue_amount),
    estimatedCostSalesCount: numericValue(row.estimated_cost_sales_count),
    estimatedCostRevenueAmount: numericValue(row.estimated_cost_revenue_amount),
    costStatus: String(row.cost_status ?? "historical_cost"),
  } satisfies NormalizedSalesProfitBreakdownRow));
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

function emptySectionResult<T>(rpcName: string | null, sectionName: string): LoggedSalesSectionResult<T> {
  return {
    count: 0,
    data: [] as T[],
    elapsedMs: 0,
    error: null,
    errorCode: null,
    loadedAt: new Date().toISOString(),
    rpcName,
    sectionName,
  };
}

async function loadSalesQuerySection<T>({
  dateFrom,
  dateTo,
  fallback = [],
  filterMode,
  profileId,
  promise,
  role,
  rpcName,
  sectionName,
}: {
  dateFrom: string;
  dateTo: string;
  fallback?: T[];
  filterMode: string;
  profileId: string;
  promise: PromiseLike<SupabaseSectionResult<T>>;
  role: string;
  rpcName?: string | null;
  sectionName: string;
}): Promise<LoggedSalesSectionResult<T>> {
  const startedAt = Date.now();
  const loadedAt = new Date().toISOString();

  try {
    const result = await promise;
    const elapsedMs = Date.now() - startedAt;
    const data = (result.data ?? fallback) as T[];
    const rowCount = result.count ?? data.length ?? 0;

    if (result.error) {
      const errorCode = result.error.code == null ? null : String(result.error.code);
      const errorMessage = supabaseQueryErrorMessage(result.error);
      console.error("[sales] Section load failed", {
        current_user_id: profileId,
        current_user_role: role,
        data_missing: result.data == null,
        date_from: dateFrom,
        date_to: dateTo,
        elapsed_ms: elapsedMs,
        error_code: errorCode,
        error_message: errorMessage,
        filter_mode: filterMode,
        returned_row_count: rowCount,
        rpc_function_name: rpcName ?? null,
        section_name: sectionName,
      });
      return {
        count: rowCount,
        data: fallback,
        elapsedMs,
        error: errorMessage,
        errorCode,
        loadedAt,
        rpcName: rpcName ?? null,
        sectionName,
      };
    }

    console.info("[sales] Section load completed", {
      current_user_id: profileId,
      current_user_role: role,
      data_missing: result.data == null,
      date_from: dateFrom,
      date_to: dateTo,
      elapsed_ms: elapsedMs,
      filter_mode: filterMode,
      returned_row_count: rowCount,
      rpc_function_name: rpcName ?? null,
      section_name: sectionName,
    });

    return {
      count: rowCount,
      data,
      elapsedMs,
      error: null,
      errorCode: null,
      loadedAt,
      rpcName: rpcName ?? null,
      sectionName,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const errorMessage = supabaseQueryErrorMessage(error);
    const errorCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") || null : null;
    console.error("[sales] Section load threw", {
      current_user_id: profileId,
      current_user_role: role,
      data_missing: true,
      date_from: dateFrom,
      date_to: dateTo,
      elapsed_ms: elapsedMs,
      error_code: errorCode,
      error_message: errorMessage,
      filter_mode: filterMode,
      returned_row_count: 0,
      rpc_function_name: rpcName ?? null,
      section_name: sectionName,
    });
    return {
      count: 0,
      data: fallback,
      elapsedMs,
      error: errorMessage,
      errorCode,
      loadedAt,
      rpcName: rpcName ?? null,
      sectionName,
    };
  }
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
  const profileId = String((profile as { id?: unknown }).id ?? "unknown");
  const profileRole = String((profile as { role?: unknown }).role ?? "unknown");
  const canViewProfit = isOwnerAdminRole(profile);

  if (!supabase) {
    return (
      <>
        <PageHeader
          title="Sales Dashboard"
          subtitle="Sales are calculated from imported VMS Order Details for the selected business dates."
        />
        <EmptyState title="Connect Supabase to activate sales analytics" body="Add environment variables and restart the app." />
      </>
    );
  }

  const [batchResult, fullReconciliationResult] = await Promise.all([
    loadSalesQuerySection<VmsDashboardBatch>({
      dateFrom: "",
      dateTo: "",
      filterMode: String(params.range ?? "default"),
      profileId,
      promise: queryVmsDashboardBatches(supabase, {
        reportTypes: ["vms_order_details_weekly", "sales"],
        orderBy: "uploaded_at",
        ascending: false,
      }),
      role: profileRole,
      sectionName: "vms_batch_sources",
    }),
    loadSalesQuerySection<TransactionStatusRow>({
      dateFrom: "",
      dateTo: "",
      filterMode: String(params.range ?? "default"),
      profileId,
      promise: supabase.rpc("sales_dashboard_batch_reconciliation"),
      role: profileRole,
      rpcName: "sales_dashboard_batch_reconciliation",
      sectionName: "batch_reconciliation_all",
    }),
  ]);

  const batches = batchResult.data as VmsDashboardBatch[];
  const fullReconciliationRows = normalizeSalesBatchReconciliationRows(fullReconciliationResult.data as TransactionStatusRow[]);
  const fullReconciliationByBatchId = salesBatchReconciliationById(fullReconciliationRows);
  const coverageAwareBatches = applySalesBatchCoverage(batches, fullReconciliationByBatchId);
  const selectedRange = resolveSalesDashboardRange(params, coverageAwareBatches, renderedAt);
  const selectedRangeLabel = formatSalesRangeLabel(selectedRange);
  const compactRangeLabel = `${selectedRange.start} to ${selectedRange.end}`;

  const [
    salesSummaryResult,
    dayBreakdownResult,
    monthBreakdownResult,
    machineBreakdownResult,
    locationBreakdownResult,
    productBreakdownResult,
    filteredReconciliationResult,
    productProfitResult,
    machineProfitResult,
    locationProfitResult,
  ] = await Promise.all([
    loadSalesQuerySection<SalesSummaryRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_summary", {
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_summary",
      sectionName: "summary_kpi",
    }),
    loadSalesQuerySection<SalesDashboardBreakdownRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_breakdown", {
        p_dimension: "day",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_breakdown",
      sectionName: "chart_day",
    }),
    loadSalesQuerySection<SalesDashboardBreakdownRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_breakdown", {
        p_dimension: "month",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_breakdown",
      sectionName: "chart_month",
    }),
    loadSalesQuerySection<SalesDashboardBreakdownRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_breakdown", {
        p_dimension: "machine",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_breakdown",
      sectionName: "chart_machine",
    }),
    loadSalesQuerySection<SalesDashboardBreakdownRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_breakdown", {
        p_dimension: "location",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_breakdown",
      sectionName: "chart_location",
    }),
    loadSalesQuerySection<SalesDashboardBreakdownRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_breakdown", {
        p_dimension: "product",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_breakdown",
      sectionName: "chart_product",
    }),
    loadSalesQuerySection<TransactionStatusRow>({
      dateFrom: selectedRange.start,
      dateTo: selectedRange.end,
      filterMode: selectedRange.key,
      profileId,
      promise: supabase.rpc("sales_dashboard_batch_reconciliation", {
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
      role: profileRole,
      rpcName: "sales_dashboard_batch_reconciliation",
      sectionName: "batch_reconciliation_filtered",
    }),
    canViewProfit
      ? loadSalesQuerySection<SalesProfitBreakdownRow>({
          dateFrom: selectedRange.start,
          dateTo: selectedRange.end,
          filterMode: selectedRange.key,
          profileId,
          promise: supabase.rpc("sales_dashboard_profit_breakdown", {
            p_dimension: "product",
            p_date_from: selectedRange.start,
            p_date_to: selectedRange.end,
          }),
          role: profileRole,
          rpcName: "sales_dashboard_profit_breakdown",
          sectionName: "profit_product",
        })
      : Promise.resolve(emptySectionResult<SalesProfitBreakdownRow>("sales_dashboard_profit_breakdown", "profit_product")),
    canViewProfit
      ? loadSalesQuerySection<SalesProfitBreakdownRow>({
          dateFrom: selectedRange.start,
          dateTo: selectedRange.end,
          filterMode: selectedRange.key,
          profileId,
          promise: supabase.rpc("sales_dashboard_profit_breakdown", {
            p_dimension: "machine",
            p_date_from: selectedRange.start,
            p_date_to: selectedRange.end,
          }),
          role: profileRole,
          rpcName: "sales_dashboard_profit_breakdown",
          sectionName: "profit_machine",
        })
      : Promise.resolve(emptySectionResult<SalesProfitBreakdownRow>("sales_dashboard_profit_breakdown", "profit_machine")),
    canViewProfit
      ? loadSalesQuerySection<SalesProfitBreakdownRow>({
          dateFrom: selectedRange.start,
          dateTo: selectedRange.end,
          filterMode: selectedRange.key,
          profileId,
          promise: supabase.rpc("sales_dashboard_profit_breakdown", {
            p_dimension: "location",
            p_date_from: selectedRange.start,
            p_date_to: selectedRange.end,
          }),
          role: profileRole,
          rpcName: "sales_dashboard_profit_breakdown",
          sectionName: "profit_location",
        })
      : Promise.resolve(emptySectionResult<SalesProfitBreakdownRow>("sales_dashboard_profit_breakdown", "profit_location")),
  ]);

  const summary = normalizeSalesSummary((salesSummaryResult.data as SalesSummaryRow[])[0]);
  const dayBreakdownRows = normalizeSalesBreakdownRows(dayBreakdownResult.data as SalesDashboardBreakdownRow[]);
  const monthBreakdownRows = normalizeSalesBreakdownRows(monthBreakdownResult.data as SalesDashboardBreakdownRow[]);
  const machineBreakdownRows = normalizeSalesBreakdownRows(machineBreakdownResult.data as SalesDashboardBreakdownRow[]);
  const locationBreakdownRows = normalizeSalesBreakdownRows(locationBreakdownResult.data as SalesDashboardBreakdownRow[]);
  const productBreakdownRows = normalizeSalesBreakdownRows(productBreakdownResult.data as SalesDashboardBreakdownRow[]);
  const productProfitRows = normalizeSalesProfitBreakdownRows(productProfitResult.data as SalesProfitBreakdownRow[])
    .sort((left, right) => right.grossProfitAmount - left.grossProfitAmount || right.revenueAmount - left.revenueAmount || left.bucketLabel.localeCompare(right.bucketLabel));
  const machineProfitRows = normalizeSalesProfitBreakdownRows(machineProfitResult.data as SalesProfitBreakdownRow[])
    .sort((left, right) => right.grossProfitAmount - left.grossProfitAmount || right.revenueAmount - left.revenueAmount || left.bucketLabel.localeCompare(right.bucketLabel));
  const locationProfitRows = normalizeSalesProfitBreakdownRows(locationProfitResult.data as SalesProfitBreakdownRow[])
    .sort((left, right) => right.grossProfitAmount - left.grossProfitAmount || right.revenueAmount - left.revenueAmount || left.bucketLabel.localeCompare(right.bucketLabel));
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
  const dayCount = rangeDayCount(selectedRange.start, selectedRange.end);
  const trendUsesDaily = dayCount <= 62;
  const trendRows = trendUsesDaily ? dayBreakdownRows : monthBreakdownRows;
  const trendTitle = trendUsesDaily ? "Sales by day" : "Sales by month";
  const trendSubtitle = trendUsesDaily
    ? "Daily revenue for the selected business dates."
    : "Monthly revenue trend for the selected business dates.";
  const topProductSalesRows = [...productBreakdownRows]
    .sort((left, right) => right.successfulSalesAmount - left.successfulSalesAmount || right.unitsSold - left.unitsSold || left.bucketLabel.localeCompare(right.bucketLabel))
    .slice(0, 15);
  const latestSourceBatch = coverage.latest ?? detailedFiles[0] ?? batches[0] ?? null;
  const lastUpdatedAt = batchLastUpdatedAt(latestSourceBatch) ?? renderedAt.toISOString();
  const sourceStatusText = contributingFiles.length
    ? missingPeriods.length
      ? `${formatInteger(contributingFiles.length)} active detailed file(s), with coverage gaps in this range`
      : `${formatInteger(contributingFiles.length)} active detailed file(s) contributing`
    : "Waiting for finalized detailed Order Details files";
  const paymentMethodText = summary.paymentMethodAvailable
    ? "Cash and card split is available for this range."
    : "Payment method split is not available for this range.";
  const summaryLoadFailed = Boolean(salesSummaryResult.error);
  const sourceLoadFailed = Boolean(batchResult.error || fullReconciliationResult.error || filteredReconciliationResult.error);
  const hasSalesRows = summary.successfulSalesCount > 0 || trendRows.length > 0;
  const hasProfitWarning = canViewProfit && (summary.missingCostRevenueAmount > 0 || summary.estimatedCostRevenueAmount > 0);

  return (
    <>
      <PageHeader
        title="Sales Dashboard"
        subtitle="Sales are calculated from imported VMS Order Details for the selected business dates."
      />

      <div className="space-y-6">
        <section className="surface-card space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">{compactRangeLabel}</span>
                <span className="text-sm text-slate-500">Updated {formatVmsDateTime(lastUpdatedAt)}</span>
              </div>
              <div className="text-sm text-slate-500">{sourceStatusText}</div>
            </div>
            <Link href="#data-sources" className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900">
              Data sources
            </Link>
          </div>

          <div className="flex flex-wrap gap-2">
            <FilterPresetLink active={selectedRange.key === "default"} href="/sales" label="Latest" />
            <FilterPresetLink active={selectedRange.key === "today"} href="/sales?range=today" label="Today" />
            <FilterPresetLink active={selectedRange.key === "yesterday"} href="/sales?range=yesterday" label="Yesterday" />
            <FilterPresetLink active={selectedRange.key === "this_week"} href="/sales?range=this_week" label="This week" />
            <FilterPresetLink active={selectedRange.key === "this_month"} href="/sales?range=this_month" label="This month" />
            <FilterPresetLink active={selectedRange.key === "last_month"} href="/sales?range=last_month" label="Last month" />
            <FilterPresetLink active={selectedRange.key === "this_year"} href="/sales?range=this_year" label="This year" />
            <FilterPresetLink active={selectedRange.key === "all_time"} href="/sales?range=all_time" label="All time" />
          </div>

          <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr_1fr_1.25fr]">
            <form className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Month</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="range" value="month" />
                <input name="month" type="month" defaultValue={selectedRange.monthValue} className="field-input h-10 min-w-0 flex-1" />
                <button className="btn-secondary h-10 shrink-0 px-4">Apply</button>
              </div>
            </form>

            <form className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Year</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="range" value="year" />
                <input name="year" type="number" min="2000" max="2100" defaultValue={selectedRange.yearValue} className="field-input h-10 min-w-0 flex-1" />
                <button className="btn-secondary h-10 shrink-0 px-4">Apply</button>
              </div>
            </form>

            <form className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Single day</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="range" value="date" />
                <input name="date" type="date" defaultValue={selectedRange.dateValue} className="field-input h-10 min-w-0 flex-1" />
                <button className="btn-secondary h-10 shrink-0 px-4">Apply</button>
              </div>
            </form>

            <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3" open={selectedRange.key === "custom"}>
              <summary className="cursor-pointer text-sm font-semibold text-slate-900">Custom date</summary>
              <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input type="hidden" name="range" value="custom" />
                <input name="date_from" type="date" defaultValue={selectedRange.dateFromValue} className="field-input h-10 min-w-0" />
                <input name="date_to" type="date" defaultValue={selectedRange.dateToValue} className="field-input h-10 min-w-0" />
                <button className="btn-secondary h-10 shrink-0 px-4">Apply</button>
              </form>
            </details>
          </div>
        </section>

        {summaryLoadFailed ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            Sales summary could not load. Please contact admin if this keeps happening.
          </div>
        ) : null}

        {hasProfitWarning ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Profit is estimated because some sales are missing cost or still rely on current product cost fallback.
          </div>
        ) : null}

        {!hasSalesRows ? (
          <EmptyState
            title="No sales found for this range."
            body="Change the date filter or import finalized Order Details files for the missing business dates."
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Revenue" value={<MetricValue>{lyd(summary.revenueAmount)}</MetricValue>} />
              {canViewProfit ? (
                <MetricCard
                  label="Gross Profit"
                  value={<MetricValue>{summary.grossProfitAmount === null ? "Not available" : lyd(summary.grossProfitAmount)}</MetricValue>}
                  helper={summary.grossProfitAmount === null ? "Cost is not available for this range yet." : undefined}
                />
              ) : null}
              {canViewProfit ? (
                <MetricCard
                  label="Gross Margin %"
                  value={<MetricValue>{formatMarginPercent(summary.grossMarginPercent)}</MetricValue>}
                  helper={summary.grossMarginPercent === null ? "Profit is hidden for your role." : undefined}
                />
              ) : null}
              <MetricCard label="Units Sold" value={<MetricValue>{formatInteger(summary.successfulUnitsSold)}</MetricValue>} />

              {canViewProfit ? (
                <MetricCard
                  label="COGS"
                  value={<MetricValue>{summary.cogsAmount === null ? "Not available" : lyd(summary.cogsAmount)}</MetricValue>}
                  helper={summary.cogsAmount === null ? "Cost is not available for this range yet." : undefined}
                />
              ) : null}
              <MetricCard label="Average Transaction" value={<MetricValue>{lyd(summary.averageTransaction)}</MetricValue>} />
              <MetricCard label="Failed Vend Amount" value={<MetricValue>{lyd(summary.failedVendAmount)}</MetricValue>} />
              <MetricCard label="Refund Amount" value={<MetricValue>{lyd(summary.refundAmount)}</MetricValue>} />

              {canViewProfit ? (
                <MetricCard
                  label="Missing Cost Revenue"
                  tone={summary.missingCostRevenueAmount > 0 ? "warn" : "default"}
                  value={<MetricValue>{lyd(summary.missingCostRevenueAmount)}</MetricValue>}
                  helper="Revenue still counts even when product cost is missing."
                />
              ) : null}
              {canViewProfit ? (
                <MetricCard
                  label="Missing Cost Items"
                  tone={summary.missingCostSalesCount > 0 ? "warn" : "default"}
                  value={<MetricValue>{formatInteger(summary.missingCostSalesCount)}</MetricValue>}
                  helper="Includes unmapped products that cannot resolve a Snacky cost."
                />
              ) : null}
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <KpiSection title={trendTitle} subtitle={trendSubtitle}>
                {trendUsesDaily ? (
                  dayBreakdownResult.error ? (
                    <SectionInlineMessage title="Sales by day could not load." body="Please contact admin if this keeps happening." />
                  ) : trendRows.length ? (
                    <BarList rows={chronologicalBarRows(trendRows)} valueFormatter={lyd} />
                  ) : (
                    <SectionInlineMessage title="No daily sales found." body="There are no daily sales rows for the selected business dates." />
                  )
                ) : monthBreakdownResult.error ? (
                  <SectionInlineMessage title="Sales by month could not load." body="Please contact admin if this keeps happening." />
                ) : trendRows.length ? (
                  <BarList rows={chronologicalBarRows(trendRows)} valueFormatter={lyd} />
                ) : (
                  <SectionInlineMessage title="No monthly sales found." body="There are no monthly sales rows for the selected business dates." />
                )}
              </KpiSection>

              <KpiSection title="Sales by machine" subtitle="Top machines ranked by revenue.">
                {machineBreakdownResult.error ? (
                  <SectionInlineMessage title="Sales by machine could not load." body="Please contact admin if this keeps happening." />
                ) : machineBreakdownRows.length ? (
                  <BarList rows={valueRankedBarRows(machineBreakdownRows).slice(0, 10)} valueFormatter={lyd} />
                ) : (
                  <SectionInlineMessage title="No machine sales found." body="There are no machine sales rows for the selected business dates." />
                )}
              </KpiSection>

              <KpiSection title="Sales by location" subtitle="Top locations ranked by revenue.">
                {locationBreakdownResult.error ? (
                  <SectionInlineMessage title="Sales by location could not load." body="Please contact admin if this keeps happening." />
                ) : locationBreakdownRows.length ? (
                  <BarList rows={valueRankedBarRows(locationBreakdownRows).slice(0, 10)} valueFormatter={lyd} />
                ) : (
                  <SectionInlineMessage title="No location sales found." body="There are no location sales rows for the selected business dates." />
                )}
              </KpiSection>

              <KpiSection title="Sales mix" subtitle={paymentMethodText}>
                {summary.paymentMethodAvailable ? (
                  <BarList
                    rows={[
                      { label: "Cash", value: summary.cashPaymentAmount, detail: `${formatInteger(summary.cashPaymentCount)} sales` },
                      { label: "Card", value: summary.cardPaymentAmount, detail: `${formatInteger(summary.cardPaymentCount)} sales` },
                      { label: "Unknown", value: summary.unknownPaymentAmount, detail: `${formatInteger(summary.unknownPaymentCount)} sales` },
                    ]}
                    valueFormatter={lyd}
                  />
                ) : (
                  <SectionInlineMessage title="Payment method split not available." body="Snacky OS can still show revenue totals for this date range." />
                )}
              </KpiSection>
            </div>

            <KpiSection title="Sales by product" subtitle="Top products ranked by revenue.">
              {productBreakdownResult.error ? (
                <SectionInlineMessage title="Sales by product could not load." body="Please contact admin if this keeps happening." />
              ) : topProductSalesRows.length ? (
                <DataTable headers={["Product", "Units sold", "Revenue"]}>
                  {topProductSalesRows.map((row) => (
                    <tr key={row.bucketLabel}>
                      <td className="font-medium">{row.bucketLabel}</td>
                      <td>{formatInteger(row.unitsSold)}</td>
                      <td>{lyd(row.successfulSalesAmount)}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <SectionInlineMessage title="No product sales found." body="There are no product sales rows for the selected business dates." />
              )}
            </KpiSection>

            {canViewProfit ? (
              <KpiSection title="Product profit" subtitle="Revenue remains unchanged. Profit uses historical cost when available, then current product cost fallback.">
                {productProfitResult.error ? (
                  <SectionInlineMessage title="Product profit could not load." body="Please contact admin if this keeps happening." />
                ) : productProfitRows.length ? (
                  <DataTable headers={["Product", "Units sold", "Revenue", "Cost", "Gross profit", "Margin %", "Cost status"]}>
                    {productProfitRows.slice(0, 20).map((row) => (
                      <tr key={row.bucketKey}>
                        <td className="font-medium">{row.bucketLabel}</td>
                        <td>{formatInteger(row.unitsSold)}</td>
                        <td>{lyd(row.revenueAmount)}</td>
                        <td>{lyd(row.cogsAmount)}</td>
                        <td>{lyd(row.grossProfitAmount)}</td>
                        <td>{formatMarginPercent(row.grossMarginPercent)}</td>
                        <td><StatusBadge status={compactStatusLabel(row.costStatus)} /></td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <SectionInlineMessage title="No product profit rows found." body="Profit appears after detailed sales and product cost data are available." />
                )}
              </KpiSection>
            ) : null}

            {canViewProfit ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <KpiSection title="Profit by machine" subtitle="Top machines ranked by gross profit.">
                  {machineProfitResult.error ? (
                    <SectionInlineMessage title="Machine profit could not load." body="Please contact admin if this keeps happening." />
                  ) : machineProfitRows.length ? (
                    <DataTable headers={["Machine", "Revenue", "Cost", "Gross profit", "Margin %", "Units sold"]}>
                      {machineProfitRows.slice(0, 12).map((row) => (
                        <tr key={row.bucketKey}>
                          <td className="font-medium">{row.bucketLabel}</td>
                          <td>{lyd(row.revenueAmount)}</td>
                          <td>{lyd(row.cogsAmount)}</td>
                          <td>{lyd(row.grossProfitAmount)}</td>
                          <td>{formatMarginPercent(row.grossMarginPercent)}</td>
                          <td>{formatInteger(row.unitsSold)}</td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <SectionInlineMessage title="No machine profit rows found." body="Profit appears after detailed sales and product cost data are available." />
                  )}
                </KpiSection>

                <KpiSection title="Profit by location" subtitle="Top locations ranked by gross profit.">
                  {locationProfitResult.error ? (
                    <SectionInlineMessage title="Location profit could not load." body="Please contact admin if this keeps happening." />
                  ) : locationProfitRows.length ? (
                    <DataTable headers={["Location", "Revenue", "Cost", "Gross profit", "Margin %", "Units sold"]}>
                      {locationProfitRows.slice(0, 12).map((row) => (
                        <tr key={row.bucketKey}>
                          <td className="font-medium">{row.bucketLabel}</td>
                          <td>{lyd(row.revenueAmount)}</td>
                          <td>{lyd(row.cogsAmount)}</td>
                          <td>{lyd(row.grossProfitAmount)}</td>
                          <td>{formatMarginPercent(row.grossMarginPercent)}</td>
                          <td>{formatInteger(row.unitsSold)}</td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <SectionInlineMessage title="No location profit rows found." body="Profit appears after detailed sales and product cost data are available." />
                  )}
                </KpiSection>
              </div>
            ) : null}
          </>
        )}

        <details id="data-sources" className="surface-card">
          <summary className="cursor-pointer text-base font-semibold text-slate-900">Data sources and coverage</summary>
          <div className="mt-4 space-y-4">
            {sourceLoadFailed ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
                Data source details could not load completely. Please contact admin if this keeps happening.
              </div>
            ) : null}

            <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <div className="font-semibold text-slate-900">Selected range</div>
                <div>{selectedRangeLabel}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Files contributing</div>
                <div>{formatInteger(contributingFiles.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Ignored files</div>
                <div>{formatInteger(ignoredFiles.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Last updated</div>
                <div>{formatVmsDateTime(lastUpdatedAt)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Detailed files uploaded</div>
                <div>{formatInteger(detailedFiles.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Latest included date</div>
                <div>{selectedRange.end}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Coverage gaps</div>
                <div>{formatInteger(missingPeriods.length)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Payment method split</div>
                <div>{summary.paymentMethodAvailable ? "Available" : "Unavailable"}</div>
              </div>
            </div>

            {overlappingSummaryFiles.length ? (
              <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
                {formatInteger(overlappingSummaryFiles.length)} summary sales file(s) overlap this period, but Snacky sales totals still come from detailed Order Details files only.
              </div>
            ) : null}

            {missingPeriods.length ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                {missingPeriods.map((gap) => (
                  <p key={`${gap.start}-${gap.end}`}>
                    Missing detailed sales data from {gap.start} to {gap.end}.
                  </p>
                ))}
              </div>
            ) : null}

            {fileContributions.length ? (
              <DataTable headers={["File", "Uploaded", "Coverage", "Rows in range", "Revenue", "Status", "Used now"]}>
                {fileContributions.map((row) => (
                  <tr key={row.batch.id}>
                    <td className="max-w-xs">
                      <div className="font-medium text-slate-900">
                        <Link href={`/vms-import/${row.batch.id}`} className="hover:text-slate-700">
                          {row.fileName}
                        </Link>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{businessContributionReason(row)}</div>
                    </td>
                    <td className="text-sm">{formatVmsDateTime(row.uploadedAt)}</td>
                    <td className="text-sm">
                      <div>{row.actualCoverageLabel}</div>
                      {row.metadataCoverageLabel !== "-" && row.metadataCoverageLabel !== row.actualCoverageLabel ? (
                        <div className="mt-1 text-xs text-slate-500">Expected: {row.metadataCoverageLabel}</div>
                      ) : null}
                    </td>
                    <td>{formatInteger(row.successfulRowsInRange)}</td>
                    <td>{lyd(row.salesAmountInRange)}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td>{row.included ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <p className="text-sm text-slate-500">No VMS import batches are available yet.</p>
            )}
          </div>
        </details>
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
          subtitle="Sales are calculated from imported VMS Order Details for the selected business dates."
        />
        <EmptyState title="Something did not load" body="Snacky OS recovered from a sales dashboard load error. Please retry, and contact admin if the issue keeps happening." />
      </>
    );
  }
}
