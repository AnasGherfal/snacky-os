import Link from "next/link";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { LocalDraftForm } from "@/components/LocalDraft";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, FormField, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canCreateVmsImports, canValidateVmsImports, canViewVmsImports, getEffectivePermissions, isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { cleanSearchParams, getPagination } from "@/lib/pagination";
import { completeVmsImport, prepareVmsImport } from "@/lib/vms-import-actions";
import {
  validateVmsRows,
  vmsValue,
  type VmsReferenceMachine,
  type VmsReferenceMachineMapping,
  type VmsReferenceMapping,
  type VmsReferenceProduct,
  type VmsValidationResult,
} from "@/lib/vms-import-validation";
import {
  createVmsSalesSourceRowKey,
  parseVmsImportMode,
  salesPeriodFromMappedRow,
  vmsHeaderSignature,
  vmsImportModeLabels,
  type VmsImportMode,
} from "@/lib/vms-sales-import";
import {
  applyColumnMapping,
  detectColumnMappingDetails,
  detectHeaderRowIndex,
  detectVmsReportTypeFromRows,
  findSalesReportPeriod,
  parseReportType,
  requiredMissing,
  sheetRowsToRecords,
  vmsExpectedFields,
  vmsReportTypes,
  type VmsFieldDef,
  type VmsReportType,
} from "@/lib/vms-parser";
import {
  createVmsOrderDetailsDuplicateHash,
  detectOrderDetailsDateRange,
  orderDetailsPaymentAmount,
  orderDetailsSuccessfulSalesAmount,
  orderDetailsTransactionStatus,
} from "@/lib/vms-order-details";
import { extractVmsSchemaIssue, vmsSchemaIssueMessage } from "@/lib/vms-schema-diagnostics";

export const dynamic = "force-dynamic";

type ImportSummary = {
  reportType?: string;
  importType?: string;
  fileName?: string;
  fileType?: string;
  sheetName?: string;
  totalRows?: number;
  importedRows?: number;
  needsProductMappingRows?: number;
  unknownMachineRows?: number;
  invalidRows?: number;
  skippedRows?: number;
  rowsSkippedDuplicate?: number;
  rowsNeedingReview?: number;
  reprocessCount?: number;
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
  unknownMachines?: string[];
  unmappedProducts?: string[];
  errors?: string[];
};

type VmsImportSearchParams = {
  [key: string]: string | undefined;
  batchId?: string;
  importBatchId?: string;
  previewId?: string;
  sheet?: string;
  reportType?: string;
  headerRow?: string;
  step?: string;
  error?: string;
  autoCreateProducts?: string;
  updateCostFromVms?: string;
  useSavedMapping?: string;
  importMode?: string;
  reportStartDate?: string;
  reportEndDate?: string;
};

type SupabaseServerClient = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;

type PreviewSheet = { name: string; rows: string[][] };

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

