import Link from "next/link";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports, canViewVmsImports, isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { cleanSearchParams, getPagination, type SearchParamsRecord } from "@/lib/pagination";
import { privateStorageObjectUrl } from "@/lib/storage-buckets";
import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";
import { createVmsImportDuplicateContextMap, describeVmsImportBatchStatus, type VmsImportBatchStatus } from "@/lib/vms-import-status";
import { vmsReportTypes } from "@/lib/vms-parser";
import { extractVmsSchemaIssue } from "@/lib/vms-schema-diagnostics";
import { batchUsageSummary } from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

type VmsSourceParams = SearchParamsRecord & {
  error?: string;
};

type VmsSourceRow = {
  id: string;
  source_type?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  sheet_name?: string | null;
  report_type?: string | null;
  report_start_date?: string | null;
  report_end_date?: string | null;
  uploaded_by?: string | null;
  uploaded_at?: string | null;
  imported_by?: string | null;
  imported_at?: string | null;
  status?: string | null;
  row_count?: number | null;
  rows_found?: number | null;
  rows_imported?: number | null;
  rows_skipped?: number | null;
  rows_skipped_duplicate?: number | null;
  rows_needing_review?: number | null;
  is_active?: boolean | null;
  deleted_at?: string | null;
  disabled_at?: string | null;
  delete_reason?: string | null;
  disable_reason?: string | null;
  file_hash?: string | null;
  source_usage?: unknown;
  dashboard_usage?: unknown;
  storage_bucket?: string | null;
  storage_path?: string | null;
  original_file_name?: string | null;
  detected_min_datetime?: string | null;
  detected_max_datetime?: string | null;
  total_successful_sales?: number | string | null;
  successful_rows_count?: number | null;
  failed_rows_count?: number | null;
  refunded_rows_count?: number | null;
  latest_error?: string | null;
  last_error?: string | null;
  last_reprocessed_at?: string | null;
  reprocess_count?: number | null;
};

const preferredBatchSelect = [
  "id",
  "source_type",
  "file_name",
  "file_type",
  "sheet_name",
  "report_type",
  "report_start_date",
  "report_end_date",
  "uploaded_by",
  "uploaded_at",
  "imported_by",
  "imported_at",
  "status",
  "row_count",
  "rows_found",
  "rows_imported",
  "rows_skipped",
  "rows_skipped_duplicate",
  "rows_needing_review",
  "is_active",
  "deleted_at",
  "disabled_at",
  "delete_reason",
  "disable_reason",
  "file_hash",
  "source_usage",
  "dashboard_usage",
  "storage_bucket",
  "storage_path",
  "original_file_name",
  "detected_min_datetime",
  "detected_max_datetime",
  "total_successful_sales",
  "successful_rows_count",
  "failed_rows_count",
  "refunded_rows_count",
  "latest_error",
  "last_reprocessed_at",
  "reprocess_count",
].join(", ");

const legacyBatchSelect = [
  "id",
  "source_type",
  "file_name",
  "report_type",
  "uploaded_by",
  "uploaded_at",
  "imported_by",
  "imported_at",
  "status",
  "row_count",
  "rows_found",
  "rows_imported",
  "error_count",
  "file_hash",
  "notes",
].join(", ");

function reportLabel(reportType: string | null | undefined) {
  return vmsReportTypes.find((type) => type.value === reportType)?.label ?? reportType ?? "-";
}

function isUsableImportStatus(status: string | null | undefined) {
  return ["imported", "imported_with_warnings", "partially_imported"].includes(String(status ?? ""));
}

function activeLabel(batch: VmsSourceRow) {
  if (batch.deleted_at) return "deleted";
  if (batch.status === "disabled" || batch.is_active === false) return "disabled";
  if (isUsableImportStatus(batch.status)) return "active";
  return batch.status ?? "pending";
}

function isStockReportType(reportType: string | null | undefined) {
  return reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram";
}

