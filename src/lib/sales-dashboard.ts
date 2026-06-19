import {
  batchImportedRows,
  batchLastUpdatedAt,
  isActiveImportedVmsBatch,
  sourceFileName,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";
import {
  createVmsOrderDetailsDuplicateHash,
  orderDetailsAliases,
  orderDetailsBusinessDate,
  orderDetailsPaymentAmount,
  orderDetailsTransactionStatus,
  orderDetailsValue,
} from "@/lib/vms-order-details";

export type SalesDashboardSearchParams = {
  range?: string;
  month?: string;
  year?: string;
  date?: string;
  date_from?: string;
  date_to?: string;
};

export type SalesDateRangeKey =
  | "default"
  | "today"
  | "yesterday"
  | "this_week"
  | "this_month"
  | "last_month"
  | "this_year"
  | "month"
  | "year"
  | "all_time"
  | "date"
  | "custom";

export type SalesDateRange = {
  key: SalesDateRangeKey;
  label: string;
  helperText: string;
  start: string;
  end: string;
  monthValue: string;
  yearValue: string;
  dateValue: string;
  dateFromValue: string;
  dateToValue: string;
};

export type SalesBatchReconciliation = {
  batchId: string;
  sourceFileName: string;
  batchStatus: string | null;
  isActive: boolean | null;
  deletedAt: string | null;
  uploadedAt: string | null;
  importedAt: string | null;
  metadataReportStartDate: string | null;
  metadataReportEndDate: string | null;
  metadataDetectedMinDateTime: string | null;
  metadataDetectedMaxDateTime: string | null;
  metadataImportedRowsTotal: number;
  metadataRowsFoundTotal: number;
  metadataDuplicateRowsTotal: number;
  rawRowCountTotal: number;
  rawSuccessfulRowsTotal: number;
  rawFailedVendRowsTotal: number;
  rawRefundedRowsTotal: number;
  rawFailedPaymentRowsTotal: number;
  rawNeedsReviewRowsTotal: number;
  rawMissingDatetimeRowsTotal: number;
  rawMissingAmountRowsTotal: number;
  rawSuccessfulSalesAmountTotal: number;
  rawFailedVendAmountTotal: number;
  rawRefundedAmountTotal: number;
  rawUnitsSoldTotal: number;
  rawMinTransactionAt: string | null;
  rawMaxTransactionAt: string | null;
  rawMinSaleDate: string | null;
  rawMaxSaleDate: string | null;
  rangeRowCount: number;
  rangeSuccessfulRows: number;
  rangeFailedVendRows: number;
  rangeRefundedRows: number;
  rangeFailedPaymentRows: number;
  rangeNeedsReviewRows: number;
  rangeSuccessfulSalesAmount: number;
  rangeFailedVendAmount: number;
  rangeRefundedAmount: number;
  rangeUnitsSold: number;
  rangeTransactionCount: number;
  rangeMinTransactionAt: string | null;
  rangeMaxTransactionAt: string | null;
};

export type SalesFileContribution = {
  batch: VmsDashboardBatch;
  actualCoverageEnd: string | null;
  actualCoverageLabel: string;
  actualCoverageStart: string | null;
  fileName: string;
  importedRowsTotal: number;
  included: boolean;
  isActive: boolean;
  latestTransactionAt: string | null;
  metadataCoverageLabel: string;
  reason: string;
  rowsInRange: number;
  salesAmountInRange: number;
  status: string;
  successfulRowsInRange: number;
  timestampCoverageEnd: string | null;
  timestampCoverageStart: string | null;
  uploadedAt: string | null;
};

export type SalesReconciliationStatusGroup = {
  amount: number;
  count: number;
  normalizedStatus: string;
  rawRefundStatus: string;
  rawShippingStatus: string;
};

export type SalesReconciliationExcludedRow = {
  batchId: string;
  batchStatus: string | null;
  businessDate: string | null;
  exclusionReason: string;
  machineLabel: string;
  machineMatchStatus: string | null;
  orderId: string | null;
  parsedAmount: number;
  productLabel: string;
  productMatchStatus: string | null;
  rawAmount: string | null;
  rawDateTime: string | null;
  rawRefundStatus: string | null;
  rawShippingStatus: string | null;
  rowNumber: number;
  slot: string | null;
  sourceFileName: string;
  validationErrors: string[];
  validationStatus: string | null;
};

export type SalesRangeReconciliationDiagnostics = {
  dashboardSuccessfulAmount: number;
  dashboardSuccessfulCount: number;
  excludedSuccessfulAmount: number;
  excludedSuccessfulCount: number;
  excludedSuccessfulRows: SalesReconciliationExcludedRow[];
  importedSuccessfulAmount: number;
  importedSuccessfulCount: number;
  parsedMissingBusinessDateCount: number;
  parsedMissingMachineCount: number;
  parsedMissingProductCount: number;
  parsedSuccessfulAmount: number;
  parsedSuccessfulCount: number;
  parsedSuccessfulDuplicateRows: number;
  statusFilteredRows: SalesReconciliationExcludedRow[];
  statusGroups: SalesReconciliationStatusGroup[];
};

export type SalesDashboardBreakdownDimension = "day" | "month" | "hour" | "machine" | "location" | "product";

export type SalesDashboardBreakdownRow = {
  bucket_key?: string | null;
  bucket_label?: string | null;
  sort_key?: string | null;
  successful_sales_amount?: number | string | null;
  successful_sales_count?: number | string | null;
  units_sold?: number | string | null;
  rows_used?: number | string | null;
};

export type NormalizedSalesDashboardBreakdownRow = {
  bucketKey: string;
  bucketLabel: string;
  sortKey: string;
  successfulSalesAmount: number;
  successfulSalesCount: number;
  unitsSold: number;
  rowsUsed: number;
};

export function normalizeSalesBreakdownRows(rows: SalesDashboardBreakdownRow[]) {
  return rows.map((row) => ({
    bucketKey: String(row.bucket_key ?? ""),
    bucketLabel: String(row.bucket_label ?? row.bucket_key ?? "Unknown"),
    sortKey: String(row.sort_key ?? row.bucket_key ?? row.bucket_label ?? ""),
    successfulSalesAmount: numericValue(row.successful_sales_amount),
    successfulSalesCount: numericValue(row.successful_sales_count),
    unitsSold: numericValue(row.units_sold),
    rowsUsed: numericValue(row.rows_used),
  }));
}

type DateRangeBounds = {
  end: string;
  start: string;
};

function isValidDatePart(year: number, month: number, day: number) {
  const candidate = new Date(year, month - 1, day);
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatLocalDate(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function parseIsoDate(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidDatePart(year, month, day) ? `${year}-${padDatePart(month)}-${padDatePart(day)}` : null;
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

function parseYearValue(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? String(year) : null;
}

function dateFromParts(year: number, month: number, day: number) {
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date: Date) {
  const dayIndex = date.getDay();
  const daysSinceMonday = (dayIndex + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfYear(date: Date) {
  return new Date(date.getFullYear(), 0, 1);
}

function endOfYear(date: Date) {
  return new Date(date.getFullYear(), 11, 31);
}

function formatMonthValue(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}`;
}

function monthLabel(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function dateOnlyFromTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const text = String(value).trim();
  const direct = parseIsoDate(text.slice(0, 10));
  if (direct) return direct;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : formatLocalDate(parsed);
}

function integerValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function normalizeBounds(start: string, end: string) {
  return start <= end ? { start, end } : { start: end, end: start };
}

function inRange(date: string | null | undefined, range: Pick<SalesDateRange, "start" | "end">) {
  return Boolean(date && date >= range.start && date <= range.end);
}

function jsonRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, entry == null ? "" : String(entry)]),
  );
}

function batchRowKey(batchId: string, rowNumber: number) {
  return `${batchId}:${rowNumber}`;
}

function countableDetailedBatch(batch: VmsDashboardBatch | undefined) {
  if (!batch) return false;
  if (batch.report_type !== "vms_order_details_weekly") return false;
  return isActiveImportedVmsBatch(batch);
}

async function fetchPagedRows<T>({
  filter,
  select,
  supabase,
  table,
}: {
  filter: (query: any) => any;
  select: string;
  supabase: any;
  table: string;
}): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const result = await filter(supabase.from(table).select(select).range(from, from + 999));
    if (result.error) throw result.error;
    if (!result.data?.length) break;
    rows.push(...(result.data as T[]));
    if (result.data.length < 1000) break;
  }
  return rows;
}

function rangeWithDefaults({
  end,
  helperText,
  key,
  label,
  start,
}: {
  end: string;
  helperText: string;
  key: SalesDateRangeKey;
  label: string;
  start: string;
}): SalesDateRange {
  const normalized = normalizeBounds(start, end);
  return {
    key,
    label,
    helperText,
    start: normalized.start,
    end: normalized.end,
    monthValue: normalized.start.slice(0, 7),
    yearValue: normalized.start.slice(0, 4),
    dateValue: normalized.start === normalized.end ? normalized.start : normalized.end,
    dateFromValue: normalized.start,
    dateToValue: normalized.end,
  };
}

function activeDetailedSalesBatches(batches: VmsDashboardBatch[]) {
  return batches.filter((batch) => batch.report_type === "vms_order_details_weekly" && isActiveImportedVmsBatch(batch));
}

function coverageLabel(start: string | null | undefined, end: string | null | undefined) {
  return start && end ? `${start} to ${end}` : "-";
}

export function batchCoverageDates(batch: VmsDashboardBatch) {
  const reportStart = parseIsoDate(batch.report_start_date);
  const reportEnd = parseIsoDate(batch.report_end_date);
  const detectedStart = dateOnlyFromTimestamp(batch.detected_min_datetime);
  const detectedEnd = dateOnlyFromTimestamp(batch.detected_max_datetime);
  const start = reportStart ?? detectedStart ?? reportEnd ?? detectedEnd;
  const end = reportEnd ?? detectedEnd ?? reportStart ?? detectedStart;

  return start && end ? normalizeBounds(start, end) : { start, end };
}

function reconciliationCoverageDates(reconciliation: SalesBatchReconciliation | null | undefined) {
  const start = parseIsoDate(reconciliation?.rawMinSaleDate);
  const end = parseIsoDate(reconciliation?.rawMaxSaleDate);
  return start && end ? normalizeBounds(start, end) : { start, end };
}

function rangeSortKey(batch: VmsDashboardBatch) {
  const coverage = batchCoverageDates(batch);
  return `${coverage.end ?? ""}|${coverage.start ?? ""}|${batchLastUpdatedAt(batch) ?? ""}`;
}

export function rangesOverlap(left: DateRangeBounds, right: DateRangeBounds) {
  return left.start <= right.end && right.start <= left.end;
}

export function formatSalesRangeLabel(range: Pick<SalesDateRange, "start" | "end">) {
  return `${range.start} to ${range.end}`;
}

export function salesBatchReconciliationById(rows: SalesBatchReconciliation[]) {
  return new Map(rows.map((row) => [row.batchId, row]));
}

export function applySalesBatchCoverage(
  batches: VmsDashboardBatch[],
  reconciliationByBatchId: Map<string, SalesBatchReconciliation>,
) {
  return batches.map((batch) => {
    if (batch.report_type !== "vms_order_details_weekly") return batch;
    const reconciliation = reconciliationByBatchId.get(batch.id);
    if (!reconciliation) return batch;
    return {
      ...batch,
      report_start_date: reconciliation.rawMinSaleDate,
      report_end_date: reconciliation.rawMaxSaleDate,
      detected_min_datetime: reconciliation.rawMinTransactionAt,
      detected_max_datetime: reconciliation.rawMaxTransactionAt,
      row_count: reconciliation.rawRowCountTotal,
      rows_found: reconciliation.rawRowCountTotal,
      rows_imported: reconciliation.rawRowCountTotal,
      successful_rows_count: reconciliation.rawSuccessfulRowsTotal,
      failed_rows_count: reconciliation.rawFailedVendRowsTotal + reconciliation.rawFailedPaymentRowsTotal + reconciliation.rawNeedsReviewRowsTotal,
      refunded_rows_count: reconciliation.rawRefundedRowsTotal,
    } satisfies VmsDashboardBatch;
  });
}

function latestCurrentMonthCoverage(batches: VmsDashboardBatch[], monthStart: string, monthEnd: string) {
  const overlappingEnds = batches
    .map((batch) => batchCoverageDates(batch))
    .filter((coverage) => coverage.start && coverage.end)
    .filter((coverage) => rangesOverlap({ start: coverage.start as string, end: coverage.end as string }, { start: monthStart, end: monthEnd }))
    .map((coverage) => coverage.end as string)
    .sort();

  return overlappingEnds.at(-1) ?? null;
}

function defaultSalesRange(batches: VmsDashboardBatch[], now: Date) {
  const activeDetailed = activeDetailedSalesBatches(batches);
  const today = formatLocalDate(now);
  const currentMonthStart = formatLocalDate(startOfMonth(now));
  const currentMonthEnd = formatLocalDate(endOfMonth(now));
  const currentMonthLatestEnd = latestCurrentMonthCoverage(activeDetailed, currentMonthStart, currentMonthEnd);

  if (currentMonthLatestEnd) {
    return rangeWithDefaults({
      key: "default",
      label: "Latest available detailed sales",
      helperText: "Defaulted to the current month because active detailed sales exist for this month.",
      start: currentMonthStart,
      end: currentMonthLatestEnd <= today ? currentMonthLatestEnd : today,
    });
  }

  const latestDetailed = [...activeDetailed].sort((left, right) => rangeSortKey(right).localeCompare(rangeSortKey(left)))[0] ?? null;
  const latestCoverage = latestDetailed ? batchCoverageDates(latestDetailed) : null;
  if (latestCoverage?.start && latestCoverage.end) {
    return rangeWithDefaults({
      key: "default",
      label: "Latest available detailed sales",
      helperText: `Defaulted to the latest active detailed sales coverage from ${sourceFileName(latestDetailed)}.`,
      start: latestCoverage.start,
      end: latestCoverage.end,
    });
  }

  return rangeWithDefaults({
    key: "default",
    label: "Current month",
    helperText: "No active detailed sales files were found, so the dashboard is waiting for imports.",
    start: currentMonthStart,
    end: today,
  });
}

export function resolveSalesDashboardRange(
  params: SalesDashboardSearchParams,
  batches: VmsDashboardBatch[],
  now = new Date(),
) {
  const today = formatLocalDate(now);
  const rawRange = String(params.range ?? "").trim().toLowerCase();
  const monthValue = parseMonthValue(params.month);
  const yearValue = parseYearValue(params.year);
  const singleDate = parseIsoDate(params.date);
  const customStart = parseIsoDate(params.date_from);
  const customEnd = parseIsoDate(params.date_to);

  if (rawRange === "today") {
    return rangeWithDefaults({
      key: "today",
      label: "Today",
      helperText: "Showing detailed sales from today only.",
      start: today,
      end: today,
    });
  }

  if (rawRange === "yesterday") {
    const yesterday = formatLocalDate(addDays(now, -1));
    return rangeWithDefaults({
      key: "yesterday",
      label: "Yesterday",
      helperText: "Showing detailed sales from yesterday only.",
      start: yesterday,
      end: yesterday,
    });
  }

  if (rawRange === "this_week") {
    return rangeWithDefaults({
      key: "this_week",
      label: "This week",
      helperText: "Showing detailed sales from Monday through today.",
      start: formatLocalDate(startOfWeek(now)),
      end: today,
    });
  }

  if (rawRange === "this_month") {
    return rangeWithDefaults({
      key: "this_month",
      label: "This month",
      helperText: "Showing detailed sales from the first day of this month through today.",
      start: formatLocalDate(startOfMonth(now)),
      end: today,
    });
  }

  if (rawRange === "this_year") {
    return rangeWithDefaults({
      key: "this_year",
      label: "This year",
      helperText: "Showing detailed sales from January 1 through today.",
      start: formatLocalDate(startOfYear(now)),
      end: today,
    });
  }

  if (rawRange === "last_month") {
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return rangeWithDefaults({
      key: "last_month",
      label: "Last month",
      helperText: "Showing detailed sales from the previous calendar month.",
      start: formatLocalDate(startOfMonth(previousMonth)),
      end: formatLocalDate(endOfMonth(previousMonth)),
    });
  }

  if (rawRange === "month" && monthValue) {
    const [year, month] = monthValue.split("-").map(Number);
    const monthDate = dateFromParts(year, month, 1);
    return rangeWithDefaults({
      key: "month",
      label: monthLabel(monthValue),
      helperText: `Showing detailed sales for ${monthLabel(monthValue)}.`,
      start: formatLocalDate(startOfMonth(monthDate)),
      end: formatLocalDate(endOfMonth(monthDate)),
    });
  }

  if (rawRange === "year" && yearValue) {
    const year = Number(yearValue);
    return rangeWithDefaults({
      key: "year",
      label: yearValue,
      helperText: `Showing detailed sales for ${yearValue}.`,
      start: `${yearValue}-01-01`,
      end: `${yearValue}-12-31`,
    });
  }

  if (rawRange === "all_time") {
    const coverage = vmsCoverageSummary(activeDetailedSalesBatches(batches));
    const allTimeStart = coverage.start || defaultSalesRange(batches, now).start;
    const allTimeEnd = coverage.end || today;
    return rangeWithDefaults({
      key: "all_time",
      label: "All time",
      helperText: "Showing all active detailed sales currently available in Snacky OS.",
      start: allTimeStart,
      end: allTimeEnd,
    });
  }

  if (rawRange === "date" && singleDate) {
    return rangeWithDefaults({
      key: "date",
      label: singleDate,
      helperText: "Showing detailed sales for one specific day.",
      start: singleDate,
      end: singleDate,
    });
  }

  if ((rawRange === "custom" || customStart || customEnd) && (customStart || customEnd)) {
    const start = customStart ?? customEnd ?? today;
    const end = customEnd ?? customStart ?? today;
    return rangeWithDefaults({
      key: "custom",
      label: "Custom range",
      helperText: "Showing detailed sales for your custom date range.",
      start,
      end,
    });
  }

  return defaultSalesRange(batches, now);
}

function inclusiveDayCount(start: string, end: string) {
  const startDate = dateFromParts(Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10)));
  const endDate = dateFromParts(Number(end.slice(0, 4)), Number(end.slice(5, 7)), Number(end.slice(8, 10)));
  const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  return Math.max(1, diff + 1);
}

function shiftIsoDate(value: string, days: number) {
  const shifted = new Date(dateFromParts(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))));
  shifted.setDate(shifted.getDate() + days);
  return formatLocalDate(shifted);
}

export function buildSalesComparisonRange(range: SalesDateRange) {
  if (range.key === "all_time") return null;

  if (range.key === "month" || range.key === "last_month") {
    const [year, month] = range.start.slice(0, 7).split("-").map(Number);
    const previousMonth = new Date(year, month - 2, 1);
    return rangeWithDefaults({
      key: "month",
      label: monthLabel(formatMonthValue(previousMonth)),
      helperText: "Comparison period: previous calendar month.",
      start: formatLocalDate(startOfMonth(previousMonth)),
      end: formatLocalDate(endOfMonth(previousMonth)),
    });
  }

  if (range.key === "year") {
    const year = Number(range.start.slice(0, 4)) - 1;
    return rangeWithDefaults({
      key: "year",
      label: String(year),
      helperText: "Comparison period: previous calendar year.",
      start: `${year}-01-01`,
      end: `${year}-12-31`,
    });
  }

  if (range.key === "this_year") {
    const currentYear = Number(range.start.slice(0, 4));
    const comparisonEndDate = new Date(Number(range.end.slice(0, 4)) - 1, Number(range.end.slice(5, 7)) - 1, Number(range.end.slice(8, 10)));
    const comparisonEnd = formatLocalDate(comparisonEndDate);
    const comparisonStart = `${currentYear - 1}-01-01`;
    return rangeWithDefaults({
      key: "this_year",
      label: `${currentYear - 1} YTD`,
      helperText: "Comparison period: previous year to date.",
      start: comparisonStart,
      end: comparisonEnd,
    });
  }

  if (range.key === "this_month") {
    const dayCount = inclusiveDayCount(range.start, range.end);
    const comparisonEnd = shiftIsoDate(range.start, -1);
    const comparisonStart = shiftIsoDate(comparisonEnd, -(dayCount - 1));
    return rangeWithDefaults({
      key: "custom",
      label: "Previous period",
      helperText: "Comparison period: the immediately preceding date span with the same number of days.",
      start: comparisonStart,
      end: comparisonEnd,
    });
  }

  const dayCount = inclusiveDayCount(range.start, range.end);
  const comparisonEnd = shiftIsoDate(range.start, -1);
  const comparisonStart = shiftIsoDate(comparisonEnd, -(dayCount - 1));
  return rangeWithDefaults({
    key: "custom",
    label: "Previous period",
    helperText: "Comparison period: the immediately preceding date span with the same number of days.",
    start: comparisonStart,
    end: comparisonEnd,
  });
}

function looksLikeMissingColumnError(value: string) {
  return [
    "missing column",
    "missing required column",
    "required column",
    "header",
    "schema cache",
    "pgrst204",
    "42703",
  ].some((token) => value.includes(token));
}

function classifyContribution({
  batch,
  metadataCoverage,
  reconciliation,
  range,
}: {
  batch: VmsDashboardBatch;
  metadataCoverage: ReturnType<typeof batchCoverageDates>;
  reconciliation: SalesBatchReconciliation | null;
  range: SalesDateRange;
}) {
  const reportType = String(batch.report_type ?? "");
  const rawStatus = String(batch.status ?? "").toLowerCase();
  const importedRows = reconciliation?.rawRowCountTotal ?? batchImportedRows(batch);
  const duplicateRows = reconciliation?.metadataDuplicateRowsTotal ?? integerValue(batch.rows_skipped_duplicate);
  const successfulRows = reconciliation?.rawSuccessfulRowsTotal ?? integerValue(batch.successful_rows_count);
  const latestError = `${String(batch.latest_error ?? "")} ${String(batch.last_error ?? "")}`.trim().toLowerCase();
  const actualCoverage = reconciliationCoverageDates(reconciliation);
  const overlapsSelectedRange = actualCoverage.start && actualCoverage.end
    ? rangesOverlap({ start: actualCoverage.start, end: actualCoverage.end }, { start: range.start, end: range.end })
    : false;
  const metadataOverlapsSelectedRange = metadataCoverage.start && metadataCoverage.end
    ? rangesOverlap({ start: metadataCoverage.start, end: metadataCoverage.end }, { start: range.start, end: range.end })
    : false;
  const rowsInRange = reconciliation?.rangeRowCount ?? 0;
  const successfulRowsInRange = reconciliation?.rangeSuccessfulRows ?? 0;
  const rowsExcludedByStatus = rowsInRange - successfulRowsInRange;

  if (reportType === "sales") {
    return {
      included: false,
      reason: metadataOverlapsSelectedRange
        ? "Summary sales file is available for this period, but dashboard totals only use detailed Order Details rows."
        : "Summary sales file is reconciliation-only and outside the selected business-date range.",
      status: "summary_file_only",
    };
  }

  if (reportType !== "vms_order_details_weekly") {
    return {
      included: false,
      reason: "This VMS file type does not feed the detailed sales dashboard.",
      status: "unsupported_file_type",
    };
  }

  if (batch.deleted_at || batch.is_active === false || rawStatus === "disabled" || rawStatus === "deleted") {
    return {
      included: false,
      reason: rowsInRange > 0
        ? `This detailed sales batch has ${rowsInRange.toLocaleString("en-US")} row(s) inside the selected business-date range, but the batch is inactive so the dashboard excludes it.`
        : "This detailed sales batch is inactive, so it is excluded from dashboard totals.",
      status: "inactive_batch",
    };
  }

  if (rawStatus === "failed") {
    return {
      included: false,
      reason: looksLikeMissingColumnError(latestError)
        ? "Import failed because required columns or headers were missing, so no detailed sales rows could be used."
        : "Import failed before this file could become an active detailed sales source.",
      status: looksLikeMissingColumnError(latestError) ? "missing_required_columns" : "failed_import",
    };
  }

  if (rawStatus === "previewed" || rawStatus === "draft" || rawStatus === "cancelled" || rawStatus === "canceled") {
    return {
      included: false,
      reason: rowsInRange > 0
        ? `This batch has ${rowsInRange.toLocaleString("en-US")} row(s) inside the selected business-date range, but it is still preview-only or unfinished so those rows are blocked from dashboard totals.`
        : "This batch is preview-only or unfinished, so it cannot contribute to dashboard totals yet.",
      status: "preview_only",
    };
  }

  if (!isActiveImportedVmsBatch(batch)) {
    return {
      included: false,
      reason: "This detailed sales batch is not currently active for dashboard use.",
      status: "inactive_batch",
    };
  }

  if (successfulRowsInRange > 0) {
    return {
      included: true,
      reason: duplicateRows > 0
        ? `Contributing ${successfulRowsInRange.toLocaleString("en-US")} successful sale row(s) inside the selected business-date range. ${duplicateRows.toLocaleString("en-US")} duplicate row(s) were skipped during import.`
        : `Contributing ${successfulRowsInRange.toLocaleString("en-US")} successful sale row(s) inside the selected business-date range.`,
      status: "included",
    };
  }

  if (duplicateRows > 0 && importedRows === 0) {
    return {
      included: false,
      reason: "All usable rows were already present from older detailed files, so this batch added no new dashboard rows.",
      status: "duplicate_rows_ignored",
    };
  }

  if (importedRows <= 0 && (batchImportedRows(batch) > 0 || integerValue(batch.rows_found) > 0)) {
    return {
      included: false,
      reason: metadataCoverage.start && metadataCoverage.end
        ? `Batch metadata says this file covers ${metadataCoverage.start} to ${metadataCoverage.end}, but 0 detailed transaction rows were actually saved in vms_transactions_raw.`
        : "Batch metadata shows imported rows, but 0 detailed transaction rows were actually saved in vms_transactions_raw.",
      status: "metadata_without_raw_rows",
    };
  }

  if (actualCoverage.start && actualCoverage.end && !overlapsSelectedRange) {
    return {
      included: false,
      reason: `Business dates for this file are ${actualCoverage.start} to ${actualCoverage.end}, which falls outside the selected business-date range ${range.start} to ${range.end}.`,
      status: "outside_selected_date_range",
    };
  }

  if (rowsInRange > 0 && rowsExcludedByStatus > 0) {
    return {
      included: false,
      reason: `This file has ${rowsInRange.toLocaleString("en-US")} detailed row(s) inside the selected business-date range, but all of them are excluded from sales totals because their statuses are failed vend, refunded, failed payment, or needs review.`,
      status: "rows_excluded_by_status",
    };
  }

  if (importedRows > 0 && !actualCoverage.start && !actualCoverage.end) {
    return {
      included: false,
      reason: reconciliation?.rawMissingDatetimeRowsTotal
        ? `Detailed rows were saved for this file, but ${reconciliation.rawMissingDatetimeRowsTotal.toLocaleString("en-US")} row(s) are missing usable transaction datetime values, so the dashboard cannot place them inside a business-date range.`
        : "Detailed rows were saved for this file, but the dashboard could not derive a usable transaction date range from them.",
      status: "missing_transaction_datetime",
    };
  }

  if (successfulRows <= 0 || importedRows <= 0) {
    return {
      included: false,
      reason: "The batch imported no usable detailed successful-sale rows for dashboard totals.",
      status: "no_detailed_rows",
    };
  }

  return {
    included: false,
    reason: "The file is active, but it contributes 0 detailed rows inside the selected business-date range.",
    status: "no_detailed_rows",
  };
}

function contributionSortRank(row: SalesFileContribution) {
  if (row.included) return 0;
  if (row.status === "outside_selected_date_range") return 1;
  if (row.status === "rows_excluded_by_status") return 2;
  if (row.status === "metadata_without_raw_rows") return 3;
  if (row.status === "missing_transaction_datetime") return 4;
  if (row.status === "summary_file_only") return 5;
  if (row.status === "preview_only") return 6;
  if (row.status === "failed_import" || row.status === "missing_required_columns") return 7;
  if (row.status === "inactive_batch") return 8;
  if (row.status === "duplicate_rows_ignored") return 9;
  if (row.status === "no_detailed_rows") return 10;
  return 11;
}

export function buildSalesFileContributions({
  batches,
  reconciliationByBatchId,
  range,
}: {
  batches: VmsDashboardBatch[];
  reconciliationByBatchId: Map<string, SalesBatchReconciliation>;
  range: SalesDateRange;
}) {
  return batches
    .map((batch) => {
      const metadataCoverage = batchCoverageDates(batch);
      const reconciliation = reconciliationByBatchId.get(batch.id) ?? null;
      const actualCoverage = reconciliationCoverageDates(reconciliation);
      const classification = classifyContribution({ batch, metadataCoverage, reconciliation, range });
      const importedRowsTotal = batch.report_type === "vms_order_details_weekly"
        ? reconciliation?.rawRowCountTotal ?? batchImportedRows(batch)
        : batchImportedRows(batch);

      return {
        batch,
        actualCoverageEnd: actualCoverage.end,
        actualCoverageLabel: coverageLabel(actualCoverage.start, actualCoverage.end),
        actualCoverageStart: actualCoverage.start,
        fileName: sourceFileName(batch),
        importedRowsTotal,
        included: classification.included,
        isActive: Boolean(batch.is_active) && !batch.deleted_at && rawStatus(batch) !== "disabled" && rawStatus(batch) !== "deleted",
        latestTransactionAt: reconciliation?.rangeMaxTransactionAt
          ?? reconciliation?.rawMaxTransactionAt
          ?? batch.detected_max_datetime
          ?? batch.imported_at
          ?? null,
        metadataCoverageLabel: coverageLabel(metadataCoverage.start, metadataCoverage.end),
        reason: classification.reason,
        rowsInRange: reconciliation?.rangeRowCount ?? 0,
        salesAmountInRange: reconciliation?.rangeSuccessfulSalesAmount ?? 0,
        status: classification.status,
        successfulRowsInRange: reconciliation?.rangeSuccessfulRows ?? 0,
        timestampCoverageEnd: reconciliation?.rawMaxTransactionAt ?? null,
        timestampCoverageStart: reconciliation?.rawMinTransactionAt ?? null,
        uploadedAt: batch.uploaded_at ?? batch.imported_at ?? null,
      } satisfies SalesFileContribution;
    })
    .sort((left, right) => {
      const rank = contributionSortRank(left) - contributionSortRank(right);
      if (rank !== 0) return rank;
      return String(right.uploadedAt ?? "").localeCompare(String(left.uploadedAt ?? ""));
    });
}

function rawStatus(batch: VmsDashboardBatch) {
  return String(batch.status ?? "").toLowerCase();
}

type SalesImportAuditRow = {
  import_batch_id?: string | null;
  machine_match_status?: string | null;
  matched_machine_id?: string | null;
  matched_product_id?: string | null;
  normalized_data?: unknown;
  product_match_status?: string | null;
  raw_data?: unknown;
  row_number?: number | null;
  validation_errors?: unknown;
  validation_status?: string | null;
};

type SalesTransactionRawRow = {
  business_date?: string | null;
  cargo_lane_number?: string | null;
  duplicate_hash?: string | null;
  import_batch_id?: string | null;
  machine_code?: string | null;
  machine_name?: string | null;
  mapped_machine_id?: string | null;
  mapped_product_id?: string | null;
  order_number?: string | null;
  payment_amount?: number | string | null;
  payment_time?: string | null;
  product_number?: string | null;
  row_number?: number | null;
  shipping_status?: string | null;
  third_party_order_no?: string | null;
  third_party_transaction_number?: string | null;
  transaction_status?: string | null;
  vms_product_name?: string | null;
};

export async function querySalesRangeReconciliationDiagnostics({
  batches,
  range,
  supabase,
}: {
  batches: VmsDashboardBatch[];
  range: Pick<SalesDateRange, "start" | "end">;
  supabase: any;
}): Promise<SalesRangeReconciliationDiagnostics> {
  const detailedBatches = batches.filter((batch) => batch.report_type === "vms_order_details_weekly");
  const batchIds = detailedBatches.map((batch) => batch.id).filter(Boolean);
  if (!batchIds.length) {
    return {
      dashboardSuccessfulAmount: 0,
      dashboardSuccessfulCount: 0,
      excludedSuccessfulAmount: 0,
      excludedSuccessfulCount: 0,
      excludedSuccessfulRows: [],
      importedSuccessfulAmount: 0,
      importedSuccessfulCount: 0,
      parsedMissingBusinessDateCount: 0,
      parsedMissingMachineCount: 0,
      parsedMissingProductCount: 0,
      parsedSuccessfulAmount: 0,
      parsedSuccessfulCount: 0,
      parsedSuccessfulDuplicateRows: 0,
      statusFilteredRows: [],
      statusGroups: [],
    };
  }

  const batchById = new Map(detailedBatches.map((batch) => [batch.id, batch]));
  const importRows = await fetchPagedRows<SalesImportAuditRow>({
    supabase,
    table: "vms_import_rows",
    select: "import_batch_id, row_number, raw_data, normalized_data, validation_status, validation_errors, machine_match_status, product_match_status, matched_machine_id, matched_product_id",
    filter: (query) => query.in("import_batch_id", batchIds).order("row_number", { ascending: true }),
  });
  const transactionRows = await fetchPagedRows<SalesTransactionRawRow>({
    supabase,
    table: "vms_transactions_raw",
    select: "import_batch_id, row_number, order_number, third_party_transaction_number, third_party_order_no, payment_amount, payment_time, business_date, transaction_status, mapped_machine_id, mapped_product_id, duplicate_hash, shipping_status, cargo_lane_number, machine_code, machine_name, product_number, vms_product_name",
    filter: (query) => query.in("import_batch_id", batchIds).order("row_number", { ascending: true }),
  });

  const transactionByBatchRow = new Map(
    transactionRows.map((row) => [batchRowKey(String(row.import_batch_id ?? ""), Number(row.row_number ?? 0)), row]),
  );
  const duplicateGroups = new Map<string, number[]>();
  const statusGroups = new Map<string, SalesReconciliationStatusGroup>();

  for (const row of importRows) {
    const batchId = String(row.import_batch_id ?? "");
    const rowNumber = Number(row.row_number ?? 0);
    const normalized = jsonRecord(row.normalized_data);
    const duplicateHash = createVmsOrderDetailsDuplicateHash(normalized);
    const duplicateKey = `${batchId}:${duplicateHash}`;
    const numbers = duplicateGroups.get(duplicateKey) ?? [];
    numbers.push(rowNumber);
    duplicateGroups.set(duplicateKey, numbers);
  }

  let parsedSuccessfulCount = 0;
  let parsedSuccessfulAmount = 0;
  let parsedMissingBusinessDateCount = 0;
  let parsedMissingMachineCount = 0;
  let parsedMissingProductCount = 0;
  const excludedSuccessfulRows: SalesReconciliationExcludedRow[] = [];
  const statusFilteredRows: SalesReconciliationExcludedRow[] = [];

  for (const row of importRows) {
    const batchId = String(row.import_batch_id ?? "");
    const batch = batchById.get(batchId);
    if (!batch) continue;

    const rowNumber = Number(row.row_number ?? 0);
    const normalized = jsonRecord(row.normalized_data);
    const raw = jsonRecord(row.raw_data);
    const businessDate = orderDetailsBusinessDate(normalized);
    const normalizedStatus = orderDetailsTransactionStatus(normalized);
    const parsedAmount = Math.max(0, orderDetailsPaymentAmount(normalized) ?? 0);
    const rawShippingStatus = orderDetailsValue(normalized, orderDetailsAliases.shippingStatus)
      || orderDetailsValue(raw, orderDetailsAliases.shippingStatus)
      || "(blank)";
    const rawRefundStatus = orderDetailsValue(normalized, orderDetailsAliases.refundStatus)
      || orderDetailsValue(raw, orderDetailsAliases.refundStatus)
      || "(blank)";
    const groupKey = `${rawShippingStatus}|${rawRefundStatus}|${normalizedStatus}`;
    const statusGroup = statusGroups.get(groupKey) ?? {
      amount: 0,
      count: 0,
      normalizedStatus,
      rawRefundStatus,
      rawShippingStatus,
    };
    statusGroup.count += 1;
    statusGroup.amount += parsedAmount;
    statusGroups.set(groupKey, statusGroup);

    if (normalizedStatus !== "successful_sale") {
      if (businessDate && inRange(businessDate, range)) {
        statusFilteredRows.push({
          batchId,
          batchStatus: batch.status ?? null,
          businessDate,
          exclusionReason: `status:${normalizedStatus}`,
          machineLabel: String(
            orderDetailsValue(normalized, orderDetailsAliases.machineName)
              || orderDetailsValue(normalized, orderDetailsAliases.machineCode)
              || "Unknown machine",
          ),
          machineMatchStatus: row.machine_match_status ?? null,
          orderId: String(
            orderDetailsValue(normalized, orderDetailsAliases.orderNumber)
              || orderDetailsValue(normalized, orderDetailsAliases.thirdPartyTransactionNumber)
              || orderDetailsValue(normalized, orderDetailsAliases.thirdPartyOrderNo)
              || "",
          ) || null,
          parsedAmount,
          productLabel: String(
            orderDetailsValue(normalized, orderDetailsAliases.productName)
              || orderDetailsValue(normalized, orderDetailsAliases.productNumber)
              || "Unknown product",
          ),
          productMatchStatus: row.product_match_status ?? null,
          rawAmount: orderDetailsValue(normalized, orderDetailsAliases.paymentAmount) || null,
          rawDateTime: orderDetailsValue(raw, orderDetailsAliases.paymentTime)
            || orderDetailsValue(raw, orderDetailsAliases.deliveryTime)
            || orderDetailsValue(normalized, orderDetailsAliases.paymentTime)
            || null,
          rawRefundStatus: rawRefundStatus === "(blank)" ? null : rawRefundStatus,
          rawShippingStatus: rawShippingStatus === "(blank)" ? null : rawShippingStatus,
          rowNumber,
          slot: orderDetailsValue(normalized, orderDetailsAliases.cargoLaneNumber) || null,
          sourceFileName: sourceFileName(batch),
          validationErrors: Array.isArray(row.validation_errors)
            ? row.validation_errors.map((value) => String(value))
            : [],
          validationStatus: row.validation_status ?? null,
        });
      }
      continue;
    }
    if (!businessDate) {
      parsedMissingBusinessDateCount += 1;
      continue;
    }
    if (!inRange(businessDate, range)) continue;

    parsedSuccessfulCount += 1;
    parsedSuccessfulAmount += parsedAmount;
    if (!row.matched_machine_id) parsedMissingMachineCount += 1;
    if (!row.matched_product_id) parsedMissingProductCount += 1;

    const txRow = transactionByBatchRow.get(batchRowKey(batchId, rowNumber));
    const duplicateHash = createVmsOrderDetailsDuplicateHash(normalized);
    const duplicateNumbers = duplicateGroups.get(`${batchId}:${duplicateHash}`) ?? [];
    const exclusionReasons: string[] = [];

    if (!txRow) {
      if (String(row.validation_status ?? "") !== "imported") exclusionReasons.push(`audit:${String(row.validation_status ?? "unknown")}`);
      if (!row.matched_product_id) exclusionReasons.push("missing_product_mapping");
      if (!row.matched_machine_id) exclusionReasons.push("missing_machine_mapping");
      if (duplicateNumbers.length > 1) exclusionReasons.push(`duplicate_group:${duplicateNumbers.join(",")}`);
    } else {
      if (String(txRow.transaction_status ?? "") !== "successful_sale") exclusionReasons.push(`status:${String(txRow.transaction_status ?? "unknown")}`);
      if (!countableDetailedBatch(batch)) exclusionReasons.push(`batch:${rawStatus(batch) || "inactive"}`);
      if (!inRange(String(txRow.business_date ?? ""), range)) exclusionReasons.push("outside_business_date_range");
    }

    if (!exclusionReasons.length) continue;

    excludedSuccessfulRows.push({
      batchId,
      batchStatus: batch.status ?? null,
      businessDate,
      exclusionReason: exclusionReasons.join(" | "),
      machineLabel: String(
        orderDetailsValue(normalized, orderDetailsAliases.machineName)
          || orderDetailsValue(normalized, orderDetailsAliases.machineCode)
          || "Unknown machine",
      ),
      machineMatchStatus: row.machine_match_status ?? null,
      orderId: String(
        orderDetailsValue(normalized, orderDetailsAliases.orderNumber)
          || orderDetailsValue(normalized, orderDetailsAliases.thirdPartyTransactionNumber)
          || orderDetailsValue(normalized, orderDetailsAliases.thirdPartyOrderNo)
          || "",
      ) || null,
      parsedAmount,
      productLabel: String(
        orderDetailsValue(normalized, orderDetailsAliases.productName)
          || orderDetailsValue(normalized, orderDetailsAliases.productNumber)
          || "Unknown product",
      ),
      productMatchStatus: row.product_match_status ?? null,
      rawAmount: orderDetailsValue(normalized, orderDetailsAliases.paymentAmount) || null,
      rawDateTime: orderDetailsValue(raw, orderDetailsAliases.paymentTime)
        || orderDetailsValue(raw, orderDetailsAliases.deliveryTime)
        || orderDetailsValue(normalized, orderDetailsAliases.paymentTime)
        || null,
      rawRefundStatus: rawRefundStatus === "(blank)" ? null : rawRefundStatus,
      rawShippingStatus: rawShippingStatus === "(blank)" ? null : rawShippingStatus,
      rowNumber,
      slot: orderDetailsValue(normalized, orderDetailsAliases.cargoLaneNumber) || null,
      sourceFileName: sourceFileName(batch),
      validationErrors: Array.isArray(row.validation_errors)
        ? row.validation_errors.map((value) => String(value))
        : [],
      validationStatus: row.validation_status ?? null,
    });
  }

  let importedSuccessfulCount = 0;
  let importedSuccessfulAmount = 0;
  let dashboardSuccessfulCount = 0;
  let dashboardSuccessfulAmount = 0;

  for (const row of transactionRows) {
    const batchId = String(row.import_batch_id ?? "");
    const batch = batchById.get(batchId);
    if (!batch) continue;
    const businessDate = String(row.business_date ?? "").trim();
    if (!inRange(businessDate, range)) continue;
    if (String(row.transaction_status ?? "") !== "successful_sale") continue;

    const amount = Math.max(0, Number(row.payment_amount ?? 0) || 0);
    importedSuccessfulCount += 1;
    importedSuccessfulAmount += amount;

    if (countableDetailedBatch(batch)) {
      dashboardSuccessfulCount += 1;
      dashboardSuccessfulAmount += amount;
    }
  }

  const excludedSuccessfulAmount = parsedSuccessfulAmount - dashboardSuccessfulAmount;
  const excludedSuccessfulCount = parsedSuccessfulCount - dashboardSuccessfulCount;
  const parsedSuccessfulDuplicateRows = [...duplicateGroups.values()]
    .reduce((sum, rowNumbers) => sum + Math.max(0, rowNumbers.length - 1), 0);

  return {
    dashboardSuccessfulAmount,
    dashboardSuccessfulCount,
    excludedSuccessfulAmount,
    excludedSuccessfulCount,
    excludedSuccessfulRows: excludedSuccessfulRows.sort((left, right) => left.rowNumber - right.rowNumber),
    importedSuccessfulAmount,
    importedSuccessfulCount,
    parsedMissingBusinessDateCount,
    parsedMissingMachineCount,
    parsedMissingProductCount,
    parsedSuccessfulAmount,
    parsedSuccessfulCount,
    parsedSuccessfulDuplicateRows,
    statusFilteredRows: statusFilteredRows.sort((left, right) => left.rowNumber - right.rowNumber),
    statusGroups: [...statusGroups.values()]
      .map((group) => ({ ...group, amount: Number(group.amount.toFixed(2)) }))
      .sort((left, right) => right.count - left.count),
  };
}
