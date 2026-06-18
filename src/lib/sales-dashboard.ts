import {
  batchImportedRows,
  batchLastUpdatedAt,
  isActiveImportedVmsBatch,
  sourceFileName,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";

export type SalesDashboardSearchParams = {
  range?: string;
  month?: string;
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
  | "month"
  | "date"
  | "custom";

export type SalesDateRange = {
  key: SalesDateRangeKey;
  label: string;
  helperText: string;
  start: string;
  end: string;
  monthValue: string;
  dateValue: string;
  dateFromValue: string;
  dateToValue: string;
};

export type SalesBatchMetric = {
  latestTransactionAt: string | null;
  rows: number;
  salesAmount: number;
};

export type SalesFileContribution = {
  batch: VmsDashboardBatch;
  coverageEnd: string | null;
  coverageLabel: string;
  coverageStart: string | null;
  fileName: string;
  importedRowsTotal: number;
  included: boolean;
  latestTransactionAt: string | null;
  reason: string;
  rowsInRange: number;
  salesAmountInRange: number;
  status: string;
  uploadedAt: string | null;
};

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

function normalizeBounds(start: string, end: string) {
  return start <= end ? { start, end } : { start: end, end: start };
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
    dateValue: normalized.start === normalized.end ? normalized.start : normalized.end,
    dateFromValue: normalized.start,
    dateToValue: normalized.end,
  };
}

function activeDetailedSalesBatches(batches: VmsDashboardBatch[]) {
  return batches.filter((batch) => batch.report_type === "vms_order_details_weekly" && isActiveImportedVmsBatch(batch));
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
  coverage,
  metric,
  range,
}: {
  batch: VmsDashboardBatch;
  coverage: ReturnType<typeof batchCoverageDates>;
  metric: SalesBatchMetric;
  range: SalesDateRange;
}) {
  const reportType = String(batch.report_type ?? "");
  const rawStatus = String(batch.status ?? "").toLowerCase();
  const importedRows = batchImportedRows(batch);
  const duplicateRows = Number(batch.rows_skipped_duplicate ?? 0);
  const successfulRows = Number(batch.successful_rows_count ?? 0);
  const latestError = `${String(batch.latest_error ?? "")} ${String(batch.last_error ?? "")}`.trim().toLowerCase();
  const overlapsSelectedRange = coverage.start && coverage.end
    ? rangesOverlap({ start: coverage.start, end: coverage.end }, { start: range.start, end: range.end })
    : false;

  if (reportType === "sales") {
    return {
      included: false,
      reason: overlapsSelectedRange
        ? "Summary sales file is available for this period, but dashboard totals only use detailed Order Details rows."
        : "Summary sales file is reconciliation-only and outside the selected date range.",
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
      reason: "This detailed sales batch is inactive, so it is excluded from dashboard totals.",
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
      reason: "This batch is preview-only or unfinished, so it cannot contribute to dashboard totals yet.",
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

  if (metric.rows > 0) {
    return {
      included: true,
      reason: duplicateRows > 0
        ? `Contributing ${metric.rows.toLocaleString("en-US")} detailed row(s) inside the selected range. ${duplicateRows.toLocaleString("en-US")} duplicate row(s) were skipped during import.`
        : `Contributing ${metric.rows.toLocaleString("en-US")} detailed row(s) inside the selected range.`,
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

  if (coverage.start && coverage.end && !overlapsSelectedRange) {
    return {
      included: false,
      reason: "Active detailed file, but 0 rows fall inside the selected date range.",
      status: "outside_selected_date_range",
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
    reason: "The file is active, but it contributes 0 detailed rows inside the selected date range.",
    status: "no_detailed_rows",
  };
}

function contributionSortRank(row: SalesFileContribution) {
  if (row.included) return 0;
  if (row.status === "outside_selected_date_range") return 1;
  if (row.status === "summary_file_only") return 2;
  if (row.status === "preview_only") return 3;
  if (row.status === "failed_import" || row.status === "missing_required_columns") return 4;
  if (row.status === "inactive_batch") return 5;
  if (row.status === "duplicate_rows_ignored") return 6;
  if (row.status === "no_detailed_rows") return 7;
  return 8;
}

export function buildSalesFileContributions({
  batches,
  metricsByBatchId,
  range,
}: {
  batches: VmsDashboardBatch[];
  metricsByBatchId: Map<string, SalesBatchMetric>;
  range: SalesDateRange;
}) {
  return batches
    .map((batch) => {
      const coverage = batchCoverageDates(batch);
      const metric = metricsByBatchId.get(batch.id) ?? { latestTransactionAt: null, rows: 0, salesAmount: 0 };
      const classification = classifyContribution({ batch, coverage, metric, range });

      return {
        batch,
        coverageEnd: coverage.end,
        coverageLabel: coverage.start && coverage.end ? `${coverage.start} to ${coverage.end}` : "-",
        coverageStart: coverage.start,
        fileName: sourceFileName(batch),
        importedRowsTotal: batchImportedRows(batch),
        included: classification.included,
        latestTransactionAt: metric.latestTransactionAt,
        reason: classification.reason,
        rowsInRange: metric.rows,
        salesAmountInRange: metric.salesAmount,
        status: classification.status,
        uploadedAt: batch.uploaded_at ?? batch.imported_at ?? null,
      } satisfies SalesFileContribution;
    })
    .sort((left, right) => {
      const rank = contributionSortRank(left) - contributionSortRank(right);
      if (rank !== 0) return rank;
      return String(right.uploadedAt ?? "").localeCompare(String(left.uploadedAt ?? ""));
    });
}
