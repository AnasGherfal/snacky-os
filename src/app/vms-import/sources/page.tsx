import Link from "next/link";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports, canViewVmsImports } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { cleanSearchParams, getPagination, type SearchParamsRecord } from "@/lib/pagination";
import { privateStorageObjectUrl } from "@/lib/storage-buckets";
import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";
import { vmsReportTypes } from "@/lib/vms-parser";
import { extractVmsSchemaIssue } from "@/lib/vms-schema-diagnostics";

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

function dashboardUsageForReport(reportType: string | null | undefined) {
  if (reportType === "vms_order_details_weekly") return "Sales dashboard, Product sales dashboard, Machine sales dashboard, Failed vend/refund report, Product velocity";
  if (reportType === "sales") return "Reconciliation only, Period total check";
  if (isStockReportType(reportType)) return "Recommended route refill items, Machine stock dashboard, Refill priority";
  return "Not used until mapped";
}

function usageText(value: unknown, fallback: string) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value.map(String).join(", ") || fallback;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const dashboards = Array.isArray(record.dashboards) ? record.dashboards.map(String).join(", ") : "";
    const explanation = typeof record.explanation === "string" ? record.explanation : "";
    return [dashboards, explanation].filter(Boolean).join(" - ") || fallback;
  }
  return String(value);
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
const legacySourceSelect = "id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, uploaded_by, uploaded_at, status, row_count, rows_found, rows_imported, rows_skipped, latest_error, notes";

function isMissingSourceSchemaError(error: unknown) {
  const row = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  const text = [row?.code, row?.message, row?.details, row?.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return text.includes("schema cache") || text.includes("column") || text.includes("does not exist") || row?.code === "42703" || row?.code === "PGRST204" || row?.code === "42P01" || row?.code === "PGRST205";
}

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

async function loadVmsDataSources({
  supabase,
  from,
  to,
}: {
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
  from: number;
  to: number;
}) {
  try {
    const result = await supabase
      .from("vms_import_batches")
      .select(preferredSourceSelect, { count: "exact" })
      .order("uploaded_at", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (!result.error) return { batches: (result.data ?? []) as VmsSourceRow[], batchCount: result.count ?? result.data?.length ?? 0, error: "" };
    logVmsDataSourcesLoadIssue({ queryName: "vms_import_batches.sources", selectedColumns: preferredSourceSelect, error: result.error });
    if (!isMissingSourceSchemaError(result.error)) return { batches: [], batchCount: 0, error: sourceErrorMessage(result.error) };
  } catch (error) {
    logVmsDataSourcesLoadIssue({ queryName: "vms_import_batches.sources", selectedColumns: preferredSourceSelect, error });
    return { batches: [], batchCount: 0, error: sourceErrorMessage(error) };
  }

  try {
    const fallback = await supabase
      .from("vms_import_batches")
      .select(legacySourceSelect, { count: "exact" })
      .order("uploaded_at", { ascending: false, nullsFirst: false })
      .range(from, to);
    if (fallback.error) {
      logVmsDataSourcesLoadIssue({ queryName: "vms_import_batches.sources_legacy", selectedColumns: legacySourceSelect, error: fallback.error });
      return { batches: [], batchCount: 0, error: sourceErrorMessage(fallback.error) };
    }
    return { batches: (fallback.data ?? []) as VmsSourceRow[], batchCount: fallback.count ?? fallback.data?.length ?? 0, error: "Some VMS metadata columns are missing. Showing available import history." };
  } catch (error) {
    logVmsDataSourcesLoadIssue({ queryName: "vms_import_batches.sources_legacy", selectedColumns: legacySourceSelect, error });
    return { batches: [], batchCount: 0, error: sourceErrorMessage(error) };
  }
}

function SourceActions({ batch, canManage }: { batch: VmsSourceRow; canManage: boolean }) {
  const originalFileUrl = batch.storage_bucket && batch.storage_path
    ? privateStorageObjectUrl(String(batch.storage_bucket), String(batch.storage_path))
    : null;

  return (
    <div className="flex flex-wrap gap-2">
      <Link href={`/vms-import/${batch.id}`} className="btn-secondary">View</Link>
      {originalFileUrl ? <Link href={originalFileUrl} className="btn-secondary">Original File</Link> : null}
      {canManage ? (
        <>
          {isUsableImportStatus(batch.status) && batch.is_active !== false && !batch.deleted_at ? (
            <form action={updateVmsImportBatchState} className="flex gap-2">
              <input type="hidden" name="batch_id" value={batch.id} />
              <input type="hidden" name="action" value="disable" />
              <input name="reason" placeholder="Reason" className="field-input h-9 w-40 text-xs" />
              <FormSubmitButton className="btn-secondary" pendingLabel="Disabling...">Disable</FormSubmitButton>
            </form>
          ) : (
            <form action={updateVmsImportBatchState}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <input type="hidden" name="action" value="restore" />
              <FormSubmitButton className="btn-secondary" pendingLabel="Restoring...">Restore</FormSubmitButton>
            </form>
          )}
          <form action={reprocessVmsImportBatch}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <FormSubmitButton className="btn-secondary" pendingLabel="Reprocessing...">Reprocess / repair</FormSubmitButton>
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

  let batches: VmsSourceRow[] = [];
  let batchCount = 0;
  let loadError = "";
  let schemaNotice = "";

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
  }

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
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td><StatusBadge status={activeLabel(batch)} /></td>
                <td><StatusBadge status={batch.status ?? "unknown"} /></td>
                <td className="max-w-xs">
                  <Link href={`/vms-import/${batch.id}`} className="link-secondary font-medium text-slate-900">{batch.original_file_name ?? batch.file_name ?? "-"}</Link>
                  <div className="mt-1 text-xs text-slate-500">{batch.sheet_name ?? "-"} {batch.file_type ? `- ${String(batch.file_type).toUpperCase()}` : ""}</div>
                </td>
                <td>{reportLabel(batch.report_type ?? batch.source_type)}</td>
                <td>{batchDateRange(batch)}</td>
                <td className="text-sm">
                  <div>Found: {batch.rows_found ?? batch.row_count ?? 0}</div>
                  <div>Imported: {batch.rows_imported ?? 0}</div>
                </td>
                <td>{batch.rows_skipped_duplicate ?? 0}</td>
                <td>{batch.rows_needing_review ?? 0}</td>
                <td className="max-w-xs text-xs text-slate-600">{usageText(batch.dashboard_usage, dashboardUsageForReport(batch.report_type ?? batch.source_type))}</td>
                <td className="text-xs text-slate-600">{batch.uploaded_by ?? batch.imported_by ?? "-"}</td>
                <td className="text-sm">
                  <div>{formatDateTime(batch.uploaded_at ?? batch.imported_at)}</div>
                  {batch.last_reprocessed_at ? <div className="text-xs text-slate-500">Reprocessed {batch.reprocess_count ?? 0}x</div> : null}
                </td>
                <td className="max-w-xs text-xs text-amber-700">
                  {batch.latest_error || batch.last_error || batch.disable_reason || batch.delete_reason || "-"}
                  <div className="mt-1 text-slate-500">Failed: {batch.failed_rows_count ?? 0} · Refunds: {batch.refunded_rows_count ?? 0}</div>
                </td>
                <td><SourceActions batch={batch} canManage={canManage} /></td>
              </tr>
            ))}
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
