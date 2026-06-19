import Link from "next/link";
import { redirect } from "next/navigation";
import { BarList, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { lyd, pct } from "@/lib/format";
import { formatInteger } from "@/lib/kpi";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";

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

type CashReconciliationSummaryRow = {
  collection_count: number | string | null;
  counted_collection_count: number | string | null;
  pending_collection_count: number | string | null;
  variance_review_count: number | string | null;
  expected_cash_amount: number | string | null;
  actual_cash_collected_amount: number | string | null;
  variance_amount: number | string | null;
  variance_rate: number | string | null;
};

type CashReconciliationBreakdownRow = {
  bucket_key: string | null;
  bucket_label: string | null;
  sort_key: string | null;
  expected_cash_amount: number | string | null;
  actual_cash_collected_amount: number | string | null;
  variance_amount: number | string | null;
  collection_count: number | string | null;
  counted_collection_count: number | string | null;
  pending_collection_count: number | string | null;
  variance_review_count: number | string | null;
};

type CashSummary = {
  collectionCount: number;
  countedCollectionCount: number;
  pendingCollectionCount: number;
  varianceReviewCount: number;
  expectedCashAmount: number;
  actualCashCollectedAmount: number;
  varianceAmount: number;
  varianceRate: number;
};

type CashBreakdownRow = {
  bucketKey: string;
  bucketLabel: string;
  sortKey: string;
  expectedCashAmount: number;
  actualCashCollectedAmount: number;
  varianceAmount: number;
  collectionCount: number;
  countedCollectionCount: number;
  pendingCollectionCount: number;
  varianceReviewCount: number;
};

type MetricRow = {
  label: string;
  selected: string;
  comparison: string;
  delta: string;
};

const EMPTY_CASH_SUMMARY: CashSummary = {
  collectionCount: 0,
  countedCollectionCount: 0,
  pendingCollectionCount: 0,
  varianceReviewCount: 0,
  expectedCashAmount: 0,
  actualCashCollectedAmount: 0,
  varianceAmount: 0,
  varianceRate: 0,
};

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
  const shifted = new Date(dateFromParts(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))));
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
    return cashRangeWithDefaults({
      key: "today",
      label: "Today",
      helperText: "Showing cash collections collected today.",
      start: today,
      end: today,
    });
  }

  if (rawRange === "yesterday") {
    const yesterday = formatLocalDate(addDays(now, -1));
    return cashRangeWithDefaults({
      key: "yesterday",
      label: "Yesterday",
      helperText: "Showing cash collections collected yesterday.",
      start: yesterday,
      end: yesterday,
    });
  }

  if (rawRange === "this_month") {
    return cashRangeWithDefaults({
      key: "this_month",
      label: "This month",
      helperText: "Showing cash collections collected from the first day of this month through today.",
      start: formatLocalDate(startOfMonth(now)),
      end: today,
    });
  }

  if (rawRange === "last_month") {
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return cashRangeWithDefaults({
      key: "last_month",
      label: "Last month",
      helperText: "Showing cash collections from the previous calendar month.",
      start: formatLocalDate(startOfMonth(previousMonth)),
      end: formatLocalDate(endOfMonth(previousMonth)),
    });
  }

  if (rawRange === "this_year") {
    return cashRangeWithDefaults({
      key: "this_year",
      label: "This year",
      helperText: "Showing cash collections from January 1 through today.",
      start: formatLocalDate(startOfYear(now)),
      end: today,
    });
  }

  if (rawRange === "month" && monthValue) {
    const [year, month] = monthValue.split("-").map(Number);
    const monthDate = dateFromParts(year, month, 1);
    return cashRangeWithDefaults({
      key: "month",
      label: monthLabel(monthValue),
      helperText: `Showing cash collections for ${monthLabel(monthValue)}.`,
      start: formatLocalDate(startOfMonth(monthDate)),
      end: formatLocalDate(endOfMonth(monthDate)),
    });
  }

  if (rawRange === "year" && yearValue) {
    return cashRangeWithDefaults({
      key: "year",
      label: yearValue,
      helperText: `Showing cash collections for ${yearValue}.`,
      start: `${yearValue}-01-01`,
      end: `${yearValue}-12-31`,
    });
  }

  if (rawRange === "all_time") {
    return cashRangeWithDefaults({
      key: "all_time",
      label: "All time",
      helperText: "Showing every cash collection currently available in Snacky OS.",
      start: null,
      end: null,
    });
  }

  if (rawRange === "date" && singleDate) {
    return cashRangeWithDefaults({
      key: "date",
      label: singleDate,
      helperText: "Showing cash collections collected on the selected date.",
      start: singleDate,
      end: singleDate,
    });
  }

  if (rawRange === "custom" || customStart || customEnd) {
    const start = customStart ?? customEnd ?? today;
    const end = customEnd ?? customStart ?? today;
    return cashRangeWithDefaults({
      key: "custom",
      label: "Custom range",
      helperText: "Showing cash collections for your custom date range.",
      start,
      end,
    });
  }

  return cashRangeWithDefaults({
    key: "this_month",
    label: "This month",
    helperText: "Showing cash collections collected from the first day of this month through today.",
    start: formatLocalDate(startOfMonth(now)),
    end: today,
  });
}