function isMachineStockSnapshotImportType(reportType: string | null | undefined) {
  return reportType === "stock" || reportType === "machine_stock_snapshot";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function batchDateRange(batch: VmsSourceRow) {
  if (isStockReportType(batch.report_type ?? batch.source_type)) {
    return formatDateTime(batch.detected_max_datetime ?? batch.detected_min_datetime ?? batch.uploaded_at ?? batch.imported_at);
  }
  if (batch.report_start_date && batch.report_end_date) return `${batch.report_start_date} to ${batch.report_end_date}`;
  if (batch.detected_min_datetime || batch.detected_max_datetime) return `${formatDateTime(batch.detected_min_datetime)} to ${formatDateTime(batch.detected_max_datetime)}`;
  return "-";
}

function usageText(batch: VmsSourceRow) {
  const usage = batchUsageSummary(batch);
  return usage.length ? usage.join(", ") : "Not used until mapped";
}

function isNextNavigationSignal(error: unknown) {
  const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE";
}

function sourceErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "Unknown VMS source error");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" - ");
}

const preferredSourceSelect = "id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, uploaded_by, uploaded_at, status, is_active, deleted_at, delete_reason, disabled_at, disable_reason, source_usage, dashboard_usage, storage_bucket, storage_path, original_file_name, detected_min_datetime, detected_max_datetime, total_successful_sales, successful_rows_count, failed_rows_count, refunded_rows_count, row_count, rows_found, rows_imported, rows_skipped, report_start_date, report_end_date, rows_skipped_duplicate, rows_needing_review, latest_error, last_error, last_reprocessed_at, reprocess_count";

function logVmsDataSourcesLoadIssue({
  queryName,
  selectedColumns,
  error,
}: {
  queryName: string;
  selectedColumns: string;
  error: unknown;
}) {
  const row = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  console.error("[vms-data-sources] Failed to load VMS data sources", {
    queryName,
    selectedColumns,
    code: row?.code ?? null,
    message: row?.message ?? String(error instanceof Error ? error.message : error ?? "Unknown error"),
    details: row?.details ?? null,
    hint: row?.hint ?? null,
  });
}

