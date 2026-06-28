import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { canConfirmVmsImports, canViewVmsImports } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { formatInteger } from "@/lib/kpi";
import { resolveSalesDashboardRange, salesDashboardPrefersMonthlyProfitSource, type SalesDashboardSearchParams } from "@/lib/sales-dashboard";
import {
  enumerateMonthDays,
  formatCoverageMonthLabel,
  monthCoverageCoveredDays,
  monthValuesForYear,
  normalizeSalesCoverageRows,
  salesDashboardSourceLabel,
  summarizeSalesCoverage,
  type NormalizedSalesMonthlyCoverageRow,
  type SalesMonthlyCoverageRow,
} from "@/lib/sales-coverage";
import {
  createVmsImportDuplicateContextMap,
  describeVmsImportBatchStatus,
  vmsImportReportTypeLabel,
  type VmsImportBatchLike,
} from "@/lib/vms-import-status";
import { formatVmsDateTime, isActiveImportedVmsBatch } from "@/lib/vms-dashboard-source";
import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";
import { extractVmsSchemaIssue, vmsSchemaIssueMessage } from "@/lib/vms-schema-diagnostics";

export const dynamic = "force-dynamic";

type SalesCoverageSearchParams = SalesDashboardSearchParams;

type SalesCoverageBatchRow = VmsImportBatchLike & {
  file_type?: string | null;
  imported_by?: string | null;
  latest_error?: string | null;
  last_error?: string | null;
  rows_skipped_duplicate?: number | null;
  sheet_name?: string | null;
  source_usage?: unknown;
  dashboard_usage?: unknown;
  uploaded_by?: string | null;
};

type CoverageLoadResult = {
  batches: SalesCoverageBatchRow[];
  error: string | null;
  schemaNotice: string | null;
};

type CoverageRpcRow = SalesMonthlyCoverageRow;

const preferredBatchSelect = [
  "id",
  "source_type",
  "file_name",
  "file_type",
  "sheet_name",
  "report_type",
  "status",
  "is_active",
  "file_hash",
  "uploaded_by",
  "uploaded_at",
  "imported_by",
  "imported_at",
  "deleted_at",
  "disabled_at",
  "disable_reason",
  "delete_reason",
  "rows_found",
  "row_count",
  "rows_imported",
  "rows_skipped_duplicate",
  "rows_needing_review",
  "latest_error",
  "last_error",
  "report_start_date",
  "report_end_date",
  "detected_min_datetime",
  "detected_max_datetime",
  "total_successful_sales",
  "successful_rows_count",
  "failed_rows_count",
  "refunded_rows_count",
  "source_usage",
  "dashboard_usage",
  "original_file_name",
].join(", ");

const legacyBatchSelect = [
  "id",
  "source_type",
  "file_name",
  "report_type",
  "status",
  "is_active",
  "uploaded_by",
  "uploaded_at",
  "imported_by",
  "imported_at",
  "deleted_at",
  "file_hash",
  "rows_found",
  "row_count",
  "rows_imported",
  "rows_needing_review",
  "report_start_date",
  "report_end_date",
  "detected_min_datetime",
  "detected_max_datetime",
  "total_successful_sales",
  "successful_rows_count",
  "failed_rows_count",
  "refunded_rows_count",
  "latest_error",
  "last_error",
  "original_file_name",
].join(", ");

function reportTypeValue(batch: SalesCoverageBatchRow) {
  return String(batch.report_type ?? batch.source_type ?? "").trim();
}

function coverageBatchLabel(batch: SalesCoverageBatchRow) {
  return batch.original_file_name ?? batch.file_name ?? "-";
}

function selectedMonthPillClass(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("ready")) return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (normalized.includes("partial") || normalized.includes("action")) return "border-amber-200 bg-amber-50 text-amber-900";
  if (normalized.includes("missing") || normalized.includes("attention")) return "border-rose-200 bg-rose-50 text-rose-900";
  return "border-slate-200 bg-slate-50 text-slate-900";
}

function formatBatchCoverage(batch: SalesCoverageBatchRow) {
  const coverage = batch.report_start_date && batch.report_end_date
    ? { start: batch.report_start_date, end: batch.report_end_date }
    : { start: batch.detected_min_datetime?.slice(0, 10) ?? "", end: batch.detected_max_datetime?.slice(0, 10) ?? "" };
  if (coverage.start && coverage.end) return `${coverage.start} to ${coverage.end}`;
  if (coverage.start || coverage.end) return coverage.start || coverage.end;
  return "-";
}