function buildCashComparisonRange(range: CashRange) {
  if (range.key === "all_time" || !range.start || !range.end) return null;

  if (range.key === "month" || range.key === "last_month") {
    const [year, month] = range.start.slice(0, 7).split("-").map(Number);
    const previousMonth = new Date(year, month - 2, 1);
    return cashRangeWithDefaults({
      key: "month",
      label: monthLabel(formatDateMonth(previousMonth)),
      helperText: "Comparison period: previous calendar month.",
      start: formatLocalDate(startOfMonth(previousMonth)),
      end: formatLocalDate(endOfMonth(previousMonth)),
    });
  }

  if (range.key === "year") {
    const year = Number(range.start.slice(0, 4)) - 1;
    return cashRangeWithDefaults({
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
    return cashRangeWithDefaults({
      key: "this_year",
      label: `${currentYear - 1} YTD`,
      helperText: "Comparison period: previous year to date.",
      start: `${currentYear - 1}-01-01`,
      end: formatLocalDate(comparisonEndDate),
    });
  }

  const dayCount = inclusiveDayCount(range.start, range.end);
  const comparisonEnd = shiftIsoDate(range.start, -1);
  const comparisonStart = shiftIsoDate(comparisonEnd, -(dayCount - 1));
  return cashRangeWithDefaults({
    key: "custom",
    label: "Previous period",
    helperText: "Comparison period: the immediately preceding date span with the same number of days.",
    start: comparisonStart,
    end: comparisonEnd,
  });
}

function formatDelta(value: number) {
  const rounded = Number(value.toFixed(2));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${lyd(rounded)}`;
}

function formatPercentPointDelta(value: number) {
  const rounded = Number(value.toFixed(1));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1)} pp`;
}

function normalizeCashSummary(row?: CashReconciliationSummaryRow | null): CashSummary {
  if (!row) return EMPTY_CASH_SUMMARY;
  return {
    collectionCount: Number(row.collection_count ?? 0),
    countedCollectionCount: Number(row.counted_collection_count ?? 0),
    pendingCollectionCount: Number(row.pending_collection_count ?? 0),
    varianceReviewCount: Number(row.variance_review_count ?? 0),
    expectedCashAmount: Number(row.expected_cash_amount ?? 0),
    actualCashCollectedAmount: Number(row.actual_cash_collected_amount ?? 0),
    varianceAmount: Number(row.variance_amount ?? 0),
    varianceRate: Number(row.variance_rate ?? 0),
  };
}

function normalizeCashBreakdownRows(rows: CashReconciliationBreakdownRow[]) {
  return rows.map((row) => ({
    bucketKey: String(row.bucket_key ?? ""),
    bucketLabel: String(row.bucket_label ?? row.bucket_key ?? "Unknown"),
    sortKey: String(row.sort_key ?? row.bucket_key ?? row.bucket_label ?? ""),
    expectedCashAmount: Number(row.expected_cash_amount ?? 0),
    actualCashCollectedAmount: Number(row.actual_cash_collected_amount ?? 0),
    varianceAmount: Number(row.variance_amount ?? 0),
    collectionCount: Number(row.collection_count ?? 0),
    countedCollectionCount: Number(row.counted_collection_count ?? 0),
    pendingCollectionCount: Number(row.pending_collection_count ?? 0),
    varianceReviewCount: Number(row.variance_review_count ?? 0),
  } satisfies CashBreakdownRow));
}

function breakdownRowsToBarRows(rows: CashBreakdownRow[], mode: "chronological" | "top" = "chronological") {
  const ordered = [...rows].sort((left, right) => {
    if (mode === "top") {
      return right.actualCashCollectedAmount - left.actualCashCollectedAmount || left.bucketLabel.localeCompare(right.bucketLabel);
    }
    return left.sortKey.localeCompare(right.sortKey) || left.bucketLabel.localeCompare(right.bucketLabel);
  });

  return ordered.map((row) => ({
    label: row.bucketLabel,
    value: row.actualCashCollectedAmount,
    detail: `${lyd(row.expectedCashAmount)} expected | ${formatDelta(row.varianceAmount)} variance${row.pendingCollectionCount > 0 ? ` | ${formatInteger(row.pendingCollectionCount)} pending` : ""}`,
  }));
}

function metricRows(selected: CashSummary, comparison: CashSummary): MetricRow[] {
  return [
    {
      label: "Expected cash",
      selected: lyd(selected.expectedCashAmount),
      comparison: lyd(comparison.expectedCashAmount),
      delta: formatDelta(selected.expectedCashAmount - comparison.expectedCashAmount),
    },
    {
      label: "Actual cash",
      selected: lyd(selected.actualCashCollectedAmount),
      comparison: lyd(comparison.actualCashCollectedAmount),
      delta: formatDelta(selected.actualCashCollectedAmount - comparison.actualCashCollectedAmount),
    },
    {
      label: "Variance",
      selected: formatDelta(selected.varianceAmount),
      comparison: formatDelta(comparison.varianceAmount),
      delta: formatDelta(selected.varianceAmount - comparison.varianceAmount),
    },
    {
      label: "Collections",
      selected: formatInteger(selected.collectionCount),
      comparison: formatInteger(comparison.collectionCount),
      delta: formatInteger(selected.collectionCount - comparison.collectionCount),
    },
    {
      label: "Pending count",
      selected: formatInteger(selected.pendingCollectionCount),
      comparison: formatInteger(comparison.pendingCollectionCount),
      delta: formatInteger(selected.pendingCollectionCount - comparison.pendingCollectionCount),
    },
    {
      label: "Variance review",
      selected: formatInteger(selected.varianceReviewCount),
      comparison: formatInteger(comparison.varianceReviewCount),
      delta: formatInteger(selected.varianceReviewCount - comparison.varianceReviewCount),
    },
    {
      label: "Variance rate",
      selected: pct(selected.varianceRate),
      comparison: pct(comparison.varianceRate),
      delta: formatPercentPointDelta((selected.varianceRate - comparison.varianceRate) * 100),
    },
  ];
}

function filterButtonClass(active: boolean) {
  return active ? "btn-primary" : "btn-secondary";
}

function createRangeHref(range: string) {
  return `/reports/cash-reconciliation?range=${encodeURIComponent(range)}`;
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
  ) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return <ErrorState title="Cash reconciliation unavailable" body="Supabase is not configured, so Snacky OS cannot load cash reconciliation reports." />;
  }

  const params = await searchParams;
  const selectedRange = resolveCashReconciliationRange(params);
  const comparisonRange = buildCashComparisonRange(selectedRange);

  const [summaryResult, comparisonSummaryResult, dayBreakdownResult, monthBreakdownResult, machineBreakdownResult] = await Promise.all([
    safeSupabaseQuery<CashReconciliationSummaryRow>({
      label: "cash-reconciliation.summary",
      promise: supabase.rpc("cash_reconciliation_summary", {
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
    }),
    comparisonRange
      ? safeSupabaseQuery<CashReconciliationSummaryRow>({
          label: "cash-reconciliation.comparison-summary",
          promise: supabase.rpc("cash_reconciliation_summary", {
            p_date_from: comparisonRange.start,
            p_date_to: comparisonRange.end,
          }),
        })
      : Promise.resolve({ data: [] as CashReconciliationSummaryRow[], count: 0, error: null as string | null }),
    safeSupabaseQuery<CashReconciliationBreakdownRow>({
      label: "cash-reconciliation.breakdown.day",
      promise: supabase.rpc("cash_reconciliation_breakdown", {
        p_dimension: "day",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
    }),
    safeSupabaseQuery<CashReconciliationBreakdownRow>({
      label: "cash-reconciliation.breakdown.month",
      promise: supabase.rpc("cash_reconciliation_breakdown", {
        p_dimension: "month",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
    }),
    safeSupabaseQuery<CashReconciliationBreakdownRow>({
      label: "cash-reconciliation.breakdown.machine",
      promise: supabase.rpc("cash_reconciliation_breakdown", {
        p_dimension: "machine",
        p_date_from: selectedRange.start,
        p_date_to: selectedRange.end,
      }),
    }),
  ]);

  if (summaryResult.error) {
    console.error("[cash-reconciliation] Failed to load summary", {
      selected_range: selectedRange,
      error: summaryResult.error,
    });
    return (
      <ErrorState
        title="Cash reconciliation unavailable"
        body={summaryResult.error}
        action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>}
      />
    );
  }

  const selectedSummary = normalizeCashSummary(summaryResult.data[0]);
  const comparisonSummary = comparisonRange ? normalizeCashSummary(comparisonSummaryResult.data[0]) : null;
  const comparisonSummaryValue = comparisonSummary ?? EMPTY_CASH_SUMMARY;
  const dayBreakdownRows = [...normalizeCashBreakdownRows(dayBreakdownResult.data)].sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.bucketLabel.localeCompare(right.bucketLabel));
  const monthBreakdownRows = [...normalizeCashBreakdownRows(monthBreakdownResult.data)].sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.bucketLabel.localeCompare(right.bucketLabel));
  const machineBreakdownRows = [...normalizeCashBreakdownRows(machineBreakdownResult.data)].sort((left, right) => right.actualCashCollectedAmount - left.actualCashCollectedAmount || left.bucketLabel.localeCompare(right.bucketLabel));
  const selectedRangeStart = selectedRange.start;
  const selectedRangeEnd = selectedRange.end;
  const showDayBreakdown = selectedRangeStart !== null && selectedRangeEnd !== null && inclusiveDayCount(selectedRangeStart, selectedRangeEnd) <= 62;
  const hasCollections = selectedSummary.collectionCount > 0;
  const loadWarning = [comparisonRange ? comparisonSummaryResult.error : null, dayBreakdownResult.error, monthBreakdownResult.error, machineBreakdownResult.error].filter(Boolean) as string[];
  const comparisonSubtitle = comparisonRange
    ? `Selected range ${selectedRange.label} compared with ${comparisonRange.label}.`
    : "All-time reports do not have a comparison window, so choose a finite month or year to compare side by side.";

  return (
    <>
      <PageHeader
        title={"Cash Reconciliation / \u0645\u0637\u0627\u0628\u0642\u0629 \u0627\u0644\u0643\u0627\u0634"}
        subtitle="Compare VMS expected cash against actual counted cash by collected date. Variance is actual minus expected, and pending collections stay visible until finance counts them."
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

      {loadWarning.length ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Some cash reconciliation breakdowns could not load. The main summary is still shown.
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiSection title="Expected cash"><div className="text-3xl font-semibold text-slate-900">{lyd(selectedSummary.expectedCashAmount)}</div></KpiSection>
        <KpiSection title="Actual cash collected"><div className="text-3xl font-semibold text-slate-900">{lyd(selectedSummary.actualCashCollectedAmount)}</div></KpiSection>
        <KpiSection title="Variance"><div className={`text-3xl font-semibold ${selectedSummary.varianceAmount < 0 ? "text-rose-700" : selectedSummary.varianceAmount > 0 ? "text-emerald-700" : "text-slate-900"}`}>{formatDelta(selectedSummary.varianceAmount)}</div></KpiSection>
        <KpiSection title="Collections"><div className="text-3xl font-semibold text-slate-900">{formatInteger(selectedSummary.collectionCount)}</div></KpiSection>
        <KpiSection title="Pending count"><div className="text-3xl font-semibold text-slate-900">{formatInteger(selectedSummary.pendingCollectionCount)}</div></KpiSection>
        <KpiSection title="Variance review"><div className="text-3xl font-semibold text-slate-900">{formatInteger(selectedSummary.varianceReviewCount)}</div></KpiSection>
      </div>

      <SectionCard>
        <div className="p-4 text-sm leading-6 text-slate-600">
          Variance formula: actual cash collected minus expected cash. Pending collections are counted separately so finance can see what still needs to be counted.
        </div>
      </SectionCard>

      {!hasCollections ? (
        <EmptyState
          title="No cash collections found"
          body="Cash collections will appear here once routes are closed and finance counts the cash."
          action={<SecondaryButton href="/cash-collections/new">Create cash collection</SecondaryButton>}
        />
      ) : (
        <div className="mt-6 space-y-6">
          <KpiSection title="Comparison view" subtitle={comparisonSubtitle}>
            {comparisonRange ? (
              !comparisonSummaryResult.error ? (
                <DataTable headers={["Metric", "Selected", "Comparison", "Delta"]}>
                  {metricRows(selectedSummary, comparisonSummaryValue).map((row) => (
                    <tr key={row.label}>
                      <td className="font-medium text-slate-900">{row.label}</td>
                      <td>{row.selected}</td>
                      <td>{row.comparison}</td>
                      <td className="font-semibold text-slate-900">{row.delta}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <p className="text-sm text-slate-500">Comparison data could not load for the selected period. Try the report again or switch to a different range.</p>
              )
            ) : (
              <p className="text-sm text-slate-500">All-time reports do not have a natural comparison range. Switch to a month, date, or year report to see a side-by-side comparison.</p>
            )}
          </KpiSection>

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Cash by day" subtitle={selectedRange.label}>
              {showDayBreakdown ? (
                <BarList rows={breakdownRowsToBarRows(dayBreakdownRows)} valueFormatter={lyd} />
              ) : (
                <p className="text-sm text-slate-500">Daily detail is hidden for longer ranges. Switch to a month or custom range of 62 days or fewer to see the daily view.</p>
              )}
            </KpiSection>
            <KpiSection title="Cash by month" subtitle={selectedRange.label}>
              <BarList rows={breakdownRowsToBarRows(monthBreakdownRows)} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Cash by machine" subtitle={selectedRange.label}>
              <BarList rows={breakdownRowsToBarRows(machineBreakdownRows, "top").slice(0, 10)} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Collection mix" subtitle={selectedRange.label}>
              <BarList
                rows={[
                  { label: "Counted", value: selectedSummary.countedCollectionCount, detail: `${formatInteger(selectedSummary.collectionCount)} total collections` },
                  { label: "Pending", value: selectedSummary.pendingCollectionCount, detail: "Waiting for finance count" },
                  { label: "Variance review", value: selectedSummary.varianceReviewCount, detail: "Needs attention" },
                ]}
                valueFormatter={formatInteger}
              />
            </KpiSection>
          </div>
        </div>
      )}
    </>
  );
}
