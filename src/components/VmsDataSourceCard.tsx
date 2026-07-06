import Link from "next/link";
import { KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { StatusBadge } from "@/components/ui";
import {
  activeStockBatches,
  batchDateRangeLabel,
  batchImportedRows,
  batchLastUpdatedAt,
  detailedSalesSourceMessage,
  formatVmsDateTime,
  preferredDetailedSalesBatches,
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
  const salesBatches = showSales ? preferredDetailedSalesBatches(batches) : [];
  const coverage = showSales ? vmsCoverageSummary(salesBatches) : null;
  const stockBatches = showStock ? activeStockBatches(batches) : [];
  const latestStockBatch = stockBatches[0] ?? null;
  const salesMessage = showSales ? detailedSalesSourceMessage(batches, batches.filter((batch) => batch.report_type === "sales")) : null;
  const stockMessage = showStock ? stockSourceMessage(batches) : null;
  const hasSalesData = Boolean(coverage?.active.length);
  const hasStockData = Boolean(latestStockBatch);
  const salesSourceLabel = coverage?.active.length
    ? (salesBatches[0]?.report_type === "monthly_transaction_details" ? "Using Monthly Transaction Report" : "Using Detailed Order Details")
    : "Monthly Transaction Report not imported yet";
  const salesFiles = coverage?.active.slice(-3).reverse() ?? [];
  const stockFiles = stockBatches.slice(0, 3);

  return (
    <KpiSection title={title} subtitle={subtitle}>
      <KpiLoadWarning message={error} />

      {showSales ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Detailed Sales Files</div>
            <StatusBadge status={coverage?.active.length ? "active" : "pending"} label={salesSourceLabel} />
          </div>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
            <div><div className="font-semibold text-slate-900">Active files</div><div>{coverage?.active.length ?? 0}</div></div>
            <div><div className="font-semibold text-slate-900">Date range</div><div>{coverage?.start && coverage?.end ? `${coverage.start} to ${coverage.end}` : "-"}</div></div>
            <div><div className="font-semibold text-slate-900">Latest file</div><div>{sourceFileName(coverage?.latest)}</div></div>
            <div><div className="font-semibold text-slate-900">Rows imported</div><div>{batchImportedRows(coverage?.latest).toLocaleString("en-US")}</div></div>
            <div><div className="font-semibold text-slate-900">Last updated</div><div>{formatVmsDateTime(batchLastUpdatedAt(coverage?.latest))}</div></div>
          </div>
          <p className="mt-3 text-sm font-medium text-slate-700">{salesMessage}</p>
          {salesFiles.length ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Files Used Now</div>
              <div className="mt-3 space-y-2">
                {salesFiles.map((batch) => (
                  <div key={batch.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="font-medium text-slate-900">
                      <Link href={`/vms-import/${batch.id}`} className="link-secondary">
                        {sourceFileName(batch)}
                      </Link>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {batchDateRangeLabel(batch)} | {batchImportedRows(batch).toLocaleString("en-US")} rows | updated {formatVmsDateTime(batchLastUpdatedAt(batch))}
                    </div>
                  </div>
                ))}
              </div>
              {coverage && coverage.active.length > salesFiles.length ? (
                <p className="mt-3 text-xs text-slate-500">+{coverage.active.length - salesFiles.length} older active detailed file(s) still contributing to dashboard totals.</p>
              ) : null}
            </div>
          ) : null}
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
          {stockFiles.length ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Snapshot Files In Use</div>
              <div className="mt-3 space-y-2">
                {stockFiles.map((batch) => (
                  <div key={batch.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="font-medium text-slate-900">
                      <Link href={`/vms-import/${batch.id}`} className="link-secondary">
                        {sourceFileName(batch)}
                      </Link>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {batchDateRangeLabel(batch)} | {batchImportedRows(batch).toLocaleString("en-US")} rows | updated {formatVmsDateTime(batchLastUpdatedAt(batch))}
                    </div>
                  </div>
                ))}
              </div>
              {stockBatches.length > stockFiles.length ? (
                <p className="mt-3 text-xs text-slate-500">+{stockBatches.length - stockFiles.length} older active stock file(s) remain available in VMS Data Sources.</p>
              ) : null}
            </div>
          ) : null}
          {!hasStockData ? <p className="mt-3 text-sm text-slate-500">No active stock snapshot is available yet.</p> : null}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Link href="/vms-import/sources" className="text-sm font-semibold text-amber-700 hover:text-amber-800">
          Open VMS data sources
        </Link>
      </div>
    </KpiSection>
  );
}