function SourceActions({
  batch,
  canManage,
  canFinalizeOrderDetailsFiles,
  statusInfo,
  stockSnapshotRowCount,
  transactionRowCount,
}: {
  batch: VmsSourceRow;
  canManage: boolean;
  canFinalizeOrderDetailsFiles: boolean;
  statusInfo: VmsImportBatchStatus;
  stockSnapshotRowCount: number;
  transactionRowCount: number;
}) {
  const originalFileUrl = batch.storage_bucket && batch.storage_path
    ? privateStorageObjectUrl(String(batch.storage_bucket), String(batch.storage_path))
    : null;

  if (statusInfo.action === "view_existing" && statusInfo.relatedBatchId) {
    return (
      <div className="flex flex-wrap gap-2">
        <Link href={`/vms-import/${batch.id}`} className="btn-secondary">View</Link>
        <Link href={`/vms-import/${statusInfo.relatedBatchId}`} className="btn-primary">{statusInfo.actionLabel ?? "Open active copy"}</Link>
      </div>
    );
  }

  if (statusInfo.action === "review_mappings") {
    return (
      <div className="flex flex-wrap gap-2">
        <Link href={`/vms-import/${batch.id}`} className="btn-secondary">View</Link>
        <Link href="/vms-mappings?status=needs_review" className="btn-primary">{statusInfo.actionLabel ?? "Review mappings"}</Link>
      </div>
    );
  }

  const isPreviewStockBatch = isMachineStockSnapshotImportType(batch.report_type ?? batch.source_type)
    && String(batch.status ?? "") === "previewed"
    && !batch.deleted_at;
  const canMarkImportedAndActivate = isPreviewStockBatch && stockSnapshotRowCount > 0;
  const isOrderDetailsBatch = String(batch.report_type ?? batch.source_type) === "vms_order_details_weekly";
  const canFinalizeOrderDetails = canManage
    && canFinalizeOrderDetailsFiles
    && isOrderDetailsBatch
    && transactionRowCount > 0
    && !batch.deleted_at
    && !(isUsableImportStatus(batch.status) && batch.is_active !== false);
  const genericRestoreBlockedByOrderDetailsFinalization = isOrderDetailsBatch
    && transactionRowCount > 0
    && !(isUsableImportStatus(batch.status) && batch.is_active !== false);

  return (
    <div className="flex flex-wrap gap-2">
      <Link href={`/vms-import/${batch.id}`} className="btn-secondary">View</Link>
      {originalFileUrl ? <Link href={originalFileUrl} className="btn-secondary">Original File</Link> : null}
      {canManage ? (
        <>
          {canMarkImportedAndActivate || canFinalizeOrderDetails ? (
            <form action={updateVmsImportBatchState}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <input type="hidden" name="action" value="finalize_import" />
              <FormSubmitButton className="btn-primary" pendingLabel="Finalizing file...">
                Finalize file
              </FormSubmitButton>
            </form>
          ) : isUsableImportStatus(batch.status) && batch.is_active !== false && !batch.deleted_at ? (
            <form action={updateVmsImportBatchState} className="flex gap-2">
              <input type="hidden" name="batch_id" value={batch.id} />
              <input type="hidden" name="action" value="disable" />
              <input name="reason" placeholder="Reason" className="field-input h-9 w-40 text-xs" />
              <FormSubmitButton className="btn-secondary" pendingLabel="Disabling...">Disable</FormSubmitButton>
            </form>
          ) : statusInfo.action === "restore" && !isPreviewStockBatch && !genericRestoreBlockedByOrderDetailsFinalization ? (
            <form action={updateVmsImportBatchState}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <input type="hidden" name="action" value="restore" />
              <FormSubmitButton className="btn-secondary" pendingLabel="Restoring file...">{statusInfo.actionLabel ?? "Restore deleted batch"}</FormSubmitButton>
            </form>
          ) : null}
          <form action={reprocessVmsImportBatch}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <FormSubmitButton className="btn-secondary" pendingLabel="Reprocessing file...">Reprocess file</FormSubmitButton>
          </form>
          {!batch.deleted_at ? (
            <details className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-slate-700">More</summary>
              <form action={updateVmsImportBatchState} className="mt-2 grid gap-2">
                <input type="hidden" name="batch_id" value={batch.id} />
                <input type="hidden" name="action" value="soft_delete" />
                <input name="reason" placeholder="Soft delete reason" className="field-input h-9 text-xs" />
                <FormSubmitButton className="btn-secondary" pendingLabel="Soft deleting...">Soft Delete</FormSubmitButton>
              </form>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

async function VmsDataSourcesPageContent({ searchParams }: { searchParams: Promise<VmsSourceParams> }) {
  const params = await searchParams;
  const profile = await getCurrentProfile();
  if (!profile || !canViewVmsImports(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  const { page, pageSize, from, to } = getPagination(params);
  const paginationParams = cleanSearchParams(params);
  const canManage = canConfirmVmsImports(profile);
  const canFinalizeOrderDetailsFiles = isOwnerAdminRole(profile);

  let batches: VmsSourceRow[] = [];
  let batchCount = 0;
  let loadError = "";
  let schemaNotice = "";
  const stockSnapshotRowsByBatchId = new Map<string, number>();
  const transactionRowsByBatchId = new Map<string, number>();

  if (supabase) {
    const preferred = await supabase
      .from("vms_import_batches")
      .select(preferredBatchSelect, { count: "exact" })
      .order("uploaded_at", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (!preferred.error) {
      batches = (preferred.data ?? []) as unknown as VmsSourceRow[];
      batchCount = preferred.count ?? batches.length;
    } else if (extractVmsSchemaIssue(preferred.error, "vms_import_batches.select.sources")) {
      console.error("[vms-data-sources] Preferred VMS source query failed; trying legacy shape", {
        query: "vms_import_batches.select.sources",
        error: preferred.error,
        schemaIssue: extractVmsSchemaIssue(preferred.error, "vms_import_batches.select.sources"),
      });

      const fallback = await supabase
        .from("vms_import_batches")
        .select(legacyBatchSelect, { count: "exact" })
        .order("imported_at", { ascending: false, nullsFirst: false })
        .range(from, to);

      if (fallback.error) {
        console.error("[vms-data-sources] Legacy VMS source query failed", { query: "vms_import_batches.select.sources.legacy", error: fallback.error });
        loadError = sourceErrorMessage(fallback.error);
      } else {
        batches = (fallback.data ?? []) as unknown as VmsSourceRow[];
        batchCount = fallback.count ?? batches.length;
        schemaNotice = "VMS import database columns need the latest migration. Showing available legacy import data.";
      }
    } else {
      console.error("[vms-data-sources] Failed to load vms_import_batches", { query: "vms_import_batches.select.sources", error: preferred.error });
      loadError = sourceErrorMessage(preferred.error);
    }

    const previewStockBatchIds = batches
      .filter((batch) => isMachineStockSnapshotImportType(batch.report_type ?? batch.source_type) && String(batch.status ?? "") === "previewed")
      .map((batch) => batch.id);
    if (previewStockBatchIds.length) {
      const stockRowsResult = await supabase
        .from("vms_stock_snapshots")
        .select("import_batch_id")
        .in("import_batch_id", previewStockBatchIds)
        .eq("import_row_status", "imported");

      if (stockRowsResult.error) {
        console.error("[vms-data-sources] Could not load stock snapshot counts for preview batches", {
          query: "vms_stock_snapshots.preview_counts",
          batchIds: previewStockBatchIds,
          error: stockRowsResult.error,
        });
      } else {
        ((stockRowsResult.data ?? []) as Array<{ import_batch_id?: string | null }>).forEach((row) => {
          const batchId = String(row.import_batch_id ?? "").trim();
          if (!batchId) return;
          stockSnapshotRowsByBatchId.set(batchId, (stockSnapshotRowsByBatchId.get(batchId) ?? 0) + 1);
        });
      }
    }

    const orderDetailsBatchIds = batches
      .filter((batch) => String(batch.report_type ?? batch.source_type) === "vms_order_details_weekly" && !batch.deleted_at)
      .map((batch) => batch.id);
    if (orderDetailsBatchIds.length) {
      const transactionRowsResult = await supabase
        .from("vms_transactions_raw")
        .select("import_batch_id")
        .in("import_batch_id", orderDetailsBatchIds);

      if (transactionRowsResult.error) {
        console.error("[vms-data-sources] Could not load Order Details row counts for data source actions", {
          query: "vms_transactions_raw.order_details_counts",
          batchIds: orderDetailsBatchIds,
          error: transactionRowsResult.error,
        });
      } else {
        ((transactionRowsResult.data ?? []) as Array<{ import_batch_id?: string | null }>).forEach((row) => {
          const linkedBatchId = String(row.import_batch_id ?? "").trim();
          if (!linkedBatchId) return;
          transactionRowsByBatchId.set(linkedBatchId, (transactionRowsByBatchId.get(linkedBatchId) ?? 0) + 1);
        });
      }
    }
  }

  const duplicateContexts = createVmsImportDuplicateContextMap(batches);

  return (
    <>
      <PageHeader
        title="VMS Data Sources"
        subtitle="Trace every VMS file feeding dashboards, refills, inventory snapshots, and reconciliation."
        action={<Link href="/vms-import" className="btn-primary">Import VMS File</Link>}
      />

      {params.error ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          {params.error}
        </div>
      ) : null}
      <div className="mb-5 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
        Detailed Order imports are append-only. Snacky keeps older detailed sales files active, skips duplicate transactions, and never replaces prior detailed sales coverage.
      </div>
      {schemaNotice ? (
        <div className="mb-5 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          {schemaNotice}
        </div>
      ) : null}

      {!supabase ? (
        <EmptyState title="Connect Supabase to view VMS data sources" body="Add environment variables and restart the app." />
      ) : loadError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Could not load VMS data sources. {loadError}
        </div>
      ) : !batches.length ? (
        <EmptyState title="No VMS files imported yet" body="Upload detailed order files for sales dashboards and stock snapshots for refills." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="surface-card">
              <div className="text-sm font-semibold text-slate-900">Active files</div>
              <div className="mt-1 text-2xl font-semibold">{batches.filter((batch) => activeLabel(batch) === "active").length}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm font-semibold text-slate-900">Needs review rows</div>
              <div className="mt-1 text-2xl font-semibold">{batches.reduce((sum, batch) => sum + Number(batch.rows_needing_review ?? 0), 0)}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm font-semibold text-slate-900">Duplicates skipped</div>
              <div className="mt-1 text-2xl font-semibold">{batches.reduce((sum, batch) => sum + Number(batch.rows_skipped_duplicate ?? 0), 0)}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm font-semibold text-slate-900">Successful sales</div>
              <div className="mt-1 text-2xl font-semibold">{lyd(batches.reduce((sum, batch) => sum + Number(batch.total_successful_sales ?? 0), 0))}</div>
            </div>
          </div>

          <DataTable headers={["Active", "Status", "File", "Report type", "Date range / snapshot", "Rows", "Skipped dupes", "Needs review", "Used in dashboards/features", "Uploaded by", "Uploaded at", "Last error / warning", "Actions"]}>
            {batches.map((batch) => {
              const statusInfo = describeVmsImportBatchStatus(batch, duplicateContexts.get(batch.id) ?? {});
              return (
                <tr key={batch.id}>
                  <td><StatusBadge status={activeLabel(batch)} /></td>
                  <td>
                    <StatusBadge status={statusInfo.label} />
                    <div className="mt-1 text-xs text-slate-500">{statusInfo.actionLabel ?? "No action needed"}</div>
                  </td>
                  <td className="max-w-xs">
                    <Link href={`/vms-import/${batch.id}`} className="link-secondary font-medium text-slate-900">{batch.original_file_name ?? batch.file_name ?? "-"}</Link>
                    <div className="mt-1 text-xs text-slate-500">{batch.sheet_name ?? "-"} {batch.file_type ? `- ${String(batch.file_type).toUpperCase()}` : ""}</div>
                  </td>
                  <td>{reportLabel(batch.report_type ?? batch.source_type)}</td>
                  <td>{batchDateRange(batch)}</td>
                  <td className="text-sm">
                    <div>Found: {batch.rows_found ?? batch.row_count ?? 0}</div>
                    <div>Imported: {batch.rows_imported ?? 0}</div>
                    {isMachineStockSnapshotImportType(batch.report_type ?? batch.source_type) && String(batch.status ?? "") === "previewed" && (stockSnapshotRowsByBatchId.get(batch.id) ?? 0) > 0 ? (
                      <div className="text-xs text-emerald-700">Saved stock rows: {stockSnapshotRowsByBatchId.get(batch.id) ?? 0}</div>
                    ) : null}
                    {String(batch.report_type ?? batch.source_type) === "vms_order_details_weekly" && (transactionRowsByBatchId.get(batch.id) ?? 0) > 0 && !(isUsableImportStatus(batch.status) && batch.is_active !== false) ? (
                      <div className="text-xs text-emerald-700">Saved transaction rows: {transactionRowsByBatchId.get(batch.id) ?? 0}</div>
                    ) : null}
                  </td>
                  <td>{batch.rows_skipped_duplicate ?? 0}</td>
                  <td>{batch.rows_needing_review ?? 0}</td>
                  <td className="max-w-xs text-xs text-slate-600">{usageText(batch)}</td>
                  <td className="text-xs text-slate-600">{batch.uploaded_by ?? batch.imported_by ?? "-"}</td>
                  <td className="text-sm">
                    <div>{formatDateTime(batch.uploaded_at ?? batch.imported_at)}</div>
                    {batch.last_reprocessed_at ? <div className="text-xs text-slate-500">Reprocessed {batch.reprocess_count ?? 0}x</div> : null}
                  </td>
                  <td className="max-w-xs text-xs text-amber-700">
                    {statusInfo.reason}
                    <div className="mt-1 text-slate-500">Failed: {batch.failed_rows_count ?? 0} | Refunds: {batch.refunded_rows_count ?? 0}</div>
                  </td>
                  <td>
                    <SourceActions
                      batch={batch}
                      canManage={canManage}
                      canFinalizeOrderDetailsFiles={canFinalizeOrderDetailsFiles}
                      statusInfo={statusInfo}
                      stockSnapshotRowCount={stockSnapshotRowsByBatchId.get(batch.id) ?? 0}
                      transactionRowCount={transactionRowsByBatchId.get(batch.id) ?? 0}
                    />
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/vms-import/sources" searchParams={paginationParams} page={page} pageSize={pageSize} totalCount={batchCount} itemLabel="VMS files" />
        </div>
      )}
    </>
  );
}

export default async function VmsDataSourcesPage(props: { searchParams: Promise<VmsSourceParams> }) {
  try {
    return await VmsDataSourcesPageContent(props);
  } catch (error) {
    if (isNextNavigationSignal(error)) throw error;
    logVmsDataSourcesLoadIssue({
      queryName: "vms_data_sources.unexpected_server_component_error",
      selectedColumns: preferredSourceSelect,
      error,
    });
    return (
      <>
        <PageHeader
          title="VMS Data Sources"
          subtitle="Trace every VMS file feeding dashboards, refills, inventory snapshots, and reconciliation."
          action={<Link href="/vms-import" className="btn-primary">Import VMS File</Link>}
        />
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Could not load VMS data sources. {sourceErrorMessage(error)}
        </div>
      </>
    );
  }
}