async function loadCoverageBatches(supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>) {
  const preferred = await supabase
    .from("vms_import_batches")
    .select(preferredBatchSelect)
    .in("report_type", ["vms_order_details_weekly", "monthly_product_profit", "sales"])
    .order("uploaded_at", { ascending: false, nullsFirst: false });

  if (!preferred.error) {
    return {
      batches: (preferred.data ?? []) as unknown as SalesCoverageBatchRow[],
      error: null,
      schemaNotice: null,
    } satisfies CoverageLoadResult;
  }

  const schemaIssue = extractVmsSchemaIssue(preferred.error, "vms_import_batches.sales_coverage");
  if (!schemaIssue) {
    return {
      batches: [],
      error: vmsSchemaIssueMessage(preferred.error, "vms_import_batches.sales_coverage") ?? String(preferred.error.message ?? "Could not load sales coverage batches."),
      schemaNotice: null,
    } satisfies CoverageLoadResult;
  }

  const fallback = await supabase
    .from("vms_import_batches")
    .select(legacyBatchSelect)
    .in("report_type", ["vms_order_details_weekly", "monthly_product_profit", "sales"])
    .order("uploaded_at", { ascending: false, nullsFirst: false });

  if (fallback.error) {
    return {
      batches: [],
      error: vmsSchemaIssueMessage(fallback.error, "vms_import_batches.sales_coverage") ?? String(fallback.error.message ?? "Could not load sales coverage batches."),
      schemaNotice: null,
    } satisfies CoverageLoadResult;
  }

  return {
    batches: (fallback.data ?? []) as unknown as SalesCoverageBatchRow[],
    error: null,
    schemaNotice: "VMS import database columns need the latest migration. Showing available legacy import data.",
  } satisfies CoverageLoadResult;
}

type CoverageRowsLoadResult = {
  error: string | null;
  rows: NormalizedSalesMonthlyCoverageRow[];
};

async function loadCoverageRows(supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>, sourceMode: "monthly" | "detailed"): Promise<CoverageRowsLoadResult> {
  const queryName = sourceMode === "monthly"
    ? "sales_dashboard_monthly_profit_coverage"
    : "sales_dashboard_monthly_coverage";
  const rpc = sourceMode === "monthly"
    ? supabase.rpc("sales_dashboard_monthly_profit_coverage")
    : supabase.rpc("sales_dashboard_monthly_coverage");
  const result = await rpc;
  if (result.error) {
    return {
      error: vmsSchemaIssueMessage(result.error, queryName) ?? String(result.error.message ?? "Could not load sales coverage rows."),
      rows: [],
    };
  }
  return {
    error: null,
    rows: normalizeSalesCoverageRows((result.data ?? []) as CoverageRpcRow[]),
  };
}

function coverageStateLabel({
  coverageError,
  coveredDays,
  monthDays,
  sourceBatches,
  activeBatches,
}: {
  activeBatches: SalesCoverageBatchRow[];
  coverageError: string | null;
  coveredDays: Set<string>;
  monthDays: string[];
  sourceBatches: SalesCoverageBatchRow[];
}) {
  if (coverageError) return "Needs attention";
  if (!sourceBatches.length) return "Missing";
  if (!activeBatches.length) return "Needs action";
  if (!coveredDays.size) return "Missing";
  if (coveredDays.size < monthDays.length) return "Partial";
  return "Ready";
}

function coverageStateReason({
  activeBatches,
  coverageError,
  coveredDays,
  monthDays,
  monthLabel,
  sourceBatches,
  sourceLabel,
}: {
  activeBatches: SalesCoverageBatchRow[];
  coverageError: string | null;
  coveredDays: Set<string>;
  monthDays: string[];
  monthLabel: string;
  sourceBatches: SalesCoverageBatchRow[];
  sourceLabel: string;
}) {
  if (coverageError) return "Coverage totals could not load for this view.";
  if (!sourceBatches.length) return `No finalized ${sourceLabel} files have been imported yet.`;
  if (!activeBatches.length) return `Files exist, but none are active in the dashboard yet.`;
  if (!coveredDays.size) return `Active files exist, but none overlap ${monthLabel}.`;
  if (coveredDays.size < monthDays.length) return `Some days are still missing from ${monthLabel}.`;
  return `${monthLabel} is fully covered by active files.`;
}

