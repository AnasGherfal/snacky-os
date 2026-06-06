import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { DataTable, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports, canViewVmsImports, getEffectivePermissions } from "@/lib/authz";
import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";
import { parseReportType, vmsExpectedFields, vmsReportTypes } from "@/lib/vms-parser";
import {
  VMS_IMPORT_PIPELINE_RELATIONS,
  extractVmsSchemaIssue,
  vmsSchemaIssueMessage,
  type VmsSupabaseError,
} from "@/lib/vms-schema-diagnostics";
import { privateStorageObjectUrl } from "@/lib/storage-buckets";

export const dynamic = "force-dynamic";

type ImportSummary = {
  reportType?: string;
  importType?: string;
  fileName?: string;
  sheetName?: string;
  totalRows?: number;
  importedRows?: number;
  needsProductMappingRows?: number;
  unknownMachineRows?: number;
  invalidRows?: number;
  skippedRows?: number;
  rowsSkippedDuplicate?: number;
  rowsNeedingReview?: number;
  productsCreated?: number;
  productsUpdated?: number;
  mappingsCreated?: number;
  mappingsUpdated?: number;
  mappingsNeedingReview?: number;
  autoCreateMissingProducts?: boolean;
  updateCostFromVms?: boolean;
  orderDetailsReportPeriod?: { reportStartDate: string; reportEndDate: string } | null;
  successfulSalesRows?: number;
  failedVendRows?: number;
  refundedRows?: number;
  failedPaymentRows?: number;
  needsReviewTransactionRows?: number;
  estimatedSuccessfulSales?: number;
  unmappedProducts?: string[];
  unknownMachines?: string[];
  errors?: string[];
  updatedTargets?: string[];
  failedTargets?: string[];
  resultMessage?: string;
};

function parseSummary(notes: string | null | undefined): ImportSummary | null {
  if (!notes) return null;
  try {
    return JSON.parse(notes) as ImportSummary;
  } catch {
    return null;
  }
}

function reportLabel(reportType: string | null | undefined) {
  return vmsReportTypes.find((type) => type.value === reportType)?.label ?? reportType ?? "-";
}

function updatedFallbackForReport(reportType: string | null | undefined) {
  if (reportType === "vms_order_details_weekly") return ["Sales dashboard", "Product sales", "Failed vend report"];
  if (reportType === "sales") return ["Reconciliation totals"];
  if (isStockReportType(reportType)) return ["Machine stock", "Recommended refill items"];
  return [] as string[];
}

function dashboardUsageForReport(reportType: string | null | undefined) {
  if (reportType === "vms_order_details_weekly") {
    return [
      ["Sales dashboard", true],
      ["Product dashboard", true],
      ["Machine dashboard", true],
      ["Failed vend dashboard", true],
      ["Refill recommendation", true],
      ["Finance dashboard", false],
    ] as const;
  }
  if (reportType === "sales") {
    return [
      ["Reconciliation only", true],
      ["Main sales dashboard", false],
      ["Product dashboard", false],
      ["Machine dashboard", false],
      ["Finance dashboard", false],
    ] as const;
  }
  if (reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram") {
    return [
      ["Refill recommendation", true],
      ["Inventory dashboard", true],
      ["Product mapping", true],
      ["Machine mapping", true],
      ["Sales revenue", false],
      ["Finance dashboard", false],
    ] as const;
  }
  return [["Not used until mapped", false]] as const;
}

function isUsableImportStatus(status: string | null | undefined) {
  return ["imported", "imported_with_warnings", "partially_imported"].includes(String(status ?? ""));
}

function isStockReportType(reportType: string | null | undefined) {
  return reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function queryErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");
  return String((error as { message?: unknown }).message ?? "Unknown error");
}

