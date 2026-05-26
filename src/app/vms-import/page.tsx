import Link from "next/link";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, FormField, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { cleanSearchParams, getPagination } from "@/lib/pagination";
import { completeVmsImport, prepareVmsImport } from "@/lib/vms-import-actions";
import { validateVmsRows, vmsValue, type VmsValidationResult } from "@/lib/vms-import-validation";
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
  findSalesReportPeriod,
  parseReportType,
  requiredMissing,
  sheetRowsToRecords,
  vmsExpectedFields,
  vmsReportTypes,
  type VmsFieldDef,
  type VmsReportType,
} from "@/lib/vms-parser";
import { getSupabaseServerClient } from "@/lib/supabase-server";

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
  unknownMachines?: string[];
  unmappedProducts?: string[];
  errors?: string[];
};

type VmsImportSearchParams = {
  [key: string]: string | undefined;
  batchId?: string;
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

function clampStep(value: string | undefined, hasPreview: boolean) {
  if (!hasPreview) return 1;
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) ? Math.min(7, Math.max(2, Math.floor(parsed))) : 2;
}

function batchMetric(batch: any, key: keyof ImportSummary, fallback = 0) {
  const summary = parseSummary(batch?.notes);
  return Number(summary?.[key] ?? fallback);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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

function Stepper({ currentStep }: { currentStep: number }) {
  const steps = ["Upload", "Sheet", "Report", "Header", "Mapping", "Preview", "Confirm"];
  return (
    <div className="mb-6 grid gap-2 md:grid-cols-7">
      {steps.map((label, index) => {
        const step = index + 1;
        const active = step === currentStep;
        const done = step < currentStep;
        return (
          <div key={label} className={`rounded-lg border px-3 py-2 text-sm ${active ? "border-emerald-300 bg-emerald-50 text-emerald-900" : done ? "border-slate-200 bg-white text-slate-700" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
            <div className="text-xs font-semibold uppercase tracking-wide">Step {step}</div>
            <div className="font-medium">{label}</div>
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
          <h2 className="text-lg font-semibold text-slate-900">Upload new file</h2>
          <p className="mt-1 text-sm text-slate-500">Upload the VMS export exactly as downloaded. Excel and CSV files are accepted.</p>
        </div>
        <FormField label="VMS file" required hint="Accepted: .xlsx, .xls, .csv">
          <input name="file" type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required className="field-input" />
        </FormField>
        <button className="btn-primary w-full">Upload and preview</button>
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

export default async function VmsImportPage({ searchParams }: { searchParams: Promise<VmsImportSearchParams> }) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const paginationParams = cleanSearchParams(params);
  const { page, pageSize, from, to } = getPagination(paginationParams);
  if (params.batchId) redirect(`/vms-import/${params.batchId}`);

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="VMS import unavailable" body="Supabase is not configured, so Snacky OS cannot upload or review VMS files." />
      </>
    );
  }
  const [{ data: batches, count: batchCount, error: batchesError }, { data: preview, error: previewError }] = await Promise.all([
    supabase
      .from("vms_import_batches")
      .select("id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, status, row_count, rows_imported, rows_skipped, rows_skipped_duplicate, import_mode, error_count, notes, last_reprocessed_at, reprocess_count", { count: "exact" })
      .order("imported_at", { ascending: false })
      .range(from, to),
    params.previewId
      ? supabase
          .from("vms_import_previews")
          .select("id, file_name, file_type, file_size_bytes, report_type, sheets, created_at")
          .eq("id", params.previewId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const importLoadError = batchesError ?? previewError;
  if (importLoadError) {
    console.error("[vms-import] Failed to load import page", importLoadError);
    return (
      <>
        <ErrorState title="Could not load VMS import" body="Snacky OS could not load VMS import batches or the selected preview." action={<SecondaryButton href="/vms-import">Retry</SecondaryButton>} />
      </>
    );
  }
  const importerIds = [...new Set((batches ?? []).map((batch: any) => batch.imported_by).filter(Boolean))];
  const { data: importers, error: importersError } = importerIds.length
    ? await supabase.from("team_members").select("id, full_name").in("id", importerIds)
    : { data: [], error: null };
  if (importersError) {
    console.error("[vms-import] Failed to load importers", importersError);
    return (
      <>
        <ErrorState title="Could not load VMS importers" body="Import batches loaded, but Snacky OS could not load the user names attached to them." action={<SecondaryButton href="/vms-import">Retry</SecondaryButton>} />
      </>
    );
  }
  const importerById = new Map((importers ?? []).map((member: any) => [String(member.id), member.full_name]));

  const previewSheets = ((preview?.sheets ?? []) as PreviewSheet[]).filter((sheet) => sheet.rows?.length);
  const selectedSheet = previewSheets.find((sheet) => sheet.name === params.sheet) ?? previewSheets[0] ?? null;
  const selectedReportType = parseReportType(params.reportType ?? preview?.report_type) ?? "custom";
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
  let savedHeaderMapping: any = null;
  if (selectedSheet && headerSignature) {
    const { data, error } = await supabase
      .from("vms_header_mappings")
      .select("id, last_used_mapping, updated_at, use_count")
      .eq("report_type", selectedReportType)
      .eq("source_signature", headerSignature)
      .maybeSingle();
    if (error && error.code !== "42P01") {
      console.warn("[vms-import] Saved header mapping lookup failed", error);
    }
    savedHeaderMapping = data ?? null;
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

  let validation: VmsValidationResult | null = null;
  if (selectedSheet && currentStep >= 5) {
    const [
      { data: machines, error: machinesError },
      { data: machineMappings, error: machineMappingsError },
      { data: mappings, error: mappingsError },
      { data: products, error: productsError },
    ] = await Promise.all([
      supabase.from("machines").select("id, machine_code, vms_machine_id, name, location_id"),
      supabase.from("vms_machine_mappings").select("id, vms_machine_key, vms_machine_name, machine_id, location_id, status, aliases"),
      supabase.from("vms_product_mappings").select("id, vms_product_id, vms_product_name, product_id, match_status"),
      supabase.from("products").select("id, sku, barcode, name"),
    ]);
    const validationLoadError = machinesError ?? mappingsError ?? productsError;
    if (validationLoadError || (machineMappingsError && machineMappingsError.code !== "42P01")) {
      console.error("[vms-import] Failed to load validation references", validationLoadError);
      return (
        <>
          <ErrorState title="Could not validate VMS rows" body="Snacky OS could not load machines, mappings, or products needed to validate the import." action={<SecondaryButton href="/vms-import">Start over</SecondaryButton>} />
        </>
      );
    }
    validation = validateVmsRows({
      reportType: selectedReportType,
      rows: mappedRows,
      originalRows: selectedRows.records,
      firstDataRowNumber: selectedRows.headerRowIndex + 2,
      machines: (machines ?? []) as any[],
      machineMappings: (machineMappings ?? []) as any[],
      mappings: (mappings ?? []) as any[],
      products: (products ?? []) as any[],
      autoCreateMissingProducts: autoCreateProducts,
    });
  }

  const importMode = parseVmsImportMode(params.importMode);
  const titleSalesReportPeriod = selectedSheet && selectedReportType === "sales"
    ? findSalesReportPeriod(selectedSheet.rows, selectedRows.headerRowIndex)
    : null;
  const mappedSalesRange = selectedReportType === "sales" ? findMappedSalesReportRange(mappedRows) : { start: "", end: "" };
  const reportStartDate = params.reportStartDate ?? titleSalesReportPeriod?.reportStartDate ?? mappedSalesRange.start;
  const reportEndDate = params.reportEndDate ?? titleSalesReportPeriod?.reportEndDate ?? mappedSalesRange.end;
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
      for (let index = 0; index < uniqueKeys.length; index += 500) {
        const chunk = uniqueKeys.slice(index, index + 500);
        const { data: duplicates, error: duplicateError } = await supabase
          .from("vms_sales_snapshots")
          .select("source_row_key")
          .in("source_row_key", chunk)
          .eq("import_row_status", "imported");
        if (duplicateError && duplicateError.code !== "42703") {
          console.warn("[vms-import] Duplicate preview lookup failed", duplicateError);
          break;
        }
        duplicatePreviewCount += new Set((duplicates ?? []).map((row: any) => String(row.source_row_key))).size;
      }
    }
  }
  const estimatedSalesTotal = selectedReportType === "sales"
    ? mappedRows.reduce((sum, row) => sum + (mappedNumber(vmsValue(row, ["total_sales_amount", "transaction_amount", "revenue_amount", "sales_amount", "total_sales", "total_sales_lyd", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"])) ?? 0), 0)
    : 0;
  const machinesFound = validation ? new Set(validation.rows.map((row) => row.machineIdentifier).filter(Boolean)).size : 0;
  const productsFound = validation ? new Set(validation.rows.map((row) => row.productIdentifier || row.productName).filter(Boolean)).size : 0;
  const rowsReadyToImport = validation ? Math.max(0, validation.importedRows - duplicatePreviewCount) : 0;

  const baseState = {
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
        subtitle="A step-by-step import wizard for VMS Excel and CSV reports."
      />

      <Stepper currentStep={currentStep} />

      {params.error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {params.error}
        </div>
      ) : null}

      {!preview ? <div className="mb-6"><UploadCard /></div> : null}

      {preview && selectedSheet && currentStep === 2 ? (
        <section className="surface-card mb-6 space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Step 2: Sheet Selection</h2>
              <p className="mt-1 text-sm text-slate-500">Select the sheet and inspect the first 20 rows exactly as Snacky OS read them.</p>
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
            <input type="hidden" name="previewId" value={preview.id} />
            <input type="hidden" name="step" value={3} />
            <FormField label="Sheet">
              <select name="sheet" defaultValue={selectedSheet.name} className="field-input">
                {previewSheets.map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name} ({sheet.rows.length} rows)</option>)}
              </select>
            </FormField>
            <button className="btn-primary self-end">Continue</button>
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
            <h2 className="text-lg font-semibold text-slate-900">Step 3: Choose Report Type</h2>
            <p className="mt-1 text-sm text-slate-500">The report type controls which fields are expected and how rows are validated.</p>
          </div>
          <form className="space-y-4">
            <input type="hidden" name="step" value={4} />
            <input type="hidden" name="previewId" value={baseState.previewId} />
            <input type="hidden" name="sheet" value={baseState.sheetName} />
            <FormField label="Report type" required>
              <select name="reportType" defaultValue={selectedReportType} className="field-input">
                {vmsReportTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </FormField>
            <div className="flex flex-wrap gap-3">
              <Link href={queryFor({ previewId: preview.id, sheet: selectedSheet.name, step: "2" })} className="btn-secondary">Back</Link>
              <button className="btn-primary">Choose header row</button>
            </div>
          </form>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 4 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 4: Header Row Detection</h2>
            <p className="mt-1 text-sm text-slate-500">Choose the row that contains column headers. Title rows above it will be ignored.</p>
          </div>
          <form className="space-y-4">
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
              <Link href={queryFor({ previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, step: "3" })} className="btn-secondary">Back</Link>
              <button className="btn-primary">Continue to mapping</button>
            </div>
          </form>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 5 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 5: Column Mapping</h2>
            <p className="mt-1 text-sm text-slate-500">Map VMS columns to Snacky fields. Required fields must be mapped before validation.</p>
          </div>
          {savedHeaderMapping ? (
            <div className="flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 md:flex-row md:items-center md:justify-between">
              <div>
                We found a saved mapping for this VMS report. {useSavedMapping ? "It is applied by default." : "Apply it to reuse the last successful mapping."}
              </div>
              <Link
                href={queryFor({
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
              <Link href={queryFor({ previewId: preview.id, sheet: selectedSheet.name, reportType: selectedReportType, headerRow: String(selectedRows.headerRowIndex), step: "4" })} className="btn-secondary">Back</Link>
              <button className="btn-primary">Preview and validate</button>
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
            <h2 className="text-lg font-semibold text-slate-900">Step 6: Preview / Validation</h2>
            <p className="mt-1 text-sm text-slate-500">No data has been imported yet. Review mapped rows, product mappings, machines, and validation errors before confirming.</p>
          </div>
          {missingRequired.length ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Required mapping missing: {missingRequired.join(", ")}.
            </div>
          ) : null}
          {validation ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatCard label="Total rows" value={validation.totalRows} />
              <StatCard label="Rows to import" value={rowsReadyToImport} note={selectedReportType === "sales" ? `${duplicatePreviewCount} duplicates skipped` : undefined} />
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
              <button className="btn-secondary">Back to mapping</button>
            </form>
            <form className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(160px,auto)_minmax(160px,auto)_auto]">
              <WizardStateInputs step={7} {...baseState} mapping={selectedMapping} includeImportOptions={false} />
              <input type="hidden" name="autoCreateProducts" value={optionValue(autoCreateProducts)} />
              <input type="hidden" name="updateCostFromVms" value={optionValue(updateCostFromVms)} />
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
              <button className="btn-primary self-end">Continue to confirm</button>
            </form>
          </div>
        </section>
      ) : null}

      {preview && selectedSheet && currentStep === 7 ? (
        <section className="surface-card mb-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Step 7: Confirm Import</h2>
            <p className="mt-1 text-sm text-slate-500">This is the only step that saves snapshots, mappings, and the import batch.</p>
          </div>
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
              <button className="btn-secondary">Back</button>
            </form>
            <form action={completeVmsImport}>
              <WizardStateInputs {...baseState} mapping={selectedMapping} finalAction />
              <button className="btn-primary">Confirm Import</button>
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

      <section className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Recent imports</h2>
        {!batches?.length ? (
          <EmptyState title="No VMS imports yet" body="Upload a VMS Excel/CSV report to create the first import batch." />
        ) : (
          <>
            <DataTable headers={["Status", "File name", "Report type", "Mode", "Rows imported", "Duplicates", "Needs mapping", "Rows failed", "Imported by", "Date"]}>
              {batches.map((batch: any) => (
                <tr key={batch.id}>
                  <td><Link href={`/vms-import/${batch.id}`}><StatusBadge status={batch.status} /></Link></td>
                  <td className="font-medium text-slate-900"><Link className="link-secondary" href={`/vms-import/${batch.id}`}>{batch.file_name ?? "-"}</Link></td>
                  <td>{reportLabel(batch.report_type ?? batch.source_type)}</td>
                  <td>{vmsImportModeLabels[parseVmsImportMode(batch.import_mode)]}</td>
                  <td>{batch.rows_imported ?? batchMetric(batch, "importedRows", 0)}</td>
                  <td>{batch.rows_skipped_duplicate ?? batchMetric(batch, "rowsSkippedDuplicate", 0)}</td>
                  <td>{batchMetric(batch, "needsProductMappingRows", 0)}</td>
                  <td>{batchMetric(batch, "invalidRows", batch.error_count ?? 0)}</td>
                  <td>{batch.imported_by ? importerById.get(String(batch.imported_by)) ?? "Unknown" : "-"}</td>
                  <td>{formatDateTime(batch.imported_at)}</td>
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