function dashboardUsageForReport(reportType: string | null | undefined) {
  if (reportType === "vms_order_details_weekly") {
    return [
      "Sales dashboard",
      "Product dashboard",
      "Machine dashboard",
      "Failed vend dashboard",
      "Refill recommendation",
    ];
  }
  if (reportType === "sales") return ["Reconciliation only"];
  if (reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram") return ["Inventory dashboard", "Refill recommendations", "Product mapping", "Machine mapping"];
  return ["Not used until mapped"];
}

function isStockReportType(reportType: string | null | undefined) {
  return reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram";
}

function activeLabel(batch: VmsBatchRow) {
  return ["imported", "imported_with_warnings", "partially_imported"].includes(String(batch.status ?? "")) && batch.is_active !== false && !batch.deleted_at ? "Yes" : "No";
}

function batchDateRange(batch: VmsBatchRow) {
  if (isStockReportType(batch.report_type ?? batch.source_type)) {
    return `Snapshot: ${formatDateTime(batch.detected_min_datetime ?? batch.uploaded_at ?? batch.imported_at)}`;
  }
  if (batch.report_start_date || batch.report_end_date) return `${batch.report_start_date ?? "-"} to ${batch.report_end_date ?? "-"}`;
  const summary = parseSummary(batch.notes);
  const start = summary?.orderDetailsReportPeriod?.reportStartDate;
  const end = summary?.orderDetailsReportPeriod?.reportEndDate;
  return start || end ? `${start ?? "-"} to ${end ?? "-"}` : "-";
}

function dateOnly(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addDays(dateOnlyValue: string, days: number) {
  const [year, month, day] = dateOnlyValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return dateOnly(date);
}

function weeklyCoverageGaps(batches: VmsBatchRow[]) {
  const ranges = batches
    .map((batch) => ({ start: batch.report_start_date ?? "", end: batch.report_end_date ?? "" }))
    .filter((range) => range.start && range.end)
    .sort((a, b) => a.start.localeCompare(b.start));
  const gaps: { start: string; end: string }[] = [];
  for (let index = 1; index < ranges.length; index += 1) {
    const expectedNext = addDays(ranges[index - 1].end, 1);
    if (expectedNext < ranges[index].start) gaps.push({ start: expectedNext, end: addDays(ranges[index].start, -1) });
  }
  return { ranges, gaps };
}

function clampStep(value: string | undefined, hasPreview: boolean) {
  if (!hasPreview) return 1;
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) ? Math.min(7, Math.max(2, Math.floor(parsed))) : 2;
}

function displayStepFromInternalStep(currentStep: number) {
  if (currentStep >= 7) return 3;
  if (currentStep >= 5) return 2;
  return 1;
}

function batchMetric(batch: VmsBatchRow | null | undefined, key: keyof ImportSummary, fallback = 0) {
  const summary = parseSummary(batch?.notes);
  return Number(summary?.[key] ?? fallback);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function safeDecode(value: string | undefined) {
  if (!value) return "-";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type SupabaseQueryError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

type VmsPageLoadIssue = {
  loader: string;
  table?: string | null;
  code?: string | null;
  message: string;
  details?: string | null;
  hint?: string | null;
  missing?: string | null;
  digest?: string | null;
};

type VmsSchemaHealth = {
  checked: boolean;
  missingTables: string[];
  missingColumns: string[];
  errors: VmsPageLoadIssue[];
};

type VmsBatchRow = {
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
  file_hash?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  detected_min_datetime?: string | null;
  detected_max_datetime?: string | null;
  total_successful_sales?: number | string | null;
  successful_rows_count?: number | null;
  failed_rows_count?: number | null;
  refunded_rows_count?: number | null;
  import_mode?: string | null;
  error_count?: number | null;
  notes?: string | null;
  last_reprocessed_at?: string | null;
  reprocess_count?: number | null;
};

type VmsImportPreviewRow = {
  id: string;
  file_name: string | null;
  file_type: string | null;
  file_size_bytes: number | null;
  report_type: string | null;
  sheets: unknown;
  created_at: string | null;
};

type VmsReviewSummary = {
  productMappingsNeedingReview: number | null;
  machineMappingsNeedingReview: number | null;
  savedHeaderMappings: number | null;
};

type ImporterRow = {
  id: string;
  full_name: string | null;
};

type SavedHeaderMapping = {
  id: string;
  last_used_mapping: unknown;
  updated_at: string | null;
  use_count: number | null;
};

type ValidationReferenceRows = {
  machines: VmsReferenceMachine[];
  products: VmsReferenceProduct[];
  productMappings: VmsReferenceMapping[];
  machineMappings: VmsReferenceMachineMapping[];
  headerMappings: VmsHeaderMappingReference[];
  previewRows: VmsPreviewRowReference[];
};

type VmsHeaderMappingReference = {
  id: string;
  report_type?: string | null;
  source_signature?: string | null;
};

type VmsPreviewRowReference = {
  id: string;
  preview_id?: string | null;
  sheet_name?: string | null;
  row_number: number;
  raw_row?: unknown;
};

type ValidationReferenceCounts = {
  machines: number;
  products: number;
  productMappings: number;
  machineMappings: number;
  headerMappings: number;
  previewRows: number;
};

type ValidationBlockingError = {
  queryName: string;
  error: SupabaseQueryError | null;
};

type ValidationReferenceLoadResult = ValidationReferenceRows & {
  counts: ValidationReferenceCounts;
  notices: string[];
  blockingError: ValidationBlockingError | null;
};

const preferredBatchSelect = [
  "id",
  "uploaded_by",
  "uploaded_at",
  "file_name",
  "report_type",
  "report_start_date",
  "report_end_date",
  "import_mode",
  "status",
  "rows_found",
  "rows_imported",
  "rows_skipped_duplicate",
  "rows_needing_review",
  "is_active",
  "deleted_at",
  "disabled_at",
  "delete_reason",
  "disable_reason",
  "source_usage",
  "dashboard_usage",
  "file_hash",
  "storage_bucket",
  "storage_path",
  "detected_min_datetime",
  "detected_max_datetime",
  "total_successful_sales",
  "successful_rows_count",
  "failed_rows_count",
  "refunded_rows_count",
  "notes",
  "source_type",
  "file_type",
  "sheet_name",
  "imported_by",
  "imported_at",
  "row_count",
  "rows_skipped",
  "error_count",
  "last_reprocessed_at",
  "reprocess_count",
].join(", ");

const legacyBatchSelect = [
  "id",
  "source_type",
  "file_name",
  "imported_by",
  "imported_at",
  "status",
  "row_count",
  "error_count",
  "notes",
].join(", ");

function queryError(error: unknown): SupabaseQueryError | null {
  if (!error || typeof error !== "object") return null;
  return error as SupabaseQueryError;
}

function errorText(error: SupabaseQueryError | null) {
  return `${error?.code ?? ""} ${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
}

function isMissingColumnError(error: SupabaseQueryError | null) {
  const text = errorText(error);
  return error?.code === "42703" || error?.code === "PGRST204" || text.includes("column") || text.includes("schema cache");
}

function isMissingSchemaError(error: SupabaseQueryError | null) {
  const text = errorText(error);
  return error?.code === "42P01" || error?.code === "PGRST205" || text.includes("does not exist") || isMissingColumnError(error);
}

function isPermissionError(error: SupabaseQueryError | null) {
  const text = errorText(error);
  return error?.code === "42501" || text.includes("permission denied") || text.includes("row-level security") || text.includes("rls");
}

function userFacingLoadError(error: SupabaseQueryError | null, queryName?: string) {
  if (isPermissionError(error)) return "You do not have permission to load VMS imports.";
  const schemaMessage = vmsSchemaIssueMessage(error, queryName);
  if (schemaMessage) return schemaMessage;
  if (isMissingSchemaError(error)) return "VMS import schema is missing or stale. Run the latest migration.";
  return "Snacky OS could not load VMS imports. Technical details are available in the server console.";
}

function relationFromQueryName(queryName: string) {
  return queryName.split(".")[0] || null;
}

function loadIssueFromError(loader: string, error: unknown): VmsPageLoadIssue {
  const supabaseError = queryError(error);
  const schemaIssue = extractVmsSchemaIssue(error, loader);
  const digest = error && typeof error === "object" && "digest" in error
    ? String((error as { digest?: unknown }).digest ?? "") || null
    : null;
  const missing = schemaIssue?.type === "missing_relation"
    ? schemaIssue.relation
    : schemaIssue?.type === "missing_column"
      ? `${schemaIssue.relation ? `${schemaIssue.relation}.` : ""}${schemaIssue.column}`
      : schemaIssue?.type === "schema_cache"
        ? schemaIssue.relation ?? "schema cache"
        : null;
  return {
    loader,
    table: relationFromQueryName(loader),
    code: supabaseError?.code ?? null,
    message: supabaseError?.message ?? String(error instanceof Error ? error.message : error ?? "Unknown VMS import error"),
    details: supabaseError?.details ?? null,
    hint: supabaseError?.hint ?? null,
    missing,
    digest,
  };
}

function logVmsImportLoadIssue({
  queryName,
  error,
  selectedBatchId,
  currentUserId,
  effectivePermissions,
}: {
  queryName: string;
  error: unknown;
  selectedBatchId: string | null;
  currentUserId: string | null;
  effectivePermissions: string[];
}) {
  const supabaseError = queryError(error);
  console.error("[vms-import] Load query failed", {
    queryName,
    code: supabaseError?.code ?? null,
    message: supabaseError?.message ?? String(error ?? "Unknown error"),
    details: supabaseError?.details ?? null,
    hint: supabaseError?.hint ?? null,
    schemaIssue: extractVmsSchemaIssue(error, queryName),
    selectedBatchId,
    currentUserId,
    effectivePermissions,
  });
}

const expectedVmsTables = [
  "vms_import_batches",
  "vms_import_preview_rows",
  "vms_product_mappings",
  "vms_machine_mappings",
  "vms_header_mappings",
  "vms_sales_raw",
  "vms_transactions_raw",
  "vms_machine_stock_snapshots",
];

const expectedVmsImportBatchColumns = [
  "file_hash",
  "detected_min_datetime",
  "detected_max_datetime",
  "is_active",
  "status",
  "report_type",
  "rows_found",
  "rows_imported",
  "parse_diagnostics",
];

async function loadVmsSchemaHealth(supabase: SupabaseServerClient): Promise<VmsSchemaHealth> {
  const health: VmsSchemaHealth = { checked: false, missingTables: [], missingColumns: [], errors: [] };
  try {
    const informationSchema = supabase.schema("information_schema");
    const tablesResult = await informationSchema
      .from("tables")
      .select("table_name")
      .eq("table_schema", "public")
      .in("table_name", expectedVmsTables);
    if (tablesResult.error) {
      health.errors.push(loadIssueFromError("information_schema.tables.vms_health", tablesResult.error));
      return health;
    }

    const foundTables = new Set((tablesResult.data ?? []).map((row) => String((row as { table_name?: unknown }).table_name)));
    health.missingTables = expectedVmsTables.filter((table) => !foundTables.has(table));

    const columnsResult = await informationSchema
      .from("columns")
      .select("column_name")
      .eq("table_schema", "public")
      .eq("table_name", "vms_import_batches")
      .in("column_name", expectedVmsImportBatchColumns);
    if (columnsResult.error) {
      health.errors.push(loadIssueFromError("information_schema.columns.vms_import_batches_health", columnsResult.error));
      return health;
    }

    const foundColumns = new Set((columnsResult.data ?? []).map((row) => String((row as { column_name?: unknown }).column_name)));
    health.missingColumns = expectedVmsImportBatchColumns
      .filter((column) => !foundColumns.has(column))
      .map((column) => `vms_import_batches.${column}`);
    health.checked = true;
    return health;
  } catch (error) {
    health.errors.push(loadIssueFromError("vms_schema_health.unexpected", error));
    return health;
  }
}

function parseHeaderRow(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function booleanParam(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function optionValue(value: boolean) {
  return value ? "yes" : "no";
}

function formatBytes(value: unknown) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sampleList(samples: Record<string, string[]>, header: string) {
  const values = header ? samples[header] ?? [] : [];
  return values.length ? values.join(" | ") : "-";
}

function findMappedSalesReportRange(rows: Record<string, string>[]) {
  const dates = rows
    .map((row) => salesPeriodFromMappedRow(row)?.reportStartDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (!dates.length) return { start: "", end: "" };
  return { start: dates[0], end: dates[dates.length - 1] };
}

function mappedNumber(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const negative = raw.includes("(") && raw.includes(")");
  let cleaned = raw.replace(/[^\d,.\-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    cleaned = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = cleaned.length - lastComma - 1;
    cleaned = decimals > 0 && decimals <= 2 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null;
}

function buildPreviewSalesSourceKey({
  row,
  validationRow,
  reportRange,
  titlePeriod,
}: {
  row: Record<string, string>;
  validationRow: NonNullable<VmsValidationResult>["rows"][number];
  reportRange: { start: string; end: string };
  titlePeriod: { reportStartDate: string; reportEndDate: string } | null;
}) {
  if (validationRow.status !== "imported") return null;
  const rowPeriod = titlePeriod ?? salesPeriodFromMappedRow(row);
  if (!rowPeriod) return null;
  const machineId = validationRow.matchedMachineId;
  const productId = validationRow.matchedProductId;
  if (!machineId || !productId) return null;
  const soldQty = mappedNumber(vmsValue(row, ["sold_qty", "transaction_count", "number_of_transaction", "number_of_transactions", "quantity_sold", "units_sold", "sales_units", "units", "qty", "quantity", "sales_qty", "sales_quantity", "volume", "sales_volume"])) ?? 0;
  const grossSalesAmount = mappedNumber(vmsValue(row, ["total_sales_amount", "transaction_amount", "revenue_amount", "sales_amount", "total_sales", "total_sales_lyd", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"])) ?? 0;
  const refundAmount = mappedNumber(vmsValue(row, ["refund_amount", "refund_total"])) ?? 0;
  return createVmsSalesSourceRowKey({
    vmsTransactionId: vmsValue(row, ["vms_transaction_id", "transaction_id", "transaction_no", "txn_id", "order_id", "order_no", "receipt_id", "receipt_no"]),
    machineId,
    machineCode: validationRow.machineIdentifier,
    machineName: validationRow.machineIdentifier,
    productId,
    productCode: validationRow.productIdentifier,
    productName: validationRow.productName,
    saleStartDate: rowPeriod.reportStartDate,
    saleEndDate: rowPeriod.reportEndDate,
    reportStartDate: titlePeriod?.reportStartDate ?? reportRange.start,
    reportEndDate: titlePeriod?.reportEndDate ?? reportRange.end,
    soldQty,
    grossSalesAmount,
    netSalesAmount: Math.max(0, grossSalesAmount - Math.max(0, refundAmount)),
  });
}

function rowPreview(row: string[]) {
  const text = row.filter(Boolean).slice(0, 6).join(" | ");
  return text || "Blank row";
}

function queryFor(params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, value);
  });
  return `/vms-import?${query.toString()}`;
}

function readMapping(params: VmsImportSearchParams, reportType: VmsReportType, defaults: Record<string, string>) {
  const mapping: Record<string, string> = {};
  for (const field of vmsExpectedFields[reportType]) {
    mapping[field.field] = params[`map_${field.field}`] ?? defaults[field.field] ?? "";
  }
  return mapping;
}

function requirementLabel(field: VmsFieldDef, fields: VmsFieldDef[]) {
  if (field.required) return "Required";
  if (!field.requiredGroup) return "Optional";
  return `Required: one of ${fields.filter((item) => item.requiredGroup === field.requiredGroup).map((item) => item.label).join(" / ")}`;
}

function requirementSatisfied(field: VmsFieldDef, fields: VmsFieldDef[], mapping: Record<string, string>) {
  if (field.required) return Boolean(mapping[field.field]);
  if (!field.requiredGroup) return true;
  return fields.filter((item) => item.requiredGroup === field.requiredGroup).some((item) => Boolean(mapping[item.field]));
}

function WizardStateInputs({
  step,
  importBatchId,
  previewId,
  sheetName,
  reportType,
  headerRow,
  mapping,
  autoCreateProducts,
  updateCostFromVms,
  importMode,
  reportStartDate,
  reportEndDate,
  includeImportOptions = true,
  finalAction = false,
}: {
  step?: number;
  importBatchId?: string;
  previewId: string;
  sheetName: string;
  reportType: VmsReportType;
  headerRow: number;
  mapping?: Record<string, string>;
  autoCreateProducts?: boolean;
  updateCostFromVms?: boolean;
  importMode?: VmsImportMode;
  reportStartDate?: string;
  reportEndDate?: string;
  includeImportOptions?: boolean;
  finalAction?: boolean;
}) {
  return (
    <>
      {step ? <input type="hidden" name="step" value={step} /> : null}
      {importBatchId ? <input type="hidden" name={finalAction ? "import_batch_id" : "importBatchId"} value={importBatchId} /> : null}
      <input type="hidden" name={finalAction ? "preview_id" : "previewId"} value={previewId} />
      <input type="hidden" name={finalAction ? "sheet_name" : "sheet"} value={sheetName} />
      <input type="hidden" name={finalAction ? "report_type" : "reportType"} value={reportType} />
      <input type="hidden" name={finalAction ? "header_row" : "headerRow"} value={headerRow} />
      {includeImportOptions && autoCreateProducts !== undefined ? (
        <input type="hidden" name={finalAction ? "auto_create_products" : "autoCreateProducts"} value={optionValue(autoCreateProducts)} />
      ) : null}
      {includeImportOptions && updateCostFromVms !== undefined ? (
        <input type="hidden" name={finalAction ? "update_cost_from_vms" : "updateCostFromVms"} value={optionValue(updateCostFromVms)} />
      ) : null}
      {includeImportOptions && importMode ? (
        <input type="hidden" name={finalAction ? "import_mode" : "importMode"} value={importMode} />
      ) : null}
      {includeImportOptions && reportStartDate ? (
        <input type="hidden" name={finalAction ? "report_start_date" : "reportStartDate"} value={reportStartDate} />
      ) : null}
      {includeImportOptions && reportEndDate ? (
        <input type="hidden" name={finalAction ? "report_end_date" : "reportEndDate"} value={reportEndDate} />
      ) : null}
      {mapping
        ? Object.entries(mapping).map(([field, column]) => (
            <input key={field} type="hidden" name={`map_${field}`} value={column} />
          ))
        : null}
    </>
  );
}

export default async function VmsImportPage({ searchParams }: { searchParams: Promise<VmsImportSearchParams> }) {
  try {
    return await VmsImportPageContent({ searchParams });
  } catch (error) {
    const profile = await getCurrentProfile().catch(() => null);
    const effectivePermissions = profile ? getEffectivePermissions(profile) : [];
    const issue = loadIssueFromError("vms_import_page.unexpected_server_component_error", error);
    console.error("[vms-import] Page-level render guard caught an unexpected error", {
      digest: error && typeof error === "object" ? (error as { digest?: unknown }).digest ?? null : null,
      issue,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
    });

    return (
      <>
        <PageHeader
          title="VMS Import"
          subtitle="Three-step import: upload and detect, review mapping, confirm import."
        />
        <div className="mb-6"><UploadCard /></div>
        <InlineLoadIssue title="VMS import page recovered from a server render error" issue={issue} />
        {isOwnerAdminRole(profile) ? (
          <AdminDiagnosticsPanel issues={[issue]} currentUserId={profile?.id ?? null} effectivePermissions={effectivePermissions} />
        ) : null}
      </>
    );
  }
}

function Stepper({ currentStep }: { currentStep: number }) {
  const visibleStep = displayStepFromInternalStep(currentStep);
  const steps = [
    { label: "Upload + Auto Detect", detail: "File, sheet, report, header" },
    { label: "Review Mapping", detail: "Products, machines, rows" },
    { label: "Confirm Import", detail: "Save and refresh dashboards" },
  ];
  return (
    <div className="mb-6 grid gap-2 md:grid-cols-3">
      {steps.map((item, index) => {
        const step = index + 1;
        const active = step === visibleStep;
        const done = step < visibleStep;
        return (
          <div key={item.label} className={`rounded-lg border px-3 py-2 text-sm ${active ? "border-emerald-300 bg-emerald-50 text-emerald-900" : done ? "border-slate-200 bg-white text-slate-700" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
            <div className="text-xs font-semibold uppercase tracking-wide">Step {step}</div>
            <div className="font-medium">{item.label}</div>
            <div className="mt-1 text-xs opacity-80">{item.detail}</div>
          </div>
        );
      })}
    </div>
  );
}