function BatchActionCell({
  batch,
  canManage,
  statusInfo,
}: {
  batch: SalesCoverageBatchRow;
  canManage: boolean;
  statusInfo: ReturnType<typeof describeVmsImportBatchStatus>;
}) {
  if (statusInfo.action === "view_existing" && statusInfo.relatedBatchId) {
    return (
      <Link href={`/vms-import/${statusInfo.relatedBatchId}`} className="btn-secondary whitespace-nowrap">
        {statusInfo.actionLabel ?? "Open active copy"}
      </Link>
    );
  }

  if (!canManage) {
    return <span className="text-xs text-slate-400">-</span>;
  }

  if (statusInfo.action === "review_mappings") {
    return (
      <Link href="/vms-mappings?status=needs_review" className="btn-secondary whitespace-nowrap">
        {statusInfo.actionLabel ?? "Review mappings"}
      </Link>
    );
  }

  if (statusInfo.action === "finalize") {
    return (
      <form action={updateVmsImportBatchState}>
        <input type="hidden" name="batch_id" value={batch.id} />
        <input type="hidden" name="action" value="finalize_import" />
        <FormSubmitButton className="btn-primary" pendingLabel="Finalizing...">
          {statusInfo.actionLabel ?? "Finalize / activate"}
        </FormSubmitButton>
      </form>
    );
  }

  if (statusInfo.action === "restore") {
    return (
      <form action={updateVmsImportBatchState}>
        <input type="hidden" name="batch_id" value={batch.id} />
        <input type="hidden" name="action" value="restore" />
        <FormSubmitButton className="btn-secondary" pendingLabel="Restoring...">
          {statusInfo.actionLabel ?? "Restore batch"}
        </FormSubmitButton>
      </form>
    );
  }

  if (statusInfo.action === "reprocess") {
    return (
      <form action={reprocessVmsImportBatch}>
        <input type="hidden" name="batch_id" value={batch.id} />
        <FormSubmitButton className="btn-secondary" pendingLabel="Reprocessing...">
          {statusInfo.actionLabel ?? "Reprocess file"}
        </FormSubmitButton>
      </form>
    );
  }

  return <span className="text-xs text-slate-400">-</span>;
}

