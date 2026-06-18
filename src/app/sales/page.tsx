import Link from "next/link";
import type { ReactNode } from "react";
import { BarList, KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatInteger, groupSum } from "@/lib/kpi";
import { cleanSearchParams, type SearchParamsRecord } from "@/lib/pagination";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import {
  buildSalesFileContributions,
  formatSalesRangeLabel,
  rangesOverlap,
  resolveSalesDashboardRange,
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

type SalesRow = {
  id: string;
  import_batch_id: string | null;
  machine_id: string | null;
  product_id: string | null;
  units_sold: number | string | null;
  transaction_count: number | string | null;
  net_sales_amount: number | string | null;
  gross_sales_amount: number | string | null;
  cash_sales_amount: number | string | null;
  card_sales_amount: number | string | null;
  sale_date: string | null;
  sales_month: string | null;
  period_start: string | null;
  period_end: string | null;
  machine_name: string | null;
  location_name: string | null;
  product_name: string | null;
};

type TransactionStatusRow = {
  sale_date: string | null;
  failed_vend_count: number | string | null;
  failed_vend_amount: number | string | null;
  refund_count: number | string | null;
  refund_amount: number | string | null;
  failed_payment_count: number | string | null;
  needs_review_count: number | string | null;
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

function buildBatchMetricsById(rows: SalesRow[]) {
  const metricsByBatchId = new Map<string, { latestTransactionAt: string | null; rows: number; salesAmount: number }>();

  rows.forEach((row) => {
    const batchId = String(row.import_batch_id ?? "").trim();
    if (!batchId) return;

    const current = metricsByBatchId.get(batchId) ?? { latestTransactionAt: null, rows: 0, salesAmount: 0 };
    const candidateTimestamp = row.period_end ?? row.period_start ?? row.sale_date ?? null;

    metricsByBatchId.set(batchId, {
      latestTransactionAt: latestTimestamp([current.latestTransactionAt, candidateTimestamp]),
      rows: current.rows + 1,
      salesAmount: current.salesAmount + numericValue(row.net_sales_amount ?? row.gross_sales_amount),
    });
  });

  return metricsByBatchId;
}

function latestTimestamp(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
    .at(-1) ?? null;
}

async function SalesDashboardPageContent({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord & SalesDashboardSearchParams>;
}) {
  await requireCurrentProfileForPath("/sales");
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

  const batchResult = await safeSupabaseQuery<VmsDashboardBatch>({
    label: "sales.vms_import_batches",
    promise: queryVmsDashboardBatches(supabase, {
      reportTypes: ["vms_order_details_weekly", "sales"],
      orderBy: "uploaded_at",
      ascending: false,
    }),
  });

  const batches = batchResult.data as VmsDashboardBatch[];
  const selectedRange = resolveSalesDashboardRange(params, batches, renderedAt);
  const selectedRangeLabel = formatSalesRangeLabel(selectedRange);

  const [salesResult, statusResult] = await Promise.all([
    safeSupabaseQuery<SalesRow>({
      label: "sales.vms_sales_clean.filtered",
      promise: supabase
        .from("vms_sales_clean")
        .select("id, import_batch_id, machine_id, product_id, units_sold, transaction_count, net_sales_amount, gross_sales_amount, cash_sales_amount, card_sales_amount, sale_date, sales_month, period_start, period_end, machine_name, location_name, product_name")
        .gte("sale_date", selectedRange.start)
        .lte("sale_date", selectedRange.end)
        .order("sale_date", { ascending: true }),
    }),
    safeSupabaseQuery<TransactionStatusRow>({
      label: "sales.vms_transaction_status_daily.filtered",
      promise: supabase
        .from("vms_transaction_status_daily")
        .select("sale_date, failed_vend_count, failed_vend_amount, refund_count, refund_amount, failed_payment_count, needs_review_count")
        .gte("sale_date", selectedRange.start)
        .lte("sale_date", selectedRange.end)
        .order("sale_date", { ascending: true }),
    }),
  ]);

  const sales = salesResult.data as SalesRow[];
  const statuses = statusResult.data as TransactionStatusRow[];
  const metricsByBatchId = buildBatchMetricsById(sales);
  const fileContributions = buildSalesFileContributions({
    batches,
    metricsByBatchId,
    range: selectedRange,
  });
  const contributingFiles = fileContributions.filter((row) => row.included);
  const ignoredFiles = fileContributions.filter((row) => !row.included);
  const detailedFiles = batches.filter((batch) => batch.report_type === "vms_order_details_weekly");
  const summaryOnlyFiles = fileContributions.filter((row) => row.batch.report_type === "sales");
  const overlappingSummaryFiles = summaryOnlyFiles.filter((row) => (
    row.coverageStart
    && row.coverageEnd
    && rangesOverlap({ start: row.coverageStart, end: row.coverageEnd }, { start: selectedRange.start, end: selectedRange.end })
  ));
  const coverage = vmsCoverageSummary(batches);
  const missingPeriods = coverage.gaps.filter((gap) => rangesOverlap(gap, { start: selectedRange.start, end: selectedRange.end }));
  const totalSales = sales.reduce((sum, row) => sum + numericValue(row.net_sales_amount ?? row.gross_sales_amount), 0);
  const totalUnits = sales.reduce((sum, row) => sum + numericValue(row.units_sold), 0);
  const totalTransactions = sales.reduce((sum, row) => sum + numericValue(row.transaction_count), 0);
  const totalCash = sales.reduce((sum, row) => sum + numericValue(row.cash_sales_amount), 0);
  const totalCard = sales.reduce((sum, row) => sum + numericValue(row.card_sales_amount), 0);
  const hasTenderBreakdown = sales.some((row) => numericValue(row.cash_sales_amount) > 0 || numericValue(row.card_sales_amount) > 0);
  const statusTotals = statuses.reduce((totals, row) => ({
    failedVendCount: totals.failedVendCount + numericValue(row.failed_vend_count),
    failedVendAmount: totals.failedVendAmount + numericValue(row.failed_vend_amount),
    refundCount: totals.refundCount + numericValue(row.refund_count),
    refundAmount: totals.refundAmount + numericValue(row.refund_amount),
    failedPaymentCount: totals.failedPaymentCount + numericValue(row.failed_payment_count),
    needsReviewCount: totals.needsReviewCount + numericValue(row.needs_review_count),
  }), { failedVendCount: 0, failedVendAmount: 0, refundCount: 0, refundAmount: 0, failedPaymentCount: 0, needsReviewCount: 0 });
  const failedVendRate = totalTransactions + statusTotals.failedVendCount > 0
    ? `${((statusTotals.failedVendCount / (totalTransactions + statusTotals.failedVendCount)) * 100).toFixed(1)}%`
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

  return (
    <>
      <PageHeader
        title="Sales Dashboard"
        subtitle="Detailed VMS Order Details drive Snacky sales KPIs. Use the date filters below to control exactly which detailed rows, files, and missing periods are counted."
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
              <p className="mt-1 text-sm text-slate-500">Filter KPIs and file contributions to one calendar month.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="hidden" name="range" value="month" />
                <input name="month" type="month" defaultValue={selectedRange.monthValue} className="field-input" />
                <button className="btn-secondary">Apply month</button>
              </div>
            </form>

            <form className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Specific date</div>
              <p className="mt-1 text-sm text-slate-500">Inspect a single vending day without carrying older totals forward.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="hidden" name="range" value="date" />
                <input name="date" type="date" defaultValue={selectedRange.dateValue} className="field-input" />
                <button className="btn-secondary">Apply date</button>
              </div>
            </form>

            <form className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Custom range</div>
              <p className="mt-1 text-sm text-slate-500">Use an exact start and end date for investigations or partial-period review.</p>
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
            <div className="mt-1 text-lg font-semibold text-slate-900">Showing sales from {selectedRangeLabel}</div>
            <p className="mt-1 text-sm text-slate-500">{selectedRange.helperText}</p>
          </div>
        </section>

        <KpiSection
          title="Data Source Summary"
          subtitle="Sales dashboard totals use detailed VMS Order Details rows where transaction_status = successful_sale. Summary sales files remain reconciliation-only and are shown below for clarity, not for totals."
        >
          <KpiLoadWarning message={batchResult.error} />

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
              <div>
                <div className="font-semibold text-slate-900">Selected date range</div>
                <div>{selectedRangeLabel}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">Detailed VMS rows used</div>
                <div>{formatInteger(sales.length)}</div>
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
                  "File date coverage",
                  "Imported rows total",
                  "Rows inside selected filter",
                  "Sales amount inside selected filter",
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
                    <td>{row.coverageLabel}</td>
                    <td className="text-sm">
                      <div>{formatInteger(row.importedRowsTotal)}</div>
                      {row.batch.report_type === "vms_order_details_weekly" ? (
                        <div className="mt-1 text-xs text-slate-500">
                          Successful sales: {formatInteger(Number(row.batch.successful_rows_count ?? 0))}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatInteger(row.rowsInRange)}</td>
                    <td>{lyd(row.salesAmountInRange)}</td>
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
        </KpiSection>

        <KpiLoadWarning message={salesResult.error} />
        <KpiLoadWarning message={statusResult.error} />

        {!sales.length ? (
          <EmptyState
            title="No detailed sales rows found for this date range."
            body="Summary-only files, preview batches, inactive batches, and files outside the selected range do not feed these KPIs. Adjust the filter or upload finalized Order Details XLS files for the missing period."
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiSection title="Total sales"><MetricValue>{lyd(totalSales)}</MetricValue></KpiSection>
              <KpiSection title="Units sold"><MetricValue>{formatInteger(totalUnits)}</MetricValue></KpiSection>
              <KpiSection title="Average transaction"><MetricValue>{totalTransactions ? lyd(totalSales / totalTransactions) : "Unknown / not mapped"}</MetricValue></KpiSection>
              <KpiSection title="Failed vend rate"><MetricValue>{failedVendRate}</MetricValue></KpiSection>
              <KpiSection title="Cash sales"><MetricValue compact={!hasTenderBreakdown}>{hasTenderBreakdown ? lyd(totalCash) : "Not available in selected files"}</MetricValue></KpiSection>
              <KpiSection title="Card sales"><MetricValue compact={!hasTenderBreakdown}>{hasTenderBreakdown ? lyd(totalCard) : "Not available in selected files"}</MetricValue></KpiSection>
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
                <BarList rows={[{ label: "Cash", value: totalCash }, { label: "Card", value: totalCard }]} valueFormatter={lyd} />
              </KpiSection>
            ) : (
              <EmptyState title="No cash vs card split available" body="Selected detailed files do not contain usable payment-type splits, so Snacky OS shows total sales only." />
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