function productCell(row: { productIdentifier: string | null; productName: string | null }) {
  if (row.productIdentifier && row.productName && row.productIdentifier !== row.productName) return `${row.productIdentifier} - ${row.productName}`;
  return row.productName || row.productIdentifier || "-";
}

function UploadCard() {
  return (
    <SectionCard>
      <LocalDraftForm action={prepareVmsImport} formType="vms-import" draftKeyParts={["upload"]} className="space-y-4 p-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Step 1: Upload + Auto Detect</h2>
          <p className="mt-1 text-sm text-slate-500">Upload the VMS export exactly as downloaded. Snacky OS detects the sheet, report type, headers, rows, and date/snapshot range.</p>
        </div>
        <FormField label="VMS file" required hint="Accepted: .xlsx, .xls, .csv">
          <input name="file" type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required className="field-input" />
        </FormField>
        <FormField label="Report type" hint="Auto-detect usually identifies the detailed weekly order report. You can change it in the wizard.">
          <select name="report_type" defaultValue="" className="field-input">
            <option value="">Auto-detect</option>
            <option value="vms_order_details_weekly">Detailed Order Details Report - Recommended</option>
            <option value="machine_stock_snapshot">Machine Stock Snapshot</option>
            <option value="stock">Machine Stock Report (legacy)</option>
            <option value="sales">General / Summary Sales Report</option>
          </select>
        </FormField>
        <FormSubmitButton
          className="btn-primary w-full"
          pendingLabel="Reading file and preparing preview..."
          slowLabel="Still working. Snacky OS is saving the preview; please do not press again."
          slowAfterMs={18000}
        >
          Upload + Auto Detect
        </FormSubmitButton>
      </LocalDraftForm>
    </SectionCard>
  );
}

