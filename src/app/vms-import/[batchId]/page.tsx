import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { AdminTechnicalDetails } from "@/components/TechnicalDetails";
import { DataTable, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports, canViewVmsImports, getEffectivePermissions, isOwnerAdminRole } from "@/lib/authz";
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

type SupabaseServerClient = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
type VmsImportBatchRow = Record<string, unknown> & { id: string; status?: string | null; report_type?: string | null; source_type?: string | null; latest_error?: string | null; last_error?: string | null; };
type VmsImportRow = Record<string, unknown> & { id: string; row_number?: number | null; raw_data?: unknown; normalized_data?: unknown; validation_status?: string | null; validation_errors?: unknown; machine_match_status?: string | null; product_match_status?: string | null; };

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
  message?: string;
};

function parseSummary(notes: string | null | undefined): ImportSummary | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as ImportSummary;
    if (!parsed.resultMessage && parsed.message) {
      parsed.resultMessage = parsed.message;
    }
    return parsed;
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

function isMachineStockSnapshotReportType(reportType: string | null | undefined) {
  return reportType === "stock" || reportType === "machine_stock_snapshot";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isNextNavigationSignal(error: unknown) {
  const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE";
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
    console.error("[vms-import:detail] Missing table detected", { missing: tableMatch[1], raw: text });
    return "VMS import setup is incomplete. Please contact admin.";
  }
  const columnMatch = text.match(/column ['"]?([a-z0-9_]+)['"]? does not exist/i);
  if (columnMatch) {
    console.error("[vms-import:detail] Missing column detected", { missingCol: columnMatch[1], raw: text });
    return "VMS import setup is incomplete. Please contact admin.";
  }
  if (queryError?.code === "42P01" || queryError?.code === "42703" || text.includes("does not exist") || text.includes("schema cache")) {
    return "VMS import setup is incomplete. Please contact admin.";
  }
  return "VMS import could not load. Please contact admin.";
}

async function checkRequiredVmsTables(supabase: SupabaseServerClient, batchId: string, currentUserId: string | null, effectivePermissions: string[]) {
  const results: { table: string; kind: string; requiredFor: string; exists: boolean; error?: string | null; code?: string | null; missingRelation?: string | null; missingColumn?: string | null }[] = [];
  for (const relation of VMS_IMPORT_PIPELINE_RELATIONS) {
    const selectedColumns = "id";
    const queryName = `${relation.name}.schema_check`;
    try {
      const res = await supabase.from(relation.name).select(selectedColumns, { head: true }).limit(1);
      if (res.error) {
        logPostImportLoaderFailure({ queryName, selectedColumns, error: res.error, batchId, currentUserId, effectivePermissions });
        const issue = extractVmsSchemaIssue(res.error, queryName);
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
      logPostImportLoaderFailure({ queryName, selectedColumns, error: err, batchId, currentUserId, effectivePermissions });
      results.push({ table: relation.name, kind: relation.kind, requiredFor: relation.requiredFor, exists: false, error: String(err instanceof Error ? err.message : err) });
    }
  }
  return results;
}

async function countBatchRows(supabase: SupabaseServerClient, table: string, batchId: string, currentUserId: string | null, effectivePermissions: string[]) {
  const selectedColumns = "id";
  const queryName = `${table}.count_for_batch`;
  try {
    const { count, error } = await supabase
      .from(table)
      .select(selectedColumns, { count: "exact", head: true })
      .eq("import_batch_id", batchId);
    if (error) {
      logPostImportLoaderFailure({ queryName, selectedColumns: `${selectedColumns}; filter: import_batch_id = ${batchId}`, error, batchId, currentUserId, effectivePermissions });
    }
    return {
      count: error ? null : count ?? 0,
      error: error ? queryErrorMessage(error) : null,
      code: (error as VmsSupabaseError | null)?.code ?? null,
    };
  } catch (error) {
    logPostImportLoaderFailure({ queryName, selectedColumns: `${selectedColumns}; filter: import_batch_id = ${batchId}`, error, batchId, currentUserId, effectivePermissions });
    return { count: null, error: queryErrorMessage(error), code: null };
  }
}

const preferredBatchDetailSelect = "id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, uploaded_by, uploaded_at, status, is_active, deleted_at, deleted_by, delete_reason, disabled_at, disabled_by, disable_reason, source_usage, dashboard_usage, file_hash, storage_bucket, storage_path, original_file_name, detected_min_datetime, detected_max_datetime, total_successful_sales, successful_rows_count, failed_rows_count, refunded_rows_count, row_count, rows_found, rows_imported, rows_skipped, rows_skipped_duplicate, rows_needing_review, import_mode, report_start_date, report_end_date, error_count, errors, latest_error, last_error, notes, column_mapping, last_reprocessed_at, reprocess_count";
const legacyBatchDetailSelect = "id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, uploaded_by, uploaded_at, status, row_count, rows_found, rows_imported, rows_skipped, error_count, notes";
const importedRowsSelect = "id, row_number, raw_data, normalized_data, validation_status, validation_errors, machine_match_status, product_match_status, matched_machine_id, matched_product_id";

type VmsImportBatchLoadResult = {
  batches: VmsImportBatchRow[];
  selectedBatch: VmsImportBatchRow | null;
  rows: VmsImportRow[];
  errors: { loader: string; message: string; error?: unknown }[];
  schemaNotice: string;
};

function logPostImportLoaderFailure({
  queryName,
  selectedColumns,
  error,
  batchId,
  batch,
  currentUserId,
  effectivePermissions,
}: {
  queryName: string;
  selectedColumns: string;
  error: unknown;
  batchId: string;
  batch?: VmsImportBatchRow | null;
  currentUserId: string | null;
  effectivePermissions: string[];
}) {
  const queryError = error && typeof error === "object" ? error as { code?: string; message?: string; details?: string; hint?: string } : null;
  console.error("[vms-import:detail] Post-import loader failed", {
    queryName,
    selectedColumns,
    code: queryError?.code ?? null,
    message: queryError?.message ?? String(error instanceof Error ? error.message : error ?? "Unknown error"),
    details: queryError?.details ?? null,
    hint: queryError?.hint ?? null,
    schemaIssue: extractVmsSchemaIssue(error, queryName),
    batch_id: batchId,
    status: batch?.status ?? null,
    report_type: batch?.report_type ?? batch?.source_type ?? null,
    currentUserId,
    effectivePermissions,
  });
}

async function loadVmsImportBatch({
  supabase,
  batchId,
  currentUserId,
  effectivePermissions,
}: {
  supabase: SupabaseServerClient;
  batchId: string;
  currentUserId: string | null;
  effectivePermissions: string[];
}): Promise<VmsImportBatchLoadResult> {
  const fallback: VmsImportBatchLoadResult = { batches: [], selectedBatch: null, rows: [], errors: [], schemaNotice: "" };

  let preferredBatch;
  try {
    preferredBatch = await supabase.from("vms_import_batches").select(preferredBatchDetailSelect).eq("id", batchId).maybeSingle();
  } catch (error) {
    logPostImportLoaderFailure({ queryName: "vms_import_batches.selected", selectedColumns: preferredBatchDetailSelect, error, batchId, currentUserId, effectivePermissions });
    return { ...fallback, errors: [{ loader: "vms_import_batches.selected", message: userFacingLoadError(error, "vms_import_batches.selected"), error }] };
  }

  let batch = preferredBatch.data as VmsImportBatchRow | null;
  let batchError = preferredBatch.error as unknown;
  let schemaNotice = "";
  if (preferredBatch.error && extractVmsSchemaIssue(preferredBatch.error, "vms_import_batches.selected")) {
    logPostImportLoaderFailure({ queryName: "vms_import_batches.selected", selectedColumns: preferredBatchDetailSelect, error: preferredBatch.error, batchId, currentUserId, effectivePermissions });
    try {
      const fallbackBatch = await supabase.from("vms_import_batches").select(legacyBatchDetailSelect).eq("id", batchId).maybeSingle();
      batch = fallbackBatch.data as VmsImportBatchRow | null;
      batchError = fallbackBatch.error;
      if (!fallbackBatch.error) schemaNotice = userFacingLoadError(preferredBatch.error, "vms_import_batches.selected");
    } catch (error) {
      logPostImportLoaderFailure({ queryName: "vms_import_batches.selected_legacy", selectedColumns: legacyBatchDetailSelect, error, batchId, currentUserId, effectivePermissions });
      return { ...fallback, errors: [{ loader: "vms_import_batches.selected_legacy", message: userFacingLoadError(error, "vms_import_batches.selected_legacy"), error }] };
    }
  }

  if (batchError) {
    logPostImportLoaderFailure({ queryName: "vms_import_batches.selected", selectedColumns: preferredBatchDetailSelect, error: batchError, batchId, currentUserId, effectivePermissions });
    return { ...fallback, errors: [{ loader: "vms_import_batches.selected", message: userFacingLoadError(batchError, "vms_import_batches.selected"), error: batchError }] };
  }
  if (!batch) return fallback;

  try {
    const rowsResult = await supabase.from("vms_import_rows").select(importedRowsSelect).eq("import_batch_id", batchId).order("row_number", { ascending: true });
    if (rowsResult.error) {
      logPostImportLoaderFailure({ queryName: "vms_import_rows.for_batch", selectedColumns: importedRowsSelect, error: rowsResult.error, batchId, batch, currentUserId, effectivePermissions });
      return { batches: [], selectedBatch: batch, rows: [], errors: [{ loader: "vms_import_rows.for_batch", message: userFacingLoadError(rowsResult.error, "vms_import_rows.for_batch"), error: rowsResult.error }], schemaNotice };
    }
    return { batches: [], selectedBatch: batch, rows: rowsResult.data ?? [], errors: [], schemaNotice };
  } catch (error) {
    logPostImportLoaderFailure({ queryName: "vms_import_rows.for_batch", selectedColumns: importedRowsSelect, error, batchId, batch, currentUserId, effectivePermissions });
    return { batches: [], selectedBatch: batch, rows: [], errors: [{ loader: "vms_import_rows.for_batch", message: userFacingLoadError(error, "vms_import_rows.for_batch"), error }], schemaNotice };
  }
}

async function safeCountAllRows(supabase: SupabaseServerClient, table: string, batchId: string, currentUserId: string | null, effectivePermissions: string[]) {
  try {
    const result = await supabase.from(table).select("id", { count: "exact", head: true });
    if (result.error) {
      logPostImportLoaderFailure({ queryName: `${table}.count`, selectedColumns: "id", error: result.error, batchId, currentUserId, effectivePermissions });
      return { count: null, error: result.error };
    }
    return { count: result.count ?? 0, error: null };
  } catch (error) {
    logPostImportLoaderFailure({ queryName: `${table}.count`, selectedColumns: "id", error, batchId, currentUserId, effectivePermissions });
    return { count: null, error };
  }
}

async function loadLatestVmsImportBatch(supabase: SupabaseServerClient, batchId: string, currentUserId: string | null, effectivePermissions: string[]) {
  const selectedColumns = "id, status, file_name, report_type, rows_found, rows_imported, uploaded_by, uploaded_at, imported_at, is_active";
  try {
    const result = await supabase.from("vms_import_batches").select(selectedColumns).order("uploaded_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (result.error) {
      logPostImportLoaderFailure({ queryName: "vms_import_batches.latest", selectedColumns, error: result.error, batchId, currentUserId, effectivePermissions });
      return null;
    }
    return result.data as VmsImportBatchRow | null;
  } catch (error) {
    logPostImportLoaderFailure({ queryName: "vms_import_batches.latest", selectedColumns, error, batchId, currentUserId, effectivePermissions });
    return null;
  }
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function textValue(value: unknown, fallback = "-") {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

function rowValue(row: VmsImportRow, key: string) {
  const normalized = jsonRecord(row.normalized_data);
  return String(normalized[key] ?? normalized[key.toLowerCase()] ?? "");
}

function productLabel(row: VmsImportRow) {
  const id = rowValue(row, "product_identifier");
  const name = rowValue(row, "product_name");
  if (id && name && id !== name) return `${id} - ${name}`;
  return name || id || "-";
}

function machineLabel(row: VmsImportRow) {
  return rowValue(row, "machine_identifier") || rowValue(row, "machine_name") || "-";
}

function validationErrors(row: VmsImportRow) {
  const errors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
  return errors.length ? errors.join(", ") : "-";
}

function RawData({ row }: { row: VmsImportRow }) {
  return (
    <pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
      {JSON.stringify(jsonRecord(row.raw_data), null, 2)}
    </pre>
  );
}

async function VmsImportBatchDetailPageContent({
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

  const loadedImport = await loadVmsImportBatch({
    supabase,
    batchId,
    currentUserId: profile?.id ?? null,
    effectivePermissions,
  });
  const batch = loadedImport.selectedBatch;
  const batchSchemaNotice = loadedImport.schemaNotice;

  if (loadedImport.errors.length && !batch) {
    return (
      <>
        <PageHeader title="VMS Import Batch" subtitle="Review imported VMS rows and mapping issues." action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>} />
        <ErrorState title="Could not load VMS import batch" body={loadedImport.errors[0]?.message ?? "Snacky OS could not load this VMS import."} action={<SecondaryButton href="/vms-import">Show latest imports</SecondaryButton>} />
      </>
    );
  }

  if (!batch) {
    const latestBatch = await loadLatestVmsImportBatch(supabase, batchId, profile?.id ?? null, effectivePermissions);
    const message = "This import batch no longer exists. Showing latest imports instead.";
    if (latestBatch?.id && latestBatch.id !== batchId) redirect(`/vms-import/${latestBatch.id}?error=${encodeURIComponent(message)}`);
    redirect(`/vms-import?error=${encodeURIComponent(message)}`);
  }

  const rows = loadedImport.rows;
  const rowsLoadError = loadedImport.errors.find((issue) => issue.loader === "vms_import_rows.for_batch")?.error ?? null;

  let importer: { id: string; full_name: string | null } | null = null;
  if (batch.uploaded_by ?? batch.imported_by) {
    try {
      const importerResult = await supabase.from("team_members").select("id, full_name").eq("id", batch.uploaded_by ?? batch.imported_by).maybeSingle();
      if (importerResult.error) {
        logPostImportLoaderFailure({ queryName: "team_members.importer", selectedColumns: "id, full_name", error: importerResult.error, batchId, batch, currentUserId: profile?.id ?? null, effectivePermissions });
      } else {
        importer = importerResult.data as { id: string; full_name: string | null } | null;
      }
    } catch (error) {
      logPostImportLoaderFailure({ queryName: "team_members.importer", selectedColumns: "id, full_name", error, batchId, batch, currentUserId: profile?.id ?? null, effectivePermissions });
    }
  }
  const originalFileUrl = stringValue(batch.storage_bucket) && stringValue(batch.storage_path)
    ? privateStorageObjectUrl(stringValue(batch.storage_bucket), stringValue(batch.storage_path))
    : null;

  // Diagnostics: check presence of required VMS tables and counts related to this batch
  const tableChecks = await checkRequiredVmsTables(supabase, batch.id, profile?.id ?? null, effectivePermissions);
  const [
    previewRowsCount,
    importedRowsCount,
    stockSnapshotRowsCount,
    machineStockAuditRowsCount,
    salesRawCount,
    transactionsRawCount,
    productMappingsCountResult,
    machineMappingsCountResult,
  ] = await Promise.all([
    countBatchRows(supabase, "vms_import_preview_rows", batch.id, profile?.id ?? null, effectivePermissions),
    countBatchRows(supabase, "vms_import_rows", batch.id, profile?.id ?? null, effectivePermissions),
    countBatchRows(supabase, "vms_stock_snapshots", batch.id, profile?.id ?? null, effectivePermissions),
    countBatchRows(supabase, "vms_machine_stock_snapshots", batch.id, profile?.id ?? null, effectivePermissions),
    countBatchRows(supabase, "vms_sales_raw", batch.id, profile?.id ?? null, effectivePermissions),
    countBatchRows(supabase, "vms_transactions_raw", batch.id, profile?.id ?? null, effectivePermissions),
    safeCountAllRows(supabase, "vms_product_mappings", batch.id, profile?.id ?? null, effectivePermissions),
    safeCountAllRows(supabase, "vms_machine_mappings", batch.id, profile?.id ?? null, effectivePermissions),
  ]);
  const canFinalizePreviewStockBatch = canConfirmVmsImports(profile)
    && String(batch.status ?? "") === "previewed"
    && isMachineStockSnapshotReportType(stringValue(batch.report_type));
  const canFinalizeOrderDetailsBatch = isOwnerAdminRole(profile)
    && stringValue(batch.report_type) === "vms_order_details_weekly"
    && Number(transactionsRawCount.count ?? 0) > 0
    && !(isUsableImportStatus(stringValue(batch.status)) && batch.is_active !== false && !batch.deleted_at);
  const finalizeEvidenceCount = Math.max(
    Number(stockSnapshotRowsCount.count ?? 0),
    Number(machineStockAuditRowsCount.count ?? 0),
    Number(importedRowsCount.count ?? 0),
  );
  const mappingCountError = productMappingsCountResult.error ?? machineMappingsCountResult.error ?? null;
  const mappingCount = mappingCountError ? null : (productMappingsCountResult.count ?? 0) + (machineMappingsCountResult.count ?? 0);

  // Latest batch snapshot for quick inspection
  const latestBatch = await loadLatestVmsImportBatch(supabase, batch.id, profile?.id ?? null, effectivePermissions);
  const latestDiagnosticError = rowsLoadError
    ? userFacingLoadError(rowsLoadError, "vms_import_rows.for_batch")
    : (stringValue(batch.latest_error) || stringValue(batch.last_error) || batchSchemaNotice || null);

  const rowList = rows ?? [];
  const summary = parseSummary(stringValue(batch.notes) || null);
  const reportType = parseReportType(stringValue(batch.report_type));
  const fieldLabels = new Map((reportType ? vmsExpectedFields[reportType] : []).map((field) => [field.field, field.label]));
  const mapping = jsonRecord(batch.column_mapping);
  const needsMappingRows = rowList.filter((row) => row.validation_status === "needs_mapping" || row.product_match_status === "needs_mapping");
  const unknownMachineRows = rowList.filter((row) => row.validation_status === "unknown_machine" || row.machine_match_status === "unknown");
  const invalidRows = rowList.filter((row) => row.validation_status === "invalid_row");
  const importedRows = rowList.filter((row) => row.validation_status === "imported");
  const savedRowsValue = reportType === "vms_order_details_weekly"
    ? numberValue(transactionsRawCount.count, 0)
    : isStockReportType(stringValue(batch.report_type))
      ? numberValue(stockSnapshotRowsCount.count, importedRowsCount.count ?? rowList.length)
      : numberValue(importedRowsCount.count, rowList.length);

  return (
    <>
      <PageHeader
        title="VMS Import Batch"
        subtitle={`${textValue(batch.file_name, "VMS file")} - ${reportLabel(stringValue(batch.report_type) || stringValue(batch.source_type))}`}
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
              Sheet: {textValue(batch.sheet_name)} - Imported by {importer?.full_name ?? "-"} - {formatDateTime(stringValue(batch.imported_at))}
            </p>
            {batch.last_reprocessed_at ? (
              <p className="mt-1 text-xs text-slate-500">
                Reprocessed {Number(numberValue(batch.reprocess_count))} time(s). Last: {formatDateTime(stringValue(batch.last_reprocessed_at))}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={stringValue(batch.status)} />
            {needsMappingRows.length ? <Link href="/vms-mappings?status=needs_review" className="btn-secondary">Review product mappings</Link> : null}
            {canFinalizePreviewStockBatch || canFinalizeOrderDetailsBatch ? (
              <form action={updateVmsImportBatchState}>
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <input type="hidden" name="action" value="finalize_import" />
                <FormSubmitButton className="btn-primary" pendingLabel={canFinalizeOrderDetailsBatch ? "Finalizing file..." : "Marking imported..."} disabled={canFinalizePreviewStockBatch ? finalizeEvidenceCount <= 0 : false}>
                  {canFinalizeOrderDetailsBatch ? "Finalize file" : "Mark imported and activate"}
                </FormSubmitButton>
              </form>
            ) : null}
            {rowList.length && canConfirmVmsImports(profile) ? (
              <form action={reprocessVmsImportBatch}>
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <FormSubmitButton pendingLabel="Reprocessing VMS import...">Repair metadata / reprocess mappings</FormSubmitButton>
              </form>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Total rows" value={summary?.totalRows ?? numberValue(batch.row_count, rowList.length)} />
          <StatCard label="Imported" value={summary?.importedRows ?? numberValue(batch.rows_imported, importedRowsCount.count ?? importedRows.length)} />
          <StatCard label="Active in dashboards" value={isUsableImportStatus(stringValue(batch.status)) && batch.is_active !== false && !batch.deleted_at ? "Yes" : "No"} />
          <StatCard label="Duplicates skipped" value={summary?.rowsSkippedDuplicate ?? numberValue(batch.rows_skipped_duplicate)} />
          <StatCard label="Needs mapping" value={summary?.needsProductMappingRows ?? needsMappingRows.length} />
          <StatCard label="Unknown machines" value={summary?.unknownMachineRows ?? unknownMachineRows.length} />
          <StatCard label="Invalid rows" value={summary?.invalidRows ?? invalidRows.length} />
          <StatCard label="Saved rows" value={savedRowsValue} />
          <StatCard label="Successful sales" value={isStockReportType(stringValue(batch.report_type)) ? "N/A" : (batch.total_successful_sales ? String(batch.total_successful_sales) : String(summary?.estimatedSuccessfulSales ?? 0))} />
        </div>
        {isStockReportType(stringValue(batch.report_type)) ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <StatCard label="Snapshot date" value={formatDateTime(stringValue(batch.detected_min_datetime) || stringValue(batch.uploaded_at) || stringValue(batch.imported_at))} />
            <StatCard label="Used in" value="Inventory / refills" />
            <StatCard label="Sales revenue" value="N/A" />
          </div>
        ) : null}
        {stringValue(batch.report_type) === "sales" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <StatCard label="Import mode" value={String(batch.import_mode ?? summary?.importType ?? "append").replaceAll("_", " ")} />
            <StatCard label="Report start" value={textValue(batch.report_start_date)} />
            <StatCard label="Report end" value={textValue(batch.report_end_date)} />
          </div>
        ) : null}
        {stringValue(batch.report_type) === "vms_order_details_weekly" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <StatCard label="Report start" value={textValue(batch.report_start_date, summary?.orderDetailsReportPeriod?.reportStartDate ?? "-")} />
            <StatCard label="Report end" value={textValue(batch.report_end_date, summary?.orderDetailsReportPeriod?.reportEndDate ?? "-")} />
            <StatCard label="Successful sales" value={summary?.successfulSalesRows ?? numberValue(batch.successful_rows_count, 0)} />
            <StatCard label="Failed vend" value={summary?.failedVendRows ?? 0} />
            <StatCard label="Refunded" value={summary?.refundedRows ?? 0} />
            <StatCard label="Needs review" value={summary?.needsReviewTransactionRows ?? 0} />
            <StatCard label="Failed payment" value={summary?.failedPaymentRows ?? 0} />
          </div>
        ) : null}
        {stringValue(batch.report_type) === "product_list" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <StatCard label="Products created" value={summary?.productsCreated ?? 0} />
            <StatCard label="Products updated" value={summary?.productsUpdated ?? 0} />
            <StatCard label="Mappings created" value={summary?.mappingsCreated ?? 0} />
            <StatCard label="Mappings updated" value={summary?.mappingsUpdated ?? 0} />
            <StatCard label="Mappings needing review" value={summary?.mappingsNeedingReview ?? needsMappingRows.length} />
            <StatCard label="Rows skipped" value={summary?.skippedRows ?? numberValue(batch.rows_skipped)} />
          </div>
        ) : null}
        {stringValue(batch.report_type) === "product_list" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <StatCard label="Auto-create missing products" value={summary?.autoCreateMissingProducts === false ? "No" : "Yes"} />
            <StatCard label="Use VMS cost as product cost" value={summary?.updateCostFromVms ? "Yes" : "No"} />
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div className="font-semibold">What was updated</div>
            <ul className="mt-2 list-disc pl-5">
              {(summary?.updatedTargets?.length ? summary.updatedTargets : updatedFallbackForReport(stringValue(batch.report_type)).filter(() => Number(numberValue(batch.rows_imported)) > 0)).map((target) => <li key={target}>{target}</li>)}
              {!(summary?.updatedTargets?.length || (Number(numberValue(batch.rows_imported)) > 0 && updatedFallbackForReport(stringValue(batch.report_type)).length)) ? <li>No dashboard data updated</li> : null}
            </ul>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold">What needs review</div>
            <ul className="mt-2 list-disc pl-5">
              <li>{numberValue(batch.rows_skipped_duplicate ?? summary?.rowsSkippedDuplicate)} duplicate row(s) skipped</li>
              <li>{numberValue(batch.rows_needing_review ?? summary?.rowsNeedingReview)} row(s) needing review</li>
            </ul>
          </div>
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <div className="font-semibold">What failed</div>
            {summary?.failedTargets?.length ? (
              <ul className="mt-2 list-disc pl-5">{summary.failedTargets.map((target) => <li key={target}>{target}</li>)}</ul>
            ) : batch.latest_error || batch.last_error ? (
              <p className="mt-2">One or more import steps failed. Please contact admin.</p>
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
          {dashboardUsageForReport(stringValue(batch.report_type) || stringValue(batch.source_type)).map(([label, used]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <div className="font-medium text-slate-900">{label}</div>
              <div className={used ? "mt-1 text-emerald-700" : "mt-1 text-slate-500"}>{used ? "Used" : "Not used"}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-slate-500">
          {stringValue(batch.report_type) === "vms_order_details_weekly"
            ? "Detailed Order Details files feed transaction-level dashboards. Only successful_sale rows count as normal sales revenue."
            : stringValue(batch.report_type) === "sales"
              ? "General VMS summary files are retained for reconciliation and are not the main sales dashboard source when detailed transactions exist."
              : "Machine stock files feed refill and inventory views, not sales revenue."}
        </p>
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">File audit</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Original file" value={textValue(batch.original_file_name, textValue(batch.file_name))} />
          <StatCard label="File hash" value={stringValue(batch.file_hash) ? stringValue(batch.file_hash).slice(0, 12) : "-"} />
          <StatCard label="Stored file" value={stringValue(batch.storage_path) ? "Yes" : "No"} />
          <StatCard label="Uploaded at" value={formatDateTime(stringValue(batch.uploaded_at) || stringValue(batch.imported_at))} />
          <StatCard label="Detected min" value={formatDateTime(stringValue(batch.detected_min_datetime))} />
          <StatCard label="Detected max" value={formatDateTime(stringValue(batch.detected_max_datetime))} />
          <StatCard label="Disabled at" value={formatDateTime(stringValue(batch.disabled_at))} />
          <StatCard label="Deleted at" value={formatDateTime(stringValue(batch.deleted_at))} />
        </div>
        {stringValue(batch.disable_reason) || stringValue(batch.delete_reason) ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {stringValue(batch.disable_reason) || stringValue(batch.delete_reason)}
          </div>
        ) : null}
        {originalFileUrl ? (
          <div className="mt-4">
            <Link href={originalFileUrl} className="btn-secondary">Download original file</Link>
          </div>
        ) : null}
      </section>

      <AdminTechnicalDetails
        canView={isOwnerAdminRole(profile)}
        title="Technical details"
        summary="Batch loader issues, relation status, and row counts for owner/admin review."
        className="mb-6"
      >
        {latestDiagnosticError ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Latest load issue: {latestDiagnosticError}
          </div>
        ) : null}
        {loadedImport.errors.length ? (
          <div className="mb-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <div className="font-semibold text-amber-950">Section-level loader errors</div>
            {loadedImport.errors.map((issue) => (
              <div key={issue.loader} className="rounded-md border border-amber-200 bg-white p-2 text-xs text-slate-700">
                <div className="font-semibold text-slate-900">{issue.loader}</div>
                <div>{issue.message}</div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Batch id" value={String(batch.id)} />
          <StatCard label="File name" value={textValue(batch.file_name)} />
          <StatCard label="Report type" value={reportLabel(stringValue(batch.report_type) || stringValue(batch.source_type))} />
          <StatCard label="Status" value={textValue(batch.status)} />
          <StatCard label="Active" value={isUsableImportStatus(stringValue(batch.status)) && batch.is_active !== false && !batch.deleted_at ? "Yes" : "No"} />
          <StatCard label="Rows found" value={numberValue(batch.rows_found ?? batch.row_count)} />
          <StatCard label="Rows imported" value={numberValue(batch.rows_imported)} />
          <StatCard label="Created/uploaded" value={formatDateTime(stringValue(batch.uploaded_at) || stringValue(batch.imported_at))} />
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Batch snapshot</div>
            <div className="mt-1 text-sm text-slate-900">Latest batch: {textValue(latestBatch?.id)}</div>
            <div className="mt-1 text-xs text-slate-500">Status: {textValue(latestBatch?.status)} - Active: {latestBatch?.is_active === false ? "No" : "Yes"} - File: {textValue(latestBatch?.file_name)}</div>
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
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Stock snapshot rows</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{stockSnapshotRowsCount.count === null ? "?" : stockSnapshotRowsCount.count}</div>
            <div className="mt-1 text-xs text-slate-500">{stockSnapshotRowsCount.error ?? "Rows saved in vms_stock_snapshots"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Machine stock audit rows</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{machineStockAuditRowsCount.count === null ? "?" : machineStockAuditRowsCount.count}</div>
            <div className="mt-1 text-xs text-slate-500">{machineStockAuditRowsCount.error ?? "Rows saved in vms_machine_stock_snapshots"}</div>
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
      </AdminTechnicalDetails>

      {canConfirmVmsImports(profile) ? (
        <section className="surface-card mb-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Actions</h2>
          <p className="mb-4 text-sm text-slate-500">Reprocess repairs mappings, recalculates counters, rebuilds dashboard usage, and refreshes metadata for this import.</p>
          <div className="grid gap-3 lg:grid-cols-4">
            {canFinalizePreviewStockBatch ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <input type="hidden" name="action" value="finalize_import" />
                <div className="text-sm font-semibold text-emerald-900">Mark imported and activate</div>
                <p className="text-xs text-emerald-900/80">
                  Promotes saved stock rows into an active imported batch for <code>/routes/new</code>. No rows are deleted.
                </p>
                <div className="text-xs text-emerald-900/80">
                  Evidence found: stock rows {stockSnapshotRowsCount.count ?? 0}, machine audit rows {machineStockAuditRowsCount.count ?? 0}, imported row audit rows {importedRowsCount.count ?? 0}
                </div>
                <FormSubmitButton className="btn-primary w-full" pendingLabel="Marking imported..." disabled={finalizeEvidenceCount <= 0}>
                  Mark imported and activate
                </FormSubmitButton>
              </form>
            ) : null}
            {canFinalizeOrderDetailsBatch ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <input type="hidden" name="action" value="finalize_import" />
                <div className="text-sm font-semibold text-amber-900">Finalize imported rows</div>
                <p className="text-xs text-amber-900/80">
                  Promotes saved <code>vms_transactions_raw</code> rows into an active imported Order Details batch for dashboards. No rows are re-imported or duplicated.
                </p>
                <div className="text-xs text-amber-900/80">
                  Evidence found: transaction rows {transactionsRawCount.count ?? 0}
                </div>
                <FormSubmitButton className="btn-primary w-full" pendingLabel="Finalizing file...">
                  Finalize file
                </FormSubmitButton>
              </form>
            ) : null}
            {isUsableImportStatus(stringValue(batch.status)) && batch.is_active !== false ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-slate-200 p-3">
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <input type="hidden" name="action" value="disable" />
                <div className="text-sm font-semibold text-slate-900">Disable from dashboards</div>
                <input name="reason" className="field-input" placeholder="Reason" />
                <FormSubmitButton className="btn-secondary w-full" pendingLabel="Disabling file...">Disable</FormSubmitButton>
              </form>
            ) : !canFinalizePreviewStockBatch && !(stringValue(batch.report_type) === "vms_order_details_weekly" && Number(transactionsRawCount.count ?? 0) > 0) ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-slate-200 p-3">
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <input type="hidden" name="action" value={stringValue(batch.status) === "deleted" ? "restore" : "enable"} />
                <div className="text-sm font-semibold text-slate-900">Restore to dashboards</div>
                <p className="text-xs text-slate-500">Restores active imported status and recalculates dashboard views.</p>
                <FormSubmitButton className="btn-secondary w-full" pendingLabel="Restoring file...">Restore</FormSubmitButton>
              </form>
            ) : null}
            {stringValue(batch.status) !== "deleted" ? (
              <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <input type="hidden" name="batch_id" value={String(batch.id)} />
                <input type="hidden" name="action" value="soft_delete" />
                <div className="text-sm font-semibold text-rose-900">Soft delete</div>
                <input name="reason" className="field-input" placeholder="Reason" />
                <FormSubmitButton className="btn-primary w-full" pendingLabel="Soft deleting file...">Soft delete</FormSubmitButton>
              </form>
            ) : null}
            <form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-rose-300 bg-white p-3">
              <input type="hidden" name="batch_id" value={String(batch.id)} />
              <input type="hidden" name="action" value="hard_delete" />
              <div className="text-sm font-semibold text-rose-900">Advanced hard delete</div>
              <input name="confirmation" className="field-input" placeholder="Type DELETE" />
              <FormSubmitButton className="btn-secondary w-full" pendingLabel="Permanently deleting file...">Hard delete</FormSubmitButton>
            </form>
          </div>
        </section>
      ) : null}

      <AdminTechnicalDetails
        canView={isOwnerAdminRole(profile)}
        title="Technical details"
        summary="Mapped columns, row-level validation issues, and raw import rows for owner/admin review."
        className="mb-6"
      >
        <section>
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

        <section>
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Row status breakdown</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Imported" value={importedRows.length} />
            <StatCard label="Needs product mapping" value={needsMappingRows.length} />
            <StatCard label="Unknown machine" value={unknownMachineRows.length} />
            <StatCard label="Invalid row" value={invalidRows.length} />
            <StatCard label="Skipped" value={rowList.filter((row) => row.validation_status === "skipped").length} />
          </div>
        </section>

        <section>
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

        <section>
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

        <section>
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
      </AdminTechnicalDetails>
    </>
  );
}

export default async function VmsImportBatchDetailPage(props: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  try {
    return await VmsImportBatchDetailPageContent(props);
  } catch (error) {
    if (isNextNavigationSignal(error)) throw error;
    const resolvedParams = await props.params.catch(() => ({ batchId: "unknown" }));
    const profile = await getCurrentProfile().catch(() => null);
    const effectivePermissions = profile ? getEffectivePermissions(profile) : [];
    logPostImportLoaderFailure({
      queryName: "vms_import_batch_detail.unexpected_server_component_error",
      selectedColumns: preferredBatchDetailSelect,
      error,
      batchId: resolvedParams.batchId,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
    });
    return (
      <>
        <PageHeader title="VMS Import Batch" subtitle="Review imported VMS rows and mapping issues." action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>} />
        <ErrorState
          title="VMS import batch could not fully load"
          body={userFacingLoadError(error, "vms_import_batch_detail.unexpected_server_component_error")}
          action={<SecondaryButton href="/vms-import/sources">Open VMS data sources</SecondaryButton>}
        />
      </>
    );
  }
}
