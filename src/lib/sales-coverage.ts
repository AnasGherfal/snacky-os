import { batchCoverageDates, rangesOverlap, type SalesDashboardSourceMode, type SalesFileContribution } from "./sales-dashboard.ts";
import { type VmsDashboardBatch } from "./vms-dashboard-source.ts";

export type SalesMonthlyCoverageRow = {
  active_finalized_batch_count?: number | string | null;
  batch_count?: number | string | null;
  business_month?: string | null;
  finalized_batch_count?: number | string | null;
  finalized_rows?: number | string | null;
  finalized_successful_sale_amount?: number | string | null;
  finalized_successful_sale_rows?: number | string | null;
  max_business_date?: string | null;
  min_business_date?: string | null;
  null_business_date_rows?: number | string | null;
  successful_sale_amount?: number | string | null;
  successful_sale_rows?: number | string | null;
  total_rows?: number | string | null;
};

export type NormalizedSalesMonthlyCoverageRow = {
  activeFinalizedBatchCount: number;
  batchCount: number;
  businessMonth: string | null;
  finalizedBatchCount: number;
  finalizedRows: number;
  finalizedSuccessfulSaleAmount: number;
  finalizedSuccessfulSaleRows: number;
  maxBusinessDate: string | null;
  minBusinessDate: string | null;
  nullBusinessDateRows: number;
  successfulSaleAmount: number;
  successfulSaleRows: number;
  totalRows: number;
};

function numericValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function parseMonthValue(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${padDatePart(month)}`;
}

function parseIsoDate(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day);
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null;
  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function formatLocalDate(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function normalizeSalesCoverageRows(rows: SalesMonthlyCoverageRow[]) {
  return rows.map((row) => ({
    activeFinalizedBatchCount: numericValue(row.active_finalized_batch_count),
    batchCount: numericValue(row.batch_count),
    businessMonth: row.business_month ?? null,
    finalizedBatchCount: numericValue(row.finalized_batch_count),
    finalizedRows: numericValue(row.finalized_rows),
    finalizedSuccessfulSaleAmount: numericValue(row.finalized_successful_sale_amount),
    finalizedSuccessfulSaleRows: numericValue(row.finalized_successful_sale_rows),
    maxBusinessDate: row.max_business_date ?? null,
    minBusinessDate: row.min_business_date ?? null,
    nullBusinessDateRows: numericValue(row.null_business_date_rows),
    successfulSaleAmount: numericValue(row.successful_sale_amount),
    successfulSaleRows: numericValue(row.successful_sale_rows),
    totalRows: numericValue(row.total_rows),
  } satisfies NormalizedSalesMonthlyCoverageRow));
}

export function summarizeSalesCoverage(rows: NormalizedSalesMonthlyCoverageRow[]) {
  const finalizedRows = rows.filter((row) => row.businessMonth && row.finalizedSuccessfulSaleRows > 0);
  const earliestBusinessDate = finalizedRows
    .map((row) => row.minBusinessDate)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;
  const latestBusinessDate = finalizedRows
    .map((row) => row.maxBusinessDate)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const monthsWithFinalizedData = finalizedRows.map((row) => formatCoverageMonthLabel(row.businessMonth));
  const nullBusinessDateRows = rows.reduce((sum, row) => sum + row.nullBusinessDateRows, 0);

  return {
    earliestBusinessDate,
    latestBusinessDate,
    monthsWithFinalizedData,
    monthsWithFinalizedDataLabel: monthsWithFinalizedData.length ? monthsWithFinalizedData.join(", ") : "No finalized months yet",
    nullBusinessDateRows,
  };
}

export function formatCoverageMonthLabel(value: string | null | undefined) {
  if (!value) return "Missing business date";
  const parsed = parseMonthValue(value) ?? parseIsoDate(value);
  if (!parsed) return String(value);
  const [year, month] = parsed.slice(0, 7).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

export function monthBounds(monthValue: string) {
  const parsed = parseMonthValue(monthValue);
  if (!parsed) return { end: "", start: "" };
  const [year, month] = parsed.split("-").map(Number);
  const start = `${year}-${padDatePart(month)}-01`;
  const end = formatLocalDate(new Date(year, month, 0));
  return { end, start };
}

export function enumerateMonthDays(monthValue: string) {
  const bounds = monthBounds(monthValue);
  if (!bounds.start || !bounds.end) return [];
  const days: string[] = [];
  for (let current = new Date(`${bounds.start}T00:00:00`); formatLocalDate(current) <= bounds.end; current = addDays(current, 1)) {
    days.push(formatLocalDate(current));
  }
  return days;
}

export function monthValuesForYear(year: number) {
  return Array.from({ length: 12 }, (_, index) => `${year}-${padDatePart(index + 1)}`);
}

export type SalesCoverageStateKind =
  | "summary_error"
  | "no_source"
  | "inactive_batch"
  | "deleted_batch"
  | "failed_import"
  | "missing_business_date"
  | "status_filtered"
  | "no_rows"
  | "partial"
  | "ready";

export type SalesCoverageState = {
  body: string;
  kind: SalesCoverageStateKind;
  label: string;
  title: string;
};

function coverageState(kind: SalesCoverageStateKind, label: string, title: string, body: string): SalesCoverageState {
  return { body, kind, label, title };
}

function sourceLabelForMode(sourceMode: SalesDashboardSourceMode, sourceReportType?: string | null) {
  if (sourceMode === "monthly") return "Monthly Profit Report";
  if (sourceReportType === "monthly_transaction_details") return "Monthly Transaction Report";
  return "Detailed Order Details";
}

export function salesDashboardSourceLabel(sourceMode: SalesDashboardSourceMode, sourceReportType?: string | null) {
  return sourceLabelForMode(sourceMode, sourceReportType);
}

export function describeSalesDashboardNoDataState({
  canFinalizeInactiveFiles,
  contributingFiles,
  coverageLabel,
  fileContributions,
  monthlyCoverageRows,
  sourceReportType,
  sourceMode,
  selectedRange,
}: {
  canFinalizeInactiveFiles: boolean;
  contributingFiles: SalesFileContribution[];
  coverageLabel: string;
  fileContributions: SalesFileContribution[];
  monthlyCoverageRows: NormalizedSalesMonthlyCoverageRow[];
  sourceReportType?: string | null;
  sourceMode: SalesDashboardSourceMode;
  selectedRange: { end: string; start: string };
}): SalesCoverageState {
  const rangeBounds = { start: selectedRange.start, end: selectedRange.end };
  const effectiveSourceReportType = sourceMode === "monthly" ? "monthly_product_profit" : sourceReportType ?? "vms_order_details_weekly";
  const sourceRowsInRange = fileContributions.filter((row) => {
    if (row.batch.report_type !== effectiveSourceReportType) return false;
    if (row.rowsInRange > 0 || row.successfulRowsInRange > 0) return true;
    return Boolean(
      row.actualCoverageStart
      && row.actualCoverageEnd
      && rangesOverlap({ start: row.actualCoverageStart, end: row.actualCoverageEnd }, rangeBounds),
    );
  });
  const sourceLabel = sourceLabelForMode(sourceMode, sourceReportType);

  if (contributingFiles.some((row) => row.included)) {
    return coverageState(
      "summary_error",
      "Needs attention",
      sourceLabel + " rows exist, but the dashboard summary could not calculate them.",
      sourceMode === "monthly"
        ? "Monthly profit rows overlap this range, but the dashboard totals came back empty. Check the monthly summary RPC and data source diagnostics."
        : "Detailed successful-sale rows overlap this range, but the dashboard totals came back empty. Check the summary RPC and data source diagnostics.",
    );
  }

  if (sourceRowsInRange.some((row) => row.batch.deleted_at || String(row.batch.status ?? "") === "deleted")) {
    return coverageState(
      "deleted_batch",
      "Deleted",
      "This date range has a deleted import file.",
      "Restore it or import as a new active file.",
    );
  }

  if (sourceRowsInRange.some((row) => String(row.status ?? "") === "failed_import" || String(row.status ?? "") === "missing_required_columns" || String(row.batch.status ?? "") === "failed")) {
    return coverageState(
      "failed_import",
      "Failed",
      "An import exists for this range, but it failed.",
      "Reprocess or repair it.",
    );
  }

  if (sourceRowsInRange.some((row) => row.status === "preview_only" || row.status === "inactive_batch")) {
    return coverageState(
      "inactive_batch",
      "Inactive",
      "Sales rows exist, but the file is not active yet.",
      canFinalizeInactiveFiles
        ? "Finalize or activate the file before it can feed the dashboard."
        : "The sales file for this date range is still being finalized.",
    );
  }

  if (sourceRowsInRange.some((row) => row.status === "missing_transaction_datetime") || monthlyCoverageRows.some((row) => row.businessMonth === null && row.finalizedRows > 0 && row.nullBusinessDateRows > 0)) {
    return coverageState(
      "missing_business_date",
      "Missing dates",
      "Rows exist but business dates are missing.",
      sourceMode === "monthly"
        ? "Some monthly profit rows still do not have a resolved business date. Rebuild the import dates, then reload the dashboard."
        : "Some Order Details rows still do not have a resolved business date. Rebuild business dates, then reload the dashboard.",
    );
  }

  if (sourceRowsInRange.some((row) => row.status === "rows_excluded_by_status")) {
    return coverageState(
      "status_filtered",
      "Partial",
      "Rows exist for this range, but they were not successful sales.",
      sourceMode === "monthly"
        ? "The overlapping monthly rows were saved, but they were not counted in the dashboard totals."
        : "The overlapping Order Details rows were saved, but they were classified as failed vends, refunds, failed payments, or needs review.",
    );
  }

  if (sourceRowsInRange.length === 0) {
    return coverageState(
      "no_source",
      "No source",
      "No VMS sales file uploaded for this range.",
      sourceMode === "monthly"
        ? "Import a monthly profit report file to populate this range."
        : "Import a detailed Order Details file to populate this range.",
    );
  }

  return coverageState(
    "no_rows",
    "Missing",
    sourceMode === "monthly"
      ? "No monthly profit rows found for this range."
      : "No detailed Order Details rows found for this range.",
    coverageLabel === "-"
      ? sourceMode === "monthly"
        ? "Change the date filter or import the matching monthly profit report first."
        : "Change the date filter or import the matching detailed Order Details file first."
      : "Change the date filter. Current finalized coverage runs from " + coverageLabel + ".",
  );
}

export function describeSalesCoverageState({
  activeBatches,
  coverageError,
  coveredDays,
  monthDays,
  monthLabel,
  sourceBatches,
  sourceLabel,
}: {
  activeBatches: Array<{ deleted_at?: string | null; is_active?: boolean | null; status?: string | null }>; 
  coverageError: string | null;
  coveredDays: Set<string>;
  monthDays: string[];
  monthLabel: string;
  sourceBatches: Array<{ deleted_at?: string | null; is_active?: boolean | null; status?: string | null }>; 
  sourceLabel: string;
}): SalesCoverageState {
  if (coverageError) {
    return coverageState(
      "summary_error",
      "Needs attention",
      "Coverage totals could not load for this view.",
      "Please contact admin if this keeps happening.",
    );
  }

  if (!sourceBatches.length) {
    return coverageState(
      "no_source",
      "No source",
      "No VMS sales file uploaded for this range.",
      "Import a " + sourceLabel.toLowerCase() + " file to start coverage tracking.",
    );
  }

  if (sourceBatches.some((batch) => batch.deleted_at || String(batch.status ?? "") === "deleted")) {
    return coverageState(
      "deleted_batch",
      "Deleted",
      "This date range has a deleted import file.",
      "Restore it or import as a new active file.",
    );
  }

  if (sourceBatches.some((batch) => String(batch.status ?? "") === "failed")) {
    return coverageState(
      "failed_import",
      "Failed",
      "An import exists for this range, but it failed.",
      "Reprocess or repair it.",
    );
  }

  if (!activeBatches.length) {
    return coverageState(
      "inactive_batch",
      "Inactive",
      "Sales rows exist, but the file is not active yet.",
      "Activate the file before it can feed coverage.",
    );
  }

  if (!coveredDays.size) {
    return coverageState(
      "no_rows",
      "Missing",
      "Active files exist, but none overlap " + monthLabel + ".",
      "Import or activate the missing " + sourceLabel.toLowerCase() + " rows to complete coverage.",
    );
  }

  if (coveredDays.size < monthDays.length) {
    return coverageState(
      "partial",
      "Partial",
      "Some days are still missing from " + monthLabel + ".",
      "Import or activate the missing " + sourceLabel.toLowerCase() + " rows to complete coverage.",
    );
  }

  return coverageState(
    "ready",
    "Ready",
    monthLabel + " is fully covered by active files.",
    "Snacky OS can use the active " + sourceLabel.toLowerCase() + " rows for this period.",
  );
}
export function monthCoverageCoveredDays(
  monthValue: string,
  batches: VmsDashboardBatch[],
  predicate: (batch: VmsDashboardBatch) => boolean,
) {
  const days = new Set<string>();
  const bounds = monthBounds(monthValue);
  if (!bounds.start || !bounds.end) return days;

  for (const batch of batches.filter(predicate)) {
    const coverage = batchCoverageDates(batch);
    if (!coverage.start || !coverage.end) continue;
    const from = coverage.start > bounds.start ? coverage.start : bounds.start;
    const to = coverage.end < bounds.end ? coverage.end : bounds.end;
    if (!rangesOverlap({ start: from, end: to }, bounds)) continue;

    for (const day of enumerateMonthDays(monthValue)) {
      if (day >= from && day <= to) days.add(day);
    }
  }

  return days;
}



