/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import {
  buildMachineCashReconciliation,
  summarizeCashCollections,
  type FinanceCashCollectionRow,
  type MachineIdentity,
  type VmsMachineSalesRow,
} from "@/lib/finance-operations";
import { lyd, pct } from "@/lib/format";
import { formatInteger } from "@/lib/kpi";
import {
  resolveDetailedSalesDashboardSourceReportType,
  resolveSalesDashboardSourceReportType,
  type SalesDashboardSourceMode,
  type SalesDateRange,
} from "@/lib/sales-dashboard";
import { queryVmsDashboardBatches, type VmsDashboardBatch } from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

type CashReconciliationSearchParams = {
  range?: string;
  month?: string;
  year?: string;
  date?: string;
  date_from?: string;
  date_to?: string;
};

type CashRangeKey =
  | "today"
  | "yesterday"
  | "this_month"
  | "last_month"
  | "this_year"
  | "month"
  | "year"
  | "all_time"
  | "date"
  | "custom";

type CashRange = {
  key: CashRangeKey;
  label: string;
  helperText: string;
  start: string | null;
  end: string | null;
  monthValue: string;
  yearValue: string;
  dateValue: string;
  dateFromValue: string;
  dateToValue: string;
};

type SalesSummaryRow = {
  revenue_amount?: number | string | null;
  successful_sales_count?: number | string | null;
  units_sold?: number | string | null;
  cash_sales_amount?: number | string | null;
  card_sales_amount?: number | string | null;
  unknown_payment_sales_amount?: number | string | null;
  payment_method_available?: boolean | null;
};

type CashCollectionRow = FinanceCashCollectionRow & {
  machine?: {
    id?: string | null;
    name?: string | null;
    machine_code?: string | null;
    location?: { id?: string | null; name?: string | null } | { id?: string | null; name?: string | null }[] | null;
  } | {
    id?: string | null;
    name?: string | null;
    machine_code?: string | null;
    location?: { id?: string | null; name?: string | null } | { id?: string | null; name?: string | null }[] | null;
  }[] | null;
};

type MachineRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location?: { id?: string | null; name?: string | null } | { id?: string | null; name?: string | null }[] | null;
};

type RangeSummary = {
  vmsSalesAmount: number;
  vmsUnits: number;
  vmsTransactionCount: number;
  cashCountedAmount: number;
  varianceAmount: number;
  accuracy: number | null;
  countedCollectionCount: number;
  pendingCollectionCount: number;
  varianceReviewCount: number;
  paymentSplitAvailable: boolean;
  vmsCashSalesAmount: number;
  vmsCardSalesAmount: number;
  vmsUnknownSalesAmount: number;
};

type PeriodBreakdownRow = {
  key: string;
  label: string;
  sortKey: string;
  vmsSalesAmount: number;
  cashCountedAmount: number;
  varianceAmount: number;
  countedCollectionCount: number;
};

type ComparisonMetricRow = {
  label: string;
  selected: string;
  comparison: string;
  delta: string;
};

function numeric(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function dateFromParts(year: number, month: number, day: number) {
  return new Date(year, month - 1, day);
}

function formatLocalDate(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function parseIsoDate(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day);
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day
    ? `${year}-${padDatePart(month)}-${padDatePart(day)}`
    : null;
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

function addDays(date: Date, days: number) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
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

function monthLabel(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function normalizeBounds(start: string, end: string) {
  return start <= end ? { start, end } : { start: end, end: start };
}

function inclusiveDayCount(start: string, end: string) {
  const startDate = dateFromParts(Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10)));
  const endDate = dateFromParts(Number(end.slice(0, 4)), Number(end.slice(5, 7)), Number(end.slice(8, 10)));
  const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  return Math.max(1, diff + 1);
}

function shiftIsoDate(value: string, days: number) {
  const shifted = dateFromParts(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10)));
  shifted.setDate(shifted.getDate() + days);
  return formatLocalDate(shifted);
}