function userFacingLoadError(error: unknown, queryName?: string) {
  const queryError = error && typeof error === "object" ? error as { code?: string; message?: string; details?: string; hint?: string } : null;
  const text = `${queryError?.code ?? ""} ${queryError?.message ?? ""} ${queryError?.details ?? ""} ${queryError?.hint ?? ""}`.toLowerCase();
  if (queryError?.code === "42501" || text.includes("permission denied") || text.includes("row-level security")) {
    return "You do not have permission to load VMS imports.";
  }
  const schemaMessage = vmsSchemaIssueMessage(error, queryName);
  if (schemaMessage) return schemaMessage;
  // Try to extract specific missing table or column names for actionable diagnostics.
  const tableMatch = text.match(/relation ['"]?([a-z0-9_\.]+)['"]? does not exist/i) || text.match(/table ['"]?([a-z0-9_\.]+)['"]? does not exist/i);
  if (tableMatch) {
    const missing = tableMatch[1];
    console.error("[vms-import:detail] Missing table detected", { missing, raw: text });
    return `Missing database table: ${missing}. Run the latest migration to create this table.`;
  }
  const columnMatch = text.match(/column ['"]?([a-z0-9_]+)['"]? does not exist/i);
  if (columnMatch) {
    const missingCol = columnMatch[1];
    console.error("[vms-import:detail] Missing column detected", { missingCol, raw: text });
    return `Missing database column: ${missingCol}. Run the latest migration to add this column.`;
  }
  if (queryError?.code === "42P01" || queryError?.code === "42703" || text.includes("does not exist") || text.includes("schema cache")) {
    return "VMS import schema is missing or stale. Run the latest migration.";
  }
  return "Snacky OS could not load this VMS import. Technical details are available in the server console.";
}

async function checkRequiredVmsTables(supabase: any) {
  const results: { table: string; kind: string; requiredFor: string; exists: boolean; error?: string | null; code?: string | null; missingRelation?: string | null; missingColumn?: string | null }[] = [];
  for (const relation of VMS_IMPORT_PIPELINE_RELATIONS) {
    try {
      const res = await supabase.from(relation.name).select("id", { head: true }).limit(1);
      if (res.error) {
        const issue = extractVmsSchemaIssue(res.error, `${relation.name}.schema_check`);
        results.push({
          table: relation.name,
          kind: relation.kind,
          requiredFor: relation.requiredFor,
          exists: false,
          error: String(res.error.message ?? res.error),
          code: res.error.code ?? null,
          missingRelation: issue?.type === "missing_relation" ? issue.relation : null,
          missingColumn: issue?.type === "missing_column" ? issue.column : null,
        });
      } else {
        results.push({ table: relation.name, kind: relation.kind, requiredFor: relation.requiredFor, exists: true });
      }
    } catch (err) {
      results.push({ table: relation.name, kind: relation.kind, requiredFor: relation.requiredFor, exists: false, error: String(err instanceof Error ? err.message : err) });
    }
  }
  return results;
}

async function countBatchRows(supabase: any, table: string, batchId: string) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("import_batch_id", batchId);
  return {
    count: error ? null : count ?? 0,
    error: error ? queryErrorMessage(error) : null,
    code: (error as VmsSupabaseError | null)?.code ?? null,
  };
}

function StatCard({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {note ? <div className="mt-1 text-xs text-slate-500">{note}</div> : null}
    </div>
  );
}

function InlineEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
      <div className="font-semibold text-slate-900">{title}</div>
      <p className="mt-1 text-slate-500">{body}</p>
    </div>
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function rowValue(row: any, key: string) {
  const normalized = jsonRecord(row.normalized_data);
  return String(normalized[key] ?? normalized[key.toLowerCase()] ?? "");
}

function productLabel(row: any) {
  const id = rowValue(row, "product_identifier");
  const name = rowValue(row, "product_name");
  if (id && name && id !== name) return `${id} - ${name}`;
  return name || id || "-";
}

function machineLabel(row: any) {
  return rowValue(row, "machine_identifier") || rowValue(row, "machine_name") || "-";
}

function validationErrors(row: any) {
  const errors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
  return errors.length ? errors.join(", ") : "-";
}

function RawData({ row }: { row: any }) {
  return (
    <pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
      {JSON.stringify(jsonRecord(row.raw_data), null, 2)}
    </pre>
  );
}

export default async function VmsImportBatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { batchId } = await params;
  const { error = "", success = "" } = await searchParams;
  const profile = await getCurrentProfile();
  const effectivePermissions = profile ? getEffectivePermissions(profile) : [];
  if (!canViewVmsImports(profile)) {
    return (
      <>
        <PageHeader title="VMS Import Batch" subtitle="Review imported VMS rows and mapping issues." action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>} />
        <ErrorState title="VMS import access required" body="You do not have permission to view VMS imports." />
      </>
    );
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) notFound();

  const preferredBatch = await supabase
    .from("vms_import_batches")
    .select("id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, uploaded_by, uploaded_at, status, is_active, deleted_at, deleted_by, delete_reason, disabled_at, disabled_by, disable_reason, source_usage, dashboard_usage, file_hash, storage_bucket, storage_path, original_file_name, detected_min_datetime, detected_max_datetime, total_successful_sales, successful_rows_count, failed_rows_count, refunded_rows_count, row_count, rows_found, rows_imported, rows_skipped, rows_skipped_duplicate, rows_needing_review, import_mode, report_start_date, report_end_date, error_count, errors, latest_error, notes, column_mapping, last_reprocessed_at, reprocess_count")
    .eq("id", batchId)
    .maybeSingle();

  let batch = preferredBatch.data as any | null;
  let batchError = preferredBatch.error as unknown;
  let batchSchemaNotice = "";
  if (preferredBatch.error && extractVmsSchemaIssue(preferredBatch.error, "vms_import_batches.selected")) {
    console.error("[vms-import:detail] Preferred batch select failed; trying legacy shape", {
      queryName: "vms_import_batches.selected",
      code: preferredBatch.error.code,
      message: preferredBatch.error.message,
      details: preferredBatch.error.details,
      hint: preferredBatch.error.hint,
      schemaIssue: extractVmsSchemaIssue(preferredBatch.error, "vms_import_batches.selected"),
      selectedBatchId: batchId,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
    });
    const fallbackBatch = await supabase
      .from("vms_import_batches")
      .select("id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, uploaded_by, uploaded_at, status, row_count, rows_found, rows_imported, error_count, notes")
      .eq("id", batchId)
      .maybeSingle();
    batch = fallbackBatch.data as any | null;
    batchError = fallbackBatch.error;
    if (!fallbackBatch.error) {
      batchSchemaNotice = userFacingLoadError(preferredBatch.error, "vms_import_batches.selected");
    }
  }

  if (batchError) {
    const loadError = batchError;
    console.error("[vms-import:detail] Failed to load batch detail", {
      queryName: "vms_import_batches.selected",
      code: (loadError as { code?: string } | null)?.code ?? null,
      message: queryErrorMessage(loadError),
      schemaIssue: extractVmsSchemaIssue(loadError, "vms_import_batches.selected"),
      selectedBatchId: batchId,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
    });
    return (
      <>
        <PageHeader title="VMS Import Batch" subtitle="Review imported VMS rows and mapping issues." action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>} />
        <ErrorState title="Could not load VMS import batch" body={userFacingLoadError(loadError, "vms_import_batches.selected")} action={<SecondaryButton href="/vms-import">Show latest imports</SecondaryButton>} />
      </>
    );
  }

  if (!batch) {
    const { data: latestBatch } = await supabase
      .from("vms_import_batches")
      .select("id")
      .order("imported_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const message = "This import batch no longer exists. Showing latest imports instead.";
    if (latestBatch?.id && latestBatch.id !== batchId) redirect(`/vms-import/${latestBatch.id}?error=${encodeURIComponent(message)}`);
    redirect(`/vms-import?error=${encodeURIComponent(message)}`);
  }

  const rowsResult = await supabase
    .from("vms_import_rows")
    .select("id, row_number, raw_data, normalized_data, validation_status, validation_errors, machine_match_status, product_match_status, matched_machine_id, matched_product_id")
    .eq("import_batch_id", batchId)
    .order("row_number", { ascending: true });
  const rows = rowsResult.error ? [] : rowsResult.data;
  const rowsLoadError = rowsResult.error ?? null;
  if (rowsLoadError) {
    console.error("[vms-import:detail] Imported row audit query failed; continuing with diagnostics", {
      queryName: "vms_import_rows.for_batch",
      code: rowsLoadError.code,
      message: rowsLoadError.message,
      details: rowsLoadError.details,
      hint: rowsLoadError.hint,
      schemaIssue: extractVmsSchemaIssue(rowsLoadError, "vms_import_rows.for_batch"),
      selectedBatchId: batchId,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
    });
  }

  const { data: importer } = batch.uploaded_by ?? batch.imported_by
    ? await supabase.from("team_members").select("id, full_name").eq("id", batch.uploaded_by ?? batch.imported_by).maybeSingle()
    : { data: null };
  const originalFileUrl = batch.storage_bucket && batch.storage_path
    ? privateStorageObjectUrl(String(batch.storage_bucket), String(batch.storage_path))
    : null;

  // Diagnostics: check presence of required VMS tables and counts related to this batch
  const tableChecks = await checkRequiredVmsTables(supabase);
  const [
    previewRowsCount,
    importedRowsCount,
    salesRawCount,
    transactionsRawCount,
    productMappingsCountResult,
    machineMappingsCountResult,
  ] = await Promise.all([
    countBatchRows(supabase, "vms_import_preview_rows", batch.id),
    countBatchRows(supabase, "vms_import_rows", batch.id),
    countBatchRows(supabase, "vms_sales_raw", batch.id),
    countBatchRows(supabase, "vms_transactions_raw", batch.id),
    supabase.from("vms_product_mappings").select("id", { count: "exact", head: true }),
    supabase.from("vms_machine_mappings").select("id", { count: "exact", head: true }),
  ]);
  const mappingCountError = productMappingsCountResult.error ?? machineMappingsCountResult.error ?? null;
  const mappingCount = mappingCountError ? null : (productMappingsCountResult.count ?? 0) + (machineMappingsCountResult.count ?? 0);

  // Latest batch snapshot for quick inspection
  const { data: latestBatch } = await supabase.from("vms_import_batches").select("id, status, file_name, report_type, rows_found, rows_imported, uploaded_by, created_at, is_active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const latestDiagnosticError = rowsLoadError
    ? userFacingLoadError(rowsLoadError, "vms_import_rows.for_batch")
    : batchSchemaNotice || null;

  const rowList = (rows ?? []) as any[];
  const summary = parseSummary(batch.notes);
  const reportType = parseReportType(batch.report_type);
  const fieldLabels = new Map((reportType ? vmsExpectedFields[reportType] : []).map((field) => [field.field, field.label]));
  const mapping = jsonRecord(batch.column_mapping);
  const needsMappingRows = rowList.filter((row) => row.validation_status === "needs_mapping" || row.product_match_status === "needs_mapping");
  const unknownMachineRows = rowList.filter((row) => row.validation_status === "unknown_machine" || row.machine_match_status === "unknown");
  const invalidRows = rowList.filter((row) => row.validation_status === "invalid_row");
  const importedRows = rowList.filter((row) => row.validation_status === "imported");

  return (
    <>
      <PageHeader
        title="VMS Import Batch"
        subtitle={`${batch.file_name ?? "VMS file"} - ${reportLabel(batch.report_type ?? batch.source_type)}`}
        action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>}
      />

      {error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900" role="status">
          {success}
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Import summary</h2>
            <p className="mt-1 text-sm text-slate-500">
              Sheet: {batch.sheet_name ?? "-"} - Imported by {importer?.full_name ?? "-"} - {formatDateTime(batch.imported_at)}
            </p>
            {batch.last_reprocessed_at ? (
              <p className="mt-1 text-xs text-slate-500">
                Reprocessed {Number(batch.reprocess_count ?? 0)} time(s). Last: {formatDateTime(batch.last_reprocessed_at)}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={batch.status} />
            {needsMappingRows.length ? <Link href="/vms-mappings?status=needs_review" className="btn-secondary">Review product mappings</Link> : null}
            {rowList.length && canConfirmVmsImports(profile) ? (
              <form action={reprocessVmsImportBatch}>
                <input type="hidden" name="batch_id" value={batch.id} />
                <FormSubmitButton pendingLabel="Reprocessing VMS import...">Repair metadata / reprocess mappings</FormSubmitButton>
              </form>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Total rows" value={summary?.totalRows ?? batch.row_count ?? rowList.length} />
          <StatCard label="Imported" value={summary?.importedRows ?? batch.rows_imported ?? importedRows.length} />
          <StatCard label="Active in dashboards" value={isUsableImportStatus(batch.status) && batch.is_active !== false && !batch.deleted_at ? "Yes" : "No"} />
          <StatCard label="Duplicates skipped" value={summary?.rowsSkippedDuplicate ?? batch.rows_skipped_duplicate ?? 0} />
          <StatCard label="Needs mapping" value={summary?.needsProductMappingRows ?? needsMappingRows.length} />
          <StatCard label="Unknown machines" value={summary?.unknownMachineRows ?? unknownMachineRows.length} />
          <StatCard label="Invalid rows" value={summary?.invalidRows ?? invalidRows.length} />
          <StatCard label="Saved rows" value={rowList.length} />
          <StatCard label="Successful sales" value={isStockReportType(batch.report_type) ? "N/A" : (batch.total_successful_sales ? String(batch.total_successful_sales) : String(summary?.estimatedSuccessfulSales ?? 0))} />
        </div>
        {isStockReportType(batch.report_type) ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <StatCard label="Snapshot date" value={formatDateTime(batch.detected_min_datetime ?? batch.uploaded_at ?? batch.imported_at)} />
            <StatCard label="Used in" value="Inventory / refills" />
            <StatCard label="Sales revenue" value="N/A" />
          </div>
        ) : null}
        {batch.report_type === "sales" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <StatCard label="Import mode" value={String(batch.import_mode ?? summary?.importType ?? "append").replaceAll("_", " ")} />
            <StatCard label="Report start" value={batch.report_start_date ?? "-"} />
            <StatCard label="Report end" value={batch.report_end_date ?? "-"} />
          </div>
        ) : null}
        {batch.report_type === "vms_order_details_weekly" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <StatCard label="Report start" value={batch.report_start_date ?? summary?.orderDetailsReportPeriod?.reportStartDate ?? "-"} />
            <StatCard label="Report end" value={batch.report_end_date ?? summary?.orderDetailsReportPeriod?.reportEndDate ?? "-"} />
            <StatCard label="Successful sales" value={summary?.successfulSalesRows ?? 0} />
            <StatCard label="Failed vend" value={summary?.failedVendRows ?? 0} />
            <StatCard label="Refunded" value={summary?.refundedRows ?? 0} />
            <StatCard label="Needs review" value={summary?.needsReviewTransactionRows ?? 0} />
            <StatCard label="Failed payment" value={summary?.failedPaymentRows ?? 0} />
          </div>
        ) : null}
        {batch.report_type === "product_list" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <StatCard label="Products created" value={summary?.productsCreated ?? 0} />
            <StatCard label="Products updated" value={summary?.productsUpdated ?? 0} />
            <StatCard label="Mappings created" value={summary?.mappingsCreated ?? 0} />
            <StatCard label="Mappings updated" value={summary?.mappingsUpdated ?? 0} />
            <StatCard label="Mappings needing review" value={summary?.mappingsNeedingReview ?? needsMappingRows.length} />
            <StatCard label="Rows skipped" value={summary?.skippedRows ?? batch.rows_skipped ?? 0} />
          </div>
        ) : null}
        {batch.report_type === "product_list" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <StatCard label="Auto-create missing products" value={summary?.autoCreateMissingProducts === false ? "No" : "Yes"} />
            <StatCard label="Use VMS cost as product cost" value={summary?.updateCostFromVms ? "Yes" : "No"} />
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div className="font-semibold">What was updated</div>
            <ul className="mt-2 list-disc pl-5">
              {(summary?.updatedTargets?.length ? summary.updatedTargets : updatedFallbackForReport(batch.report_type).filter(() => Number(batch.rows_imported ?? 0) > 0)).map((target) => <li key={target}>{target}</li>)}
              {!(summary?.updatedTargets?.length || (Number(batch.rows_imported ?? 0) > 0 && updatedFallbackForReport(batch.report_type).length)) ? <li>No dashboard data updated</li> : null}
            </ul>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold">What needs review</div>
            <ul className="mt-2 list-disc pl-5">
              <li>{batch.rows_skipped_duplicate ?? summary?.rowsSkippedDuplicate ?? 0} duplicate row(s) skipped</li>
              <li>{batch.rows_needing_review ?? summary?.rowsNeedingReview ?? 0} row(s) needing review</li>
            </ul>
          </div>
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <div className="font-semibold">What failed</div>
            {summary?.failedTargets?.length ? (
              <ul className="mt-2 list-disc pl-5">{summary.failedTargets.map((target) => <li key={target}>{target}</li>)}</ul>
            ) : batch.latest_error ? (
              <p className="mt-2">{batch.latest_error}</p>
            ) : (
              <p className="mt-2">Nothing failed.</p>
            )}
          </div>
        </div>
        {summary?.resultMessage ? <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm font-medium text-slate-700">{summary.resultMessage}</div> : null}
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Dashboard usage</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {dashboardUsageForReport(batch.report_type ?? batch.source_type).map(([label, used]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <div className="font-medium text-slate-900">{label}</div>
              <div className={used ? "mt-1 text-emerald-700" : "mt-1 text-slate-500"}>{used ? "Used" : "Not used"}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-slate-500">
          {batch.report_type === "vms_order_details_weekly"
            ? "Detailed Order Details files feed transaction-level dashboards. Only successful_sale rows count as normal sales revenue."
            : batch.report_type === "sales"
              ? "General VMS summary files are retained for reconciliation and are not the main sales dashboard source when detailed transactions exist."
              : "Machine stock files feed refill and inventory views, not sales revenue."}
        </p>
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">File audit</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Original file" value={batch.original_file_name ?? batch.file_name ?? "-"} />
          <StatCard label="File hash" value={batch.file_hash ? String(batch.file_hash).slice(0, 12) : "-"} />
          <StatCard label="Stored file" value={batch.storage_path ? "Yes" : "No"} />
          <StatCard label="Uploaded at" value={formatDateTime(batch.uploaded_at ?? batch.imported_at)} />
          <StatCard label="Detected min" value={formatDateTime(batch.detected_min_datetime)} />
          <StatCard label="Detected max" value={formatDateTime(batch.detected_max_datetime)} />
          <StatCard label="Disabled at" value={formatDateTime(batch.disabled_at)} />
          <StatCard label="Deleted at" value={formatDateTime(batch.deleted_at)} />
        </div>
        {batch.disable_reason || batch.delete_reason ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {batch.disable_reason || batch.delete_reason}
          </div>
        ) : null}
        {originalFileUrl ? (
          <div className="mt-4">
            <Link href={originalFileUrl} className="btn-secondary">Download original file</Link>
          </div>
        ) : null}
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Diagnostics</h2>
        {latestDiagnosticError ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Latest load issue: {latestDiagnosticError}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Batch id" value={batch.id} />
          <StatCard label="File name" value={batch.file_name ?? "-"} />
          <StatCard label="Report type" value={reportLabel(batch.report_type ?? batch.source_type)} />
          <StatCard label="Status" value={batch.status ?? "-"} />
          <StatCard label="Active" value={batch.status === "imported" && batch.is_active !== false && !batch.deleted_at ? "Yes" : "No"} />
          <StatCard label="Rows found" value={batch.rows_found ?? batch.row_count ?? 0} />
          <StatCard label="Rows imported" value={batch.rows_imported ?? 0} />
          <StatCard label="Created/uploaded" value={formatDateTime(batch.uploaded_at ?? batch.imported_at)} />
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Batch snapshot</div>
            <div className="mt-1 text-sm text-slate-900">Latest batch: {latestBatch?.id ?? "-"}</div>
            <div className="mt-1 text-xs text-slate-500">Status: {latestBatch?.status ?? "-"} - Active: {latestBatch?.is_active === false ? "No" : "Yes"} - File: {latestBatch?.file_name ?? "-"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Preview rows for this batch</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{previewRowsCount.count === null ? "?" : previewRowsCount.count}</div>
            <div className="mt-1 text-xs text-slate-500">{previewRowsCount.error ?? "Preview rows linked by import_batch_id"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Imported audit rows</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{importedRowsCount.count === null ? "?" : importedRowsCount.count}</div>
            <div className="mt-1 text-xs text-slate-500">{importedRowsCount.error ?? "Rows saved in vms_import_rows"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Raw sales rows</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{salesRawCount.count === null ? "?" : salesRawCount.count}</div>
            <div className="mt-1 text-xs text-slate-500">{salesRawCount.error ?? "Rows saved in vms_sales_raw"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Raw transaction rows</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{transactionsRawCount.count === null ? "?" : transactionsRawCount.count}</div>
            <div className="mt-1 text-xs text-slate-500">{transactionsRawCount.error ?? "Rows saved in vms_transactions_raw"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Mappings count</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{mappingCount === null ? "?" : mappingCount}</div>
            <div className="mt-1 text-xs text-slate-500">{mappingCountError ? queryErrorMessage(mappingCountError) : "Product and machine mappings in DB"}</div>
          </div>
        </div>

        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-900">Required relation status</h3>
          <div className="mt-2 grid gap-2">
            {tableChecks.map((t) => (
              <div key={t.table} className={`rounded-md p-2 ${t.exists ? "bg-emerald-50 border border-emerald-100" : "bg-rose-50 border border-rose-100"}`}>
                <div className="text-sm font-medium text-slate-900">{t.table} <span className="text-xs font-normal text-slate-500">({t.kind})</span></div>
                <div className="text-xs text-slate-500">{t.requiredFor}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {t.exists
                    ? "exists"
                    : `failed - ${t.missingColumn ? `missing column ${t.missingColumn}` : t.missingRelation ? `missing relation ${t.missingRelation}` : t.error ?? "unknown error"}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {canConfirmVmsImports(profile) ? (
        <section className="surface-card mb-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Actions</h2>
          <p className="mb-4 text-sm text-slate-500">Reprocess repairs mappings, recalculates counters, rebuilds dashboard usage, and refreshes metadata for this import.</p>
          <div className="grid gap-3 lg:grid-cols-3">
            {isUsableImportStatus(batch.status) && batch.is_active !== false ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-slate-200 p-3">
                <input type="hidden" name="batch_id" value={batch.id} />
                <input type="hidden" name="action" value="disable" />
                <div className="text-sm font-semibold text-slate-900">Disable from dashboards</div>
                <input name="reason" className="field-input" placeholder="Reason" />
                <FormSubmitButton className="btn-secondary w-full" pendingLabel="Disabling file...">Disable</FormSubmitButton>
              </form>
            ) : (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-slate-200 p-3">
                <input type="hidden" name="batch_id" value={batch.id} />
                <input type="hidden" name="action" value={batch.status === "deleted" ? "restore" : "enable"} />
                <div className="text-sm font-semibold text-slate-900">Restore to dashboards</div>
                <p className="text-xs text-slate-500">Restores active imported status and recalculates dashboard views.</p>
                <FormSubmitButton className="btn-secondary w-full" pendingLabel="Restoring file...">Restore</FormSubmitButton>
              </form>
            )}
            {batch.status !== "deleted" ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <input type="hidden" name="batch_id" value={batch.id} />
                <input type="hidden" name="action" value="soft_delete" />
                <div className="text-sm font-semibold text-rose-900">Soft delete</div>
                <input name="reason" className="field-input" placeholder="Reason" />
                <FormSubmitButton className="btn-primary w-full" pendingLabel="Soft deleting file...">Soft delete</FormSubmitButton>
              </form>
            ) : null}
            <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-rose-300 bg-white p-3">
              <input type="hidden" name="batch_id" value={batch.id} />
              <input type="hidden" name="action" value="hard_delete" />
              <div className="text-sm font-semibold text-rose-900">Advanced hard delete</div>
              <input name="confirmation" className="field-input" placeholder="Type DELETE" />
              <FormSubmitButton className="btn-secondary w-full" pendingLabel="Permanently deleting file...">Hard delete</FormSubmitButton>
            </form>
          </div>
        </section>
      ) : null}

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Mapped columns</h2>
        {!Object.keys(mapping).length ? (
          <InlineEmpty title="No column mapping saved" body="This batch was imported before column mapping details were recorded." />
        ) : (
          <DataTable headers={["Expected field", "Source column"]}>
            {Object.entries(mapping).map(([field, source]) => (
              <tr key={field}>
                <td className="font-medium text-slate-900">{fieldLabels.get(field) ?? field}</td>
                <td>{String(source || "-")}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Row status breakdown</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Imported" value={importedRows.length} />
          <StatCard label="Needs product mapping" value={needsMappingRows.length} />
          <StatCard label="Unknown machine" value={unknownMachineRows.length} />
          <StatCard label="Invalid row" value={invalidRows.length} />
          <StatCard label="Skipped" value={rowList.filter((row) => row.validation_status === "skipped").length} />
        </div>
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Rows needing product mapping</h2>
        {!needsMappingRows.length ? (
          <InlineEmpty title="No product mapping rows" body="All product values in this batch are mapped or not required by the report type." />
        ) : (
          <DataTable headers={["Row", "VMS product", "Machine", "Status", "Errors", "Raw data"]}>
            {needsMappingRows.slice(0, 100).map((row) => (
              <tr key={row.id}>
                <td>{row.row_number}</td>
                <td>{productLabel(row)}</td>
                <td>{machineLabel(row)}</td>
                <td><StatusBadge status={row.product_match_status ?? row.validation_status} /></td>
                <td className="max-w-xs">{validationErrors(row)}</td>
                <td><RawData row={row} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Unknown machines</h2>
        {!unknownMachineRows.length ? (
          <InlineEmpty title="No unknown machines" body="All machine values in this batch were matched." />
        ) : (
          <DataTable headers={["Row", "Machine value", "Product", "Status", "Errors", "Raw data"]}>
            {unknownMachineRows.slice(0, 100).map((row) => (
              <tr key={row.id}>
                <td>{row.row_number}</td>
                <td>{machineLabel(row)}</td>
                <td>{productLabel(row)}</td>
                <td><StatusBadge status={row.machine_match_status ?? row.validation_status} /></td>
                <td className="max-w-xs">{validationErrors(row)}</td>
                <td><RawData row={row} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Invalid rows</h2>
        {!invalidRows.length ? (
          <InlineEmpty title="No invalid rows" body="No hard validation errors were saved for this batch." />
        ) : (
          <DataTable headers={["Row", "Machine", "Product", "Errors", "Raw data"]}>
            {invalidRows.slice(0, 100).map((row) => (
              <tr key={row.id}>
                <td>{row.row_number}</td>
                <td>{machineLabel(row)}</td>
                <td>{productLabel(row)}</td>
                <td className="max-w-xs">{validationErrors(row)}</td>
                <td><RawData row={row} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
