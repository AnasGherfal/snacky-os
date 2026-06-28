import { batchCoverageDates, rangesOverlap, type SalesDashboardSourceMode } from "@/lib/sales-dashboard";
import { type VmsDashboardBatch } from "@/lib/vms-dashboard-source";

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

export function salesDashboardSourceLabel(sourceMode: SalesDashboardSourceMode) {
  return sourceMode === "monthly" ? "Monthly Commodity Profit Report" : "Detailed Order Details Report";
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