function formatDateMonth(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}`;
}

function cashRangeWithDefaults({
  end,
  helperText,
  key,
  label,
  start,
}: {
  end: string | null;
  helperText: string;
  key: CashRangeKey;
  label: string;
  start: string | null;
}): CashRange {
  const normalized = start && end ? normalizeBounds(start, end) : { start, end };
  return {
    key,
    label,
    helperText,
    start: normalized.start,
    end: normalized.end,
    monthValue: normalized.start ? normalized.start.slice(0, 7) : "",
    yearValue: normalized.start ? normalized.start.slice(0, 4) : "",
    dateValue: normalized.start && normalized.end && normalized.start === normalized.end ? normalized.start : normalized.end ?? normalized.start ?? "",
    dateFromValue: normalized.start ?? "",
    dateToValue: normalized.end ?? "",
  };
}

function resolveCashReconciliationRange(params: CashReconciliationSearchParams, now = new Date()) {
  const today = formatLocalDate(now);
  const rawRange = String(params.range ?? "").trim().toLowerCase();
  const monthValue = parseMonthValue(params.month);
  const yearValue = parseYearValue(params.year);
  const singleDate = parseIsoDate(params.date);
  const customStart = parseIsoDate(params.date_from);
  const customEnd = parseIsoDate(params.date_to);

  if (rawRange === "today") {
    return cashRangeWithDefaults({ key: "today", label: "Today", helperText: "VMS sales dated today versus cash counted today.", start: today, end: today });
  }
  if (rawRange === "yesterday") {
    const yesterday = formatLocalDate(addDays(now, -1));
    return cashRangeWithDefaults({ key: "yesterday", label: "Yesterday", helperText: "VMS sales dated yesterday versus cash counted yesterday.", start: yesterday, end: yesterday });
  }
  if (rawRange === "this_month") {
    return cashRangeWithDefaults({ key: "this_month", label: "This month", helperText: "VMS sales and finance counts from the first day of this month through today.", start: formatLocalDate(startOfMonth(now)), end: today });
  }
  if (rawRange === "last_month") {
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return cashRangeWithDefaults({ key: "last_month", label: "Last month", helperText: "VMS sales and finance counts in the previous calendar month.", start: formatLocalDate(startOfMonth(previousMonth)), end: formatLocalDate(endOfMonth(previousMonth)) });
  }
  if (rawRange === "this_year") {
    return cashRangeWithDefaults({ key: "this_year", label: "This year", helperText: "VMS sales and finance counts from January 1 through today.", start: formatLocalDate(startOfYear(now)), end: today });
  }
  if (rawRange === "month" && monthValue) {
    const [year, month] = monthValue.split("-").map(Number);
    const monthDate = dateFromParts(year, month, 1);
    return cashRangeWithDefaults({ key: "month", label: monthLabel(monthValue), helperText: `VMS sales and finance counts for ${monthLabel(monthValue)}.`, start: formatLocalDate(startOfMonth(monthDate)), end: formatLocalDate(endOfMonth(monthDate)) });
  }
  if (rawRange === "year" && yearValue) {
    return cashRangeWithDefaults({ key: "year", label: yearValue, helperText: `VMS sales and finance counts for ${yearValue}.`, start: `${yearValue}-01-01`, end: `${yearValue}-12-31` });
  }
  if (rawRange === "all_time") {
    return cashRangeWithDefaults({ key: "all_time", label: "All time", helperText: "All available VMS sales versus all cash counted in Snacky OS.", start: null, end: null });
  }
  if (rawRange === "date" && singleDate) {
    return cashRangeWithDefaults({ key: "date", label: singleDate, helperText: "VMS sales dated on the selected day versus cash counted on that day.", start: singleDate, end: singleDate });
  }
  if (rawRange === "custom" || customStart || customEnd) {
    const start = customStart ?? customEnd ?? today;
    const end = customEnd ?? customStart ?? today;
    return cashRangeWithDefaults({ key: "custom", label: "Custom range", helperText: "VMS sales and finance cash counts inside the same custom date range.", start, end });
  }
  return cashRangeWithDefaults({ key: "this_month", label: "This month", helperText: "VMS sales and finance counts from the first day of this month through today.", start: formatLocalDate(startOfMonth(now)), end: today });
}

function buildCashComparisonRange(range: CashRange) {
  if (range.key === "all_time" || !range.start || !range.end) return null;
  if (range.key === "month" || range.key === "last_month") {
    const [year, month] = range.start.slice(0, 7).split("-").map(Number);
    const previousMonth = new Date(year, month - 2, 1);
    return cashRangeWithDefaults({ key: "month", label: monthLabel(formatDateMonth(previousMonth)), helperText: "Previous calendar month.", start: formatLocalDate(startOfMonth(previousMonth)), end: formatLocalDate(endOfMonth(previousMonth)) });
  }
  if (range.key === "year") {
    const year = Number(range.start.slice(0, 4)) - 1;
    return cashRangeWithDefaults({ key: "year", label: String(year), helperText: "Previous calendar year.", start: `${year}-01-01`, end: `${year}-12-31` });
  }
  if (range.key === "this_year") {
    const currentYear = Number(range.start.slice(0, 4));
    const comparisonEndDate = new Date(Number(range.end.slice(0, 4)) - 1, Number(range.end.slice(5, 7)) - 1, Number(range.end.slice(8, 10)));
    return cashRangeWithDefaults({ key: "this_year", label: `${currentYear - 1} YTD`, helperText: "Previous year to date.", start: `${currentYear - 1}-01-01`, end: formatLocalDate(comparisonEndDate) });
  }
  const dayCount = inclusiveDayCount(range.start, range.end);
  const comparisonEnd = shiftIsoDate(range.start, -1);
  const comparisonStart = shiftIsoDate(comparisonEnd, -(dayCount - 1));
  return cashRangeWithDefaults({ key: "custom", label: "Previous period", helperText: "Immediately preceding period with the same number of days.", start: comparisonStart, end: comparisonEnd });
}

function relationRecord<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function salesRangeForCash(range: CashRange, now = new Date()): SalesDateRange {
  const start = range.start ?? "2000-01-01";
  const end = range.end ?? formatLocalDate(now);
  return {
    key: range.key,
    label: range.label,
    helperText: range.helperText,
    start,
    end,
    monthValue: start.slice(0, 7),
    yearValue: start.slice(0, 4),
    dateValue: end,
    dateFromValue: start,
    dateToValue: end,
  };
}

function applyCountedAtRange(query: any, range: CashRange) {
  let next = query.not("counted_at", "is", null).neq("review_status", "voided");
  if (range.start) next = next.gte("counted_at", `${range.start}T00:00:00.000Z`);
  if (range.end) next = next.lt("counted_at", `${shiftIsoDate(range.end, 1)}T00:00:00.000Z`);
  return next;
}

function applyCollectedAtRange(query: any, range: CashRange) {
  let next = query;
  if (range.start) next = next.gte("collected_at", `${range.start}T00:00:00.000Z`);
  if (range.end) next = next.lt("collected_at", `${shiftIsoDate(range.end, 1)}T00:00:00.000Z`);
  return next;
}

function firstRpcRow(data: unknown): SalesSummaryRow {
  if (Array.isArray(data)) return (data[0] ?? {}) as SalesSummaryRow;
  return (data ?? {}) as SalesSummaryRow;
}

function salesSummaryHasActivity(row: SalesSummaryRow) {
  return numeric(row.revenue_amount) > 0
    || numeric(row.successful_sales_count) > 0
    || numeric(row.units_sold) > 0;
}

function calendarMonthRanges(range: SalesDateRange) {
  const [startYear, startMonth] = range.start.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = range.end.slice(0, 7).split("-").map(Number);
  const cursor = new Date(startYear, startMonth - 1, 1);
  const last = new Date(endYear, endMonth - 1, 1);
  const ranges: { start: string; end: string }[] = [];

  while (cursor.getTime() <= last.getTime()) {
    ranges.push({
      start: formatLocalDate(startOfMonth(cursor)),
      end: formatLocalDate(endOfMonth(cursor)),
    });
    cursor.setMonth(cursor.getMonth() + 1, 1);
  }

  return ranges;
}

function mergeSalesSummaryRows(rows: SalesSummaryRow[]): SalesSummaryRow {
  return rows.reduce<SalesSummaryRow>((total, row) => ({
    revenue_amount: roundMoney(numeric(total.revenue_amount) + numeric(row.revenue_amount)),
    successful_sales_count: Math.max(0, Math.floor(numeric(total.successful_sales_count) + numeric(row.successful_sales_count))),
    units_sold: Math.max(0, Math.floor(numeric(total.units_sold) + numeric(row.units_sold))),
    cash_sales_amount: roundMoney(numeric(total.cash_sales_amount) + numeric(row.cash_sales_amount)),
    card_sales_amount: roundMoney(numeric(total.card_sales_amount) + numeric(row.card_sales_amount)),
    unknown_payment_sales_amount: roundMoney(numeric(total.unknown_payment_sales_amount) + numeric(row.unknown_payment_sales_amount)),
    payment_method_available: Boolean(total.payment_method_available || row.payment_method_available),
  }), {});
}

function mergeVmsBreakdownRows(rows: VmsMachineSalesRow[]) {
  const merged = new Map<string, any>();
  for (const row of rows) {
    const key = String(row.bucket_key ?? row.bucket_label ?? "unknown");
    const current = merged.get(key) ?? { ...row };
    current.successful_sales_amount = roundMoney(numeric(current.successful_sales_amount) + (merged.has(key) ? numeric(row.successful_sales_amount) : 0));
    current.successful_sales_count = Math.max(0, Math.floor(numeric(current.successful_sales_count) + (merged.has(key) ? numeric(row.successful_sales_count) : 0)));
    current.units_sold = Math.max(0, Math.floor(numeric(current.units_sold) + (merged.has(key) ? numeric(row.units_sold) : 0)));
    current.rows_used = Math.max(0, Math.floor(numeric(current.rows_used) + (merged.has(key) ? numeric(row.rows_used) : 0)));
    merged.set(key, current);
  }
  return Array.from(merged.values());
}

async function loadMonthlyVmsRangeByMonth(supabase: any, range: SalesDateRange) {
  const monthRanges = calendarMonthRanges(range);
  const results = await Promise.all(monthRanges.map(async (monthRange) => {
    const [summary, month, machine] = await Promise.all([
      supabase.rpc("sales_dashboard_monthly_summary", { p_date_from: monthRange.start, p_date_to: monthRange.end }),
      supabase.rpc("sales_dashboard_monthly_breakdown", { p_dimension: "month", p_date_from: monthRange.start, p_date_to: monthRange.end }),
      supabase.rpc("sales_dashboard_monthly_breakdown", { p_dimension: "machine", p_date_from: monthRange.start, p_date_to: monthRange.end }),
    ]);
    return { summary, month, machine };
  }));
  const error = results.flatMap((result) => [result.summary.error, result.month.error, result.machine.error]).find(Boolean) ?? null;
  if (error) {
    return {
      summaryResult: { data: [], error },
      monthResult: { data: [], error },
      machineResult: { data: [], error },
    };
  }
  return {
    summaryResult: { data: [mergeSalesSummaryRows(results.map((result) => firstRpcRow(result.summary.data)))], error: null },
    monthResult: { data: mergeVmsBreakdownRows(results.flatMap((result) => result.month.data ?? [])), error: null },
    machineResult: { data: mergeVmsBreakdownRows(results.flatMap((result) => result.machine.data ?? [])), error: null },
  };
}

function summarizeRange(cashRows: CashCollectionRow[], pendingCount: number, sales: SalesSummaryRow): RangeSummary {
  const cashSummary = summarizeCashCollections(cashRows);
  const vmsSalesAmount = roundMoney(numeric(sales.revenue_amount));
  const cashCountedAmount = roundMoney(cashSummary.countedCash);
  return {
    vmsSalesAmount,
    vmsUnits: Math.max(0, Math.floor(numeric(sales.units_sold))),
    vmsTransactionCount: Math.max(0, Math.floor(numeric(sales.successful_sales_count))),
    cashCountedAmount,
    varianceAmount: roundMoney(cashCountedAmount - vmsSalesAmount),
    accuracy: vmsSalesAmount > 0 ? cashCountedAmount / vmsSalesAmount : null,
    countedCollectionCount: cashSummary.countedRows.length,
    pendingCollectionCount: pendingCount,
    varianceReviewCount: cashSummary.varianceReviewCount,
    paymentSplitAvailable: Boolean(sales.payment_method_available),
    vmsCashSalesAmount: roundMoney(numeric(sales.cash_sales_amount)),
    vmsCardSalesAmount: roundMoney(numeric(sales.card_sales_amount)),
    vmsUnknownSalesAmount: roundMoney(numeric(sales.unknown_payment_sales_amount)),
  };
}

function timeBucketFromCash(row: CashCollectionRow, dimension: "day" | "month") {
  const date = String(row.counted_at ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return dimension === "month"
    ? { key: date.slice(0, 7), label: monthLabel(date.slice(0, 7)), sortKey: date.slice(0, 7) }
    : { key: date, label: date, sortKey: date };
}

function mergeTimeBreakdown(vmsRows: VmsMachineSalesRow[], cashRows: CashCollectionRow[], dimension: "day" | "month") {
  const rows = new Map<string, PeriodBreakdownRow>();
  const ensure = (key: string, label: string, sortKey: string) => {
    const current = rows.get(key) ?? { key, label, sortKey, vmsSalesAmount: 0, cashCountedAmount: 0, varianceAmount: 0, countedCollectionCount: 0 };
    rows.set(key, current);
    return current;
  };

  for (const row of vmsRows) {
    const key = String(row.bucket_key ?? row.bucket_label ?? "unknown");
    const label = String(row.bucket_label ?? row.bucket_key ?? "Unknown");
    const current = ensure(key, label, key);
    current.vmsSalesAmount = roundMoney(current.vmsSalesAmount + numeric(row.successful_sales_amount));
  }

  for (const cash of cashRows) {
    const bucket = timeBucketFromCash(cash, dimension);
    if (!bucket) continue;
    const current = ensure(bucket.key, bucket.label, bucket.sortKey);
    current.cashCountedAmount = roundMoney(current.cashCountedAmount + numeric(cash.actual_cash_collected));
    current.countedCollectionCount += 1;
  }

  return Array.from(rows.values())
    .map((row) => ({ ...row, varianceAmount: roundMoney(row.cashCountedAmount - row.vmsSalesAmount) }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.label.localeCompare(right.label));
}

function formatDelta(value: number) {
  const rounded = roundMoney(value);
  return `${rounded > 0 ? "+" : ""}${lyd(rounded)}`;
}

function formatPercent(value: number | null) {
  return value === null ? "Not available" : pct(value);
}

function comparisonMetrics(selected: RangeSummary, comparison: RangeSummary): ComparisonMetricRow[] {
  return [
    { label: "VMS sales", selected: lyd(selected.vmsSalesAmount), comparison: lyd(comparison.vmsSalesAmount), delta: formatDelta(selected.vmsSalesAmount - comparison.vmsSalesAmount) },
    { label: "Cash counted", selected: lyd(selected.cashCountedAmount), comparison: lyd(comparison.cashCountedAmount), delta: formatDelta(selected.cashCountedAmount - comparison.cashCountedAmount) },
    { label: "Difference", selected: formatDelta(selected.varianceAmount), comparison: formatDelta(comparison.varianceAmount), delta: formatDelta(selected.varianceAmount - comparison.varianceAmount) },
    { label: "Match rate", selected: formatPercent(selected.accuracy), comparison: formatPercent(comparison.accuracy), delta: selected.accuracy === null || comparison.accuracy === null ? "-" : `${((selected.accuracy - comparison.accuracy) * 100).toFixed(1)} pp` },
    { label: "Counted collections", selected: formatInteger(selected.countedCollectionCount), comparison: formatInteger(comparison.countedCollectionCount), delta: formatInteger(selected.countedCollectionCount - comparison.countedCollectionCount) },
    { label: "Pending counts", selected: formatInteger(selected.pendingCollectionCount), comparison: formatInteger(comparison.pendingCollectionCount), delta: formatInteger(selected.pendingCollectionCount - comparison.pendingCollectionCount) },
  ];
}

function filterButtonClass(active: boolean) {
  return active ? "btn-primary" : "btn-secondary";
}

function createRangeHref(range: string) {
  return `/reports/cash-reconciliation?range=${encodeURIComponent(range)}`;
}

function differenceClass(value: number) {
  return value < 0 ? "font-semibold text-rose-700" : value > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700";
}

function machineStatus(vmsSales: number, countedCash: number, variance: number) {
  if (vmsSales <= 0 && countedCash > 0) return "cash only";
  if (vmsSales > 0 && countedCash <= 0) return "no cash counted";
  if (Math.abs(variance) >= 10) return "variance review";
  return "matched";
}

export default async function CashReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<CashReconciliationSearchParams>;
}) {
  const profile = await getCurrentProfile();
  if (
    !profile ||
    !canViewFinancials({
      id: profile.id,
      role: profile.role,
      roles: profile.roles,
      canAddProducts: profile.can_add_products,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    })
  ) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Cash reconciliation unavailable" body="Supabase is not configured, so Snacky OS cannot load cash reconciliation reports." />;

  const params = await searchParams;
  const selectedRange = resolveCashReconciliationRange(params);
  const comparisonRange = buildCashComparisonRange(selectedRange);

  const selectedCashQuery = applyCountedAtRange(
    supabase
      .from("cash_collections")
      .select("id, machine_id, collected_at, counted_at, actual_cash_collected, vms_expected_cash, variance, review_status, machine:machines(id, name, machine_code, location:locations(id, name))")
      .order("counted_at", { ascending: false })
      .limit(10000),
    selectedRange,
  );
  const selectedPendingQuery = applyCollectedAtRange(
    supabase
      .from("cash_collections")
      .select("id, collected_at, review_status")
      .in("review_status", ["pending_collection", "collected_pending_count"])
      .limit(10000),
    selectedRange,
  );
  const comparisonCashQuery = comparisonRange
    ? applyCountedAtRange(
        supabase
          .from("cash_collections")
          .select("id, machine_id, collected_at, counted_at, actual_cash_collected, vms_expected_cash, variance, review_status")
          .order("counted_at", { ascending: false })
          .limit(10000),
        comparisonRange,
      )
    : Promise.resolve({ data: [], error: null });
  const comparisonPendingQuery = comparisonRange
    ? applyCollectedAtRange(
        supabase
          .from("cash_collections")
          .select("id, collected_at, review_status")
          .in("review_status", ["pending_collection", "collected_pending_count"])
          .limit(10000),
        comparisonRange,
      )
    : Promise.resolve({ data: [], error: null });

  const [machineResult, selectedCashResult, selectedPendingResult, comparisonCashResult, comparisonPendingResult, batchResult, monthlyProfitTableCheck] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").order("name"),
    selectedCashQuery,
    selectedPendingQuery,
    comparisonCashQuery,
    comparisonPendingQuery,
    queryVmsDashboardBatches(supabase, {
      reportTypes: ["monthly_product_profit", "monthly_transaction_details", "vms_order_details_weekly"],
      orderBy: "uploaded_at",
      ascending: false,
    }),
    supabase.from("vms_monthly_product_profit").select("id", { head: true, count: "exact" }).limit(1),
  ]);

  if (machineResult.error || selectedCashResult.error || selectedPendingResult.error) {
    console.error("[cash-reconciliation] Cash query failed", {
      machines: machineResult.error,
      counted_cash: selectedCashResult.error,
      pending_cash: selectedPendingResult.error,
    });
    return <ErrorState title="Cash reconciliation unavailable" body="The cash count or machine query failed. No records were changed." action={<SecondaryButton href="/reports/cash-reconciliation">Retry</SecondaryButton>} />;
  }

  const batches = (batchResult.data ?? []) as VmsDashboardBatch[];
  const monthlyProfitTableAvailable = !monthlyProfitTableCheck.error;
  const selectedSalesRange = salesRangeForCash(selectedRange);
  let selectedSourceReportType = monthlyProfitTableAvailable
    ? resolveSalesDashboardSourceReportType(batches, selectedSalesRange)
    : resolveDetailedSalesDashboardSourceReportType(batches, selectedSalesRange);
  let selectedSourceMode: SalesDashboardSourceMode = selectedSourceReportType === "monthly_product_profit" ? "monthly" : "detailed";
  const selectedSummaryRpc = selectedSourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";
  const selectedBreakdownRpc = selectedSourceMode === "monthly" ? "sales_dashboard_monthly_breakdown" : "sales_dashboard_breakdown";

  const comparisonSalesRange = comparisonRange ? salesRangeForCash(comparisonRange) : null;
  const comparisonSourceReportType = comparisonSalesRange
    ? monthlyProfitTableAvailable
      ? resolveSalesDashboardSourceReportType(batches, comparisonSalesRange)
      : resolveDetailedSalesDashboardSourceReportType(batches, comparisonSalesRange)
    : null;
  const comparisonSourceMode: SalesDashboardSourceMode | null = comparisonSourceReportType === "monthly_product_profit" ? "monthly" : comparisonSourceReportType ? "detailed" : null;
  const comparisonSummaryRpc = comparisonSourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";

  let [selectedVmsSummaryResult, selectedVmsDayResult, selectedVmsMonthResult, selectedVmsMachineResult, comparisonVmsSummaryResult] = await Promise.all([
    supabase.rpc(selectedSummaryRpc, { p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    selectedSourceMode === "monthly"
      ? Promise.resolve({ data: [], error: null })
      : supabase.rpc(selectedBreakdownRpc, { p_dimension: "day", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    supabase.rpc(selectedBreakdownRpc, { p_dimension: "month", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    supabase.rpc(selectedBreakdownRpc, { p_dimension: "machine", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    comparisonSalesRange
      ? supabase.rpc(comparisonSummaryRpc, { p_date_from: comparisonSalesRange.start, p_date_to: comparisonSalesRange.end })
      : Promise.resolve({ data: [], error: null }),
  ]);

  let selectedMonthlyCalendarFallbackUsed = false;
  let selectedMonthlyFallbackError: unknown = null;
  if (
    selectedRange.key === "custom"
    && monthlyProfitTableAvailable
    && (selectedVmsSummaryResult.error || !salesSummaryHasActivity(firstRpcRow(selectedVmsSummaryResult.data)))
  ) {
    const monthlyFallback = await loadMonthlyVmsRangeByMonth(supabase, selectedSalesRange);
    selectedMonthlyFallbackError = monthlyFallback.summaryResult.error;
    if (!monthlyFallback.summaryResult.error && salesSummaryHasActivity(firstRpcRow(monthlyFallback.summaryResult.data))) {
      selectedVmsSummaryResult = monthlyFallback.summaryResult;
      selectedVmsDayResult = { data: [], error: null };
      selectedVmsMonthResult = monthlyFallback.monthResult;
      selectedVmsMachineResult = monthlyFallback.machineResult;
      selectedSourceReportType = "monthly_product_profit";
      selectedSourceMode = "monthly";
      selectedMonthlyCalendarFallbackUsed = true;
    }
  }

  let comparisonMonthlyFallbackError: unknown = null;
  if (
    comparisonSalesRange
    && comparisonRange?.key === "custom"
    && monthlyProfitTableAvailable
    && (comparisonVmsSummaryResult.error || !salesSummaryHasActivity(firstRpcRow(comparisonVmsSummaryResult.data)))
  ) {
    const comparisonMonthlyFallback = await loadMonthlyVmsRangeByMonth(supabase, comparisonSalesRange);
    comparisonMonthlyFallbackError = comparisonMonthlyFallback.summaryResult.error;
    if (!comparisonMonthlyFallback.summaryResult.error && salesSummaryHasActivity(firstRpcRow(comparisonMonthlyFallback.summaryResult.data))) {
      comparisonVmsSummaryResult = comparisonMonthlyFallback.summaryResult;
    }
  }

  if (selectedVmsSummaryResult.error) {
    console.error("[cash-reconciliation] VMS summary failed", {
      selected_range: selectedSalesRange,
      source_report_type: selectedSourceReportType,
      error: selectedVmsSummaryResult.error,
    });
    return <ErrorState title="Cash reconciliation unavailable" body="VMS sales could not load for the selected duration, so a trustworthy comparison cannot be shown." action={<SecondaryButton href="/reports/cash-reconciliation">Retry</SecondaryButton>} />;
  }

  const selectedCashRows = (selectedCashResult.data ?? []) as CashCollectionRow[];
  const comparisonCashRows = (comparisonCashResult.data ?? []) as CashCollectionRow[];
  const selectedSummary = summarizeRange(selectedCashRows, (selectedPendingResult.data ?? []).length, firstRpcRow(selectedVmsSummaryResult.data));
  const comparisonSummary = comparisonRange
    ? summarizeRange(comparisonCashRows, (comparisonPendingResult.data ?? []).length, firstRpcRow(comparisonVmsSummaryResult.data))
    : null;

  const selectedVmsDayRows = (selectedVmsDayResult.data ?? []) as VmsMachineSalesRow[];
  const selectedVmsMonthRows = (selectedVmsMonthResult.data ?? []) as VmsMachineSalesRow[];
  const selectedVmsMachineRows = (selectedVmsMachineResult.data ?? []) as VmsMachineSalesRow[];
  const dayRows = mergeTimeBreakdown(selectedVmsDayRows, selectedCashRows, "day");
  const monthRows = mergeTimeBreakdown(selectedVmsMonthRows, selectedCashRows, "month");

  const machines = (machineResult.data ?? []) as MachineRow[];
  const machineIdentities: MachineIdentity[] = machines.map((machine) => ({
    id: machine.id,
    name: machine.name,
    machine_code: machine.machine_code,
    location_name: relationRecord(machine.location)?.name ?? null,
  }));
  const machineRows = buildMachineCashReconciliation({
    machines: machineIdentities,
    cashCollections: selectedCashRows,
    vmsRows: selectedVmsMachineRows,
  }).map((row) => ({
    ...row,
    rangeVariance: roundMoney(row.countedCash - row.vmsSalesAmount),
    rangeAccuracy: row.vmsSalesAmount > 0 ? row.countedCash / row.vmsSalesAmount : null,
  }));

  const selectedDayCount = selectedRange.start && selectedRange.end ? inclusiveDayCount(selectedRange.start, selectedRange.end) : null;
  const showDayBreakdown = selectedSourceMode !== "monthly" && selectedDayCount !== null && selectedDayCount <= 62;
  const hasActivity = selectedSummary.vmsSalesAmount > 0 || selectedSummary.cashCountedAmount > 0 || selectedSummary.pendingCollectionCount > 0;
  const loadWarnings = [
    batchResult.error,
    comparisonCashResult.error,
    comparisonPendingResult.error,
    comparisonRange ? comparisonVmsSummaryResult.error : null,
    selectedVmsDayResult.error,
    selectedVmsMonthResult.error,
    selectedVmsMachineResult.error,
    selectedMonthlyFallbackError,
    comparisonMonthlyFallbackError,
  ].filter(Boolean);

  const comparisonSubtitle = comparisonRange
    ? `${selectedRange.label} compared with ${comparisonRange.label}. Both periods use VMS sale dates and finance counted_at dates.`
    : "All-time reports do not have a previous comparison window.";

  return (
    <>
      <PageHeader
        title={"Cash Reconciliation / \u0645\u0637\u0627\u0628\u0642\u0629 \u0627\u0644\u0643\u0627\u0634"}
        subtitle="Compare VMS sales in the selected duration with cash that Finance counted during the same duration. Cash is filtered by counted_at, not by the day it was removed from the machine."
        action={<SecondaryButton href="/cash-collections">Cash collections</SecondaryButton>}
      />

      <SectionCard>
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            <Link href={createRangeHref("today")} className={filterButtonClass(selectedRange.key === "today")}>Today</Link>
            <Link href={createRangeHref("this_month")} className={filterButtonClass(selectedRange.key === "this_month")}>This month</Link>
            <Link href={createRangeHref("last_month")} className={filterButtonClass(selectedRange.key === "last_month")}>Last month</Link>
            <Link href={createRangeHref("this_year")} className={filterButtonClass(selectedRange.key === "this_year")}>This year</Link>
            <Link href={createRangeHref("all_time")} className={filterButtonClass(selectedRange.key === "all_time")}>All time</Link>
          </div>

          <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
            <div className="font-semibold">{selectedRange.label}: {selectedRange.start ?? "First record"} to {selectedRange.end ?? "Today"}</div>
            <div className="mt-1 leading-6">{selectedRange.helperText}</div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <input type="hidden" name="range" value="month" />
              <div className="text-sm font-semibold text-slate-900">Specific month</div>
              <input name="month" type="month" defaultValue={selectedRange.monthValue} className="field-input" />
              <button className="btn-primary w-full">View month</button>
            </form>
            <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <input type="hidden" name="range" value="year" />
              <div className="text-sm font-semibold text-slate-900">Specific year</div>
              <input name="year" type="number" min="1900" max="2100" defaultValue={selectedRange.yearValue} className="field-input" />
              <button className="btn-primary w-full">View year</button>
            </form>
            <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <input type="hidden" name="range" value="custom" />
              <div className="text-sm font-semibold text-slate-900">Custom range</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input name="date_from" type="date" defaultValue={selectedRange.dateFromValue} className="field-input" />
                <input name="date_to" type="date" defaultValue={selectedRange.dateToValue} className="field-input" />
              </div>
              <div className="flex gap-2">
                <button className="btn-primary w-full">Apply</button>
                <Link href="/reports/cash-reconciliation" className="btn-secondary w-full">Reset</Link>
              </div>
            </form>
          </div>
        </div>
      </SectionCard>

      {loadWarnings.length ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Some secondary reconciliation details could not load. The main selected-range VMS versus counted-cash comparison is still shown.
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <section className="surface-card"><div className="text-sm text-slate-500">VMS sales / مبيعات VMS</div><div className="mt-2 text-3xl font-semibold text-slate-950">{lyd(selectedSummary.vmsSalesAmount)}</div><div className="mt-1 text-xs text-slate-500">{formatInteger(selectedSummary.vmsUnits)} units · {formatInteger(selectedSummary.vmsTransactionCount)} successful sales</div></section>
        <section className="surface-card"><div className="text-sm text-slate-500">Cash counted / الكاش المعدود</div><div className="mt-2 text-3xl font-semibold text-slate-950">{lyd(selectedSummary.cashCountedAmount)}</div><div className="mt-1 text-xs text-slate-500">{formatInteger(selectedSummary.countedCollectionCount)} count record(s), filtered by counted_at. See exactly which machines below.</div></section>
        <section className="surface-card"><div className="text-sm text-slate-500">Difference / الفرق</div><div className={`mt-2 text-3xl font-semibold ${differenceClass(selectedSummary.varianceAmount)}`}>{formatDelta(selectedSummary.varianceAmount)}</div><div className="mt-1 text-xs text-slate-500">Cash counted minus VMS sales</div></section>
        <section className="surface-card"><div className="text-sm text-slate-500">Match rate / نسبة المطابقة</div><div className="mt-2 text-3xl font-semibold text-slate-950">{formatPercent(selectedSummary.accuracy)}</div><div className="mt-1 text-xs text-slate-500">Cash counted divided by VMS sales</div></section>
        <section className="surface-card"><div className="text-sm text-slate-500">Pending cash counts</div><div className="mt-2 text-3xl font-semibold text-slate-950">{formatInteger(selectedSummary.pendingCollectionCount)}</div><div className="mt-1 text-xs text-slate-500">Removed in this period but not counted; excluded from counted cash</div></section>
        <section className="surface-card"><div className="text-sm text-slate-500">Variance review records</div><div className="mt-2 text-3xl font-semibold text-slate-950">{formatInteger(selectedSummary.varianceReviewCount)}</div><div className="mt-1 text-xs text-slate-500">Counted collections already flagged for review</div></section>
        <section className="surface-card sm:col-span-2"><div className="text-sm text-slate-500">VMS source</div><div className="mt-2 text-xl font-semibold text-slate-950">{selectedSourceReportType.replaceAll("_", " ")}{selectedMonthlyCalendarFallbackUsed ? " · combined by calendar month" : ""}</div><div className="mt-1 text-xs text-slate-500">{selectedMonthlyCalendarFallbackUsed ? "The exact custom-range source returned no VMS activity, so Snacky OS combined the same finalized monthly VMS records that appear when each month is selected separately." : "Selected dates are passed to the same finalized VMS sales source used by the Sales Dashboard."}</div></section>
      </div>

      {selectedSummary.paymentSplitAvailable ? (
        <SectionCard>
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">VMS cash payments</div><div className="mt-1 text-xl font-semibold">{lyd(selectedSummary.vmsCashSalesAmount)}</div></div>
            <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">VMS card payments</div><div className="mt-1 text-xl font-semibold">{lyd(selectedSummary.vmsCardSalesAmount)}</div></div>
            <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">VMS unknown payments</div><div className="mt-1 text-xl font-semibold">{lyd(selectedSummary.vmsUnknownSalesAmount)}</div></div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard>
        <div className="p-4 text-sm leading-6 text-slate-700">
          <strong>Comparison rule:</strong> VMS uses sale/business dates inside the selected range. Cash uses <code>counted_at</code> inside that exact same range. The report does not use the cash removal date for the counted total. Difference = cash counted − VMS sales.
        </div>
      </SectionCard>

      {!hasActivity ? (
        <EmptyState title="No VMS sales or counted cash found" body="Choose another range, import the VMS sales file, or count a cash collection." action={<SecondaryButton href="/cash-collections">Open cash collections</SecondaryButton>} />
      ) : (
        <div className="mt-6 space-y-6">
          <section className="surface-card">
            <div className="border-b border-slate-200 pb-4">
              <h2 className="text-base font-semibold text-slate-950">Previous-period comparison</h2>
              <p className="mt-1 text-sm text-slate-500">{comparisonSubtitle}</p>
            </div>
            {comparisonRange && comparisonSummary && !comparisonVmsSummaryResult.error ? (
              <div className="mt-4">
                <DataTable headers={["Metric", "Selected range", comparisonRange.label, "Delta"]}>
                  {comparisonMetrics(selectedSummary, comparisonSummary).map((row) => (
                    <tr key={row.label}><td className="font-medium">{row.label}</td><td>{row.selected}</td><td>{row.comparison}</td><td className="font-semibold">{row.delta}</td></tr>
                  ))}
                </DataTable>
              </div>
            ) : <p className="mt-4 text-sm text-slate-500">A previous-period comparison is not available for this selection.</p>}
          </section>

          <section className="surface-card">
            <div className="border-b border-slate-200 pb-4">
              <h2 className="text-base font-semibold text-slate-950">Which machine has the difference?</h2>
              <p className="mt-1 text-sm text-slate-500">Each row compares that machine's VMS expected sales with the cash Finance counted for that machine during the selected dates. Largest differences appear first.</p>
            </div>
            {machineRows.length ? (
              <div className="mt-4">
                <DataTable sortable showSummary headers={["Machine", "Location", "VMS expected sales for machine", "VMS units", "Cash counted for machine", "Difference for machine", "Match rate", "Counted pickups", "Latest finance count", "Result"]}>
                  {[...machineRows].sort((left, right) => Math.abs(right.rangeVariance) - Math.abs(left.rangeVariance) || right.vmsSalesAmount - left.vmsSalesAmount || left.machineLabel.localeCompare(right.machineLabel)).map((row) => (
                    <tr key={row.key}>
                      <td className="font-medium"><div>{row.machineLabel}</div><div className="mt-1 text-xs text-slate-500">{row.machineCode ?? row.machineId ?? "Unmatched VMS/cash machine — fix mapping"}</div></td>
                      <td>{row.locationLabel}</td>
                      <td>{lyd(row.vmsSalesAmount)}</td>
                      <td>{formatInteger(row.unitsSold)}</td>
                      <td>{lyd(row.countedCash)}</td>
                      <td className={differenceClass(row.rangeVariance)}>{formatDelta(row.rangeVariance)}</td>
                      <td>{formatPercent(row.rangeAccuracy)}</td>
                      <td>{formatInteger(row.collectionCount)}</td>
                      <td>{row.latestCountedAt ? new Date(row.latestCountedAt).toLocaleString("en-US") : "-"}</td>
                      <td><StatusBadge status={machineStatus(row.vmsSalesAmount, row.countedCash, row.rangeVariance)} /></td>
                    </tr>
                  ))}
                </DataTable>
              </div>
            ) : <EmptyState title="No machine comparison rows" body="Import VMS sales or count cash for the selected period." />}
          </section>

          <section className="surface-card">
            <div className="border-b border-slate-200 pb-4">
              <h2 className="text-base font-semibold text-slate-950">Daily comparison</h2>
              <p className="mt-1 text-sm text-slate-500">Cash is grouped by the day Finance counted it.</p>
            </div>
            {showDayBreakdown ? (
              dayRows.length ? <div className="mt-4"><DataTable headers={["Day", "VMS sales", "Cash counted", "Difference", "Count records"]}>{dayRows.map((row) => <tr key={row.key}><td className="font-medium">{row.label}</td><td>{lyd(row.vmsSalesAmount)}</td><td>{lyd(row.cashCountedAmount)}</td><td className={differenceClass(row.varianceAmount)}>{formatDelta(row.varianceAmount)}</td><td>{formatInteger(row.countedCollectionCount)}</td></tr>)}</DataTable></div> : <p className="mt-4 text-sm text-slate-500">No daily rows found.</p>
            ) : <p className="mt-4 text-sm text-slate-500">Daily VMS detail requires a detailed sales source and a selected range of 62 days or fewer.</p>}
          </section>

          <section className="surface-card">
            <div className="border-b border-slate-200 pb-4">
              <h2 className="text-base font-semibold text-slate-950">Monthly comparison</h2>
              <p className="mt-1 text-sm text-slate-500">Useful for year and all-time selections.</p>
            </div>
            {monthRows.length ? <div className="mt-4"><DataTable headers={["Month", "VMS sales", "Cash counted", "Difference", "Count records"]}>{monthRows.map((row) => <tr key={row.key}><td className="font-medium">{row.label}</td><td>{lyd(row.vmsSalesAmount)}</td><td>{lyd(row.cashCountedAmount)}</td><td className={differenceClass(row.varianceAmount)}>{formatDelta(row.varianceAmount)}</td><td>{formatInteger(row.countedCollectionCount)}</td></tr>)}</DataTable></div> : <p className="mt-4 text-sm text-slate-500">No monthly rows found.</p>}
          </section>
        </div>
      )}
    </>
  );
}
