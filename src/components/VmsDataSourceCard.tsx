import { KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import {
  activeStockBatches,
  batchDateRangeLabel,
  batchImportedRows,
  batchLastUpdatedAt,
  detailedSalesSourceMessage,
  formatVmsDateTime,
  sourceFileName,
  stockSourceMessage,
  vmsCoverageSummary,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";

export function VmsDataSourceCard({
  batches,
  error,
  title = "Data Source",
  subtitle,
  showSales = true,
  showStock = false,
}: {
  batches: VmsDashboardBatch[];
  error?: string | null;
  title?: string;
  subtitle?: string;
  showSales?: boolean;
  showStock?: boolean;
}) {
  const coverage = showSales ? vmsCoverageSummary(batches) : null;
  const latestStockBatch = showStock ? activeStockBatches(batches)[0] ?? null : null;
  const salesMessage = showSales ? detailedSalesSourceMessage(batches, batches.filter((batch) => batch.report_type === "sales")) : null;
  const stockMessage = showStock ? stockSourceMessage(batches) : null;
  const hasSalesData = Boolean(coverage?.active.length);
  const hasStockData = Boolean(latestStockBatch);

  return (
    <KpiSection title={title} subtitle={subtitle}>
      <KpiLoadWarning message={error} />

      {showSales ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Detailed Sales Files</div>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
            <div><div className="font-semibold text-slate-900">Active files</div><div>{coverage?.active.length ?? 0}</div></div>
            <div><div className="font-semibold text-slate-900">Date range</div><div>{coverage?.start && coverage?.end ? `${coverage.start} to ${coverage.end}` : "-"}</div></div>
            <div><div className="font-semibold text-slate-900">Latest file</div><div>{sourceFileName(coverage?.latest)}</div></div>
            <div><div className="font-semibold text-slate-900">Rows imported</div><div>{batchImportedRows(coverage?.latest).toLocaleString("en-US")}</div></div>
            <div><div className="font-semibold text-slate-900">Last updated</div><div>{formatVmsDateTime(batchLastUpdatedAt(coverage?.latest))}</div></div>
          </div>
          <p className="mt-3 text-sm font-medium text-slate-700">{salesMessage}</p>
          {coverage?.gaps.length ? (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
              Missing detailed sales periods: {coverage.gaps.map((gap) => `${gap.start} to ${gap.end}`).join(", ")}.
            </div>
          ) : null}
          {!hasSalesData ? <p className="mt-3 text-sm text-slate-500">No detailed sales files are active yet.</p> : null}
        </div>
      ) : null}

      {showStock ? (
        <div className={`${showSales ? "mt-4" : ""} rounded-xl border border-slate-200 bg-slate-50 p-4`}>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stock Snapshot Files</div>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div><div className="font-semibold text-slate-900">Snapshot file</div><div>{sourceFileName(latestStockBatch)}</div></div>
            <div><div className="font-semibold text-slate-900">Snapshot time</div><div>{batchDateRangeLabel(latestStockBatch)}</div></div>
            <div><div className="font-semibold text-slate-900">Rows imported</div><div>{batchImportedRows(latestStockBatch).toLocaleString("en-US")}</div></div>
            <div><div className="font-semibold text-slate-900">Last updated</div><div>{formatVmsDateTime(batchLastUpdatedAt(latestStockBatch))}</div></div>
          </div>
          <p className="mt-3 text-sm font-medium text-slate-700">{stockMessage}</p>
          {!hasStockData ? <p className="mt-3 text-sm text-slate-500">No active stock snapshot is available yet.</p> : null}
        </div>
      ) : null}
    </KpiSection>
  );
}