async function SalesCoveragePageContent({
  searchParams,
}: {
  searchParams: Promise<SalesCoverageSearchParams>;
}) {
  const params = await searchParams;
  const profile = await requireCurrentProfileForPath("/reports/sales-coverage");
  if (!canViewVmsImports(profile)) {
    return <ErrorState title="VMS import access required" body="You do not have permission to view sales coverage." action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>} />;
  }
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return <ErrorState title="Database connection required" body="Connect Supabase to view sales coverage." />;
  }

  const batchLoad = await loadCoverageBatches(supabase);
  const renderedAt = new Date();
  const selectedRange = resolveSalesDashboardRange(params, batchLoad.batches, renderedAt);
  const sourceMode = salesDashboardPrefersMonthlyProfitSource(selectedRange) ? "monthly" : "detailed";
  const sourceLabel = salesDashboardSourceLabel(sourceMode);
  const coverageLoad = await loadCoverageRows(supabase, sourceMode);
  const monthlyCoverageRows = coverageLoad.rows;
  const coverageSummary = summarizeSalesCoverage(monthlyCoverageRows);
  const salesReportTypes = new Set(["vms_order_details_weekly", "monthly_product_profit", "sales"]);
  const salesBatches = batchLoad.batches.filter((batch) => salesReportTypes.has(reportTypeValue(batch)));
  const sourceReportType = sourceMode === "monthly" ? "monthly_product_profit" : "vms_order_details_weekly";
  const sourceBatches = salesBatches.filter((batch) => reportTypeValue(batch) === sourceReportType);
  const activeSourceBatches = sourceBatches.filter(isActiveImportedVmsBatch);
  const duplicateContexts = createVmsImportDuplicateContextMap(salesBatches);
  const selectedMonthValue = selectedRange.monthValue;
  const selectedMonthDays = selectedMonthValue ? enumerateMonthDays(selectedMonthValue) : [];
  const coveredDays = selectedMonthValue
    ? monthCoverageCoveredDays(selectedMonthValue, sourceBatches, (batch) => reportTypeValue(batch) === sourceReportType && isActiveImportedVmsBatch(batch))
    : new Set<string>();
  const selectedMonthLabel = formatCoverageMonthLabel(selectedMonthValue);
  const coverageLabel = selectedMonthDays.length ? `${coveredDays.size} / ${selectedMonthDays.length} day(s) covered` : "No month selected";
  const selectedYear = Number(selectedRange.yearValue) || renderedAt.getFullYear();
  const yearMonthRows: NormalizedSalesMonthlyCoverageRow[] = monthValuesForYear(selectedYear).map((monthValue) => monthlyCoverageRows.find((row) => row.businessMonth === monthValue) ?? {
    activeFinalizedBatchCount: 0,
    batchCount: 0,
    businessMonth: monthValue,
    finalizedBatchCount: 0,
    finalizedRows: 0,
    finalizedSuccessfulSaleAmount: 0,
    finalizedSuccessfulSaleRows: 0,
    maxBusinessDate: null,
    minBusinessDate: null,
    nullBusinessDateRows: 0,
    successfulSaleAmount: 0,
    successfulSaleRows: 0,
    totalRows: 0,
  });
  const dataStatus = coverageStateLabel({
    activeBatches: activeSourceBatches,
    coverageError: coverageLoad.error,
    coveredDays,
    monthDays: selectedMonthDays,
    sourceBatches,
  });
  const dataStatusReason = coverageStateReason({
    activeBatches: activeSourceBatches,
    coverageError: coverageLoad.error,
    coveredDays,
    monthDays: selectedMonthDays,
    monthLabel: selectedMonthLabel,
    sourceBatches,
    sourceLabel,
  });
  const canManage = canConfirmVmsImports(profile);
  const sourceStatusText = sourceBatches.length
    ? `${formatInteger(activeSourceBatches.length)} active / ${formatInteger(sourceBatches.length)} total ${sourceLabel.toLowerCase()} file(s)`
    : `No ${sourceLabel.toLowerCase()} files imported yet`;
  const batchLoadFailed = Boolean(batchLoad.error);
  const coverageLoadFailed = Boolean(coverageLoad.error);

  return (
    <>
      <PageHeader
        title="Sales Data Coverage"
        subtitle="See which sales files are active, which dates they cover, and what still needs attention."
        action={<Link href="/sales" className="btn-primary">Open sales dashboard</Link>}
      />

      <div className="space-y-6">
        {batchLoad.schemaNotice ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
            {batchLoad.schemaNotice}
          </div>
        ) : null}
        {batchLoadFailed ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {batchLoad.error}
          </div>
        ) : null}
        {coverageLoadFailed ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {coverageLoad.error}
          </div>
        ) : null}

        <section className="surface-card space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected range</div>
              <div className="mt-2 text-base font-semibold text-slate-900">{selectedRange.label}</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">{selectedRange.helperText}</div>
            </div>
            <div className={`rounded-2xl border p-4 ${selectedMonthPillClass(dataStatus)}`}>
              <div className="text-xs font-semibold uppercase tracking-wide">Data status</div>
              <div className="mt-2 text-base font-semibold">{dataStatus}</div>
              <div className="mt-1 text-sm leading-6 opacity-90">{dataStatusReason}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source used</div>
              <div className="mt-2 text-base font-semibold text-slate-900">{sourceLabel}</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">{sourceStatusText}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected month</div>
              <div className="mt-2 text-base font-semibold text-slate-900">{selectedMonthLabel}</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">{coverageLabel}</div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active source files</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{formatInteger(activeSourceBatches.length)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Finalized coverage window</div>
              <div className="mt-2 text-sm font-semibold text-slate-900">{coverageSummary.earliestBusinessDate && coverageSummary.latestBusinessDate ? `${coverageSummary.earliestBusinessDate} to ${coverageSummary.latestBusinessDate}` : "No finalized months yet"}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Months with finalized data</div>
              <div className="mt-2 text-sm font-semibold text-slate-900">{coverageSummary.monthsWithFinalizedDataLabel}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rows missing business date</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{formatInteger(coverageSummary.nullBusinessDateRows)}</div>
            </div>
          </div>
        </section>

        <section className="surface-card space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Month coverage overview</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Monthly coverage is shown for {selectedYear}. Use the selected range filters in Sales Dashboard to change the month that is highlighted below.
            </p>
          </div>
          {yearMonthRows.length ? (
            <DataTable headers={["Month", "Finalized rows", "Revenue", "Batches", "Coverage", "Missing business dates"]}>
              {yearMonthRows.map((row) => (
                <tr key={row.businessMonth ?? "missing-month"}>
                  <td className="font-medium text-slate-900">{formatCoverageMonthLabel(row.businessMonth)}</td>
                  <td>{formatInteger(row.finalizedSuccessfulSaleRows)}</td>
                  <td>{lyd(row.finalizedSuccessfulSaleAmount)}</td>
                  <td>{`${formatInteger(row.finalizedBatchCount)} finalized / ${formatInteger(row.activeFinalizedBatchCount)} active / ${formatInteger(row.batchCount)} total`}</td>
                  <td>{row.minBusinessDate && row.maxBusinessDate ? `${row.minBusinessDate} to ${row.maxBusinessDate}` : "-"}</td>
                  <td>{formatInteger(row.nullBusinessDateRows)}</td>
                </tr>
              ))}
            </DataTable>
          ) : (
            <EmptyState title="No monthly coverage yet" body="Import detailed Order Details files or monthly commodity profit files to start filling the coverage table." />
          )}
        </section>

        <section className="surface-card space-y-4" id="selected-month">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Selected month day coverage</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                {selectedMonthLabel} is tracked day by day so gaps are easy to spot.
              </p>
            </div>
            <div className="text-sm text-slate-500">
              {coverageLabel}
            </div>
          </div>
          {selectedMonthDays.length ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {selectedMonthDays.map((day) => {
                const covered = coveredDays.has(day);
                return (
                  <div
                    key={day}
                    className={`rounded-2xl border p-3 text-sm ${covered ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}
                  >
                    <div className="text-xs font-semibold uppercase tracking-wide opacity-80">{day}</div>
                    <div className="mt-1 text-base font-semibold">{covered ? "Covered" : "Missing"}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No month selected" body="Pick a month or date range in Sales Dashboard to inspect day-level coverage." />
          )}
        </section>

        <section className="surface-card space-y-4" id="file-statuses">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">File statuses and actions</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Each file shows the current operational state Snacky OS understands and the next recommended action.
            </p>
          </div>
          {!salesBatches.length ? (
            <EmptyState title="No sales files yet" body="Import detailed Order Details or monthly commodity profit files to see file-level status here." />
          ) : (
            <DataTable headers={["Status", "Action", "File", "Report type", "Coverage", "Rows", "Updated", "Why"]}>
              {salesBatches.map((batch) => {
                const statusInfo = describeVmsImportBatchStatus(batch, duplicateContexts.get(batch.id) ?? {});
                const reasonText = batch.latest_error || batch.last_error || statusInfo.reason;
                return (
                  <tr key={batch.id}>
                    <td className="max-w-xs">
                      <StatusBadge status={statusInfo.label} />
                      <div className="mt-1 text-xs text-slate-500">{statusInfo.reason}</div>
                    </td>
                    <td>
                      <BatchActionCell batch={batch} canManage={canManage} statusInfo={statusInfo} />
                    </td>
                    <td className="max-w-xs">
                      <div className="font-medium text-slate-900">
                        <Link href={`/vms-import/${batch.id}`} className="hover:text-slate-700">
                          {coverageBatchLabel(batch)}
                        </Link>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{batch.sheet_name ?? batch.file_type ?? "-"}</div>
                    </td>
                    <td>{vmsImportReportTypeLabel(batch.report_type ?? batch.source_type)}</td>
                    <td>{formatBatchCoverage(batch)}</td>
                    <td className="text-sm">
                      <div>Found: {formatInteger(Number(batch.rows_found ?? batch.row_count ?? 0))}</div>
                      <div>Imported: {formatInteger(Number(batch.rows_imported ?? 0))}</div>
                      <div>Needs review: {formatInteger(Number(batch.rows_needing_review ?? 0))}</div>
                    </td>
                    <td className="text-sm">
                      <div>{formatVmsDateTime(batch.uploaded_at ?? batch.imported_at)}</div>
                    </td>
                    <td className="max-w-xs text-xs text-slate-600">{reasonText}</td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </section>
      </div>
    </>
  );
}

export default async function SalesCoveragePage({
  searchParams,
}: {
  searchParams: Promise<SalesCoverageSearchParams>;
}) {
  try {
    return await SalesCoveragePageContent({ searchParams });
  } catch (error) {
    const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
    if (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE") throw error;
    console.error("[reports/sales-coverage] Page render error", error);
    return <ErrorState title="Sales coverage could not load" body="Snacky OS recovered from a sales coverage load error. Please try again, and contact admin if the issue keeps happening." action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>} />;
  }
}