function RawRowsTable({ rows, limit = 20, headerRow }: { rows: string[][]; limit?: number; headerRow?: number }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <tbody>
          {rows.slice(0, limit).map((row, index) => (
            <tr key={index} className={index === headerRow ? "bg-emerald-50" : ""}>
              <td className="whitespace-nowrap font-semibold text-slate-700">Row {index + 1}{index === headerRow ? " header" : ""}</td>
              {row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-64">{cell || "-"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

function ReviewSummaryCard({ summary, batchReviewRows }: { summary: VmsReviewSummary; batchReviewRows: number }) {
  return (
    <section className="surface-card mb-6">
      <h2 className="mb-4 text-lg font-semibold text-slate-900">Needs Review</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Import rows" value={batchReviewRows} />
        <StatCard label="Product mappings" value={summary.productMappingsNeedingReview ?? "-"} />
        <StatCard label="Machine mappings" value={summary.machineMappingsNeedingReview ?? "-"} />
        <StatCard label="Saved header mappings" value={summary.savedHeaderMappings ?? "-"} />
      </div>
    </section>
  );
}

function MappingStatus({
  required,
  selectedColumn,
  confidence,
}: {
  required?: boolean;
  selectedColumn: string;
  confidence?: "high" | "medium" | "low" | "missing";
}) {
  if (required && !selectedColumn) return <StatusBadge status="missing required" />;
  if (!selectedColumn) return <StatusBadge status="not mapped" />;
  return <StatusBadge status={confidence === "missing" ? "manual" : confidence ?? "manual"} />;
}

function OriginalRowData({ row }: { row: Record<string, string> }) {
  return (
    <pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
      {JSON.stringify(row, null, 2)}
    </pre>
  );
}

function DebugBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function VmsImportDebugPanel({
  selectedSheetName,
  detectedHeaderRow,
  detectedColumns,
  selectedMapping,
  sampleNormalizedRows,
  validation,
}: {
  selectedSheetName: string | null;
  detectedHeaderRow: number | null;
  detectedColumns: string[];
  selectedMapping: Record<string, string>;
  sampleNormalizedRows: Record<string, string>[];
  validation: VmsValidationResult | null;
}) {
  if (process.env.NODE_ENV !== "development" || !selectedSheetName) return null;

  const validationErrors = (validation?.errorRowsList ?? []).slice(0, 5).map((row) => ({
    rowNumber: row.rowNumber,
    status: row.status,
    reasons: row.reasons,
    machine: row.machineIdentifier,
    productIdentifier: row.productIdentifier,
    productName: row.productName,
  }));
  const failedRawRows = (validation?.reviewRowsList ?? []).slice(0, 5).map((row) => ({
    rowNumber: row.rowNumber,
    status: row.status,
    reasons: row.reasons,
    raw: row.originalRow,
  }));

  return (
    <section className="surface-card mb-6 space-y-4 border-amber-200 bg-amber-50">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Development debug</h2>
        <p className="mt-1 text-sm text-slate-600">Visible only when NODE_ENV=development.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <DebugBlock title="Selected sheet name" value={selectedSheetName} />
        <DebugBlock title="Detected header row" value={detectedHeaderRow === null ? "none" : detectedHeaderRow + 1} />
        <DebugBlock title="Detected columns" value={detectedColumns} />
        <DebugBlock title="Selected mappings" value={selectedMapping} />
        <DebugBlock title="Sample normalized rows" value={sampleNormalizedRows.slice(0, 5)} />
        <DebugBlock title="First 5 validation errors" value={validationErrors} />
        <div className="xl:col-span-2">
          <DebugBlock title="Raw row data for failed rows" value={failedRawRows} />
        </div>
      </div>
    </section>
  );
}

function InlineLoadIssue({ title, issue }: { title: string; issue?: VmsPageLoadIssue | null }) {
  if (!issue) return null;
  const missingText = issue.missing ? ` Missing: ${issue.missing}.` : "";
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
      <div className="font-semibold text-amber-950">{title}</div>
      <p className="mt-1">
        {issue.missing ? "VMS import schema needs repair." : "This section could not load."}
        {missingText} {issue.message}
      </p>
    </div>
  );
}

function VmsSchemaRepairPanel({ schemaHealth, canRepair }: { schemaHealth: VmsSchemaHealth; canRepair: boolean }) {
  const missing = [...schemaHealth.missingTables, ...schemaHealth.missingColumns];
  if (!missing.length && !schemaHealth.errors.length) return null;

  return (
    <section className="surface-card mb-6 border-amber-200 bg-amber-50">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-base font-semibold text-amber-950">VMS import schema needs repair</h2>
          <p className="mt-1 text-sm text-amber-900">
            Missing: {missing.length ? missing.join(", ") : "schema health check access"}. Run migration repair; upload and other available sections still work.
          </p>
        </div>
        {canRepair ? (
          <details className="rounded-lg border border-amber-300 bg-white p-3 text-sm">
            <summary className="cursor-pointer font-semibold text-slate-900">Repair VMS Schema</summary>
            <div className="mt-3 space-y-2 text-slate-700">
              <p>Apply the idempotent VMS migrations, especially:</p>
              <code className="block rounded bg-slate-950 p-3 text-xs text-white">
                npx supabase migration up
              </code>
              <p className="text-xs">
                Relevant migration: supabase/migrations/202606010002_vms_import_batch_metadata_contract.sql
              </p>
            </div>
          </details>
        ) : null}
      </div>
      {schemaHealth.errors.map((issue) => (
        <InlineLoadIssue key={issue.loader} title={issue.loader} issue={issue} />
      ))}
    </section>
  );
}

function AdminDiagnosticsPanel({
  issues,
  currentUserId,
  effectivePermissions,
}: {
  issues: VmsPageLoadIssue[];
  currentUserId: string | null;
  effectivePermissions: string[];
}) {
  if (!issues.length) return null;
  return (
    <section className="surface-card mb-6 border-amber-200 bg-white">
      <h2 className="text-lg font-semibold text-slate-900">VMS Error Diagnostics</h2>
      <p className="mt-1 text-sm text-slate-500">Admin/debug detail for failed VMS loaders. The page is using safe fallbacks instead of crashing.</p>
      <div className="mt-4 grid gap-3">
        {issues.map((issue, index) => (
          <div key={`${issue.loader}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="font-semibold text-slate-900">{issue.loader}</div>
            <div className="mt-1 grid gap-1 text-xs text-slate-600 sm:grid-cols-2 xl:grid-cols-4">
              <div>Table: {issue.table ?? "-"}</div>
              <div>Code: {issue.code ?? "-"}</div>
              <div>Missing: {issue.missing ?? "-"}</div>
              <div>Digest: {issue.digest ?? "-"}</div>
              <div>User: {currentUserId ?? "-"}</div>
              <div className="sm:col-span-2">Message: {issue.message}</div>
              <div className="sm:col-span-2">Permissions: {effectivePermissions.join(", ") || "-"}</div>
              {issue.details ? <div className="sm:col-span-2">Details: {issue.details}</div> : null}
              {issue.hint ? <div className="sm:col-span-2">Hint: {issue.hint}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

async function loadVmsImportBatches({
  supabase,
  from,
  to,
  selectedBatchId,
  currentUserId,
  effectivePermissions,
}: {
  supabase: SupabaseServerClient;
  from: number;
  to: number;
  selectedBatchId: string | null;
  currentUserId: string | null;
  effectivePermissions: string[];
}) {
  let preferred;
  try {
    preferred = await supabase
      .from("vms_import_batches")
      .select(preferredBatchSelect, { count: "exact" })
      .order("imported_at", { ascending: false })
      .range(from, to);
  } catch (error) {
    logVmsImportLoadIssue({
      queryName: "vms_import_batches.preferred",
      error,
      selectedBatchId,
      currentUserId,
      effectivePermissions,
    });
    return { batches: [], batchCount: 0, error: queryError(error) ?? { message: error instanceof Error ? error.message : String(error) }, schemaNotice: "" };
  }

  if (!preferred.error) {
    return {
      batches: (preferred.data ?? []) as unknown as VmsBatchRow[],
      batchCount: preferred.count ?? 0,
      error: null,
      schemaNotice: "",
    };
  }

  const preferredError = queryError(preferred.error);
  logVmsImportLoadIssue({
    queryName: "vms_import_batches.preferred",
    error: preferred.error,
    selectedBatchId,
    currentUserId,
    effectivePermissions,
  });

  if (!isMissingColumnError(preferredError)) {
    return { batches: [], batchCount: 0, error: preferredError, schemaNotice: "" };
  }

  let fallback;
  try {
    fallback = await supabase
      .from("vms_import_batches")
      .select(legacyBatchSelect, { count: "exact" })
      .order("imported_at", { ascending: false })
      .range(from, to);
  } catch (error) {
    logVmsImportLoadIssue({
      queryName: "vms_import_batches.legacy_fallback",
      error,
      selectedBatchId,
      currentUserId,
      effectivePermissions,
    });
    return { batches: [], batchCount: 0, error: queryError(error) ?? { message: error instanceof Error ? error.message : String(error) }, schemaNotice: "" };
  }

  if (fallback.error) {
    logVmsImportLoadIssue({
      queryName: "vms_import_batches.legacy_fallback",
      error: fallback.error,
      selectedBatchId,
      currentUserId,
      effectivePermissions,
    });
    return { batches: [], batchCount: 0, error: queryError(fallback.error), schemaNotice: "" };
  }

  return {
    batches: (fallback.data ?? []) as unknown as VmsBatchRow[],
    batchCount: fallback.count ?? 0,
    error: null,
    schemaNotice: "VMS import database columns need the latest migration. Showing available legacy import data.",
  };
}

async function countRows({
  queryName,
  selectedBatchId,
  currentUserId,
  effectivePermissions,
  build,
}: {
  queryName: string;
  selectedBatchId: string | null;
  currentUserId: string | null;
  effectivePermissions: string[];
  build: () => PromiseLike<{ count: number | null; error: unknown }>;
}) {
  try {
    const { count, error } = await build();
    if (!error) return count ?? 0;
    logVmsImportLoadIssue({ queryName, error, selectedBatchId, currentUserId, effectivePermissions });
    return null;
  } catch (error) {
    logVmsImportLoadIssue({ queryName, error, selectedBatchId, currentUserId, effectivePermissions });
    return null;
  }
}

async function loadVmsReviewSummary({
  supabase,
  selectedBatchId,
  currentUserId,
  effectivePermissions,
}: {
  supabase: SupabaseServerClient;
  selectedBatchId: string | null;
  currentUserId: string | null;
  effectivePermissions: string[];
}): Promise<VmsReviewSummary> {
  const [productMappingsNeedingReview, machineMappingsNeedingReview, savedHeaderMappings] = await Promise.all([
    countRows({
      queryName: "vms_product_mappings.needs_review_count",
      selectedBatchId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("vms_product_mappings").select("id", { count: "exact", head: true }).eq("match_status", "needs_review"),
    }),
    countRows({
      queryName: "vms_machine_mappings.needs_review_count",
      selectedBatchId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("vms_machine_mappings").select("id", { count: "exact", head: true }).eq("status", "needs_review"),
    }),
    countRows({
      queryName: "vms_header_mappings.count",
      selectedBatchId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("vms_header_mappings").select("id", { count: "exact", head: true }),
    }),
  ]);

  return { productMappingsNeedingReview, machineMappingsNeedingReview, savedHeaderMappings };
}

async function loadValidationRows<T>({
  queryName,
  selectedBatchId,
  currentUserId,
  effectivePermissions,
  build,
}: {
  queryName: string;
  selectedBatchId: string | null;
  currentUserId: string | null;
  effectivePermissions: string[];
  build: () => PromiseLike<{ data: T[] | null; error: unknown }>;
}) {
  try {
    const { data, error } = await build();
    if (!error) {
      return { queryName, data: data ?? [], error: null as SupabaseQueryError | null };
    }

    logVmsImportLoadIssue({ queryName, error, selectedBatchId, currentUserId, effectivePermissions });
    return { queryName, data: [] as T[], error: queryError(error) };
  } catch (error) {
    logVmsImportLoadIssue({ queryName, error, selectedBatchId, currentUserId, effectivePermissions });
    return { queryName, data: [] as T[], error: queryError(error) ?? { message: error instanceof Error ? error.message : String(error) } };
  }
}

function validationReferenceErrorMessage(blockingError: ValidationBlockingError) {
  if (isPermissionError(blockingError.error)) return "You do not have permission to validate VMS imports.";
  const schemaMessage = vmsSchemaIssueMessage(blockingError.error, blockingError.queryName);
  if (schemaMessage) return schemaMessage;
  if (isMissingSchemaError(blockingError.error)) return "VMS import schema is missing or stale. Run the latest migration.";
  if (blockingError.queryName === "machines.validation_references") return "Could not load machines needed to validate this VMS import.";
  if (blockingError.queryName === "products.validation_references") return "Could not load products needed to validate this VMS import.";
  if (blockingError.queryName === "vms_import_preview_rows.current_preview") return "Could not load preview rows for this import. Run the latest migration or re-upload the file.";
  if (blockingError.queryName === "vms_import_preview_rows.empty") return "This import batch has no preview rows. Please re-upload the file.";
  if (blockingError.queryName === "vms_import_previews.selected") return "This import preview no longer exists. Please re-upload the file.";
  return "Could not load VMS import. Technical details are in console.";
}

async function loadVmsValidationReferences({
  supabase,
  selectedPreviewId,
  currentUserId,
  effectivePermissions,
}: {
  supabase: SupabaseServerClient;
  selectedPreviewId: string | null;
  currentUserId: string | null;
  effectivePermissions: string[];
}): Promise<ValidationReferenceLoadResult> {
  const [
    machinesResult,
    productsResult,
    productMappingsResult,
    machineMappingsResult,
    headerMappingsResult,
    previewRowsResult,
  ] = await Promise.all([
    loadValidationRows<VmsReferenceMachine>({
      queryName: "machines.validation_references",
      selectedBatchId: selectedPreviewId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("machines").select("id, machine_code, vms_machine_id, name, location_id"),
    }),
    loadValidationRows<VmsReferenceProduct>({
      queryName: "products.validation_references",
      selectedBatchId: selectedPreviewId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("products").select("id, sku, barcode, name"),
    }),
    loadValidationRows<VmsReferenceMapping>({
      queryName: "vms_product_mappings.validation_references",
      selectedBatchId: selectedPreviewId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("vms_product_mappings").select("id, vms_product_id, vms_product_name, product_id, match_status"),
    }),
    loadValidationRows<VmsReferenceMachineMapping>({
      queryName: "vms_machine_mappings.validation_references",
      selectedBatchId: selectedPreviewId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("vms_machine_mappings").select("id, vms_machine_key, vms_machine_name, machine_id, location_id, status, aliases"),
    }),
    loadValidationRows<VmsHeaderMappingReference>({
      queryName: "vms_header_mappings.validation_references",
      selectedBatchId: selectedPreviewId,
      currentUserId,
      effectivePermissions,
      build: () => supabase.from("vms_header_mappings").select("id, report_type, source_signature"),
    }),
    selectedPreviewId
      ? loadValidationRows<VmsPreviewRowReference>({
        queryName: "vms_import_preview_rows.current_preview",
        selectedBatchId: selectedPreviewId,
        currentUserId,
        effectivePermissions,
        build: () => supabase
          .from("vms_import_preview_rows")
          .select("id, preview_id, sheet_name, row_number, raw_row")
          .eq("preview_id", selectedPreviewId)
          .order("row_number", { ascending: true }),
      })
      : Promise.resolve({ queryName: "vms_import_preview_rows.current_preview", data: [] as VmsPreviewRowReference[], error: null as SupabaseQueryError | null }),
  ]);

  const notices: string[] = [];
  if (productMappingsResult.error) {
    notices.push("Saved product mappings could not be loaded. Validation will continue and mark unmatched products as Needs Review.");
  }
  if (machineMappingsResult.error) {
    notices.push("Saved machine mappings could not be loaded. Validation will continue and mark unmatched machines as Needs Review.");
  }
  if (headerMappingsResult.error) {
    notices.push("Saved header mappings could not be loaded. Auto-detected column mappings are still available.");
  }
  const counts = {
    machines: machinesResult.data.length,
    products: productsResult.data.length,
    productMappings: productMappingsResult.error ? 0 : productMappingsResult.data.length,
    machineMappings: machineMappingsResult.error ? 0 : machineMappingsResult.data.length,
    headerMappings: headerMappingsResult.error ? 0 : headerMappingsResult.data.length,
    previewRows: previewRowsResult.error ? 0 : previewRowsResult.data.length,
  };

  if (!productMappingsResult.error && !machineMappingsResult.error && counts.productMappings === 0 && counts.machineMappings === 0) {
    notices.push("No saved mappings found yet. Please map the new products/machines below.");
  }

  const blockingError = machinesResult.error
    ? { queryName: machinesResult.queryName, error: machinesResult.error }
    : productsResult.error
      ? { queryName: productsResult.queryName, error: productsResult.error }
      : previewRowsResult.error
        ? { queryName: previewRowsResult.queryName, error: previewRowsResult.error }
        : selectedPreviewId && counts.previewRows === 0
          ? { queryName: "vms_import_preview_rows.empty", error: null }
          : null;

  console.info("[vms-import] Validation references loaded", {
    selectedBatchId: selectedPreviewId,
    currentUserId,
    effectivePermissions,
    counts,
    failedQueries: [
      machinesResult,
      productsResult,
      productMappingsResult,
      machineMappingsResult,
      headerMappingsResult,
      previewRowsResult,
    ]
      .filter((result) => result.error)
      .map((result) => ({
        queryName: result.queryName,
        code: result.error?.code ?? null,
        message: result.error?.message ?? null,
      })),
  });

  return {
    machines: machinesResult.data,
    products: productsResult.data,
    productMappings: productMappingsResult.error ? [] : productMappingsResult.data,
    machineMappings: machineMappingsResult.error ? [] : machineMappingsResult.data,
    headerMappings: headerMappingsResult.error ? [] : headerMappingsResult.data,
    previewRows: previewRowsResult.error ? [] : previewRowsResult.data,
    counts,
    notices: Array.from(new Set(notices)),
    blockingError,
  };
}

async function VmsImportPageContent({ searchParams }: { searchParams: Promise<VmsImportSearchParams> }) {
  const profile = await getCurrentProfile();
  const effectivePermissions = profile ? getEffectivePermissions(profile) : [];
  const pageIssues: VmsPageLoadIssue[] = [];
  const selectedBatchIdForLogs = null;
  if (!canViewVmsImports(profile)) {
    return (
      <>
        <PageHeader title="VMS Import" subtitle="Three-step import: upload and detect, review mapping, confirm import." />
        <ErrorState title="VMS import access required" body="You do not have permission to view VMS imports." />
      </>
    );
  }

  const params = await searchParams;
  const paginationParams = cleanSearchParams(params);
  const { page, pageSize, from, to } = getPagination(paginationParams);
  if (params.batchId) redirect(`/vms-import/${params.batchId}`);

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <PageHeader title="VMS Import" subtitle="Three-step import: upload and detect, review mapping, confirm import." />
        <ErrorState title="VMS import unavailable" body="Supabase is not configured, so Snacky OS cannot upload or review VMS files." />
      </>
    );
  }

  const schemaHealth = await loadVmsSchemaHealth(supabase);
  pageIssues.push(...schemaHealth.errors);

  const selectedPreviewId = params.previewId ?? null;
  const {
    batches,
    batchCount,
    error: batchesError,
    schemaNotice,
  } = await loadVmsImportBatches({
    supabase,
    from,
    to,
    selectedBatchId: selectedPreviewId ?? selectedBatchIdForLogs,
    currentUserId: profile?.id ?? null,
    effectivePermissions,
  });

  if (batchesError) pageIssues.push(loadIssueFromError("vms_import_batches.list", batchesError));

  let preview: VmsImportPreviewRow | null = null;
  let selectedPreviewNotice = "";
  let selectedImportBatchId = String(params.importBatchId ?? "").trim();
  if (selectedPreviewId) {
    const { data, error: previewError } = await (async () => {
      try {
        return await supabase
          .from("vms_import_previews")
          .select("id, file_name, file_type, file_size_bytes, report_type, sheets, created_at")
          .eq("id", selectedPreviewId)
          .maybeSingle();
      } catch (error) {
        return { data: null, error };
      }
    })();
    if (previewError) {
      logVmsImportLoadIssue({
        queryName: "vms_import_previews.selected",
        error: previewError,
        selectedBatchId: selectedPreviewId,
        currentUserId: profile?.id ?? null,
        effectivePermissions,
      });
      pageIssues.push(loadIssueFromError("vms_import_previews.selected", previewError));
      selectedPreviewNotice = userFacingLoadError(queryError(previewError), "vms_import_previews.selected");
      preview = null;
    }
    preview = data as unknown as VmsImportPreviewRow | null;
    if (!preview) {
      if (!selectedPreviewNotice) selectedPreviewNotice = "This import batch no longer exists. Showing latest imports instead.";
    } else if (!selectedImportBatchId) {
      const { data: previewRowBatch, error: previewRowBatchError } = await (async () => {
        try {
          return await supabase
            .from("vms_import_preview_rows")
            .select("import_batch_id")
            .eq("preview_id", selectedPreviewId)
            .not("import_batch_id", "is", null)
            .limit(1)
            .maybeSingle();
        } catch (error) {
          return { data: null, error };
        }
      })();
      if (!previewRowBatchError && previewRowBatch?.import_batch_id) {
        selectedImportBatchId = String(previewRowBatch.import_batch_id);
      } else if (previewRowBatchError && !isMissingSchemaError(queryError(previewRowBatchError))) {
        logVmsImportLoadIssue({
          queryName: "vms_import_preview_rows.batch_link",
          error: previewRowBatchError,
          selectedBatchId: selectedPreviewId,
          currentUserId: profile?.id ?? null,
          effectivePermissions,
        });
        pageIssues.push(loadIssueFromError("vms_import_preview_rows.batch_link", previewRowBatchError));
      } else if (previewRowBatchError) {
        pageIssues.push(loadIssueFromError("vms_import_preview_rows.batch_link", previewRowBatchError));
      }
    }
  }

  const importerIds = [...new Set((batches ?? []).map((batch) => batch.uploaded_by ?? batch.imported_by).filter(Boolean))];
  const { data: importers, error: importersError } = importerIds.length
    ? await (async () => {
      try {
        return await supabase.from("team_members").select("id, full_name").in("id", importerIds);
      } catch (error) {
        return { data: [], error };
      }
    })()
    : { data: [], error: null };
  if (importersError) {
    logVmsImportLoadIssue({
      queryName: "team_members.importers",
      error: importersError,
      selectedBatchId: selectedPreviewId,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
    });
    pageIssues.push(loadIssueFromError("team_members.importers", importersError));
  }
  const importerById = new Map(((importers ?? []) as ImporterRow[]).map((member) => [String(member.id), member.full_name]));
  const reviewSummary = await loadVmsReviewSummary({
    supabase,
    selectedBatchId: selectedPreviewId,
    currentUserId: profile?.id ?? null,
    effectivePermissions,
  });
  const batchReviewRows = batches.reduce((sum, batch) => sum + Number(batch.rows_needing_review ?? batchMetric(batch, "rowsNeedingReview", batchMetric(batch, "needsProductMappingRows", 0))), 0);
  const activeDetailedBatches = batches.filter((batch) => batch.report_type === "vms_order_details_weekly" && batch.status === "imported" && batch.is_active !== false && !batch.deleted_at);
  const detailedCoverage = weeklyCoverageGaps(activeDetailedBatches);
  const overlappingActiveBatches = activeDetailedBatches.filter((batch, index) => activeDetailedBatches.some((other, otherIndex) => (
    index !== otherIndex
    && Boolean(batch.report_start_date && batch.report_end_date && other.report_start_date && other.report_end_date)
    && String(batch.report_start_date) <= String(other.report_end_date)
    && String(other.report_start_date) <= String(batch.report_end_date)
  )));

  const previewSheets = ((preview?.sheets ?? []) as PreviewSheet[]).filter((sheet) => sheet.rows?.length);
  const selectedSheet = previewSheets.find((sheet) => sheet.name === params.sheet) ?? previewSheets[0] ?? null;
  const detectedReportType = selectedSheet ? detectVmsReportTypeFromRows(selectedSheet.rows) : null;
  const previewReportType = preview?.report_type && preview.report_type !== "custom" ? parseReportType(preview.report_type) : null;
  const selectedReportType = parseReportType(params.reportType) ?? previewReportType ?? detectedReportType ?? "custom";
  const autoCreateProducts = selectedReportType === "product_list" ? booleanParam(params.autoCreateProducts, true) : false;
  const updateCostFromVms = selectedReportType === "product_list" ? booleanParam(params.updateCostFromVms, false) : false;
  const detectedHeaderRow = selectedSheet ? detectHeaderRowIndex(selectedSheet.rows, selectedReportType) : 0;
  const selectedHeaderRow = selectedSheet ? parseHeaderRow(params.headerRow, detectedHeaderRow) : 0;
  const selectedRows = selectedSheet
    ? sheetRowsToRecords(selectedSheet.rows, { reportType: selectedReportType, headerRowIndex: selectedHeaderRow })
    : { headerRowIndex: 0, headerConfidence: 0, headers: [], records: [], samples: {}, columnSamples: {} };
  const mappingDetection = selectedSheet ? detectColumnMappingDetails(selectedRows.headers, selectedReportType, selectedRows.columnSamples) : { mapping: {}, details: [] };
  const useSavedMapping = booleanParam(params.useSavedMapping, true);
  const headerSignature = selectedSheet ? vmsHeaderSignature(selectedReportType, selectedRows.headers) : "";
  let savedHeaderMapping: SavedHeaderMapping | null = null;
  if (selectedSheet && headerSignature) {
    const { data, error } = await (async () => {
      try {
        return await supabase
          .from("vms_header_mappings")
          .select("id, last_used_mapping, updated_at, use_count")
          .eq("report_type", selectedReportType)
          .eq("source_signature", headerSignature)
          .maybeSingle();
      } catch (caught) {
        return { data: null, error: caught };
      }
    })();
    const headerMappingError = queryError(error);
    if (headerMappingError && headerMappingError.code !== "42P01") {
      console.warn("[vms-import] Saved header mapping lookup failed", error);
    }
    if (error) pageIssues.push(loadIssueFromError("vms_header_mappings.saved_header_mapping", error));
    savedHeaderMapping = (data as SavedHeaderMapping | null) ?? null;
  }
  const savedMappingDefaults = savedHeaderMapping?.last_used_mapping && typeof savedHeaderMapping.last_used_mapping === "object"
    ? savedHeaderMapping.last_used_mapping as Record<string, string>
    : {};
  const selectedMapping = readMapping(
    params,
    selectedReportType,
    useSavedMapping && Object.keys(savedMappingDefaults).length ? { ...mappingDetection.mapping, ...savedMappingDefaults } : mappingDetection.mapping,
  );
  const missingRequired = selectedSheet ? requiredMissing(selectedMapping, selectedReportType) : [];
  const mappedRows = selectedSheet ? applyColumnMapping(selectedRows.records, selectedMapping) : [];
  const mappedPreviewRows = mappedRows.slice(0, 8);
  const previewFields = vmsExpectedFields[selectedReportType].filter((field) => field.required || field.requiredGroup || selectedMapping[field.field]).slice(0, 6);
  const currentStep = clampStep(params.step, Boolean(preview));
  if (preview && !selectedSheet) {
    selectedPreviewNotice = "This import batch has no preview rows. Upload panel and import history are still available.";
    pageIssues.push({
      loader: "vms_import_previews.selected_sheet",
      table: "vms_import_previews",
      message: "Preview row exists but contains no readable sheets.",
      missing: null,
    });
  }

  let validation: VmsValidationResult | null = null;
  let validationReferenceNotices: string[] = [];
  if (selectedSheet && currentStep >= 6) {
    if (!canValidateVmsImports(profile)) {
      validationReferenceNotices.push("You do not have permission to validate VMS imports. Upload and recent imports remain available.");
      pageIssues.push({ loader: "vms_validation.permission", table: null, code: "42501", message: "Current user cannot validate VMS imports.", missing: null });
    } else {

      const validationReferences = await loadVmsValidationReferences({
        supabase,
        selectedPreviewId,
        currentUserId: profile?.id ?? null,
        effectivePermissions,
      });
      validationReferenceNotices = validationReferences.notices;

      if (validationReferences.blockingError) {
        validationReferenceNotices.push(validationReferenceErrorMessage(validationReferences.blockingError));
        pageIssues.push(loadIssueFromError(validationReferences.blockingError.queryName, validationReferences.blockingError.error ?? { message: validationReferenceErrorMessage(validationReferences.blockingError) }));
      } else {
        validation = validateVmsRows({
          reportType: selectedReportType,
          rows: mappedRows,
          originalRows: selectedRows.records,
          firstDataRowNumber: selectedRows.headerRowIndex + 2,
          machines: validationReferences.machines,
          machineMappings: validationReferences.machineMappings,
          mappings: validationReferences.productMappings,
          products: validationReferences.products,
          autoCreateMissingProducts: autoCreateProducts,
        });
      }
    }
  }

  const importMode = parseVmsImportMode(params.importMode);
  const titleSalesReportPeriod = selectedSheet && selectedReportType === "sales"
    ? findSalesReportPeriod(selectedSheet.rows, selectedRows.headerRowIndex)
    : null;
  const mappedSalesRange = selectedReportType === "sales" ? findMappedSalesReportRange(mappedRows) : { start: "", end: "" };
  const orderDetailsRange = selectedReportType === "vms_order_details_weekly" ? detectOrderDetailsDateRange(mappedRows) : { start: "", end: "" };
  const reportStartDate = params.reportStartDate ?? titleSalesReportPeriod?.reportStartDate ?? (selectedReportType === "vms_order_details_weekly" ? orderDetailsRange.start : mappedSalesRange.start);
  const reportEndDate = params.reportEndDate ?? titleSalesReportPeriod?.reportEndDate ?? (selectedReportType === "vms_order_details_weekly" ? orderDetailsRange.end : mappedSalesRange.end);
  let duplicatePreviewCount = 0;
  if (validation && selectedReportType === "sales" && currentStep >= 6) {
    const sourceKeys = mappedRows
      .flatMap((row, index) => {
        const validationRow = validation?.rows[index];
        if (!validationRow) return [];
        const key = buildPreviewSalesSourceKey({
          row,
          validationRow,
          reportRange: { start: reportStartDate, end: reportEndDate },
          titlePeriod: titleSalesReportPeriod,
        });
        return key ? [key] : [];
      });
    const uniqueKeys = Array.from(new Set(sourceKeys));
    if (uniqueKeys.length) {
      try {
        for (let index = 0; index < uniqueKeys.length; index += 500) {
          const chunk = uniqueKeys.slice(index, index + 500);
          const { data: duplicates, error: duplicateError } = await supabase
            .from("vms_sales_raw")
            .select("duplicate_hash")
            .in("duplicate_hash", chunk);
          if (duplicateError && duplicateError.code !== "42703") {
            console.warn("[vms-import] Duplicate preview lookup failed", duplicateError);
            pageIssues.push(loadIssueFromError("vms_sales_raw.duplicate_preview", duplicateError));
            break;
          }
          duplicatePreviewCount += new Set(((duplicates ?? []) as { duplicate_hash: string | null }[]).map((row) => String(row.duplicate_hash))).size;
        }
      } catch (error) {
        pageIssues.push(loadIssueFromError("vms_sales_raw.duplicate_preview", error));
      }
    }
  }
  if (validation && selectedReportType === "vms_order_details_weekly" && currentStep >= 6) {
    const sourceKeys = mappedRows
      .flatMap((row, index) => validation?.rows[index]?.status === "imported" ? [createVmsOrderDetailsDuplicateHash(row)] : []);
    const uniqueKeys = Array.from(new Set(sourceKeys));
    if (uniqueKeys.length) {
      try {
        for (let index = 0; index < uniqueKeys.length; index += 500) {
          const chunk = uniqueKeys.slice(index, index + 500);
          const { data: duplicates, error: duplicateError } = await supabase
            .from("vms_transactions_raw")
            .select("duplicate_hash")
            .in("duplicate_hash", chunk);
          if (duplicateError) {
            if (!["42P01", "42703", "PGRST204", "PGRST205"].includes(duplicateError.code ?? "")) {
              console.warn("[vms-import] Order details duplicate preview lookup failed", duplicateError);
            }
            pageIssues.push(loadIssueFromError("vms_transactions_raw.duplicate_preview", duplicateError));
            break;
          }
          duplicatePreviewCount += new Set(((duplicates ?? []) as { duplicate_hash: string | null }[]).map((row) => String(row.duplicate_hash))).size;
        }
      } catch (error) {
        pageIssues.push(loadIssueFromError("vms_transactions_raw.duplicate_preview", error));
      }
    }
  }
  const orderDetailsStatusCounts = selectedReportType === "vms_order_details_weekly"
    ? mappedRows.reduce((counts, row) => {
        const status = orderDetailsTransactionStatus(row);
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {} as Record<ReturnType<typeof orderDetailsTransactionStatus>, number>)
    : {} as Record<ReturnType<typeof orderDetailsTransactionStatus>, number>;
  const failedRefundReviewRows =
    (orderDetailsStatusCounts.failed_vend ?? 0)
    + (orderDetailsStatusCounts.refunded ?? 0)
    + (orderDetailsStatusCounts.failed_payment ?? 0)
    + (orderDetailsStatusCounts.needs_review ?? 0);
  const failedVendAmount = selectedReportType === "vms_order_details_weekly"
    ? mappedRows.reduce((sum, row) => orderDetailsTransactionStatus(row) === "failed_vend" ? sum + Math.max(0, orderDetailsPaymentAmount(row) ?? 0) : sum, 0)
    : 0;
  const refundAmount = selectedReportType === "vms_order_details_weekly"
    ? mappedRows.reduce((sum, row) => orderDetailsTransactionStatus(row) === "refunded" ? sum + Math.max(0, orderDetailsPaymentAmount(row) ?? 0) : sum, 0)
    : 0;
  const estimatedSalesTotal = selectedReportType === "sales"
    ? mappedRows.reduce((sum, row) => sum + (mappedNumber(vmsValue(row, ["total_sales_amount", "transaction_amount", "revenue_amount", "sales_amount", "total_sales", "total_sales_lyd", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"])) ?? 0), 0)
    : selectedReportType === "vms_order_details_weekly"
      ? orderDetailsSuccessfulSalesAmount(mappedRows)
      : 0;
  const machinesFound = validation ? new Set(validation.rows.map((row) => row.machineIdentifier).filter(Boolean)).size : 0;
  const productsFound = validation ? new Set(validation.rows.map((row) => row.productIdentifier || row.productName).filter(Boolean)).size : 0;
  const rowsReadyToImport = validation ? Math.max(0, validation.importedRows - duplicatePreviewCount) : 0;

  const baseState = {
    importBatchId: selectedImportBatchId,
    previewId: String(preview?.id ?? params.previewId ?? ""),
    sheetName: selectedSheet?.name ?? "",
    reportType: selectedReportType,
    headerRow: selectedRows.headerRowIndex,
    autoCreateProducts,
    updateCostFromVms,
    importMode,
    reportStartDate,
    reportEndDate,
  };

  return (
    <>
      <PageHeader
        title="VMS Import"
        subtitle="Three-step import: upload and detect, review mapping, confirm import."
      />

      <Stepper currentStep={currentStep} />

      <VmsSchemaRepairPanel schemaHealth={schemaHealth} canRepair={isOwnerAdminRole(profile)} />

      {params.error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {params.error}
        </div>
      ) : null}

      {schemaNotice ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900" role="status">
          {schemaNotice}
        </div>
      ) : null}

      {selectedPreviewNotice ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900" role="status">
          {selectedPreviewNotice}
        </div>
      ) : null}

      {isOwnerAdminRole(profile) ? (
        <AdminDiagnosticsPanel issues={pageIssues} currentUserId={profile?.id ?? null} effectivePermissions={effectivePermissions} />
      ) : null}

      {!preview && canCreateVmsImports(profile) ? <div className="mb-6"><UploadCard /></div> : null}

      {!preview ? <ReviewSummaryCard summary={reviewSummary} batchReviewRows={batchReviewRows} /> : null}

      {!preview ? (
        <section className="surface-card mb-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Detailed VMS Coverage</h2>
            <p className="mt-1 text-sm text-slate-500">Active weekly Order Details imports are the main sales/dashboard source.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Active detailed files" value={activeDetailedBatches.length} />
            <StatCard label="Coverage start" value={detailedCoverage.ranges[0]?.start ?? "-"} />
            <StatCard label="Coverage end" value={detailedCoverage.ranges.at(-1)?.end ?? "-"} />
            <StatCard label="Missing weekly gaps" value={detailedCoverage.gaps.length} />
          </div>
          {detailedCoverage.gaps.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              Missing detailed VMS sales data from {detailedCoverage.gaps.map((gap) => `${gap.start} to ${gap.end}`).join(", ")}. Dashboards may be incomplete.
            </div>
          ) : null}
          {overlappingActiveBatches.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              {overlappingActiveBatches.length} active detailed import(s) overlap another active VMS import. Duplicates are skipped where detected.
            </div>
          ) : null}
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 2 ? (
        <section className="surface-card mb-6 space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Step 1: Upload + Auto Detect</h2>
              <p className="mt-1 text-sm text-slate-500">Advanced correction for Step 1. Select the sheet and inspect the first 20 rows exactly as Snacky OS read them.</p>
            </div>
            <Link href="/vms-import" className="btn-secondary">Start over</Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="File name" value={preview.file_name ?? "-"} />
            <StatCard label="File size" value={formatBytes(preview.file_size_bytes)} />
            <StatCard label="File type" value={String(preview.file_type ?? "-").toUpperCase()} />
            <StatCard label="Sheets detected" value={previewSheets.length} />
          </div>
          <form className="grid gap-3 md:grid-cols-[1fr_auto]">
            {baseState.importBatchId ? <input type="hidden" name="importBatchId" value={baseState.importBatchId} /> : null}
            <input type="hidden" name="previewId" value={preview.id} />
            <input type="hidden" name="step" value={3} />
            <FormField label="Sheet">
              <select name="sheet" defaultValue={selectedSheet.name} className="field-input">
                {previewSheets.map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name} ({sheet.rows.length} rows)</option>)}
              </select>
            </FormField>
            <FormSubmitButton className="btn-primary self-end" pendingLabel="Loading selected sheet...">Continue</FormSubmitButton>
          </form>
          <div>
            <h3 className="mb-3 text-base font-semibold text-slate-900">First 20 parsed rows</h3>
            <RawRowsTable rows={selectedSheet.rows} limit={20} />
          </div>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 3 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 1: Upload + Auto Detect</h2>
            <p className="mt-1 text-sm text-slate-500">Advanced correction: confirm or override the detected report type before reviewing mappings.</p>
          </div>
          <form className="space-y-4">
            {baseState.importBatchId ? <input type="hidden" name="importBatchId" value={baseState.importBatchId} /> : null}
            <input type="hidden" name="step" value={4} />
            <input type="hidden" name="previewId" value={baseState.previewId} />
            <input type="hidden" name="sheet" value={baseState.sheetName} />
            <FormField label="Report type" required>
              <select name="reportType" defaultValue={selectedReportType} className="field-input">
                {vmsReportTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </FormField>
            <div className="flex flex-wrap gap-3">
              <Link href={queryFor({ importBatchId: baseState.importBatchId, previewId: preview.id, sheet: selectedSheet.name, step: "2" })} className="btn-secondary">Back</Link>
              <FormSubmitButton pendingLabel="Loading header rows...">Choose header row</FormSubmitButton>
            </div>
          </form>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 4 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 1: Upload + Auto Detect</h2>
            <p className="mt-1 text-sm text-slate-500">Advanced correction: choose the row that contains column headers. Title rows above it will be ignored.</p>
          </div>
          <form className="space-y-4">
            {baseState.importBatchId ? <input type="hidden" name="importBatchId" value={baseState.importBatchId} /> : null}
            <input type="hidden" name="step" value={5} />
            <input type="hidden" name="previewId" value={baseState.previewId} />
            <input type="hidden" name="sheet" value={baseState.sheetName} />
            <input type="hidden" name="reportType" value={baseState.reportType} />
            <FormField label="Header row">
              <select name="headerRow" defaultValue={String(selectedRows.headerRowIndex)} className="field-input">
                {selectedSheet.rows.slice(0, 10).map((row, index) => (
                  <option key={index} value={index}>
                    Row {index + 1}{index === detectedHeaderRow ? " - detected" : ""}: {rowPreview(row)}
                  </option>
                ))}
              </select>
            </FormField>
            <RawRowsTable rows={selectedSheet.rows} limit={10} headerRow={selectedRows.headerRowIndex} />
            <div className="flex flex-wrap gap-3">
              <Link href={queryFor({ importBatchId: baseState.importBatchId, previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, step: "3" })} className="btn-secondary">Back</Link>
              <FormSubmitButton pendingLabel="Loading column mapping...">Continue to mapping</FormSubmitButton>
            </div>
          </form>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 5 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 2: Review Mapping</h2>
            <p className="mt-1 text-sm text-slate-500">Review the auto-detected sheet, report type, headers, product mappings, machine mappings, and row validation before confirming.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="File" value={preview.file_name ?? "-"} />
            <StatCard label="Sheet" value={selectedSheet.name} />
            <StatCard label="Report type" value={reportLabel(selectedReportType)} />
            <StatCard label="Header row" value={`Row ${selectedRows.headerRowIndex + 1}`} />
            <StatCard label="Rows detected" value={mappedRows.length} />
          </div>
          <details className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <summary className="cursor-pointer font-semibold text-slate-800">Advanced detection settings</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={queryFor({ importBatchId: baseState.importBatchId, previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, headerRow: String(selectedRows.headerRowIndex), step: "2" })} className="btn-secondary">Change sheet</Link>
              <Link href={queryFor({ importBatchId: baseState.importBatchId, previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, headerRow: String(selectedRows.headerRowIndex), step: "3" })} className="btn-secondary">Change report type</Link>
              <Link href={queryFor({ importBatchId: baseState.importBatchId, previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, headerRow: String(selectedRows.headerRowIndex), step: "4" })} className="btn-secondary">Change header row</Link>
            </div>
          </details>
          {savedHeaderMapping ? (
            <div className="flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 md:flex-row md:items-center md:justify-between">
              <div>
                We found a saved mapping for this VMS report. {useSavedMapping ? "It is applied by default." : "Apply it to reuse the last successful mapping."}
              </div>
              <Link
                href={queryFor({
                  importBatchId: baseState.importBatchId,
                  previewId: preview.id,
                  sheet: selectedSheet.name,
                  reportType: selectedReportType,
                  headerRow: String(selectedRows.headerRowIndex),
                  step: "5",
                  useSavedMapping: useSavedMapping ? "no" : "yes",
                })}
                className="btn-secondary"
              >
                {useSavedMapping ? "Use auto-detect" : "Apply saved mapping"}
              </Link>
            </div>
          ) : null}
          {missingRequired.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              Required fields still missing: {missingRequired.join(", ")}.
            </div>
          ) : null}
          <form className="space-y-4">
            <WizardStateInputs step={6} {...baseState} includeImportOptions={false} />
            {selectedReportType === "product_list" ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <FormField label="Auto-create missing products" hint="Yes creates Snacky products from VMS product names. No creates needs_review mappings only.">
                  <select name="autoCreateProducts" defaultValue={optionValue(autoCreateProducts)} className="field-input">
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </FormField>
                <FormField label="Use VMS cost as product cost" hint="Leave as No to protect latest purchase cost. VMS cost is still saved on the mapping for review.">
                  <select name="updateCostFromVms" defaultValue={optionValue(updateCostFromVms)} className="field-input">
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </FormField>
              </div>
            ) : null}
            <DataTable headers={["Expected field", "Selected source column", "Required?", "Sample values", "Validation status"]}>
              {vmsExpectedFields[selectedReportType].map((field) => {
                const selectedColumn = selectedMapping[field.field] ?? "";
                const detail = mappingDetection.details.find((item) => item.field === field.field && item.header === selectedColumn);
                return (
                  <tr key={field.field}>
                    <td><div className="font-medium text-slate-900">{field.label}</div><div className="text-xs text-slate-500">{field.field}</div></td>
                    <td>
                      <select name={`map_${field.field}`} defaultValue={selectedColumn} className="field-input min-w-60">
                        <option value="">Do not map</option>
                        {selectedRows.headers.map((header) => (
                          <option key={header} value={header}>{header}{selectedRows.samples[header] ? ` - ${selectedRows.samples[header]}` : ""}</option>
                        ))}
                      </select>
                    </td>
                    <td>{field.required || field.requiredGroup ? <StatusBadge status={field.required ? "required" : "required one of"} /> : <span className="text-slate-500">Optional</span>}<div className="mt-1 text-xs text-slate-500">{requirementLabel(field, vmsExpectedFields[selectedReportType])}</div></td>
                    <td className="max-w-sm text-xs text-slate-600">{sampleList(selectedRows.columnSamples, selectedColumn)}</td>
                    <td><MappingStatus required={!requirementSatisfied(field, vmsExpectedFields[selectedReportType], selectedMapping)} selectedColumn={selectedColumn} confidence={detail?.confidence} /></td>
                  </tr>
                );
              })}
            </DataTable>
            <div className="flex flex-wrap gap-3">
              <Link href={queryFor({ importBatchId: baseState.importBatchId, previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, headerRow: String(selectedRows.headerRowIndex), step: "4" })} className="btn-secondary">Back</Link>
              <FormSubmitButton pendingLabel="Validating mapped rows...">Review mapped rows</FormSubmitButton>
            </div>
          </form>
          <div className="grid gap-5 xl:grid-cols-2">
            <div>
              <h3 className="mb-3 text-base font-semibold text-slate-900">Detected columns</h3>
              <DataTable headers={["Column", "First samples"]}>
                {selectedRows.headers.map((header) => (
                  <tr key={header}>
                    <td className="font-medium text-slate-900">{header}</td>
                    <td className="max-w-md text-xs text-slate-600">{sampleList(selectedRows.columnSamples, header)}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
            <div>
              <h3 className="mb-3 text-base font-semibold text-slate-900">Mapped row preview</h3>
              {!mappedPreviewRows.length ? (
                <EmptyState title="No data rows under selected header" body="Choose a different header row or sheet." />
              ) : (
                <DataTable headers={previewFields.map((field) => field.label)}>
                  {mappedPreviewRows.map((row, index) => (
                    <tr key={index}>
                      {previewFields.map((field) => <td key={field.field} className="max-w-48">{row[field.field] || "-"}</td>)}
                    </tr>
                  ))}
                </DataTable>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 6 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 2: Review Mapping</h2>
            <p className="mt-1 text-sm text-slate-500">No data has been imported yet. Review mapped rows, product mappings, machines, and validation errors before confirming.</p>
          </div>
          {missingRequired.length ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Required mapping missing: {missingRequired.join(", ")}.
            </div>
          ) : null}
          {validationReferenceNotices.map((notice) => (
            <div key={notice} className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
              {notice}
            </div>
          ))}
          {validation ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatCard label="Total rows" value={validation.totalRows} />
              <StatCard label="Rows to import" value={rowsReadyToImport} note={["sales", "vms_order_details_weekly"].includes(selectedReportType) ? `${duplicatePreviewCount} duplicates skipped` : undefined} />
              <StatCard label="Needs product mapping" value={validation.needsProductMappingRows} note={`${validation.missingProductMappingCount} unique products`} />
              <StatCard label="Unknown machine" value={validation.unknownMachineRows} note={`${validation.unknownMachineCount} unique machines`} />
              <StatCard label="Invalid row" value={validation.invalidRows} />
              <StatCard label="Warnings" value={validation.warningRows} />
            </div>
          ) : null}
          {selectedReportType === "sales" ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatCard label="Import mode" value={vmsImportModeLabels[importMode]} />
              <StatCard label="Report period" value={reportStartDate && reportEndDate ? `${reportStartDate} to ${reportEndDate}` : "-"} />
              <StatCard label="Machines found" value={machinesFound} />
              <StatCard label="Products found" value={productsFound} />
              <StatCard label="Duplicate rows" value={duplicatePreviewCount} />
              <StatCard label="Estimated sales" value={lyd(estimatedSalesTotal)} />
            </div>
          ) : null}
          {selectedReportType === "vms_order_details_weekly" ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Report type" value="Order details" />
              <StatCard label="Date range detected" value={reportStartDate && reportEndDate ? `${reportStartDate} to ${reportEndDate}` : "-"} />
              <StatCard label="Successful sales rows" value={orderDetailsStatusCounts.successful_sale ?? 0} />
              <StatCard label="Failed/refund/review rows" value={failedRefundReviewRows} />
              <StatCard label="Machines found" value={machinesFound} />
              <StatCard label="Products found" value={productsFound} />
              <StatCard label="New products needing mapping" value={validation?.needsProductMappingRows ?? 0} />
              <StatCard label="New machines needing mapping" value={validation?.unknownMachineRows ?? 0} />
              <StatCard label="Duplicates skipped" value={duplicatePreviewCount} />
              <StatCard label="Estimated successful sales" value={lyd(estimatedSalesTotal)} />
              <StatCard label="Failed vend count" value={orderDetailsStatusCounts.failed_vend ?? 0} note={lyd(failedVendAmount)} />
              <StatCard label="Refund count" value={orderDetailsStatusCounts.refunded ?? 0} note={lyd(refundAmount)} />
              <StatCard label="Failed payment count" value={orderDetailsStatusCounts.failed_payment ?? 0} />
              <StatCard label="Needs review count" value={orderDetailsStatusCounts.needs_review ?? 0} />
            </div>
          ) : null}
          <div>
            <h3 className="mb-3 text-base font-semibold text-slate-900">Normalized row preview</h3>
            {!mappedPreviewRows.length ? (
              <EmptyState title="No normalized rows" body="Choose a different header row, sheet, or column mapping." />
            ) : (
              <DataTable headers={previewFields.map((field) => field.label)}>
                {mappedPreviewRows.map((row, index) => (
                  <tr key={index}>
                    {previewFields.map((field) => <td key={field.field} className="max-w-48">{row[field.field] || "-"}</td>)}
                  </tr>
                ))}
              </DataTable>
            )}
          </div>
          {validation?.reviewGroups.length ? (
            <DataTable headers={["Needs review group", "Count", "Example rows", "Question"]}>
              {validation.reviewGroups.slice(0, 50).map((group) => (
                <tr key={group.key}>
                  <td>
                    <div className="font-medium text-slate-900">{group.title}</div>
                    <div className="mt-1"><StatusBadge status={group.type.replaceAll("_", " ")} /></div>
                  </td>
                  <td>{group.count}</td>
                  <td className="max-w-md text-xs text-slate-600">
                    {group.examples.map((row) => `Row ${row.rowNumber}: ${row.machineIdentifier ?? "-"} / ${productCell(row)}`).join(" | ")}
                  </td>
                  <td className="max-w-md">{group.question}</td>
                </tr>
              ))}
            </DataTable>
          ) : validation ? (
            <EmptyState title="No rows need review" body="Validation did not find product mapping needs, unknown machines, or invalid rows." />
          ) : null}
          {validation?.warningRowsList.filter((row) => row.status === "imported").length ? (
            <div>
              <h3 className="mb-3 text-base font-semibold text-slate-900">Rows with warnings</h3>
              <DataTable headers={["Row", "Warning", "Product", "Original row data"]}>
                {validation.warningRowsList.filter((row) => row.status === "imported").slice(0, 100).map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td className="max-w-xs">{row.reasons.join(", ")}</td>
                    <td>{productCell(row)}</td>
                    <td><OriginalRowData row={row.originalRow} /></td>
                  </tr>
                ))}
              </DataTable>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <form>
              <WizardStateInputs step={5} {...baseState} mapping={selectedMapping} />
              <FormSubmitButton className="btn-secondary" pendingLabel="Returning to mapping...">Back to mapping</FormSubmitButton>
            </form>
            <form className={selectedReportType === "sales" || selectedReportType === "vms_order_details_weekly" ? "grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(160px,auto)_minmax(160px,auto)_auto]" : "grid gap-3 md:grid-cols-[minmax(260px,1fr)_auto]"}>
              <WizardStateInputs step={7} {...baseState} mapping={selectedMapping} includeImportOptions={false} />
              <input type="hidden" name="autoCreateProducts" value={optionValue(autoCreateProducts)} />
              <input type="hidden" name="updateCostFromVms" value={optionValue(updateCostFromVms)} />
              {selectedReportType === "sales" || selectedReportType === "vms_order_details_weekly" ? (
                <>
                  <FormField label="Import mode">
                    <select name="importMode" defaultValue={importMode} className="field-input">
                      {Object.entries(vmsImportModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Range start">
                    <input name="reportStartDate" type="date" defaultValue={reportStartDate} className="field-input" />
                  </FormField>
                  <FormField label="Range end">
                    <input name="reportEndDate" type="date" defaultValue={reportEndDate} className="field-input" />
                  </FormField>
                </>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  Stock snapshots use the file snapshot timestamp and do not require a sales date range.
                </div>
              )}
              <FormSubmitButton className="btn-primary self-end" pendingLabel="Preparing confirmation...">Continue to Step 3</FormSubmitButton>
            </form>
          </div>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 7 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 3: Confirm Import</h2>
            <p className="mt-1 text-sm text-slate-500">This is the only step that saves snapshots, mappings, and the import batch.</p>
          </div>
          {validationReferenceNotices.map((notice) => (
            <div key={notice} className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
              {notice}
            </div>
          ))}
          {validation ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatCard label="Total rows" value={validation.totalRows} />
              <StatCard label="Rows to import" value={rowsReadyToImport} />
              <StatCard label="Needs product mapping" value={validation.needsProductMappingRows} />
              <StatCard label="Unknown machine" value={validation.unknownMachineRows} />
              <StatCard label="Invalid row" value={validation.invalidRows} />
              <StatCard label="Duplicates skipped" value={duplicatePreviewCount} />
            </div>
          ) : null}
          {selectedReportType === "sales" ? (
            <div className="grid gap-3 md:grid-cols-3">
              <StatCard label="Import mode" value={vmsImportModeLabels[importMode]} />
              <StatCard label="Report period" value={reportStartDate && reportEndDate ? `${reportStartDate} to ${reportEndDate}` : "-"} />
              <StatCard label="Estimated sales from file" value={lyd(estimatedSalesTotal)} />
            </div>
          ) : null}
          {selectedReportType === "vms_order_details_weekly" ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Import mode" value={vmsImportModeLabels[importMode]} />
              <StatCard label="Report period" value={reportStartDate && reportEndDate ? `${reportStartDate} to ${reportEndDate}` : "-"} />
              <StatCard label="Successful sales rows" value={orderDetailsStatusCounts.successful_sale ?? 0} />
              <StatCard label="Failed/refund/review rows" value={failedRefundReviewRows} />
              <StatCard label="Estimated successful sales" value={lyd(estimatedSalesTotal)} />
            </div>
          ) : null}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Product codes, barcodes, SKUs, names, and confirmed VMS mappings are used before a row is marked for mapping. Product List imports can create missing products or record needs_review mappings based on the selected setting.
          </div>
          {selectedReportType === "product_list" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <StatCard label="Auto-create missing products" value={autoCreateProducts ? "Yes" : "No"} />
              <StatCard label="Use VMS cost as product cost" value={updateCostFromVms ? "Yes" : "No"} />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <form>
              <WizardStateInputs step={6} {...baseState} mapping={selectedMapping} />
              <FormSubmitButton className="btn-secondary" pendingLabel="Going back...">Back</FormSubmitButton>
            </form>
            <form action={completeVmsImport}>
              <WizardStateInputs {...baseState} mapping={selectedMapping} finalAction />
              <FormSubmitButton pendingLabel="Importing VMS rows and refreshing dashboards...">Confirm Import</FormSubmitButton>
            </form>
          </div>
        </section>
      ) : null}

      <VmsImportDebugPanel
        selectedSheetName={selectedSheet?.name ?? null}
        detectedHeaderRow={selectedSheet ? selectedRows.headerRowIndex : null}
        detectedColumns={selectedRows.headers}
        selectedMapping={selectedMapping}
        sampleNormalizedRows={mappedRows.slice(0, 5)}
        validation={validation}
      />

      {/* Parse diagnostics panel: shows parse metadata passed from server for visibility before confirming import */}
      {(params.rows || params.headers || preview) ? (
        <section className="surface-card mt-4">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Parse Diagnostics</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="text-sm text-slate-700"><strong>File:</strong> {preview?.file_name ?? params.fileName ?? "-"}</div>
            <div className="text-sm text-slate-700"><strong>File size:</strong> {preview?.file_size_bytes ? String(preview.file_size_bytes) : (params.fileSize ?? "-")}</div>
            <div className="text-sm text-slate-700"><strong>Rows detected:</strong> {params.rows ?? String(((preview?.sheets as PreviewSheet[] ?? []).reduce((s, sh) => s + (sh.rows?.length ?? 0), 0)) ?? 0)}</div>
            <div className="text-sm text-slate-700"><strong>Detected report type:</strong> {params.detected ?? (detectedReportType ?? "custom")}</div>
            <div className="text-sm text-slate-700 sm:col-span-2"><strong>Headers (sample):</strong> {(params.headers ? safeDecode(params.headers) : selectedRows.headers.slice(0, 20).join(", ")) || "-"}</div>
            <div className="text-sm text-slate-700"><strong>User id:</strong> {params.uid ?? profile?.id ?? "-"}</div>
            <div className="text-sm text-slate-700"><strong>Import batch id:</strong> {params.importBatchId ?? "-"}</div>
          </div>
        </section>
      ) : null}

      <section className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Recent imports</h2>
        <InlineLoadIssue title="Recent imports could not load" issue={batchesError ? loadIssueFromError("vms_import_batches.list", batchesError) : null} />
        {!batches?.length ? (
          <EmptyState title={batchesError ? "Recent imports unavailable" : "No VMS reports imported yet."} body={batchesError ? "Upload is still available. Admin diagnostics above show the exact VMS import query issue." : "Upload your first VMS report to start building sales KPIs."} />
        ) : (
          <>
            <DataTable headers={["Status", "Active", "File name", "Report type", "Date range", "Used in", "Rows found", "Rows imported", "Duplicates", "Needs review", "Successful sales", "Failed rows", "Refunds", "Uploaded by", "Date", "Notes"]}>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td><Link href={`/vms-import/${batch.id}`}><StatusBadge status={batch.status} /></Link></td>
                  <td><StatusBadge status={activeLabel(batch)} /></td>
                  <td className="font-medium text-slate-900"><Link className="link-secondary" href={`/vms-import/${batch.id}`}>{batch.file_name ?? "-"}</Link></td>
                  <td>{reportLabel(batch.report_type ?? batch.source_type)}</td>
                  <td>{batchDateRange(batch)}</td>
                  <td className="max-w-xs text-xs text-slate-600">{dashboardUsageForReport(batch.report_type ?? batch.source_type).join(", ")}</td>
                  <td>{batch.rows_found ?? batch.row_count ?? batchMetric(batch, "totalRows", 0)}</td>
                  <td>{batch.rows_imported ?? batchMetric(batch, "importedRows", 0)}</td>
                  <td>{batch.rows_skipped_duplicate ?? batchMetric(batch, "rowsSkippedDuplicate", 0)}</td>
                  <td>{batch.rows_needing_review ?? batchMetric(batch, "rowsNeedingReview", batchMetric(batch, "needsProductMappingRows", 0))}</td>
                  <td>{isStockReportType(batch.report_type ?? batch.source_type) ? "N/A" : lyd(Number(batch.total_successful_sales ?? batchMetric(batch, "estimatedSuccessfulSales", 0)))}</td>
                  <td>{isStockReportType(batch.report_type ?? batch.source_type) ? "N/A" : batch.failed_rows_count ?? batchMetric(batch, "failedVendRows", 0)}</td>
                  <td>{isStockReportType(batch.report_type ?? batch.source_type) ? "N/A" : batch.refunded_rows_count ?? batchMetric(batch, "refundedRows", 0)}</td>
                  <td>{batch.uploaded_by || batch.imported_by ? importerById.get(String(batch.uploaded_by ?? batch.imported_by)) ?? "Unknown" : "-"}</td>
                  <td>{formatDateTime(batch.uploaded_at ?? batch.imported_at)}</td>
                  <td className="max-w-xs text-xs text-slate-600">{batch.delete_reason || batch.disable_reason || (batch.report_type === "sales" ? "Reconciliation only" : "-")}</td>
                </tr>
              ))}
            </DataTable>
            <PaginationControls basePath="/vms-import" searchParams={paginationParams} page={page} pageSize={pageSize} totalCount={batchCount ?? 0} itemLabel="imports" />
          </>
        )}
      </section>
    </>
  );
}
