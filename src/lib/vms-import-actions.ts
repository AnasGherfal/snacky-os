"use server";

import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports, canCreateVmsImports, getEffectivePermissions, isOwnerAdminRole } from "@/lib/authz";
import { isActiveImportedVmsBatch } from "@/lib/vms-dashboard-source";
import {
  applyColumnMapping,
  detectHeaderRowIndex,
  detectVmsReportTypeFromRows,
  findSalesReportPeriod,
  parseReportType,
  parseVmsUpload,
  requiredMissing,
  sheetRowsToRecords,
  normalizeHeader,
  VMS_SALES_DATE_RANGE_ERROR,
  vmsExpectedFields,
  type VmsSalesReportPeriod,
  type VmsReportType,
} from "@/lib/vms-parser";
import {
  createVmsOrderDetailsDuplicateHash,
  orderDetailsBusinessDate,
  detectOrderDetailsDateRange,
  orderDetailsAliases,
  orderDetailsDate,
  orderDetailsGrossSalesAmount,
  orderDetailsPaymentAmount,
  orderDetailsQuantity,
  orderDetailsTransactionStatus,
  orderDetailsValue,
  orderDetailsNumber,
} from "@/lib/vms-order-details";
import {
  VMS_IMPORT_MODES,
  createVmsSalesSourceRowKey,
  parseVmsImportMode,
  splitColumnMappingByRequirement,
  vmsHeaderSignature,
  type VmsImportMode,
} from "@/lib/vms-sales-import";
import { buildProductLookupMap, resolveVmsProduct, vmsLookupKey, vmsProductDisplay } from "@/lib/vms-import-validation";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  extractVmsSchemaIssue,
  vmsSchemaIssueMessage,
} from "@/lib/vms-schema-diagnostics";
import { isOptionalVmsImportBatchMetadataField, sanitizeVmsImportBatchPayload } from "@/lib/vms-import-batch-payload";

type ImportSummary = {
  reportType: VmsReportType;
  importMode: VmsImportMode;
  fileName: string;
  fileType: string;
  sheetName: string;
  totalRows: number;
  rowsFound: number;
  importedRows: number;
  needsProductMappingRows: number;
  unknownMachineRows: number;
  invalidRows: number;
  skippedRows: number;
  rowsSkippedDuplicate: number;
  rowsNeedingReview: number;
  updatedTargets: string[];
  failedTargets: string[];
  resultMessage: string;
  productsCreated: number;
  productsUpdated: number;
  mappingsCreated: number;
  mappingsUpdated: number;
  mappingsNeedingReview: number;
  autoCreateMissingProducts: boolean;
  updateCostFromVms: boolean;
  unknownMachines: string[];
  unmappedProducts: string[];
  errors: string[];
  columnMapping: Record<string, string>;
  salesReportPeriod?: VmsSalesReportPeriod | null;
  orderDetailsReportPeriod?: { reportStartDate: string; reportEndDate: string } | null;
  successfulSalesRows?: number;
  failedVendRows?: number;
  refundedRows?: number;
  failedPaymentRows?: number;
  needsReviewTransactionRows?: number;
  failedVendAmount?: number;
  refundedAmount?: number;
  estimatedSuccessfulSales?: number;
  existingDashboardSource?: ExistingOrderDetailsDashboardSource | null;
};

type VmsRawRowStatus = "pending" | "imported" | "needs_mapping" | "unknown_machine" | "invalid_row" | "skipped";

type VmsRawRowPayload = {
  import_batch_id: string;
  row_number: number;
  raw_data: Record<string, string>;
  normalized_data: Record<string, string>;
  validation_status: VmsRawRowStatus;
  validation_errors: string[];
  machine_match_status: string | null;
  product_match_status: string | null;
  matched_machine_id: string | null;
  matched_product_id: string | null;
};

type VmsImportSchemaCheckStage = "preview" | "confirm";

const VMS_IMPORT_PREVIEW_REQUIRED_TABLES = [
  "vms_import_batches",
  "vms_import_previews",
  "vms_import_preview_rows",
  "vms_product_mappings",
  "vms_machine_mappings",
  "vms_header_mappings",
  "products",
  "machines",
];

function requiredVmsImportTables(reportType: VmsReportType, stage: VmsImportSchemaCheckStage) {
  const tables = new Set(VMS_IMPORT_PREVIEW_REQUIRED_TABLES);
  if (stage === "confirm") tables.add("vms_import_rows");

  if (stage === "confirm") {
    if (reportType === "sales") {
      tables.add("vms_sales_snapshots");
      tables.add("vms_sales_raw");
    }
    if (reportType === "monthly_product_profit") {
      tables.add("vms_monthly_product_profit");
    }
    if (reportType === "vms_order_details_weekly") {
      tables.add("vms_transactions_raw");
    }
    if (reportType === "stock" || reportType === "machine_stock_snapshot") {
      tables.add("vms_stock_snapshots");
      tables.add("vms_machine_stock_snapshots");
    }
    if (reportType === "planogram") {
      tables.add("machine_slots");
    }
  }

  return [...tables];
}

function value(row: Record<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const found = row[alias] ?? row[normalizeHeader(alias)] ?? row[alias.toLowerCase()];
    if (found !== undefined && found !== "") return found;
  }
  return "";
}

function booleanOption(input: FormDataEntryValue | string | null | undefined, defaultValue: boolean) {
  if (input === null || input === undefined || input === "") return defaultValue;
  const normalized = String(input).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

async function checkVmsRequiredTables(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  reportType: VmsReportType,
  stage: VmsImportSchemaCheckStage,
) {
  const missing: string[] = [];
  for (const table of requiredVmsImportTables(reportType, stage)) {
    try {
      const res = await supabase.from(table).select("id", { head: true }).limit(1);
      if (res.error) {
        console.error("[vms-import] Required VMS relation check failed", {
          table,
          reportType,
          stage,
          code: res.error.code,
          message: res.error.message,
          details: res.error.details,
          hint: res.error.hint,
          schemaIssue: extractVmsSchemaIssue(res.error, `${table}.required_schema_check`),
        });
        missing.push(table);
      }
    } catch (err) {
      console.error("[vms-import] Required VMS relation check threw", {
        table,
        reportType,
        stage,
        error: err instanceof Error ? err.message : String(err),
      });
      missing.push(table);
    }
  }
  return missing;
}

function requiredTablesMessage(missingTables: string[], reportType: VmsReportType, stage: VmsImportSchemaCheckStage) {
  const action = stage === "preview" ? "preview" : "confirm";
  if (missingTables.length === 1) {
    return "VMS import setup is incomplete. Please contact admin.";
  }
  return "VMS import setup is incomplete. Please contact admin.";
}

function buildVmsImportStateRedirect(params: {
  previewId?: string | null;
  importBatchId?: string | null;
  sheetName?: string | null;
  reportType?: string | null;
  headerRow?: number | null;
  step?: number | null;
  importMode?: string | null;
  reportStartDate?: string | null;
  reportEndDate?: string | null;
  autoCreateProducts?: boolean | null;
  updateCostFromVms?: boolean | null;
  mapping?: Record<string, string> | null;
  error?: string | null;
}) {
  const searchParams = new URLSearchParams();
  if (params.previewId) searchParams.set("previewId", params.previewId);
  if (params.importBatchId) searchParams.set("importBatchId", params.importBatchId);
  if (params.sheetName) searchParams.set("sheet", params.sheetName);
  if (params.reportType) searchParams.set("reportType", params.reportType);
  if (params.headerRow != null) searchParams.set("headerRow", String(params.headerRow));
  if (params.step != null) searchParams.set("step", String(params.step));
  if (params.importMode) searchParams.set("importMode", params.importMode);
  if (params.reportStartDate) searchParams.set("reportStartDate", params.reportStartDate);
  if (params.reportEndDate) searchParams.set("reportEndDate", params.reportEndDate);
  if (params.autoCreateProducts != null) searchParams.set("autoCreateProducts", String(params.autoCreateProducts));
  if (params.updateCostFromVms != null) searchParams.set("updateCostFromVms", String(params.updateCostFromVms));
  if (params.mapping) {
    for (const [key, value] of Object.entries(params.mapping)) {
      searchParams.set(`map_${key}`, value);
    }
  }
  if (params.error) searchParams.set("error", params.error);
  return `/vms-import?${searchParams.toString()}`;
}

async function buildVmsImportStateRedirectFromFormData(formData: FormData, error: string, step = 7) {
  const mapping: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("map_") && typeof value === "string" && value !== "") {
      mapping[key.slice(4)] = value;
    }
  }
  const stepRaw = formData.get("step") || formData.get("currentStep");
  const parsedStep = Number(stepRaw);
  const headerRowRaw = formData.get("header_row") as string | null || formData.get("headerRow") as string | null;
  const headerRow = headerRowRaw ? Number(headerRowRaw) : null;
  return buildVmsImportStateRedirect({
    previewId: formData.get("preview_id") as string | null || formData.get("previewId") as string | null,
    importBatchId: formData.get("import_batch_id") as string | null || formData.get("importBatchId") as string | null,
    sheetName: formData.get("sheet_name") as string | null || formData.get("sheet") as string | null,
    reportType: formData.get("report_type") as string | null || formData.get("reportType") as string | null,
    headerRow,
    step: Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : step,
    importMode: formData.get("import_mode") as string | null || formData.get("importMode") as string | null,
    reportStartDate: formData.get("report_start_date") as string | null || formData.get("reportStartDate") as string | null,
    reportEndDate: formData.get("report_end_date") as string | null || formData.get("reportEndDate") as string | null,
    autoCreateProducts: booleanOption(formData.get("auto_create_products"), true),
    updateCostFromVms: booleanOption(formData.get("update_cost_from_vms"), false),
    mapping: Object.keys(mapping).length ? mapping : null,
    error,
  });
}

export { sanitizeVmsImportBatchPayload, buildVmsImportStateRedirectFromFormData };

function vmsSourceUsage(reportType: VmsReportType) {
  if (reportType === "vms_order_details_weekly") {
    return {
      source_type: "detailed_order_transactions",
      main_sales_source: true,
      reconciliation_only: false,
      dashboards: ["dashboard", "sales", "products", "machines", "restock", "failed_vends"],
      excluded_dashboards: ["finance"],
      explanation: "Detailed VMS order transactions are the primary sales and KPI source. Only successful_sale rows count as normal revenue.",
    };
  }
  if (reportType === "monthly_product_profit") {
    return {
      source_type: "monthly_product_profit",
      main_sales_source: true,
      reconciliation_only: false,
      dashboards: ["dashboard", "sales", "products", "machines", "finance"],
      excluded_dashboards: ["inventory", "refills", "routes", "failed_vends"],
      explanation: "Monthly commodity profit reports are the preferred source for month-level sales and profit dashboards. Detailed Order Details remain available for audit.",
    };
  }
  if (reportType === "sales") {
    return {
      source_type: "general_summary_sales",
      main_sales_source: false,
      reconciliation_only: true,
      dashboards: ["reconciliation"],
      excluded_dashboards: ["sales", "products", "machines", "failed_vends", "finance"],
      explanation: "General VMS summary sales files are retained for reconciliation/checking totals and do not replace detailed transactions.",
    };
  }
  if (reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram") {
    return {
      source_type: "machine_stock",
      main_sales_source: false,
      reconciliation_only: false,
      dashboards: ["dashboard", "inventory", "products", "machines", "refills", "restock", "routes"],
      excluded_dashboards: ["sales", "finance"],
      explanation: "Machine stock files feed stock/refill recommendations and do not count as sales revenue.",
    };
  }
  return {
    source_type: "unknown",
    main_sales_source: false,
    reconciliation_only: false,
    dashboards: [],
    excluded_dashboards: ["sales", "products", "machines", "finance"],
    explanation: "This file is not used by KPI dashboards until its report type and mappings are confirmed.",
  };
}

function importUpdatedTargets(reportType: VmsReportType, summary: ImportSummary) {
  const targets = new Set<string>();
  if ((reportType === "stock" || reportType === "machine_stock_snapshot" || reportType === "planogram") && summary.importedRows > 0) {
    targets.add("Machine stock");
    targets.add("Recommended refill items");
  }
  if (reportType === "vms_order_details_weekly" && summary.importedRows > 0) {
    targets.add("Sales dashboard");
    targets.add("Product sales");
    targets.add("Failed vend report");
  }
  if (reportType === "monthly_product_profit" && summary.importedRows > 0) {
    targets.add("Sales dashboard");
    targets.add("Product profit");
    targets.add("Machine profit");
  }
  if (reportType === "sales" && summary.importedRows > 0) {
    targets.add("Reconciliation totals");
  }
  if (reportType === "product_list" && (summary.productsCreated > 0 || summary.productsUpdated > 0 || summary.mappingsCreated > 0 || summary.mappingsUpdated > 0)) {
    targets.add("Product mappings");
  }
  return [...targets];
}

function importFailedTargets(summary: ImportSummary) {
  const text = summary.errors.join(" ").toLowerCase();
  const targets = new Set<string>();
  if (text.includes("stock")) targets.add("Machine stock");
  if (text.includes("recommend")) targets.add("Recommended refill items");
  if (text.includes("sales") || text.includes("transaction")) targets.add("Sales dashboard");
  if (text.includes("product")) targets.add("Product sales");
  if (text.includes("failed vend")) targets.add("Failed vend report");
  if (text.includes("metadata") || text.includes("batch")) targets.add("Import metadata");
  return [...targets];
}

function classifyImportResult(summary: ImportSummary, fatalImportError: boolean) {
  const importedUsefulRows = summary.importedRows > 0;
  const hasWarnings = summary.errors.length > 0 || summary.rowsNeedingReview > 0 || summary.rowsSkippedDuplicate > 0;
  if (!importedUsefulRows && fatalImportError) {
    return { status: "failed", active: false, message: summary.errors.join("; ").slice(0, 2000) || "VMS import failed before usable data was saved." };
  }
  if (importedUsefulRows && fatalImportError) {
    return { status: "imported", active: true, message: "Usable VMS data was imported, but one or more import steps failed. Review the exact failed step and reprocess after fixing it." };
  }
  if (importedUsefulRows && hasWarnings) {
    const firstTarget = summary.updatedTargets[0] ?? "VMS data";
    return { status: "imported", active: true, message: `${firstTarget} imported. Some rows or metadata need review.` };
  }
  if (importedUsefulRows) return { status: "imported", active: true, message: "VMS import completed successfully." };
  if (hasWarnings) return { status: "partially_imported", active: false, message: "No usable rows were imported. Review mappings, duplicates, and validation warnings." };
  return { status: "failed", active: false, message: "No usable rows were imported." };
}

function importStepError(step: string, error: unknown) {
  const supabaseError = supabaseMutationError(error);
  const detail = [supabaseError?.code, supabaseError?.message, supabaseError?.details, supabaseError?.hint]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" - ");
  return detail ? `${step} failed: ${detail}` : `${step} failed.`;
}

function summarizeVmsTransactionRawRowForLog(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    row_number: row.row_number ?? null,
    order_number: row.order_number ?? null,
    third_party_transaction_number: row.third_party_transaction_number ?? null,
    third_party_order_no: row.third_party_order_no ?? null,
    machine_code: row.machine_code ?? null,
    machine_name: row.machine_name ?? null,
    product_number: row.product_number ?? null,
    vms_product_name: row.vms_product_name ?? null,
    payment_amount: row.payment_amount ?? null,
    payment_time: row.payment_time ?? null,
    delivery_time: row.delivery_time ?? null,
    refund_time: row.refund_time ?? null,
    quantity: row.quantity ?? null,
    transaction_status: row.transaction_status ?? null,
    duplicate_hash: row.duplicate_hash ?? null,
  };
}

function importStepErrorWithBatchContext({
  step,
  error,
  batchId,
  row,
}: {
  step: string;
  error: unknown;
  batchId: string;
  row?: Record<string, unknown>;
}) {
  const base = importStepError(step, error);
  const rowNumber = row?.row_number;
  return `${base} [batch_id=${batchId}${rowNumber !== undefined && rowNumber !== null ? `, row_number=${rowNumber}` : ""}]`;
}

function safeStorageFileName(fileName: string) {
  return fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "vms-import";
}

function numberValue(input: string) {
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

function dateValue(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

const salesRowDateAliases = ["sale_date", "period_end", "date", "sales_date", "business_date", "stat_date", "day", "datetime", "timestamp", "settlement_date", "end_date", "report_date"];

function dateOnlyFromDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function startOfDateIso(dateOnly: string) {
  return `${dateOnly}T00:00:00.000Z`;
}

function endOfDateIso(dateOnly: string) {
  return `${dateOnly}T23:59:59.999Z`;
}

function monthStartFromDateOnly(dateOnly: string) {
  const [year, month] = dateOnly.split("-");
  return `${year}-${month}-01`;
}

function salesPeriodFromRowDate(row: Record<string, string>): VmsSalesReportPeriod | null {
  const periodDate = dateValue(value(row, salesRowDateAliases));
  if (!periodDate) return null;
  const reportStartDate = dateOnlyFromDate(periodDate);
  return {
    reportStartDate,
    reportEndDate: reportStartDate,
    salesMonth: monthStartFromDateOnly(reportStartDate),
    sourceTitle: "",
    sourceRowIndex: -1,
  };
}

function hasSalesRowDate(rows: Record<string, string>[]) {
  return rows.some((row) => Boolean(salesPeriodFromRowDate(row)));
}

function productKey(vmsProductId: string, vmsProductName: string) {
  return `${vmsProductId.trim()}::${vmsProductName.trim()}`.toLowerCase();
}

function uniquePush(list: string[], item: string) {
  if (item && !list.includes(item)) list.push(item);
}

function addMappingKey(map: Map<string, any>, vmsProductId: string, vmsProductName: string, mapping: any) {
  const key = productKey(vmsProductId, vmsProductName);
  if (key.replace(/:/g, "").trim()) map.set(key, mapping);
}

function findMapping(map: Map<string, any>, vmsProductId: string, vmsProductName: string) {
  return map.get(productKey(vmsProductId, vmsProductName)) ?? map.get(productKey(vmsProductId, "")) ?? map.get(productKey("", vmsProductName)) ?? null;
}

function machineIdentifier(row: Record<string, string>) {
  return value(row, ["machine_identifier", "machine_id", "vms_machine_id", "machine_code", "machine_name", "machine", "terminal_id", "terminal_no", "terminal", "device_id", "device_no", "device", "equipment_id", "machine_no", "machine_number", "vm_code", "asset_code"]);
}

function productIdentifier(row: Record<string, string>) {
  return {
    vmsProductId: value(row, ["product_identifier", "vms_product_id", "product_code", "product_id", "product_number", "product_no", "goods_id", "goods_code", "goods_number", "goods_no", "commodity_id", "commodity_code", "commodity_number", "commodity_no", "sku", "item_code", "item_id", "item_no", "plu", "barcode", "article_no"]),
    vmsProductName: value(row, ["product_name", "vms_product_name", "product", "product_description", "product_desc", "goods_name", "goods", "commodity_name", "commodity", "item_name", "item", "item_description", "description", "sku_name", "article_name", "merchandise_name", "name"]),
  };
}

function rawRowPayload({
  batchId,
  rowNumber,
  originalRow,
  mappedRow,
  status = "pending",
  reasons = [],
  machineMatchStatus = null,
  productMatchStatus = null,
  matchedMachineId = null,
  matchedProductId = null,
}: {
  batchId: string;
  rowNumber: number;
  originalRow: Record<string, string>;
  mappedRow: Record<string, string>;
  status?: VmsRawRowStatus;
  reasons?: string[];
  machineMatchStatus?: string | null;
  productMatchStatus?: string | null;
  matchedMachineId?: string | null;
  matchedProductId?: string | null;
}): VmsRawRowPayload {
  return {
    import_batch_id: batchId,
    row_number: rowNumber,
    raw_data: originalRow,
    normalized_data: mappedRow,
    validation_status: status,
    validation_errors: reasons,
    machine_match_status: machineMatchStatus,
    product_match_status: productMatchStatus,
    matched_machine_id: matchedMachineId,
    matched_product_id: matchedProductId,
  };
}

async function upsertRawRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  rows: VmsRawRowPayload[],
) {
  for (let index = 0; index < rows.length; index += 250) {
    const chunk = rows.slice(index, index + 250);
    if (!chunk.length) continue;
    const { error } = await supabase
      .from("vms_import_rows")
      .upsert(chunk, { onConflict: "import_batch_id,row_number" });
    if (error) {
      console.error("[vms-import] Raw row upsert failed", {
        queryName: "vms_import_rows.upsert",
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        chunkStart: index,
        chunkSize: chunk.length,
        schemaIssue: extractVmsSchemaIssue(error, "vms_import_rows.upsert"),
      });
      return { ok: false as const, error };
    }
  }
  return { ok: true as const, error: null };
}

function reportRequiresMachine(reportType: VmsReportType) {
  return ["stock", "machine_stock_snapshot", "sales", "monthly_product_profit", "vms_order_details_weekly", "machine_status", "planogram"].includes(reportType);
}

function reportRequiresProduct(reportType: VmsReportType) {
  return ["stock", "machine_stock_snapshot", "sales", "monthly_product_profit", "vms_order_details_weekly", "product_list", "planogram"].includes(reportType);
}

function isMachineStockReport(reportType: VmsReportType) {
  return reportType === "stock" || reportType === "machine_stock_snapshot";
}

function isMonthlyProductProfitReport(reportType: VmsReportType) {
  return reportType === "monthly_product_profit";
}

function canonicalImportedReportType(reportType: VmsReportType): VmsReportType {
  return isMachineStockReport(reportType) ? "machine_stock_snapshot" : reportType;
}

type PersistedStockSnapshotBatchSummary = {
  stockRowCount: number;
  auditRowCount: number;
  importedRowCount: number;
  detectedMinDatetime: string | null;
  detectedMaxDatetime: string | null;
  error: unknown | null;
};

type PersistedOrderDetailsBatchSummary = {
  rowCount: number;
  detectedMinDatetime: string | null;
  detectedMaxDatetime: string | null;
  businessDateStart: string | null;
  businessDateEnd: string | null;
  successfulRowsCount: number;
  failedVendRowsCount: number;
  failedRowsCount: number;
  refundedRowsCount: number;
  failedPaymentRowsCount: number;
  needsReviewRowsCount: number;
  totalSuccessfulSales: number;
  error: unknown | null;
};

type ExistingOrderDetailsDashboardSource = {
  batchId: string;
  fileName: string;
  status: string | null;
  isActive: boolean;
  rowCount: number;
  businessDateStart: string | null;
  businessDateEnd: string | null;
  successfulRowsCount: number;
  totalSuccessfulSales: number;
  detectedMinDatetime: string | null;
  detectedMaxDatetime: string | null;
};

type ExistingOrderDetailsDashboardSourceCandidate = {
  batch: {
    id: string;
    file_name?: string | null;
    original_file_name?: string | null;
    status?: string | null;
    is_active?: boolean | null;
    deleted_at?: string | null;
    imported_at?: string | null;
    updated_at?: string | null;
  };
  summary: PersistedOrderDetailsBatchSummary;
};

type OrderDetailsDashboardSourceState = "active" | "inactive" | "deleted";

function orderDetailsDashboardSourceState(
  batch: ExistingOrderDetailsDashboardSourceCandidate["batch"],
): OrderDetailsDashboardSourceState {
  if (batch.deleted_at) return "deleted";
  const active = isActiveImportedVmsBatch({
    id: batch.id,
    file_name: batch.file_name ?? null,
    original_file_name: batch.original_file_name ?? null,
    report_type: "vms_order_details_weekly",
    status: batch.status ?? null,
    is_active: batch.is_active ?? null,
    deleted_at: batch.deleted_at ?? null,
    uploaded_at: batch.imported_at ?? null,
    imported_at: batch.imported_at ?? null,
  });
  return active ? "active" : "inactive";
}

async function loadPersistedStockSnapshotBatchSummary({
  supabase,
  batchId,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchId: string;
}): Promise<PersistedStockSnapshotBatchSummary> {
  const [stockRowsResult, auditCountResult] = await Promise.all([
    supabase
      .from("vms_stock_snapshots")
      .select("captured_at, created_at")
      .eq("import_batch_id", batchId)
      .eq("import_row_status", "imported"),
    supabase
      .from("vms_machine_stock_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId),
  ]);

  const stockRowsError = stockRowsResult.error;
  const auditCountError = auditCountResult.error;
  const stockRows = stockRowsError
    ? []
    : ((stockRowsResult.data ?? []) as Array<{ captured_at?: string | null; created_at?: string | null }>);
  const stockRowCount = stockRows.length;
  const auditRowCount = auditCountError ? 0 : Number(auditCountResult.count ?? 0);

  const capturedValues = stockRows
    .flatMap((row) => [row.captured_at, row.created_at])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return {
    stockRowCount,
    auditRowCount,
    importedRowCount: auditRowCount > 0 ? auditRowCount : stockRowCount,
    detectedMinDatetime: capturedValues[0] ?? null,
    detectedMaxDatetime: capturedValues.at(-1) ?? null,
    error: stockRowsError ?? auditCountError ?? null,
  };
}

async function loadPersistedOrderDetailsBatchSummary({
  supabase,
  batchId,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchId: string;
}): Promise<PersistedOrderDetailsBatchSummary> {
  const pageSize = 1000;
  const preferredColumns = "business_date, payment_time, delivery_time, transaction_status, payment_amount";
  const legacyColumns = "payment_time, delivery_time, transaction_status, payment_amount";

  type PersistedOrderDetailsRow = {
    business_date?: string | null;
    payment_time?: string | null;
    delivery_time?: string | null;
    transaction_status?: string | null;
    payment_amount?: number | string | null;
  };

  const emptySummary = (error: unknown | null): PersistedOrderDetailsBatchSummary => ({
    rowCount: 0,
    detectedMinDatetime: null,
    detectedMaxDatetime: null,
    businessDateStart: null,
    businessDateEnd: null,
    successfulRowsCount: 0,
    failedVendRowsCount: 0,
    failedRowsCount: 0,
    refundedRowsCount: 0,
    failedPaymentRowsCount: 0,
    needsReviewRowsCount: 0,
    totalSuccessfulSales: 0,
    error,
  });

  const runSelect = async (columns: string, includeExactCount: boolean, offset: number) => {
    const query = supabase
      .from("vms_transactions_raw")
      .select(columns, includeExactCount ? { count: "exact" } : undefined)
      .eq("import_batch_id", batchId)
      .range(offset, offset + pageSize - 1);
    return query;
  };

  const firstPreferred = await runSelect(preferredColumns, true, 0);
  const fallbackToLegacySelect = firstPreferred.error && (
    String((firstPreferred.error as { code?: unknown }).code ?? "") === "42703"
    || String((firstPreferred.error as { code?: unknown }).code ?? "") === "PGRST204"
    || /business_date|column|schema cache/i.test(String((firstPreferred.error as { message?: unknown }).message ?? ""))
  );
  const firstResult = fallbackToLegacySelect
    ? await runSelect(legacyColumns, true, 0)
    : firstPreferred;

  if (firstResult.error) {
    return emptySummary(firstResult.error);
  }

  const useLegacyColumns = fallbackToLegacySelect;
  const firstPageRows = (firstResult.data ?? []) as PersistedOrderDetailsRow[];
  const totalCount = Number(firstResult.count ?? firstPageRows.length);
  let rowCount = 0;
  let detectedMinDatetime: string | null = null;
  let detectedMaxDatetime: string | null = null;
  let businessDateStart: string | null = null;
  let businessDateEnd: string | null = null;
  let successfulRowsCount = 0;
  let failedVendRowsCount = 0;
  let refundedRowsCount = 0;
  let failedPaymentRowsCount = 0;
  let needsReviewRowsCount = 0;
  let totalSuccessfulSales = 0;

  const accumulateRows = (rows: PersistedOrderDetailsRow[]) => {
    rows.forEach((row) => {
      rowCount += 1;

      const paymentTime = String(row.payment_time ?? "").trim();
      if (paymentTime) {
        detectedMinDatetime = detectedMinDatetime && detectedMinDatetime < paymentTime ? detectedMinDatetime : paymentTime;
        detectedMaxDatetime = detectedMaxDatetime && detectedMaxDatetime > paymentTime ? detectedMaxDatetime : paymentTime;
      }

      const deliveryTime = String(row.delivery_time ?? "").trim();
      if (deliveryTime) {
        detectedMinDatetime = detectedMinDatetime && detectedMinDatetime < deliveryTime ? detectedMinDatetime : deliveryTime;
        detectedMaxDatetime = detectedMaxDatetime && detectedMaxDatetime > deliveryTime ? detectedMaxDatetime : deliveryTime;
      }

      const businessDate = String(row.business_date ?? "").trim();
      if (businessDate) {
        businessDateStart = businessDateStart && businessDateStart < businessDate ? businessDateStart : businessDate;
        businessDateEnd = businessDateEnd && businessDateEnd > businessDate ? businessDateEnd : businessDate;
      }

      const transactionStatus = String(row.transaction_status ?? "");
      if (transactionStatus === "successful_sale") {
        successfulRowsCount += 1;
        const amount = Number(row.payment_amount ?? 0);
        totalSuccessfulSales += Number.isFinite(amount) ? Math.max(0, amount) : 0;
      } else if (transactionStatus === "failed_vend") {
        failedVendRowsCount += 1;
      } else if (transactionStatus === "refunded") {
        refundedRowsCount += 1;
      } else if (transactionStatus === "failed_payment") {
        failedPaymentRowsCount += 1;
      } else if (transactionStatus === "needs_review") {
        needsReviewRowsCount += 1;
      }
    });
  };

  accumulateRows(firstPageRows);

  for (let offset = firstPageRows.length; offset < totalCount; offset += pageSize) {
    const pageResult = await runSelect(useLegacyColumns ? legacyColumns : preferredColumns, false, offset);
    if (pageResult.error) {
      return emptySummary(pageResult.error);
    }

    const pageRows = (pageResult.data ?? []) as PersistedOrderDetailsRow[];
    if (!pageRows.length) break;
    accumulateRows(pageRows);
    if (pageRows.length < pageSize) break;
  }

  return {
    rowCount: totalCount > 0 ? totalCount : rowCount,
    detectedMinDatetime,
    detectedMaxDatetime,
    businessDateStart,
    businessDateEnd,
    successfulRowsCount,
    failedVendRowsCount,
    failedRowsCount: failedVendRowsCount + failedPaymentRowsCount + needsReviewRowsCount,
    refundedRowsCount,
    failedPaymentRowsCount,
    needsReviewRowsCount,
    totalSuccessfulSales: Number(totalSuccessfulSales.toFixed(2)),
    error: null,
  };
}

async function loadExistingOrderDetailsDashboardSourceCandidates({
  supabase,
  batchIds,
  fallbackFileHash,
  fallbackFileName,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchIds: string[];
  fallbackFileHash?: string | null;
  fallbackFileName?: string | null;
}): Promise<ExistingOrderDetailsDashboardSourceCandidate[]> {
  const uniqueBatchIds = [...new Set(batchIds.map((value) => String(value ?? "").trim()).filter(Boolean))];
  const candidateRows: ExistingOrderDetailsDashboardSourceCandidate["batch"][] = [];

  if (uniqueBatchIds.length) {
    const { data: batches, error } = await supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, status, is_active, deleted_at, imported_at, updated_at")
    .in("id", uniqueBatchIds);

    if (error) {
      console.warn("[vms-import] Could not load duplicate Order Details source batch metadata", {
        batchIds: uniqueBatchIds,
        error,
      });
    } else {
      candidateRows.push(...((batches ?? []) as ExistingOrderDetailsDashboardSourceCandidate["batch"][]));
    }
  }

  if ((!candidateRows.length || candidateRows.every((batch) => !batch.id)) && fallbackFileHash) {
    const { data: hashMatches, error: hashError } = await supabase
      .from("vms_import_batches")
      .select("id, file_name, original_file_name, status, is_active, deleted_at, imported_at, updated_at")
      .eq("report_type", "vms_order_details_weekly")
      .eq("file_hash", fallbackFileHash);
    if (hashError) {
      console.warn("[vms-import] Could not load duplicate Order Details batches by file hash", {
        fallbackFileHash,
        error: hashError,
      });
    } else {
      candidateRows.push(...((hashMatches ?? []) as ExistingOrderDetailsDashboardSourceCandidate["batch"][]));
    }
  }

  if (!candidateRows.length && fallbackFileName) {
    const [fileNameMatches, originalFileNameMatches] = await Promise.all([
      supabase
        .from("vms_import_batches")
        .select("id, file_name, original_file_name, status, is_active, deleted_at, imported_at, updated_at")
        .eq("report_type", "vms_order_details_weekly")
        .eq("file_name", fallbackFileName),
      supabase
        .from("vms_import_batches")
        .select("id, file_name, original_file_name, status, is_active, deleted_at, imported_at, updated_at")
        .eq("report_type", "vms_order_details_weekly")
        .eq("original_file_name", fallbackFileName),
    ]);

    if (fileNameMatches.error) {
      console.warn("[vms-import] Could not load duplicate Order Details batches by file name", {
        fallbackFileName,
        error: fileNameMatches.error,
      });
    } else {
      candidateRows.push(...((fileNameMatches.data ?? []) as ExistingOrderDetailsDashboardSourceCandidate["batch"][]));
    }

    if (originalFileNameMatches.error) {
      console.warn("[vms-import] Could not load duplicate Order Details batches by original file name", {
        fallbackFileName,
        error: originalFileNameMatches.error,
      });
    } else {
      candidateRows.push(...((originalFileNameMatches.data ?? []) as ExistingOrderDetailsDashboardSourceCandidate["batch"][]));
    }
  }

  const batchById = new Map(candidateRows.map((batch) => [String(batch.id), batch]));
  const candidateIds = [...new Set(candidateRows.map((batch) => String(batch.id).trim()).filter(Boolean))];
  const candidates = await Promise.all(candidateIds.map(async (batchId) => {
    const batch = batchById.get(batchId);
    if (!batch) return null;
    const summary = await loadPersistedOrderDetailsBatchSummary({ supabase, batchId });
    if (summary.error || summary.rowCount <= 0 || summary.successfulRowsCount <= 0) return null;
    return { batch, summary } satisfies ExistingOrderDetailsDashboardSourceCandidate;
  }));

  return candidates.filter((candidate): candidate is ExistingOrderDetailsDashboardSourceCandidate => Boolean(candidate));
}

function pickBestOrderDetailsDashboardSourceCandidate(candidates: ExistingOrderDetailsDashboardSourceCandidate[]) {
  const stateRank: Record<OrderDetailsDashboardSourceState, number> = {
    active: 3,
    inactive: 2,
    deleted: 1,
  };
  return [...candidates].sort((left, right) => {
    const leftState = orderDetailsDashboardSourceState(left.batch);
    const rightState = orderDetailsDashboardSourceState(right.batch);
    if (leftState !== rightState) return stateRank[rightState] - stateRank[leftState];
    if (left.summary.rowCount !== right.summary.rowCount) return right.summary.rowCount - left.summary.rowCount;
    if (left.summary.successfulRowsCount !== right.summary.successfulRowsCount) return right.summary.successfulRowsCount - left.summary.successfulRowsCount;
    return String(right.batch.imported_at ?? right.batch.updated_at ?? "").localeCompare(String(left.batch.imported_at ?? left.batch.updated_at ?? ""));
  })[0] ?? null;
}

function formatOrderDetailsDashboardSourceCandidate(candidate: ExistingOrderDetailsDashboardSourceCandidate) {
  const fileName = textValue(candidate.batch.original_file_name) || textValue(candidate.batch.file_name) || "unknown file";
  const businessDateRange = candidate.summary.businessDateStart && candidate.summary.businessDateEnd
    ? `${candidate.summary.businessDateStart} to ${candidate.summary.businessDateEnd}`
    : "unknown date range";
  return `${fileName} [batch_id=${candidate.batch.id}, status=${textValue(candidate.batch.status) || "unknown"}, active=${candidate.batch.is_active !== false ? "yes" : "no"}, rows=${candidate.summary.rowCount}, business_dates=${businessDateRange}, successful_sales=${candidate.summary.successfulRowsCount}, sales_amount=${candidate.summary.totalSuccessfulSales.toFixed(2)}]`;
}

function markInvalidRow(summary: ImportSummary, rowNumber: number, reason: string) {
  summary.invalidRows += 1;
  summary.skippedRows += 1;
  summary.errors.push(`Row ${rowNumber}: ${reason}`);
}

function markUnknownMachine(summary: ImportSummary, rowNumber: number, identifier: string) {
  summary.unknownMachineRows += 1;
  summary.skippedRows += 1;
  uniquePush(summary.unknownMachines, identifier || `Row ${rowNumber}`);
  summary.errors.push(`Row ${rowNumber}: unknown machine ${identifier || "blank"}.`);
}

function markNeedsProductMapping(summary: ImportSummary, productLabel: string) {
  summary.needsProductMappingRows += 1;
  uniquePush(summary.unmappedProducts, productLabel);
}

function explicitSellingPrice(row: Record<string, string>) {
  return numberValue(value(row, ["commodity_price", "commodity_price_1", "commodity_price_2", "discounted_price", "commodity_unit_price", "selling_price", "sale_price", "sales_price", "vms_selling_price", "selling_price_lyd", "unit_price", "retail_price", "price"]));
}

function explicitCostPrice(row: Record<string, string>) {
  return numberValue(value(row, ["cost_price", "purchase_price", "vms_cost_price", "cost_price_lyd", "unit_cost", "cost"]));
}

function cleanCatalogText(input: unknown) {
  return String(input ?? "").trim();
}

function stableCatalogHash(input: string) {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

function generatedCatalogSku(vmsProductId: string, barcode: string, productName: string) {
  const directSource = cleanCatalogText(vmsProductId) || cleanCatalogText(barcode);
  if (directSource) return directSource.slice(0, 96);

  const asciiName = cleanCatalogText(productName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const hash = stableCatalogHash(productName || "vms-product");
  return asciiName ? `VMS-${asciiName}-${hash}` : `VMS-${hash}`;
}

function productListBarcode(row: Record<string, string>) {
  const explicitBarcode = cleanCatalogText(value(row, ["barcode", "bar_code", "ean", "upc"]));
  if (explicitBarcode) return explicitBarcode;
  const identifier = cleanCatalogText(value(row, ["product_identifier"]));
  return /^\d{8,14}$/.test(identifier) ? identifier : "";
}

function productListCategory(row: Record<string, string>) {
  return cleanCatalogText(value(row, ["category", "type", "product_category", "group", "product_type"]));
}

function productListBrand(row: Record<string, string>) {
  return cleanCatalogText(value(row, ["brand", "manufacturer"]));
}

function productListImage(row: Record<string, string>) {
  return cleanCatalogText(value(row, ["image_url", "image", "photo", "picture"]));
}

function productListActiveStatus(row: Record<string, string>) {
  const raw = cleanCatalogText(value(row, ["active_status", "active", "status", "enabled"])).toLowerCase();
  if (!raw) return null;
  if (["0", "false", "no", "n", "inactive", "disabled", "hidden", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "y", "active", "enabled", "visible", "on"].includes(raw)) return true;
  return null;
}

function findCatalogProduct(
  products: any[],
  {
    productId,
    sku,
    barcode,
    name,
  }: {
    productId?: string | null;
    sku?: string | null;
    barcode?: string | null;
    name?: string | null;
  },
) {
  const skuKey = vmsLookupKey(sku);
  const barcodeKey = vmsLookupKey(barcode);
  const nameKey = vmsLookupKey(name);
  return (
    (productId ? products.find((product) => String(product.id) === String(productId)) : null) ??
    (skuKey ? products.find((product) => vmsLookupKey(product.sku) === skuKey) : null) ??
    (barcodeKey ? products.find((product) => vmsLookupKey(product.barcode) === barcodeKey) : null) ??
    (nameKey ? products.find((product) => vmsLookupKey(product.name) === nameKey) : null) ??
    null
  );
}

function mergeProductReference(products: any[], product: any) {
  const index = products.findIndex((item) => String(item.id) === String(product.id));
  const reference = {
    id: product.id,
    sku: product.sku ?? null,
    barcode: product.barcode ?? null,
    name: product.name ?? null,
  };
  if (index >= 0) products[index] = { ...products[index], ...reference };
  else products.push(reference);
}

async function upsertVmsCatalogProduct({
  supabase,
  productRows,
  existingProductId,
  row,
  vmsProductId,
  vmsProductName,
  updateCostFromVms,
  batchId,
  lastSeenAt,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  productRows: any[];
  existingProductId: string | null;
  row: Record<string, string>;
  vmsProductId: string;
  vmsProductName: string;
  updateCostFromVms: boolean;
  batchId: string;
  lastSeenAt: Date;
}) {
  const barcode = productListBarcode(row);
  const productName = cleanCatalogText(vmsProductName || vmsProductId || barcode);
  const sku = generatedCatalogSku(vmsProductId, barcode, productName);
  const category = productListCategory(row);
  const brand = productListBrand(row);
  const imageUrl = productListImage(row);
  const active = productListActiveStatus(row);
  const sellingPrice = explicitSellingPrice(row);
  const costPrice = explicitCostPrice(row);
  const existingProduct = findCatalogProduct(productRows, {
    productId: existingProductId,
    sku,
    barcode,
    name: productName,
  });
  const now = new Date().toISOString();

  if (!productName) {
    return { product: null, action: "invalid" as const, error: "missing product identifier or name" };
  }

  if (existingProduct?.id) {
    const payload: Record<string, unknown> = {
      import_source: "vms_import",
      last_vms_import_batch_id: batchId,
      last_vms_seen_at: lastSeenAt.toISOString(),
      updated_at: now,
    };
    if (productName) payload.name = productName;
    if (barcode) payload.barcode = barcode;
    if (category) payload.category = category;
    if (brand) payload.brand = brand;
    if (imageUrl) payload.image_url = imageUrl;
    if (active !== null) payload.active = active;
    if (sellingPrice !== null && sellingPrice >= 0) {
      Object.assign(payload, {
        selling_price: sellingPrice,
        current_selling_price_lyd: sellingPrice,
        vms_selling_price_lyd: sellingPrice,
        selling_price_source: "vms",
        price_updated_at: now,
      });
    }
    if (updateCostFromVms && costPrice !== null && costPrice >= 0) {
      Object.assign(payload, {
        cost_price: costPrice,
        current_cost_price_lyd: costPrice,
        cost_price_source: "vms",
        price_updated_at: now,
      });
    }

    const { data, error } = await supabase
      .from("products")
      .update(payload)
      .eq("id", existingProduct.id)
      .select("id, sku, barcode, name")
      .maybeSingle();

    if (error) return { product: null, action: "invalid" as const, error: error.message };
    const product = data ?? existingProduct;
    mergeProductReference(productRows, product);
    return { product, action: "updated" as const, error: null };
  }

  const payload: Record<string, unknown> = {
    sku,
    barcode: barcode || null,
    name: productName,
    category: category || "snack",
    brand: brand || null,
    image_url: imageUrl || null,
    active: active ?? true,
    cost_price: updateCostFromVms && costPrice !== null && costPrice >= 0 ? costPrice : 0,
    selling_price: sellingPrice !== null && sellingPrice >= 0 ? sellingPrice : 0,
    current_cost_price_lyd: updateCostFromVms && costPrice !== null && costPrice >= 0 ? costPrice : 0,
    current_selling_price_lyd: sellingPrice !== null && sellingPrice >= 0 ? sellingPrice : 0,
    cost_price_source: updateCostFromVms && costPrice !== null && costPrice >= 0 ? "vms" : "initial_import",
    selling_price_source: sellingPrice !== null && sellingPrice >= 0 ? "vms" : "initial_import",
    price_updated_at: sellingPrice !== null || (updateCostFromVms && costPrice !== null) ? now : null,
    vms_selling_price_lyd: sellingPrice !== null && sellingPrice >= 0 ? sellingPrice : null,
    import_source: "vms_import",
    last_vms_import_batch_id: batchId,
    last_vms_seen_at: lastSeenAt.toISOString(),
  };

  const { data, error } = await supabase
    .from("products")
    .insert(payload)
    .select("id, sku, barcode, name")
    .maybeSingle();

  if (error) {
    const { data: duplicate } = await supabase
      .from("products")
      .select("id, sku, barcode, name")
      .eq("sku", sku)
      .maybeSingle();
    if (duplicate?.id) {
      mergeProductReference(productRows, duplicate);
      return { product: duplicate, action: "updated" as const, error: null };
    }
    return { product: null, action: "invalid" as const, error: error.message };
  }

  if (data) mergeProductReference(productRows, data);
  return { product: data, action: "created" as const, error: null };
}

async function ensureConfirmedMapping({
  supabase,
  mappingsByKey,
  profile,
  vmsProductId,
  vmsProductName,
  productId,
  importedSellingPrice,
  importedCostPrice,
  machineId,
  vmsMachineIdentifier,
  machineName,
  lastSeenAt,
  batchId,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  mappingsByKey: Map<string, any>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  vmsProductId: string;
  vmsProductName: string;
  productId: string;
  importedSellingPrice: number | null;
  importedCostPrice: number | null;
  machineId: string | null;
  vmsMachineIdentifier: string | null;
  machineName: string | null;
  lastSeenAt: Date;
  batchId: string;
}) {
  const mappingName = cleanCatalogText(vmsProductName || vmsProductId);
  const existing = findMapping(mappingsByKey, vmsProductId, mappingName);
  const payload = {
    vms_product_id: vmsProductId || null,
    vms_product_name: mappingName,
    product_id: productId,
    match_status: "confirmed",
    confidence_score: 1,
    vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : existing?.vms_selling_price_lyd ?? null,
    vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : existing?.vms_cost_price_lyd ?? null,
    latest_machine_id: machineId,
    latest_vms_machine_id: vmsMachineIdentifier,
    latest_machine_name: machineName,
    last_seen_at: lastSeenAt.toISOString(),
    last_import_batch_id: batchId,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data } = await supabase
      .from("vms_product_mappings")
      .update(payload)
      .eq("id", existing.id)
      .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
      .maybeSingle();
    const mapping = data ?? { ...existing, ...payload };
    addMappingKey(mappingsByKey, vmsProductId, mappingName, mapping);
    if (vmsProductId) addMappingKey(mappingsByKey, vmsProductId, "", mapping);
    if (mappingName) addMappingKey(mappingsByKey, "", mappingName, mapping);
    return { mapping, action: "updated" as const };
  }

  const { data, error } = await supabase
    .from("vms_product_mappings")
    .insert(payload)
    .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
    .maybeSingle();

  if (error) {
    console.error("[vms-import] Confirmed mapping insert failed", error);
    return null;
  }

  if (data) {
    addMappingKey(mappingsByKey, vmsProductId, mappingName, data);
    if (vmsProductId) addMappingKey(mappingsByKey, vmsProductId, "", data);
    if (mappingName) addMappingKey(mappingsByKey, "", mappingName, data);
    await logActivity({
      profile,
      action: "create",
      entityType: "vms_mapping",
      entityId: data.id,
      entityLabel: data.vms_product_name,
      afterData: data,
      summary: `Confirmed VMS product mapping for ${data.vms_product_name}`,
    });
  }

  return data ? { mapping: data, action: "created" as const } : null;
}

async function previewRedirect(formData: FormData | null, previewId: string, sheetName: string, reportType: string, error?: string, headerRow?: number, importBatchId?: string) {
  if (formData) {
    redirect(await buildVmsImportStateRedirectFromFormData(formData, error ?? "", 7));
    return;
  }

  const params = new URLSearchParams({ previewId, sheet: sheetName, reportType });
  if (importBatchId) params.set("importBatchId", importBatchId);
  if (headerRow !== undefined) params.set("headerRow", String(headerRow));
  if (error) params.set("error", error);
  redirect(`/vms-import?${params.toString()}`);
}

function readMapping(formData: FormData, reportType: VmsReportType) {
  const mapping: Record<string, string> = {};
  for (const field of vmsExpectedFields[reportType]) {
    mapping[field.field] = String(formData.get(`map_${field.field}`) || "");
  }
  return mapping;
}

async function saveHeaderMappingMemory({
  supabase,
  profile,
  reportType,
  headerNames,
  mapping,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  reportType: VmsReportType;
  headerNames: string[];
  mapping: Record<string, string>;
}) {
  if (!headerNames.length) return;
  const sourceSignature = vmsHeaderSignature(reportType, headerNames);
  const splitMapping = splitColumnMappingByRequirement(reportType, mapping);
  const { error } = await supabase
    .from("vms_header_mappings")
    .upsert({
      report_type: reportType,
      source_signature: sourceSignature,
      header_names: headerNames,
      required_field_mapping: splitMapping.required,
      optional_field_mapping: splitMapping.optional,
      last_used_mapping: mapping,
      updated_by: profile?.team_member_id ?? null,
      updated_at: new Date().toISOString(),
      created_by: profile?.team_member_id ?? null,
    }, { onConflict: "report_type,source_signature" });
  if (error) {
    console.error("[vms-import] Header mapping memory save failed", {
      reportType,
      sourceSignature,
      errorCode: error.code,
      errorMessage: error.message,
      error,
    });
  }
}

async function loadMachineMappingMemory(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const [{ data: mappings, error: mappingError }, { data: aliases, error: aliasError }] = await Promise.all([
    supabase.from("vms_machine_mappings").select("id, vms_machine_key, vms_machine_name, machine_id, location_id, status, aliases"),
    supabase.from("vms_machine_aliases").select("mapping_id, alias, alias_key"),
  ]);
  if (mappingError || aliasError) {
    console.error("[vms-import] Machine mapping memory load failed", {
      mappingErrorCode: mappingError?.code,
      mappingErrorMessage: mappingError?.message,
      aliasErrorCode: aliasError?.code,
      aliasErrorMessage: aliasError?.message,
    });
    return [];
  }
  const aliasByMapping = new Map<string, string[]>();
  (aliases ?? []).forEach((alias: any) => {
    const key = String(alias.mapping_id ?? "");
    if (!key) return;
    aliasByMapping.set(key, [...(aliasByMapping.get(key) ?? []), String(alias.alias ?? alias.alias_key ?? "")].filter(Boolean));
  });
  return (mappings ?? []).map((mapping: any) => ({
    ...mapping,
    aliases: [...(Array.isArray(mapping.aliases) ? mapping.aliases : []), ...(aliasByMapping.get(String(mapping.id)) ?? [])],
  }));
}

function addMachineMemoryKey(map: Map<string, any>, key: string | null | undefined, machine: any) {
  const normalized = vmsLookupKey(key);
  if (normalized && !map.has(normalized)) map.set(normalized, machine);
}

async function rememberMachineMapping({
  supabase,
  profile,
  vmsMachineIdentifier,
  machine,
  status = "confirmed",
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  vmsMachineIdentifier: string;
  machine?: any | null;
  status?: "confirmed" | "needs_review";
}) {
  const key = vmsLookupKey(vmsMachineIdentifier);
  if (!key) return;
  const payload: Record<string, unknown> = {
    vms_machine_key: key,
    vms_machine_name: vmsMachineIdentifier,
    machine_id: machine?.id ?? null,
    location_id: machine?.location_id ?? null,
    confidence_score: machine?.id ? 1 : 0,
    status,
    aliases: [vmsMachineIdentifier],
    updated_by: profile?.team_member_id ?? null,
    updated_at: new Date().toISOString(),
    created_by: profile?.team_member_id ?? null,
  };
  const { data, error } = await supabase
    .from("vms_machine_mappings")
    .upsert(payload, { onConflict: "vms_machine_key" })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[vms-import] Machine mapping memory save failed", {
      vmsMachineIdentifier,
      machineId: machine?.id ?? null,
      errorCode: error.code,
      errorMessage: error.message,
      error,
    });
    return;
  }
  if (data?.id) {
    await supabase
      .from("vms_machine_aliases")
      .upsert({
        mapping_id: data.id,
        alias: vmsMachineIdentifier,
        alias_key: key,
      }, { onConflict: "alias_key" });
  }
}

async function ensureNeedsReviewMapping(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  mappingsByKey: Map<string, any>,
  profile: Awaited<ReturnType<typeof getCurrentProfile>>,
  vmsProductId: string,
  vmsProductName: string,
) {
  const key = productKey(vmsProductId, vmsProductName);
  if (mappingsByKey.has(key)) return mappingsByKey.get(key);

  const { data } = await supabase
    .from("vms_product_mappings")
    .insert({
      vms_product_id: vmsProductId || null,
      vms_product_name: vmsProductName,
      match_status: "needs_review",
      confidence_score: 0,
    })
    .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
    .maybeSingle();

  if (data) {
    mappingsByKey.set(key, data);
    if (vmsProductId) mappingsByKey.set(productKey(vmsProductId, ""), data);
    if (vmsProductName) mappingsByKey.set(productKey("", vmsProductName), data);
    await logActivity({
      profile,
      action: "create",
      entityType: "vms_mapping",
      entityId: data.id,
      entityLabel: data.vms_product_name,
      afterData: data,
      summary: `Created VMS product mapping for ${data.vms_product_name}`,
    });
  }
  return data;
}

async function applyMachineStatus(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  machineId: string,
  row: Record<string, string>,
  fallbackDate: Date,
) {
  const updates: Record<string, unknown> = {
    last_vms_status_at: (dateValue(value(row, ["last_online_at", "captured_at", "date", "last_updated", "updated_at", "report_date", "sync_time"])) ?? fallbackDate).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const onlineStatus = value(row, ["online_status", "status", "connection_status", "machine_status", "network_status", "state"]);
  const temperature = numberValue(value(row, ["temperature", "temperature_c", "temp", "cabinet_temperature"]));
  const cashBalance = numberValue(value(row, ["cash_balance", "banknote_balance", "cash_amount", "cash_in_machine", "cash_box"]));
  const emptyTrays = numberValue(value(row, ["empty_trays", "empty_slots", "empty_selections", "empty_channels", "empty_count"]));

  if (onlineStatus) updates.vms_online_status = onlineStatus;
  if (temperature !== null) updates.vms_temperature_c = temperature;
  if (cashBalance !== null) updates.vms_cash_balance_lyd = cashBalance;
  if (emptyTrays !== null) updates.vms_empty_trays = Math.max(0, Math.floor(emptyTrays));

  await supabase.from("machines").update(updates).eq("id", machineId);
}

async function markStaleSnapshotRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  table: "vms_stock_snapshots" | "vms_sales_snapshots",
  batchId: string,
  activeRowNumbers: number[],
) {
  const stalePayload = { import_row_status: "reprocessed_stale" };
  if (!activeRowNumbers.length) {
    const { error } = await supabase.from(table).update(stalePayload).eq("import_batch_id", batchId);
    if (error) throw error;
    return;
  }

  const uniqueRowNumbers = Array.from(new Set(activeRowNumbers)).sort((a, b) => a - b);
  const { error: nullError } = await supabase
    .from(table)
    .update(stalePayload)
    .eq("import_batch_id", batchId)
    .is("import_row_number", null);
  if (nullError) throw nullError;

  const { error } = await supabase
    .from(table)
    .update(stalePayload)
    .eq("import_batch_id", batchId)
    .not("import_row_number", "in", `(${uniqueRowNumbers.join(",")})`);
  if (error) throw error;
}

async function runVmsImport({
  supabase,
  profile,
  existingBatchId,
  reportType,
  importMode = VMS_IMPORT_MODES.APPEND_NEW,
  fileName,
  fileType,
  sheetName,
  originalFileName = fileName,
  fileHash = null,
  storageBucket = null,
  storagePath = null,
  headerNames = [],
  rows,
  originalRows,
  columnMapping,
  firstDataRowNumber = 2,
  sourceRowNumbers,
  salesReportPeriod = null,
  reportStartDate = salesReportPeriod?.reportStartDate ?? null,
  reportEndDate = salesReportPeriod?.reportEndDate ?? null,
  autoCreateMissingProducts = true,
  updateCostFromVms = false,
  recordReprocess = Boolean(existingBatchId),
  errorState,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  existingBatchId?: string;
  reportType: VmsReportType;
  importMode?: VmsImportMode;
  fileName: string;
  fileType: string;
  sheetName: string;
  originalFileName?: string | null;
  fileHash?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  headerNames?: string[];
  rows: Record<string, string>[];
  originalRows?: Record<string, string>[];
  columnMapping: Record<string, string>;
  firstDataRowNumber?: number;
  sourceRowNumbers?: number[];
  salesReportPeriod?: VmsSalesReportPeriod | null;
  reportStartDate?: string | null;
  reportEndDate?: string | null;
  autoCreateMissingProducts?: boolean;
  updateCostFromVms?: boolean;
  recordReprocess?: boolean;
  errorState?: {
    previewId?: string | null;
    importBatchId?: string | null;
    sheetName?: string | null;
    reportType?: string | null;
    headerRow?: number | null;
    importMode?: string | null;
    reportStartDate?: string | null;
    reportEndDate?: string | null;
    mapping?: Record<string, string>;
    autoCreateProducts?: boolean;
    updateCostFromVms?: boolean;
    step?: number;
  };
}) {
  // Basic sanity checks to avoid creating empty/faulty final batches
  if (!fileName || typeof fileName !== "string" || fileName.trim() === "") {
    console.error("[vms-import] Aborting runVmsImport: missing fileName", { fileName, errorState });
    redirect(`/vms-import?error=${encodeURIComponent("Final import aborted: missing file name.")}`);
    return;
  }
  if (!profile) {
    console.error("[vms-import] Aborting runVmsImport: missing profile", { fileName, errorState });
    redirect(`/vms-import?error=${encodeURIComponent("Final import aborted: missing user profile.")}`);
    return;
  }
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    console.error("[vms-import] Aborting runVmsImport: zero rows to import", { fileName, fileType, sheetName, errorState });
    redirect(`/vms-import?error=${encodeURIComponent("Final import aborted: no rows detected in import preview.")}`);
    return;
  }
  const isReprocess = Boolean(existingBatchId && recordReprocess);
  const errorRedirect = (message: string) => {
    if (errorState) {
      redirect(buildVmsImportStateRedirect({
        previewId: errorState.previewId,
        importBatchId: errorState.importBatchId,
        sheetName: errorState.sheetName,
        reportType: errorState.reportType,
        headerRow: errorState.headerRow ?? null,
        step: errorState.step ?? 7,
        importMode: errorState.importMode ?? null,
        reportStartDate: errorState.reportStartDate ?? null,
        reportEndDate: errorState.reportEndDate ?? null,
        mapping: errorState.mapping ?? null,
        autoCreateProducts: errorState.autoCreateProducts ?? null,
        updateCostFromVms: errorState.updateCostFromVms ?? null,
        error: message,
      }));
      return;
    }
    const target = existingBatchId ? `/vms-import/${existingBatchId}` : "/vms-import";
    redirect(`${target}?error=${encodeURIComponent(message)}`);
  };

  if (reportType === "sales" && !salesReportPeriod && !hasSalesRowDate(rows)) {
    errorRedirect(VMS_SALES_DATE_RANGE_ERROR);
    return;
  }
  if (reportType === "monthly_product_profit" && !reportStartDate && !reportEndDate && !salesReportPeriod) {
    errorRedirect("Select the report start and end date for the Monthly Profit Report.");
    return;
  }

  const orderDetailsRange = reportType === "vms_order_details_weekly" ? detectOrderDetailsDateRange(rows) : { start: "", end: "" };
  const effectiveReportStartDate = reportType === "vms_order_details_weekly" ? (reportStartDate || orderDetailsRange.start || null) : reportStartDate;
  const effectiveReportEndDate = reportType === "vms_order_details_weekly" ? (reportEndDate || orderDetailsRange.end || null) : reportEndDate;
  const effectiveImportMode = reportType === "vms_order_details_weekly" ? VMS_IMPORT_MODES.APPEND_NEW : importMode;

  const summary: ImportSummary = {
    reportType,
    importMode: effectiveImportMode,
    fileName,
    fileType,
    sheetName,
    totalRows: rows.length,
    rowsFound: rows.length,
    importedRows: 0,
    needsProductMappingRows: 0,
    unknownMachineRows: 0,
    invalidRows: 0,
    skippedRows: 0,
    rowsSkippedDuplicate: 0,
    rowsNeedingReview: 0,
    updatedTargets: [],
    failedTargets: [],
    resultMessage: "",
    productsCreated: 0,
    productsUpdated: 0,
    mappingsCreated: 0,
    mappingsUpdated: 0,
    mappingsNeedingReview: 0,
    autoCreateMissingProducts,
    updateCostFromVms,
    unknownMachines: [],
    unmappedProducts: [],
    errors: [],
    columnMapping,
    salesReportPeriod,
    orderDetailsReportPeriod: reportType === "vms_order_details_weekly" && effectiveReportStartDate && effectiveReportEndDate
      ? { reportStartDate: effectiveReportStartDate, reportEndDate: effectiveReportEndDate }
      : null,
    successfulSalesRows: 0,
    failedVendRows: 0,
    refundedRows: 0,
    failedPaymentRows: 0,
    needsReviewTransactionRows: 0,
    failedVendAmount: 0,
    refundedAmount: 0,
    estimatedSuccessfulSales: 0,
  };

  let batch: { id: string; reprocess_count?: number | null } | null = null;

  const finalizedReportType = canonicalImportedReportType(reportType);

  if (existingBatchId) {
    const lookupResult = await withSoftTimeout(
      supabase
        .from("vms_import_batches")
        .select("id, reprocess_count")
        .eq("id", existingBatchId)
        .maybeSingle(),
      VMS_SAVE_QUERY_TIMEOUT_MS,
    );

    if (lookupResult.timedOut) {
      const timeoutError = { code: "TIMEOUT", message: "VMS import batch lookup took too long." };
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.select.confirm_existing",
        error: timeoutError,
        profile,
        selectedImportBatchId: existingBatchId,
        currentStep: "confirm_import",
      });
      errorRedirect(batchMutationErrorMessage(timeoutError));
      return;
    }
    if ("error" in lookupResult) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.select.confirm_existing",
        error: lookupResult.error,
        profile,
        selectedImportBatchId: existingBatchId,
        currentStep: "confirm_import",
      });
      errorRedirect(batchMutationErrorMessage(lookupResult.error));
      return;
    }

    const existingLookup = lookupResult.value;
    if (existingLookup.error || !existingLookup.data?.id) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.select.confirm_existing",
        error: existingLookup.error ?? { code: "NOT_FOUND", message: "No existing preview batch found for final import." },
        profile,
        selectedImportBatchId: existingBatchId,
        currentStep: "confirm_import",
      });
      errorRedirect("Could not find the preview VMS import batch. Please re-upload the file after running the latest migration.");
      return;
    }

    batch = existingLookup.data;
    const existingBatchRecordId = String(batch.id);
    const confirmStartPayload = {
      status: "previewed",
      is_active: false,
      source_usage: vmsSourceUsage(finalizedReportType),
      dashboard_usage: vmsSourceUsage(finalizedReportType),
      latest_error: null,
      last_error: null,
      import_mode: effectiveImportMode,
      report_start_date: effectiveReportStartDate,
      report_end_date: effectiveReportEndDate,
      file_name: fileName,
      file_type: fileType,
      sheet_name: sheetName,
      report_type: finalizedReportType,
      file_hash: fileHash,
      storage_path: storagePath,
      updated_at: new Date().toISOString(),
      rows_found: rows.length,
      rows_imported: 0,
      rows_skipped_duplicate: 0,
      rows_needing_review: 0,
      notes: JSON.stringify({
        reportType,
        fileName,
        fileType,
        sheetName,
        importMode: effectiveImportMode,
        rowCount: rows.length,
        columnMapping,
      }),
    };
    // Check required tables before attempting update
    {
      const missingTables = await checkVmsRequiredTables(supabase, reportType, "confirm");
      if (missingTables.length) {
        console.error("[vms-import] Aborting confirm import: missing required vms tables", { missingTables, batchId: batch.id });
        errorRedirect(requiredTablesMessage(missingTables, reportType, "confirm"));
        return;
      }
    }
    const updateResult = await runVmsImportBatchMutationWithMetadataFallback({
      queryName: "vms_import_batches.update.confirm_existing",
      currentStep: "confirm_import",
      selectedImportBatchId: existingBatchRecordId,
      payload: confirmStartPayload,
      run: (payload) => supabase
        .from("vms_import_batches")
        .update(payload)
        .eq("id", existingBatchRecordId)
        .select("id, status, is_active, rows_imported, imported_at, updated_at")
        .maybeSingle(),
    });
    const confirmStartProblem = updateResult.timedOut
      ? { code: "TIMEOUT", message: "VMS import batch update took too long." }
      : updateResult.error
        ?? updateResult.value?.error
        ?? (!batchMutationReturnedRow(updateResult.value)
          ? missingBatchMutationRowError({
              queryName: "vms_import_batches.update.confirm_existing",
              currentStep: "confirm_import",
              selectedImportBatchId: existingBatchRecordId,
            })
          : null);
    if (confirmStartProblem) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.update.confirm_existing",
        error: confirmStartProblem,
        payload: updateResult.payload,
        profile,
        selectedImportBatchId: existingBatchRecordId,
        currentStep: "confirm_import",
      });
      errorRedirect(batchMutationErrorMessage(confirmStartProblem));
      return;
    }

  } else {
    console.error("[vms-import] Refusing final import without an existing preview batch", {
      queryName: "completeVmsImport.require_existing_batch",
      fileName,
      fileType,
      sheetName,
      reportType,
      rowsFound: rows.length,
      currentUserId: profile?.id ?? profile?.team_member_id ?? null,
    });
    errorRedirect("Final import requires the existing preview batch. Re-upload the file so Snacky OS can create preview rows before confirming.");
    return;
  }

  if (!batch?.id) {
    errorRedirect("Could not prepare VMS import batch.");
    return;
  }

  const initialRawRows = rows.map((row, index) => rawRowPayload({
    batchId: batch.id,
    rowNumber: sourceRowNumbers?.[index] ?? index + firstDataRowNumber,
    originalRow: originalRows?.[index] ?? row,
    mappedRow: row,
  }));
  const initialRawRowsResult = await upsertRawRows(supabase, initialRawRows);
  if (!initialRawRowsResult.ok) {
    errorRedirect(vmsSchemaIssueMessage(initialRawRowsResult.error, "vms_import_rows.upsert") ?? "Could not save VMS imported row audit. Please contact admin.");
    return;
  }

  if (effectiveImportMode === VMS_IMPORT_MODES.PREVIEW_ONLY) {
    summary.skippedRows = rows.length;
    const batchUpdate = {
      status: "previewed",
      is_active: false,
      source_usage: vmsSourceUsage(finalizedReportType),
      dashboard_usage: vmsSourceUsage(finalizedReportType),
      latest_error: null,
      last_error: null,
      updated_at: new Date().toISOString(),
      rows_found: summary.rowsFound,
      report_type: finalizedReportType,
      file_hash: fileHash,
      storage_path: storagePath,
      rows_imported: 0,
      rows_skipped_duplicate: 0,
      rows_needing_review: 0,
      notes: JSON.stringify({
        reportType,
        fileName,
        fileType,
        sheetName,
        previewOnly: true,
        totalRows: summary.totalRows,
        rowsFound: summary.rowsFound,
      }),
    };
    const previewUpdateResult = await runVmsImportBatchMutationWithMetadataFallback({
      queryName: "vms_import_batches.update.preview_only",
      currentStep: "preview_only",
      selectedImportBatchId: batch.id,
      payload: batchUpdate,
      run: (payload) => supabase
        .from("vms_import_batches")
        .update(payload)
        .eq("id", batch.id)
        .select("id, status, is_active, rows_imported, updated_at")
        .maybeSingle(),
    });
    const previewUpdateProblem = previewUpdateResult.timedOut
      ? { code: "TIMEOUT", message: "VMS import preview batch update took too long." }
      : previewUpdateResult.error
        ?? previewUpdateResult.value?.error
        ?? (!batchMutationReturnedRow(previewUpdateResult.value)
          ? missingBatchMutationRowError({
              queryName: "vms_import_batches.update.preview_only",
              currentStep: "preview_only",
              selectedImportBatchId: batch.id,
            })
          : null);
    if (previewUpdateProblem) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.update.preview_only",
        error: previewUpdateProblem,
        payload: previewUpdateResult.payload,
        profile,
        selectedImportBatchId: batch.id,
        currentStep: "preview_only",
      });
      errorRedirect(batchMutationErrorMessage(previewUpdateProblem));
      return;
    }
    await saveHeaderMappingMemory({ supabase, profile, reportType, headerNames, mapping: columnMapping });
    await logActivity({
      profile,
      action: "preview_vms",
      entityType: "vms_import",
      entityId: batch.id,
      entityLabel: `${reportType} ${fileType.toUpperCase()} ${fileName}`,
      afterData: summary,
      metadata: { report_type: reportType, file_name: fileName, file_type: fileType, sheet_name: sheetName, import_mode: effectiveImportMode },
      summary: `Previewed ${summary.totalRows} ${reportType} rows from VMS ${fileType.toUpperCase()}`,
    });
    revalidatePath("/vms-import");
    redirect(`/vms-import/${batch.id}`);
  }

  const [{ data: machines }, { data: mappings }, { data: products }, machineMappingMemory] = await Promise.all([
    supabase.from("machines").select("id, machine_code, vms_machine_id, name, location_id"),
    supabase.from("vms_product_mappings").select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd"),
    supabase.from("products").select("id, sku, barcode, name"),
    loadMachineMappingMemory(supabase),
  ]);

  const machineByVmsId = new Map<string, any>();
  (machines ?? []).forEach((machine: any) => {
    if (machine.vms_machine_id) machineByVmsId.set(vmsLookupKey(machine.vms_machine_id), machine);
    if (machine.machine_code) machineByVmsId.set(vmsLookupKey(machine.machine_code), machine);
    if (machine.name) machineByVmsId.set(vmsLookupKey(machine.name), machine);
  });
  const machineById = new Map((machines ?? []).map((machine: any) => [String(machine.id), machine]));
  (machineMappingMemory ?? []).forEach((mapping: any) => {
    if (mapping.status && mapping.status !== "confirmed") return;
    const machine = mapping.machine_id ? machineById.get(String(mapping.machine_id)) : null;
    if (!machine) return;
    addMachineMemoryKey(machineByVmsId, mapping.vms_machine_key, machine);
    addMachineMemoryKey(machineByVmsId, mapping.vms_machine_name, machine);
    (mapping.aliases ?? []).forEach((alias: string) => addMachineMemoryKey(machineByVmsId, alias, machine));
  });

  const mappingsByKey = new Map<string, any>();
  (mappings ?? []).forEach((mapping: any) => {
    const vmsProductId = String(mapping.vms_product_id ?? "");
    const vmsProductName = String(mapping.vms_product_name ?? "");
    addMappingKey(mappingsByKey, vmsProductId, vmsProductName, mapping);
    if (vmsProductId) addMappingKey(mappingsByKey, vmsProductId, "", mapping);
    if (vmsProductName) addMappingKey(mappingsByKey, "", vmsProductName, mapping);
  });
  const productRows = ((products ?? []) as any[]).map((product) => ({
    id: product.id,
    sku: product.sku ?? null,
    barcode: product.barcode ?? null,
    name: product.name ?? null,
  }));
  let productLookupMap = buildProductLookupMap(productRows);

  const stockSnapshots: any[] = [];
  const machineStockSnapshots: any[] = [];
  const machineStockSnapshotTimes: Date[] = [];
  const salesSnapshots: any[] = [];
  const salesRawRows: Record<string, unknown>[] = [];
  const monthlyProductProfitRows: Record<string, unknown>[] = [];
  const transactionRawRows: Record<string, unknown>[] = [];
  const planogramRows: any[] = [];
  const latestMappingRowsById = new Map<string, any>();
  const vmsSellingPriceByProductId = new Map<string, number>();
  const vmsCostPriceByProductId = new Map<string, number>();
  const finalRawRows: VmsRawRowPayload[] = [];
  const rememberedMachineKeys = new Set<string>();
  let fatalImportError = false;

  for (const [index, row] of rows.entries()) {
    const rowNumber = sourceRowNumbers?.[index] ?? index + firstDataRowNumber;
    const originalRow = originalRows?.[index] ?? row;
    const finishRow = (
      status: VmsRawRowStatus,
      reasons: string[] = [],
      matches: {
        machineMatchStatus?: string | null;
        productMatchStatus?: string | null;
        matchedMachineId?: string | null;
        matchedProductId?: string | null;
      } = {},
    ) => {
      finalRawRows.push(rawRowPayload({
        batchId: batch.id,
        rowNumber,
        originalRow,
        mappedRow: row,
        status,
        reasons,
        machineMatchStatus: matches.machineMatchStatus ?? (reportRequiresMachine(reportType) ? (identifier ? (machine ? "matched" : "unknown") : "missing") : null),
        productMatchStatus: matches.productMatchStatus ?? (reportRequiresProduct(reportType) ? (productNeedsMapping ? "needs_mapping" : productId ? "matched" : "missing") : null),
        matchedMachineId: matches.matchedMachineId ?? machine?.id ?? null,
        matchedProductId: matches.matchedProductId ?? productId,
      }));
    };
    const identifier = machineIdentifier(row);
    const machine = identifier ? machineByVmsId.get(vmsLookupKey(identifier)) : null;
    const rememberMachineOnce = async (status: "confirmed" | "needs_review") => {
      const key = vmsLookupKey(identifier);
      if (!identifier || !key || rememberedMachineKeys.has(key)) return;
      rememberedMachineKeys.add(key);
      await rememberMachineMapping({ supabase, profile, vmsMachineIdentifier: identifier, machine, status });
    };
    const { vmsProductId, vmsProductName } = productIdentifier(row);
    const productNameForMapping = vmsProductName || vmsProductId;
    const productLabel = vmsProductDisplay(vmsProductId, vmsProductName);
    const importedSellingPrice = explicitSellingPrice(row);
    const importedCostPrice = explicitCostPrice(row);
    const lastSeenAt = dateValue(value(row, ["updated_at", "last_online_at", "captured_at", "last_updated", "date", "sale_date", "period_end", "report_date", "sync_time", "payment_time", "delivery_time"]))
      ?? (reportType === "sales" && salesReportPeriod ? new Date(startOfDateIso(salesReportPeriod.reportEndDate)) : new Date());

    let mapping: any = null;
    let productId: string | null = null;
    let productNeedsMapping = false;
    const allowUnmappedOrderDetails = reportType === "vms_order_details_weekly" || reportType === "monthly_product_profit";

    if (reportRequiresProduct(reportType)) {
      if (!productLabel) {
        if (!allowUnmappedOrderDetails) {
          const reason = "missing product identifier or name. Check the product code/name column mapping.";
          markInvalidRow(summary, rowNumber, reason);
          finishRow("invalid_row", [reason]);
          continue;
        }
        productNeedsMapping = true;
        summary.needsProductMappingRows += 1;
        uniquePush(summary.unmappedProducts, `Row ${rowNumber}: missing product identifier or name`);
      } else {
        const productResolution = resolveVmsProduct({
          mappingMap: mappingsByKey,
          productLookupMap,
          vmsProductId,
          vmsProductName,
        });
        mapping = productResolution.mapping;

        if (productResolution.status === "ignored") {
          const reason = `product mapping is ignored: ${productLabel}.`;
          markInvalidRow(summary, rowNumber, reason);
          finishRow("invalid_row", [reason]);
          continue;
        }

        if (productResolution.status === "matched") {
          productId = productResolution.productId;
        } else if (productResolution.status === "needs_mapping" && reportType !== "product_list") {
          productNeedsMapping = true;
          markNeedsProductMapping(summary, productLabel);
          mapping = mapping ?? await ensureNeedsReviewMapping(supabase, mappingsByKey, profile, vmsProductId, productNameForMapping);
        }

        if (mapping?.id) {
          latestMappingRowsById.set(String(mapping.id), {
            id: mapping.id,
            vms_product_id: vmsProductId || null,
            vms_product_name: productNameForMapping,
            confidence_score: mapping.match_status === "confirmed" ? 1 : 0,
            vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : mapping.vms_selling_price_lyd ?? null,
            vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : mapping.vms_cost_price_lyd ?? null,
            latest_machine_id: machine?.id ?? null,
            latest_vms_machine_id: identifier || null,
            latest_machine_name: machine?.name ?? null,
            last_seen_at: lastSeenAt.toISOString(),
            last_import_batch_id: batch.id,
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    if (reportType === "custom") {
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (reportType === "product_list") {
      if (!autoCreateMissingProducts && !productId) {
        const existingReviewMapping = findMapping(mappingsByKey, vmsProductId, productNameForMapping);
        const reviewMapping = existingReviewMapping ?? await ensureNeedsReviewMapping(supabase, mappingsByKey, profile, vmsProductId, productNameForMapping);
        if (!existingReviewMapping && reviewMapping?.id) summary.mappingsCreated += 1;
        summary.mappingsNeedingReview += 1;
        markNeedsProductMapping(summary, productLabel);
        summary.skippedRows += 1;
        if (reviewMapping?.id) {
          latestMappingRowsById.set(String(reviewMapping.id), {
            id: reviewMapping.id,
            vms_product_id: vmsProductId || null,
            vms_product_name: productNameForMapping,
            confidence_score: reviewMapping.match_status === "confirmed" ? 1 : 0,
            vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : reviewMapping.vms_selling_price_lyd ?? null,
            vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : reviewMapping.vms_cost_price_lyd ?? null,
            latest_machine_id: machine?.id ?? null,
            latest_vms_machine_id: identifier || null,
            latest_machine_name: machine?.name ?? null,
            last_seen_at: lastSeenAt.toISOString(),
            last_import_batch_id: batch.id,
            updated_at: new Date().toISOString(),
          });
        }
        finishRow("needs_mapping", [`missing Snacky product: ${productLabel}`], {
          productMatchStatus: "needs_mapping",
          matchedProductId: null,
        });
        continue;
      }

      const catalogResult = await upsertVmsCatalogProduct({
        supabase,
        productRows,
        existingProductId: productId,
        row,
        vmsProductId,
        vmsProductName,
        updateCostFromVms,
        batchId: batch.id,
        lastSeenAt,
      });

      if (!catalogResult.product?.id) {
        const reason = catalogResult.error || "product catalog row could not be saved.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }

      productLookupMap = buildProductLookupMap(productRows);
      const catalogProductId = String(catalogResult.product.id);
      productId = catalogProductId;
      productNeedsMapping = false;
      if (catalogResult.action === "created") summary.productsCreated += 1;
      if (catalogResult.action === "updated") summary.productsUpdated += 1;

      const confirmedMapping = await ensureConfirmedMapping({
        supabase,
        mappingsByKey,
        profile,
        vmsProductId,
        vmsProductName: productNameForMapping,
        productId: catalogProductId,
        importedSellingPrice,
        importedCostPrice,
        machineId: machine?.id ?? null,
        vmsMachineIdentifier: identifier || null,
        machineName: machine?.name ?? null,
        lastSeenAt,
        batchId: batch.id,
      });

      if (!confirmedMapping?.mapping?.id) {
        const reason = "product was saved but VMS mapping could not be confirmed.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason], {
          productMatchStatus: "matched",
          matchedProductId: productId,
        });
        continue;
      }
      if (confirmedMapping.action === "created") summary.mappingsCreated += 1;
      if (confirmedMapping.action === "updated") summary.mappingsUpdated += 1;

      if (importedSellingPrice !== null && importedSellingPrice >= 0) vmsSellingPriceByProductId.set(catalogProductId, importedSellingPrice);
      if (updateCostFromVms && importedCostPrice !== null && importedCostPrice >= 0) vmsCostPriceByProductId.set(catalogProductId, importedCostPrice);

      summary.importedRows += 1;
      finishRow("imported", [], {
        productMatchStatus: "matched",
        matchedProductId: catalogProductId,
      });
      continue;
    }

    if (productId) {
      if (importedSellingPrice !== null && importedSellingPrice >= 0) vmsSellingPriceByProductId.set(productId, importedSellingPrice);
      if (updateCostFromVms && importedCostPrice !== null && importedCostPrice >= 0) vmsCostPriceByProductId.set(productId, importedCostPrice);
    }

    if (reportRequiresProduct(reportType) && !productNeedsMapping && !productId && !allowUnmappedOrderDetails) {
      const reason = "product could not be matched to a Snacky product.";
      markInvalidRow(summary, rowNumber, reason);
      finishRow("invalid_row", [reason]);
      continue;
    }

    if (reportRequiresMachine(reportType)) {
      if (!identifier) {
        if (!allowUnmappedOrderDetails) {
          const reason = "missing machine id. Check the machine column mapping.";
          markInvalidRow(summary, rowNumber, reason);
          finishRow("invalid_row", [reason]);
          continue;
        }
        summary.unknownMachineRows += 1;
        uniquePush(summary.unknownMachines, `Row ${rowNumber}: missing machine id`);
      }
      if (identifier && !machine) {
        await rememberMachineOnce("needs_review");
        if (!allowUnmappedOrderDetails) {
          markUnknownMachine(summary, rowNumber, identifier);
          finishRow("unknown_machine", [`unknown machine: ${identifier}`]);
          continue;
        }
        summary.unknownMachineRows += 1;
        uniquePush(summary.unknownMachines, identifier);
      } else if (identifier && machine) {
        await rememberMachineOnce("confirmed");
      }
    }

    if (reportType === "machine_status") {
      await applyMachineStatus(supabase, machine.id, row, lastSeenAt);
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (productNeedsMapping && !allowUnmappedOrderDetails) {
      summary.skippedRows += 1;
      finishRow("needs_mapping", [`unknown product: ${productLabel}`]);
      continue;
    }

    if (reportType === "vms_order_details_weekly") {
      const transactionStatus = orderDetailsTransactionStatus(row);
      const rawPaymentAmount = orderDetailsPaymentAmount(row);
      const paymentAmount = rawPaymentAmount === null ? null : Math.max(0, rawPaymentAmount);
      const grossSalesAmount = Math.max(0, orderDetailsGrossSalesAmount(row) ?? 0);
      const amountForSummary = paymentAmount ?? grossSalesAmount;
      const quantity = orderDetailsQuantity(row);
      const duplicateHash = createVmsOrderDetailsDuplicateHash(row);
      const businessDate = orderDetailsBusinessDate(row);
      const paymentTime = orderDetailsDate(orderDetailsValue(row, orderDetailsAliases.paymentTime));
      const deliveryTime = orderDetailsDate(orderDetailsValue(row, orderDetailsAliases.deliveryTime));
      const refundTime = orderDetailsDate(orderDetailsValue(row, orderDetailsAliases.refundTime));
      const importWarnings: string[] = [];

      if (!identifier) {
        importWarnings.push("missing machine id");
      } else if (!machine) {
        importWarnings.push(`unknown machine: ${identifier}`);
      }
      if (!productLabel) {
        importWarnings.push("missing product identifier or name");
      } else if (productNeedsMapping || !productId) {
        importWarnings.push(`unknown product: ${productLabel}`);
      }

      if (transactionStatus === "successful_sale") {
        summary.successfulSalesRows = (summary.successfulSalesRows ?? 0) + 1;
        summary.estimatedSuccessfulSales = (summary.estimatedSuccessfulSales ?? 0) + amountForSummary;
      } else if (transactionStatus === "failed_vend") {
        summary.failedVendRows = (summary.failedVendRows ?? 0) + 1;
        summary.failedVendAmount = (summary.failedVendAmount ?? 0) + amountForSummary;
      } else if (transactionStatus === "refunded") {
        summary.refundedRows = (summary.refundedRows ?? 0) + 1;
        summary.refundedAmount = (summary.refundedAmount ?? 0) + amountForSummary;
      } else if (transactionStatus === "failed_payment") {
        summary.failedPaymentRows = (summary.failedPaymentRows ?? 0) + 1;
      } else {
        summary.needsReviewTransactionRows = (summary.needsReviewTransactionRows ?? 0) + 1;
      }

      transactionRawRows.push({
        import_batch_id: batch.id,
        row_number: rowNumber,
        merchant_id: orderDetailsValue(row, orderDetailsAliases.merchantId) || null,
        merchant_name: orderDetailsValue(row, orderDetailsAliases.merchantName) || null,
        machine_code: orderDetailsValue(row, orderDetailsAliases.machineCode) || identifier || null,
        machine_name: orderDetailsValue(row, orderDetailsAliases.machineName) || machine?.name || null,
        order_number: orderDetailsValue(row, orderDetailsAliases.orderNumber) || null,
        cargo_lane_number: orderDetailsValue(row, orderDetailsAliases.cargoLaneNumber) || null,
        product_number: orderDetailsValue(row, orderDetailsAliases.productNumber) || vmsProductId || null,
        vms_product_name: orderDetailsValue(row, orderDetailsAliases.productName) || productNameForMapping || null,
        commodity_price_1: orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.commodityPrice1)),
        commodity_price_2: orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.commodityPrice2)),
        discounted_price: orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.discountedPrice)),
        delivery_time: deliveryTime?.toISOString() ?? null,
        shipping_status: orderDetailsValue(row, orderDetailsAliases.shippingStatus) || null,
        purchaser: orderDetailsValue(row, orderDetailsAliases.purchaser) || null,
        refund_time: refundTime?.toISOString() ?? null,
        remarks: orderDetailsValue(row, orderDetailsAliases.remarks) || null,
        refund_status: orderDetailsValue(row, orderDetailsAliases.refundStatus) || null,
        third_party_transaction_number: orderDetailsValue(row, orderDetailsAliases.thirdPartyTransactionNumber) || null,
        third_party_order_no: orderDetailsValue(row, orderDetailsAliases.thirdPartyOrderNo) || null,
        payment_amount: paymentAmount,
        payment_time: paymentTime?.toISOString() ?? null,
        business_date: businessDate,
        quantity,
        raw_row: originalRow,
        normalized_row: row,
        mapped_machine_id: machine?.id ?? null,
        mapped_product_id: productId ?? null,
        transaction_status: transactionStatus,
        duplicate_hash: duplicateHash,
      });
      summary.importedRows += 1;
      if (transactionStatus === "needs_review") {
        importWarnings.push("transaction status needs review");
      }
      finishRow("imported", importWarnings, {
        machineMatchStatus: identifier ? (machine ? "matched" : "unknown") : "missing",
        productMatchStatus: productId ? "matched" : (productNeedsMapping || productLabel ? "needs_mapping" : "missing"),
        matchedMachineId: machine?.id ?? null,
        matchedProductId: productId ?? null,
      });
      continue;
    }

    if (reportType === "planogram") {
      const slotCode = value(row, ["slot_code", "slot", "slot_no", "selection", "selection_code", "selection_no", "tray", "tray_code", "channel", "channel_no", "coil"]);
      if (!slotCode) {
        const reason = "missing slot/selection code.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }
      const capacity = Math.max(1, Math.floor(numberValue(value(row, ["capacity", "max_qty", "max_quantity", "slot_capacity", "par_qty", "current_qty"])) ?? 1));
      planogramRows.push({
        machine_id: machine.id,
        slot_code: slotCode,
        product_id: productId,
        capacity,
        min_qty: Math.max(0, Math.floor(numberValue(value(row, ["min_qty", "minimum", "min", "reorder_point", "warning_qty", "alert_qty"])) ?? 0)),
        par_qty: Math.max(1, Math.floor(numberValue(value(row, ["par_qty", "par", "target_qty", "target_stock", "target_quantity"])) ?? capacity)),
        active: true,
      });
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (isMachineStockReport(reportType)) {
      const currentQty = numberValue(value(row, ["current_qty", "inventory_quantity", "stock_qty", "stock_quantity", "quantity", "qty", "remaining", "remaining_qty", "inventory", "inventory_qty", "on_hand", "balance", "available_qty", "qty_left"]));
      if (currentQty === null || currentQty < 0) {
        const reason = "invalid current quantity.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }

      const capturedAt = dateValue(value(row, ["updated_at", "captured_at", "last_updated", "date", "report_date", "stock_date"])) ?? new Date();
      machineStockSnapshotTimes.push(capturedAt);
      const temperature = numberValue(value(row, ["temperature", "temperature_c", "temp", "cabinet_temperature"]));
      const cashBalance = numberValue(value(row, ["cash_balance", "banknote_balance", "cash_amount", "cash_in_machine", "cash_box"]));
      const outOfStockQty = numberValue(value(row, ["out_of_stock_qty", "out_of_stock_quantity", "missing_or_empty_qty", "missing_qty", "empty_qty"]));
      const capacity = numberValue(value(row, ["capacity", "inventory_capacity", "max_qty", "max_quantity", "slot_capacity"]));
      await applyMachineStatus(supabase, machine.id, row, capturedAt);
      stockSnapshots.push({
        import_batch_id: batch.id,
        import_row_number: rowNumber,
        import_row_status: "imported",
        machine_id: machine.id,
        vms_machine_id: identifier,
        slot_code: value(row, ["slot_code", "slot", "slot_no", "selection", "selection_code", "selection_no", "tray", "tray_code", "channel", "channel_no", "coil"]),
        vms_product_id: vmsProductId || null,
        vms_product_name: productNameForMapping || null,
        product_id: productId,
        current_qty: Math.floor(currentQty),
        capacity,
        captured_at: capturedAt.toISOString(),
        temperature_c: temperature,
        cash_balance_lyd: cashBalance,
        tray_status: value(row, ["empty_status", "out_of_stock", "sold_out", "tray_status", "status", "empty_trays"]) || (outOfStockQty && outOfStockQty > 0 ? "out_of_stock" : null),
        metadata: { raw: row },
      });
      machineStockSnapshots.push({
        import_batch_id: batch.id,
        row_number: rowNumber,
        machine_id: machine.id,
        product_id: productId,
        machine_code: identifier || null,
        machine_name: value(row, ["machine_name"]) || machine.name || null,
        point_name: value(row, ["point_name", "location", "location_name"]) || null,
        vms_product_code: vmsProductId || null,
        vms_product_name: productNameForMapping || null,
        product_specification: value(row, ["product_specification", "specification", "spec"]) || null,
        product_barcode: value(row, ["barcode", "product_bar_code", "product_barcode", "bar_code"]) || null,
        third_party_commodity_number: value(row, ["third_party_commodity_number", "third_party_commodity_no"]) || null,
        product_unit: value(row, ["product_unit", "unit"]) || null,
        production_date: dateValue(value(row, ["production_date", "manufacture_date"]))?.toISOString().slice(0, 10) ?? null,
        warranty_date: dateValue(value(row, ["warranty_date", "expiry_date", "expiration_date"]))?.toISOString().slice(0, 10) ?? null,
        inventory_quantity: currentQty,
        out_of_stock_quantity: outOfStockQty ?? 0,
        inventory_capacity: capacity,
        raw_row: originalRow,
      });
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (isMonthlyProductProfitReport(reportType)) {
      const monthlyTransactionCount = Math.max(0, Math.floor(numberValue(value(row, ["transaction_count", "number_of_transaction", "number_of_transactions", "total_transaction_count"])) ?? 0));
      const monthlyTransactionAmount = Math.max(0, numberValue(value(row, ["transaction_amount", "total_transaction_amount", "sales_amount", "amount", "total_amount", "revenue", "gross_sales"])) ?? 0);
      const monthlyRefundCount = Math.max(0, Math.floor(numberValue(value(row, ["refund_count", "refunds", "refund_qty", "refund_quantity"])) ?? 0));
      const monthlyRefundAmount = Math.max(0, numberValue(value(row, ["refund_amount", "refund_total", "refunds_amount"])) ?? 0);
      const monthlyTotalTransactionCount = Math.max(0, Math.floor(numberValue(value(row, ["total_transaction_count", "total_transaction", "total_transactions"])) ?? monthlyTransactionCount));
      const monthlyTotalTransactionAmount = Math.max(0, numberValue(value(row, ["total_transaction_amount", "net_sales_amount", "net_sales", "total_sales_amount"])) ?? Math.max(0, monthlyTransactionAmount - monthlyRefundAmount));
      const monthlyCostPrice = Math.max(0, numberValue(value(row, ["cost_price", "unit_cost", "purchase_price"])) ?? 0);
      const monthlyCostAmount = Math.max(0, numberValue(value(row, ["cost_amount", "cogs", "total_cost"])) ?? (monthlyCostPrice * monthlyTransactionCount));
      const monthlyProfitAmount = numberValue(value(row, ["profit_amount", "profit", "gross_profit"])) ?? (monthlyTransactionAmount - monthlyCostAmount);
      const monthlyCommodityPrice = numberValue(value(row, ["commodity_price", "commodity_price_1", "commodity_price_2", "selling_price", "sale_price", "price", "unit_price"])) ?? 0;
      const monthlyMachineCode = value(row, ["machine_code", "machine_identifier", "vms_machine_id", "machine_id", "terminal_id", "device_id"]) || identifier || machine?.machine_code || machine?.name || "Unknown machine";
      const monthlyMachineName = value(row, ["machine_name", "machine", "device_name"]) || machine?.name || monthlyMachineCode || "Unknown machine";
      const monthlyProductNumber = value(row, ["product_number", "product_identifier", "vms_product_id", "product_code", "product_id", "goods_number", "goods_code", "commodity_number", "commodity_code"]) || vmsProductId || null;
      const monthlyProductName = value(row, ["product_name", "vms_product_name", "product", "goods", "commodity_name", "item_name", "name"]) || productNameForMapping || "Unmapped product";
      const monthlyBusinessMonth = effectiveReportStartDate ? `${effectiveReportStartDate.slice(0, 7)}-01` : null;

      summary.estimatedSuccessfulSales = (summary.estimatedSuccessfulSales ?? 0) + monthlyTransactionAmount;

      monthlyProductProfitRows.push({
        import_batch_id: batch.id,
        report_start_date: effectiveReportStartDate,
        report_end_date: effectiveReportEndDate,
        business_month: monthlyBusinessMonth,
        merchant_id: value(row, ["merchant_id"]) || null,
        merchant_name: value(row, ["merchant_name"]) || null,
        machine_code: monthlyMachineCode,
        machine_name: monthlyMachineName,
        product_number: monthlyProductNumber || "",
        product_name: monthlyProductName || "Unmapped product",
        commodity_price: monthlyCommodityPrice,
        transaction_count: monthlyTransactionCount,
        transaction_amount: monthlyTransactionAmount,
        refund_count: monthlyRefundCount,
        refund_amount: monthlyRefundAmount,
        total_transaction_count: monthlyTotalTransactionCount,
        total_transaction_amount: monthlyTotalTransactionAmount,
        cost_price: monthlyCostPrice,
        cost_amount: monthlyCostAmount,
        profit_amount: monthlyProfitAmount,
        internal_machine_id: machine?.id ?? null,
        internal_product_id: productId ?? null,
      });

      summary.importedRows += 1;
      finishRow("imported", [], {
        machineMatchStatus: identifier ? (machine ? "matched" : "unknown") : "missing",
        productMatchStatus: productId ? "matched" : (productNeedsMapping || monthlyProductNumber || monthlyProductName ? "needs_mapping" : "missing"),
        matchedMachineId: machine?.id ?? null,
        matchedProductId: productId ?? null,
      });
      continue;
    }

    const soldQty = numberValue(value(row, ["sold_qty", "transaction_count", "number_of_transaction", "number_of_transactions", "quantity_sold", "units_sold", "sales_units", "units", "qty", "quantity", "sales_qty", "sales_quantity", "volume", "sales_volume"]));
    const salesAmount = numberValue(value(row, ["total_sales_amount", "transaction_amount", "revenue_amount", "sales_amount", "total_sales", "total_sales_lyd", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"]));
    if ((salesAmount === null || salesAmount < 0) && (soldQty === null || soldQty < 0)) {
      const reason = "invalid sales quantity or amount.";
      markInvalidRow(summary, rowNumber, reason);
      finishRow("invalid_row", [reason]);
      continue;
    }

    const rowPeriod = salesReportPeriod ?? salesPeriodFromRowDate(row);
    if (!rowPeriod) {
      markInvalidRow(summary, rowNumber, VMS_SALES_DATE_RANGE_ERROR);
      finishRow("invalid_row", [VMS_SALES_DATE_RANGE_ERROR]);
      continue;
    }

    const machineCode = value(row, ["machine_code", "machine_identifier", "vms_machine_id", "machine_id", "terminal_id", "device_id"]) || identifier;
    const machineName = value(row, ["machine_name", "machine", "device_name", "location"]) || machine?.name || "";
    const productNumber = value(row, ["product_number", "product_identifier", "vms_product_id", "product_code", "product_id", "goods_number", "goods_code", "commodity_number", "commodity_code"]);
    const commodityPrice = explicitSellingPrice(row);
    const refundCount = numberValue(value(row, ["refund_count", "refund_qty", "refund_quantity"]));
    const refundAmount = numberValue(value(row, ["refund_amount", "refund_total"]));
    const totalTransaction = numberValue(value(row, ["total_transaction", "total_transactions"]));
    const vmsTransactionId = value(row, ["vms_transaction_id", "transaction_id", "transaction_no", "txn_id", "order_id", "order_no", "receipt_id", "receipt_no"]);
    const grossSalesAmount = Math.max(0, salesAmount ?? 0);
    const netSalesAmount = Math.max(0, grossSalesAmount - Math.max(0, refundAmount ?? 0));
    const sourceRowKey = createVmsSalesSourceRowKey({
      vmsTransactionId,
      machineId: machine.id,
      machineCode,
      machineName,
      productId,
      productCode: productNumber || vmsProductId,
      productName: productNameForMapping,
      saleStartDate: rowPeriod.reportStartDate,
      saleEndDate: rowPeriod.reportEndDate,
      reportStartDate: salesReportPeriod?.reportStartDate ?? rowPeriod.reportStartDate,
      reportEndDate: salesReportPeriod?.reportEndDate ?? rowPeriod.reportEndDate,
      soldQty: Math.max(0, Math.floor(soldQty ?? 0)),
      grossSalesAmount,
      netSalesAmount,
    });
    const salesSnapshot = {
      import_batch_id: batch.id,
      import_row_number: rowNumber,
      import_row_status: "imported",
      source_row_key: sourceRowKey,
      vms_transaction_id: vmsTransactionId || null,
      machine_id: machine.id,
      product_id: productId,
      sold_qty: Math.max(0, Math.floor(soldQty ?? 0)),
      sales_amount: Math.max(0, salesAmount ?? 0),
      cash_sales_amount: numberValue(value(row, ["cash_sales_amount", "cash_sales", "cash_sales_lyd", "cash_amount", "cash_revenue", "cash_total"])) ?? 0,
      card_sales_amount: numberValue(value(row, ["card_sales_amount", "card_sales", "card_sales_lyd", "card_amount", "credit_card", "card_revenue", "online_sales"])) ?? 0,
      cost_amount: numberValue(value(row, ["cost_amount", "cost", "cogs", "total_cost", "product_cost"])),
      profit_amount: numberValue(value(row, ["profit_amount", "profit", "gross_profit", "margin_amount", "net_profit"])),
      period_start: startOfDateIso(rowPeriod.reportStartDate),
      period_end: endOfDateIso(rowPeriod.reportEndDate),
      machine_code: machineCode || null,
      machine_name: machineName || null,
      product_number: productNumber || vmsProductId || null,
      product_name: productNameForMapping || null,
      commodity_price: commodityPrice,
      transaction_count: Math.max(0, Math.floor(soldQty ?? 0)),
      transaction_amount: Math.max(0, salesAmount ?? 0),
      refund_count: refundCount === null ? null : Math.max(0, Math.floor(refundCount)),
      refund_amount: refundAmount === null ? null : Math.max(0, refundAmount),
      total_transaction: totalTransaction,
      sales_period_start: rowPeriod.reportStartDate,
      sales_period_end: rowPeriod.reportEndDate,
      sales_month: rowPeriod.salesMonth,
      gross_sales_amount: grossSalesAmount,
      net_sales_amount: netSalesAmount,
      gross_profit_amount: numberValue(value(row, ["profit_amount", "profit", "gross_profit", "margin_amount", "net_profit"])),
      metadata: { raw: row, sales_report_period: rowPeriod },
    };
    salesSnapshots.push(salesSnapshot);
    salesRawRows.push({
      import_batch_id: batch.id,
      row_number: rowNumber,
      raw_row: originalRow,
      normalized_row: row,
      machine_id: machine.id,
      product_id: productId,
      sale_date: rowPeriod.reportEndDate,
      sale_datetime: endOfDateIso(rowPeriod.reportEndDate),
      quantity: Math.max(0, Math.floor(soldQty ?? 0)),
      gross_sales_lyd: grossSalesAmount,
      net_sales_lyd: netSalesAmount,
      duplicate_hash: sourceRowKey,
    });
    summary.successfulSalesRows = (summary.successfulSalesRows ?? 0) + 1;
    summary.estimatedSuccessfulSales = (summary.estimatedSuccessfulSales ?? 0) + netSalesAmount;
    summary.importedRows += 1;
    finishRow("imported");
  }

  if (stockSnapshots.length) {
    const { error } = await supabase.from("vms_stock_snapshots").upsert(stockSnapshots, { onConflict: "import_batch_id,import_row_number" });
    if (error) {
      console.error("[vms-import] Stock snapshot upsert failed", error);
      summary.errors.push(importStepError("Stock snapshot save to vms_stock_snapshots", error));
      summary.skippedRows += stockSnapshots.length;
      summary.importedRows -= stockSnapshots.length;
    } else if (isReprocess) {
      try {
        await markStaleSnapshotRows(supabase, "vms_stock_snapshots", batch.id, stockSnapshots.map((row) => Number(row.import_row_number)).filter(Number.isFinite));
      } catch (staleError) {
        console.error("[vms-import] Stock stale marking failed", staleError);
        summary.errors.push("Old stock snapshot rows could not be marked stale.");
      }
    }
  } else if (isReprocess && isMachineStockReport(reportType)) {
    try {
      await markStaleSnapshotRows(supabase, "vms_stock_snapshots", batch.id, []);
    } catch (staleError) {
      console.error("[vms-import] Stock stale marking failed", staleError);
      summary.errors.push("Old stock snapshot rows could not be marked stale.");
    }
  }

  if (machineStockSnapshots.length) {
    const { error } = await supabase
      .from("vms_machine_stock_snapshots")
      .upsert(machineStockSnapshots, { onConflict: "import_batch_id,row_number" });
    if (error) {
      console.error("[vms-import] Machine stock snapshot audit upsert failed", error);
      summary.errors.push(importStepError("Machine stock audit save to vms_machine_stock_snapshots", error));
    }
  }

  if (salesSnapshots.length) {
    if (isReprocess) {
      const { error } = await supabase.from("vms_sales_snapshots").upsert(salesSnapshots, { onConflict: "import_batch_id,import_row_number" });
      if (error) {
        console.error("[vms-import] Sales snapshot reprocess upsert failed", error);
        summary.errors.push(importStepError("Sales summary snapshot save to vms_sales_snapshots", error));
        summary.skippedRows += salesSnapshots.length;
        summary.importedRows -= salesSnapshots.length;
        fatalImportError = true;
      }
      try {
        await markStaleSnapshotRows(supabase, "vms_sales_snapshots", batch.id, salesSnapshots.map((row) => Number(row.import_row_number)).filter(Number.isFinite));
      } catch (staleError) {
        console.error("[vms-import] Sales stale marking failed", staleError);
        summary.errors.push("Old sales snapshot rows could not be marked stale.");
      }
    } else {
      const { data: rpcResult, error } = await supabase.rpc("apply_vms_sales_snapshot_import", {
        p_batch_id: batch.id,
        p_import_mode: effectiveImportMode === VMS_IMPORT_MODES.REPLACE_RANGE ? "replace_range" : effectiveImportMode,
        p_report_start_date: effectiveReportStartDate,
        p_report_end_date: effectiveReportEndDate,
        p_sales_rows: salesSnapshots,
      });
      if (error) {
        console.error("[vms-import] Sales snapshot transaction failed", {
          batchId: batch.id,
          importMode: effectiveImportMode,
          reportStartDate: effectiveReportStartDate,
          reportEndDate: effectiveReportEndDate,
          errorCode: error.code,
          errorMessage: error.message,
          error,
        });
        summary.errors.push(importStepError("Sales summary snapshot save to vms_sales_snapshots", error));
        summary.skippedRows += salesSnapshots.length;
        summary.importedRows -= salesSnapshots.length;
        fatalImportError = true;
      } else {
        const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
        const insertedRows = Number(result?.rows_inserted ?? salesSnapshots.length);
        const duplicateRows = Number(result?.rows_skipped_duplicate ?? Math.max(0, salesSnapshots.length - insertedRows));
        summary.importedRows -= Math.max(0, salesSnapshots.length - insertedRows);
        summary.skippedRows += duplicateRows;
        summary.rowsSkippedDuplicate += duplicateRows;
      }
    }
  } else if (isReprocess && reportType === "sales") {
    try {
      await markStaleSnapshotRows(supabase, "vms_sales_snapshots", batch.id, []);
    } catch (staleError) {
      console.error("[vms-import] Sales stale marking failed", staleError);
      summary.errors.push("Old sales snapshot rows could not be marked stale.");
    }
  }

  if (salesRawRows.length && !fatalImportError) {
    const { error } = await supabase
      .from("vms_sales_raw")
      .upsert(salesRawRows, { onConflict: "duplicate_hash", ignoreDuplicates: true });
    if (error) {
      console.error("[vms-import] Sales raw row upsert failed", error);
      summary.errors.push(importStepError("Sales raw audit save to vms_sales_raw", error));
    }
  }

  if (monthlyProductProfitRows.length && !fatalImportError) {
    const { error } = await supabase
      .from("vms_monthly_product_profit")
      .upsert(monthlyProductProfitRows, { onConflict: "import_batch_id,business_month,machine_code,product_number,product_name" });
    if (error) {
      const sampleRow = monthlyProductProfitRows[0];
      console.error("[vms-import] Monthly commodity profit row upsert failed", {
        batchId: batch.id,
        reportType,
        rowsAttemptedInChunk: monthlyProductProfitRows.length,
        payloadColumns: Object.keys(sampleRow ?? {}).sort(),
        sampleRow,
        schemaIssue: extractVmsSchemaIssue(error, "vms_monthly_product_profit.upsert"),
        error,
      });
      summary.errors.push(importStepErrorWithBatchContext({
        step: "Monthly commodity profit save to vms_monthly_product_profit",
        error,
        batchId: batch.id,
        row: sampleRow,
      }));
      summary.importedRows = Math.max(0, summary.importedRows - monthlyProductProfitRows.length);
      summary.skippedRows += monthlyProductProfitRows.length;
      summary.rowsSkippedDuplicate += 0;
      summary.failedTargets = Array.from(new Set([...summary.failedTargets, "Sales dashboard", "Product profit", "Machine profit"]));
      fatalImportError = true;
    }
  }

  if (transactionRawRows.length && !fatalImportError && isReprocess && reportType === "vms_order_details_weekly") {
    const { error } = await supabase
      .from("vms_transactions_raw")
      .delete()
      .eq("import_batch_id", batch.id);
    if (error) {
      console.error("[vms-import] Existing order-detail rows could not be cleared before reprocess", {
        batchId: batch.id,
        reportType,
        error,
      });
      summary.errors.push(importStepError("Detailed transaction reprocess reset in vms_transactions_raw", error));
      fatalImportError = true;
    }
  }

  const existingExternalDuplicateBatchIds = new Set<string>();
  if (transactionRawRows.length && !fatalImportError) {
    const rowsByHash = new Map<string, Record<string, unknown>>();
    transactionRawRows.forEach((row) => {
      const key = String(row.duplicate_hash ?? "");
      if (key && !rowsByHash.has(key)) rowsByHash.set(key, row);
    });
    const duplicateRowsWithinFile = Math.max(0, transactionRawRows.length - rowsByHash.size);
    const uniqueRows = [...rowsByHash.values()];
    const duplicateLookupMatches: Array<{ duplicateHash: string; importBatchId: string }> = [];

    for (let index = 0; index < uniqueRows.length; index += VMS_TRANSACTION_DUPLICATE_LOOKUP_CHUNK_SIZE) {
      const chunk = uniqueRows.slice(index, index + VMS_TRANSACTION_DUPLICATE_LOOKUP_CHUNK_SIZE).map((row) => String(row.duplicate_hash));
      const { data, error } = await supabase
        .from("vms_transactions_raw")
        .select("duplicate_hash, import_batch_id")
        .in("duplicate_hash", chunk);
      if (error) {
        console.error("[vms-import] Transaction duplicate lookup failed", {
          batchId: batch.id,
          reportType,
          duplicateLookupChunkSize: chunk.length,
          firstDuplicateHash: chunk[0] ?? null,
          error,
        });
        summary.errors.push(importStepErrorWithBatchContext({
          step: "Detailed transaction duplicate lookup in vms_transactions_raw",
          error,
          batchId: batch.id,
          row: uniqueRows[index],
        }));
        fatalImportError = true;
        break;
      }
      ((data ?? []) as { duplicate_hash: string | null; import_batch_id: string | null }[]).forEach((row) => {
        const duplicateHash = String(row.duplicate_hash ?? "").trim();
        const duplicateBatchId = String(row.import_batch_id ?? "").trim();
        if (duplicateHash && duplicateBatchId && (!isReprocess || duplicateBatchId !== String(batch.id))) {
          duplicateLookupMatches.push({ duplicateHash, importBatchId: duplicateBatchId });
        }
      });
    }

    if (!fatalImportError) {
      const duplicateBatchIds = [...new Set(
        duplicateLookupMatches
          .map((row) => row.importBatchId)
          .filter((value): value is string => Boolean(value)),
      )];
      const { data: duplicateBatches, error: duplicateBatchError } = duplicateBatchIds.length
        ? await supabase
          .from("vms_import_batches")
          .select("id, file_name, original_file_name, status, is_active, deleted_at, imported_at, updated_at")
          .in("id", duplicateBatchIds)
        : { data: [], error: null };

      if (duplicateBatchError) {
        console.error("[vms-import] Transaction duplicate batch metadata lookup failed", {
          batchId: batch.id,
          reportType,
          duplicateBatchCount: duplicateBatchIds.length,
          error: duplicateBatchError,
        });
        summary.errors.push(importStepErrorWithBatchContext({
          step: "Detailed transaction duplicate batch metadata lookup",
          error: duplicateBatchError,
          batchId: batch.id,
          row: uniqueRows[0],
        }));
        fatalImportError = true;
      } else {
        const batchById = new Map(
          ((duplicateBatches ?? []) as Array<{
            id: string;
            file_name?: string | null;
            original_file_name?: string | null;
            status?: string | null;
            is_active?: boolean | null;
            deleted_at?: string | null;
            imported_at?: string | null;
            updated_at?: string | null;
          }>).map((duplicateBatch) => [String(duplicateBatch.id), duplicateBatch]),
        );
        const activeDuplicateHashes = new Set<string>();
        const deletedDuplicateBatchIds = new Set<string>();
        const inactiveDuplicateBatchIds = new Set<string>();

        for (const { duplicateHash, importBatchId } of duplicateLookupMatches) {
          const duplicateBatch = batchById.get(importBatchId);
          if (!duplicateBatch) continue;
          const duplicateState = orderDetailsDashboardSourceState({
            id: duplicateBatch.id,
            file_name: duplicateBatch.file_name ?? null,
            original_file_name: duplicateBatch.original_file_name ?? null,
            status: duplicateBatch.status ?? null,
            is_active: duplicateBatch.is_active ?? null,
            deleted_at: duplicateBatch.deleted_at ?? null,
            imported_at: duplicateBatch.imported_at ?? null,
            updated_at: duplicateBatch.updated_at ?? null,
          });
          if (duplicateState === "active") {
            activeDuplicateHashes.add(duplicateHash);
            existingExternalDuplicateBatchIds.add(importBatchId);
          } else if (duplicateState === "deleted") {
            deletedDuplicateBatchIds.add(importBatchId);
          } else {
            inactiveDuplicateBatchIds.add(importBatchId);
          }
        }

        if (duplicateLookupMatches.length) {
          console.info("[vms-import] Order Details duplicate classification", {
            batchId: batch.id,
            activeDuplicateRows: activeDuplicateHashes.size,
            deletedDuplicateBatches: deletedDuplicateBatchIds.size,
            inactiveDuplicateBatches: inactiveDuplicateBatchIds.size,
          });
        }

        const rowsToSave = uniqueRows.filter((row) => !activeDuplicateHashes.has(String(row.duplicate_hash)));
        const duplicateRows = duplicateRowsWithinFile + activeDuplicateHashes.size;
        if (duplicateRows) {
          summary.importedRows -= duplicateRows;
          summary.skippedRows += duplicateRows;
          summary.rowsSkippedDuplicate += duplicateRows;
        }

        if (!activeDuplicateHashes.size && (deletedDuplicateBatchIds.size > 0 || inactiveDuplicateBatchIds.size > 0) && uniqueRows.length > 0) {
          summary.resultMessage = "Imported as a new active dashboard source. Matching deleted or inactive batches were ignored.";
        }

        for (let index = 0; index < rowsToSave.length; index += VMS_TRANSACTION_SAVE_CHUNK_SIZE) {
          const chunk = rowsToSave.slice(index, index + VMS_TRANSACTION_SAVE_CHUNK_SIZE);
          const { error } = await supabase
            .from("vms_transactions_raw")
            .upsert(chunk, { onConflict: "duplicate_hash", ignoreDuplicates: true });
          if (!error) continue;

          const sampleRow = chunk[0];
          console.error("[vms-import] Transaction raw row upsert failed", {
            batchId: batch.id,
            reportType,
            rowsAttemptedInChunk: chunk.length,
            payloadColumns: Object.keys(sampleRow ?? {}).sort(),
            sampleRow: summarizeVmsTransactionRawRowForLog(sampleRow),
            schemaIssue: extractVmsSchemaIssue(error, "vms_transactions_raw.upsert"),
            error,
          });
          summary.errors.push(importStepErrorWithBatchContext({
            step: "Detailed transaction save to vms_transactions_raw",
            error,
            batchId: batch.id,
            row: sampleRow,
          }));
          fatalImportError = true;
          break;
        }
      }
    }
  }

  if (planogramRows.length) {
    const { error } = await supabase.from("machine_slots").upsert(planogramRows, { onConflict: "machine_id,slot_code" });
    if (error) {
      console.error("[vms-import] Planogram upsert failed", error);
      summary.errors.push(importStepError("Planogram save to machine_slots", error));
      summary.skippedRows += planogramRows.length;
      summary.importedRows -= planogramRows.length;
    }
  }

  if (latestMappingRowsById.size) {
    const { error } = await supabase.from("vms_product_mappings").upsert([...latestMappingRowsById.values()], { onConflict: "id" });
    if (error) {
      console.error("[vms-import] VMS product mapping metadata update failed", error);
      summary.errors.push(importStepError("VMS product mapping metadata update", error));
    }
  }

  if (finalRawRows.length) {
    const finalRawRowsResult = await upsertRawRows(supabase, finalRawRows);
    if (!finalRawRowsResult.ok) {
      console.error("[vms-import] Imported row audit upsert failed", finalRawRowsResult.error);
      summary.errors.push(vmsSchemaIssueMessage(finalRawRowsResult.error, "vms_import_rows.upsert") ?? "Imported row audit save failed.");
    }
  }

  if (!fatalImportError) {
    const productIds = new Set([...vmsSellingPriceByProductId.keys(), ...vmsCostPriceByProductId.keys()]);
    for (const productId of productIds) {
      const payload: Record<string, unknown> = { price_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const sellingPrice = vmsSellingPriceByProductId.get(productId);
      const costPrice = vmsCostPriceByProductId.get(productId);
      if (sellingPrice !== undefined) Object.assign(payload, { vms_selling_price_lyd: sellingPrice, current_selling_price_lyd: sellingPrice, selling_price: sellingPrice, selling_price_source: "vms" });
      if (costPrice !== undefined) Object.assign(payload, { current_cost_price_lyd: costPrice, cost_price: costPrice, cost_price_source: "vms" });
      const { error } = await supabase.from("products").update(payload).eq("id", productId);
      if (error) {
        console.error("[vms-import] Product price update failed", { productId, error });
        summary.errors.push(importStepError("Product VMS price update", error));
      }
    }
  }

  summary.rowsNeedingReview = summary.needsProductMappingRows + summary.unknownMachineRows + summary.invalidRows;
  summary.updatedTargets = importUpdatedTargets(reportType, summary);
  summary.failedTargets = importFailedTargets(summary);
  const importResult = classifyImportResult(summary, fatalImportError);
  summary.resultMessage = importResult.message;
  const snapshotTimeValues = machineStockSnapshotTimes.map((date) => date.getTime()).filter(Number.isFinite);
  const stockDetectedMinDatetime = snapshotTimeValues.length ? new Date(Math.min(...snapshotTimeValues)).toISOString() : null;
  const stockDetectedMaxDatetime = snapshotTimeValues.length ? new Date(Math.max(...snapshotTimeValues)).toISOString() : null;
  const stockFallbackTimestamp = isMachineStockReport(reportType) ? new Date().toISOString() : null;
  const persistedStockSummary = isMachineStockReport(reportType)
    ? await loadPersistedStockSnapshotBatchSummary({ supabase, batchId: batch.id })
    : null;
  const persistedOrderDetailsSummary = reportType === "vms_order_details_weekly"
    ? await loadPersistedOrderDetailsBatchSummary({ supabase, batchId: batch.id })
    : null;
  if (persistedStockSummary?.error) {
    console.warn("[vms-import] Could not verify persisted stock snapshot rows after confirm", {
      batchId: batch.id,
      reportType,
      error: persistedStockSummary.error,
    });
  }
  if (persistedOrderDetailsSummary?.error) {
    console.warn("[vms-import] Could not verify persisted detailed transaction rows after confirm", {
      batchId: batch.id,
      reportType,
      error: persistedOrderDetailsSummary.error,
    });
  }
  const persistedImportedRowCount = persistedStockSummary?.importedRowCount ?? 0;
  const persistedOrderDetailsRowCount = persistedOrderDetailsSummary?.rowCount ?? 0;
  const persistedOrderDetailsBusinessDateStart = persistedOrderDetailsSummary?.businessDateStart ?? null;
  const persistedOrderDetailsBusinessDateEnd = persistedOrderDetailsSummary?.businessDateEnd ?? null;
  const persistedOrderDetailsSuccessfulRows = persistedOrderDetailsSummary?.successfulRowsCount ?? 0;
  const persistedOrderDetailsFailedRows = persistedOrderDetailsSummary?.failedRowsCount ?? 0;
  const persistedOrderDetailsRefundedRows = persistedOrderDetailsSummary?.refundedRowsCount ?? 0;
  const persistedOrderDetailsTotalSuccessfulSales = persistedOrderDetailsSummary?.totalSuccessfulSales ?? 0;
  const parsedOrderDetailsSuccessfulRows = summary.successfulSalesRows ?? 0;
  const parsedOrderDetailsFailedVendRows = summary.failedVendRows ?? 0;
  const parsedOrderDetailsRefundedRows = summary.refundedRows ?? 0;
  const parsedOrderDetailsFailedPaymentRows = summary.failedPaymentRows ?? 0;
  const parsedOrderDetailsNeedsReviewRows = summary.needsReviewTransactionRows ?? 0;
  const parsedOrderDetailsTotalSuccessfulSales = summary.estimatedSuccessfulSales ?? 0;
  const attemptedImportedRows = summary.importedRows;
  const effectiveImportedRows = isMachineStockReport(reportType)
    ? (persistedImportedRowCount > 0 ? persistedImportedRowCount : summary.importedRows)
    : reportType === "vms_order_details_weekly"
      ? persistedOrderDetailsRowCount
      : summary.importedRows;
  const hasPersistedOrderDetailsRows = persistedOrderDetailsRowCount > 0;
  const orderDetailsSuccessfulRowsForMetadata = hasPersistedOrderDetailsRows ? persistedOrderDetailsSuccessfulRows : parsedOrderDetailsSuccessfulRows;
  const orderDetailsFailedVendRowsForMetadata = hasPersistedOrderDetailsRows ? (persistedOrderDetailsSummary?.failedVendRowsCount ?? 0) : parsedOrderDetailsFailedVendRows;
  const orderDetailsRefundedRowsForMetadata = hasPersistedOrderDetailsRows ? persistedOrderDetailsRefundedRows : parsedOrderDetailsRefundedRows;
  const orderDetailsFailedPaymentRowsForMetadata = hasPersistedOrderDetailsRows ? (persistedOrderDetailsSummary?.failedPaymentRowsCount ?? 0) : parsedOrderDetailsFailedPaymentRows;
  const orderDetailsNeedsReviewRowsForMetadata = hasPersistedOrderDetailsRows ? (persistedOrderDetailsSummary?.needsReviewRowsCount ?? 0) : parsedOrderDetailsNeedsReviewRows;
  const orderDetailsTotalSuccessfulSalesForMetadata = hasPersistedOrderDetailsRows ? persistedOrderDetailsTotalSuccessfulSales : parsedOrderDetailsTotalSuccessfulSales;
  if (reportType === "vms_order_details_weekly") {
    summary.importedRows = effectiveImportedRows;
    summary.successfulSalesRows = orderDetailsSuccessfulRowsForMetadata;
    summary.failedVendRows = orderDetailsFailedVendRowsForMetadata;
    summary.refundedRows = orderDetailsRefundedRowsForMetadata;
    summary.failedPaymentRows = orderDetailsFailedPaymentRowsForMetadata;
    summary.needsReviewTransactionRows = orderDetailsNeedsReviewRowsForMetadata;
    summary.estimatedSuccessfulSales = orderDetailsTotalSuccessfulSalesForMetadata;
  }
  const importedRowsFromPersistence = isMachineStockReport(reportType)
    && effectiveImportedRows > 0
    && summary.importedRows <= 0;
  if (importedRowsFromPersistence) {
    const repairWarning = `Auto-repaired stock snapshot metadata because ${effectiveImportedRows} stock row(s) were already saved when the final confirm state was recalculated.`;
    if (!summary.errors.includes(repairWarning)) summary.errors.push(repairWarning);
    summary.failedTargets = Array.from(new Set([...summary.failedTargets, "Import metadata"]));
    summary.resultMessage = "Stock snapshot rows were saved and auto-activated for route recommendations.";
  }
  const missingPersistedOrderDetailsRows = reportType === "vms_order_details_weekly"
    && attemptedImportedRows > 0
    && effectiveImportedRows <= 0;
  if (missingPersistedOrderDetailsRows) {
    const transactionSaveError = "Detailed VMS transaction rows were not saved to vms_transactions_raw. Reprocess this batch after the import fix is deployed.";
    if (!summary.errors.includes(transactionSaveError)) summary.errors.push(transactionSaveError);
    summary.failedTargets = Array.from(new Set([...summary.failedTargets, "Sales dashboard"]));
    summary.resultMessage = transactionSaveError;
  }
  const duplicateOnlyOrderDetailsReupload = reportType === "vms_order_details_weekly"
    && !fatalImportError
    && effectiveImportedRows <= 0
    && attemptedImportedRows <= 0
    && summary.rowsSkippedDuplicate > 0;
  if (duplicateOnlyOrderDetailsReupload) {
    const dashboardSourceCandidates = await loadExistingOrderDetailsDashboardSourceCandidates({
      supabase,
      batchIds: [...existingExternalDuplicateBatchIds],
      fallbackFileHash: fileHash,
      fallbackFileName: fileName,
    });
    const dashboardSourceCandidate = pickBestOrderDetailsDashboardSourceCandidate(dashboardSourceCandidates);

    if (!dashboardSourceCandidate) {
      summary.errors.push("Rows already exist, but Snacky OS could not identify an active dashboard batch.");
      summary.failedTargets = Array.from(new Set([...summary.failedTargets, "Sales dashboard"]));
      summary.resultMessage = `Rows already exist, but Snacky OS could not identify an active dashboard batch. Repair required.`;
    } else {
      let sourceInfo: ExistingOrderDetailsDashboardSource = {
        batchId: dashboardSourceCandidate.batch.id,
        fileName: textValue(dashboardSourceCandidate.batch.original_file_name) || textValue(dashboardSourceCandidate.batch.file_name) || "unknown file",
        status: textValue(dashboardSourceCandidate.batch.status) || null,
        isActive: dashboardSourceCandidate.batch.is_active !== false && !dashboardSourceCandidate.batch.deleted_at,
        rowCount: dashboardSourceCandidate.summary.rowCount,
        businessDateStart: dashboardSourceCandidate.summary.businessDateStart,
        businessDateEnd: dashboardSourceCandidate.summary.businessDateEnd,
        successfulRowsCount: dashboardSourceCandidate.summary.successfulRowsCount,
        totalSuccessfulSales: dashboardSourceCandidate.summary.totalSuccessfulSales,
        detectedMinDatetime: dashboardSourceCandidate.summary.detectedMinDatetime,
        detectedMaxDatetime: dashboardSourceCandidate.summary.detectedMaxDatetime,
      };
      summary.existingDashboardSource = sourceInfo;

      const sourceLabel = formatOrderDetailsDashboardSourceCandidate(dashboardSourceCandidate);
      const repairedSourceLabel = formatOrderDetailsDashboardSourceCandidate({
        batch: {
          ...dashboardSourceCandidate.batch,
          status: "imported",
          is_active: true,
          deleted_at: null,
        },
        summary: dashboardSourceCandidate.summary,
      });
      const sourceState = orderDetailsDashboardSourceState(dashboardSourceCandidate.batch);
      const sourceActive = sourceState === "active";

      console.info("[vms-import] Duplicate-only Order Details reupload matched existing dashboard source", {
        currentBatchId: batch.id,
        existingBatchId: dashboardSourceCandidate.batch.id,
        existingBatchStatus: dashboardSourceCandidate.batch.status ?? null,
        existingBatchIsActive: dashboardSourceCandidate.batch.is_active ?? null,
        existingBatchDeletedAt: dashboardSourceCandidate.batch.deleted_at ?? null,
        existingBatchRowCount: dashboardSourceCandidate.summary.rowCount,
        existingBatchBusinessDateStart: dashboardSourceCandidate.summary.businessDateStart,
        existingBatchBusinessDateEnd: dashboardSourceCandidate.summary.businessDateEnd,
        existingBatchSuccessfulRows: dashboardSourceCandidate.summary.successfulRowsCount,
        existingBatchSuccessfulSalesAmount: dashboardSourceCandidate.summary.totalSuccessfulSales,
        existingBatchState: sourceState,
        sourceLabel,
      });

      if (sourceActive) {
        summary.updatedTargets = Array.from(new Set([...summary.updatedTargets, "Sales dashboard"]));
        summary.resultMessage = `File already imported. Existing active batch is used in dashboard: ${sourceLabel}`;
      } else {
        const actorId = profile.team_member_id ?? profile.id ?? null;
        const repairResult = await activateOrderDetailsBatchWithCoreMetadata({
          supabase,
          batchId: dashboardSourceCandidate.batch.id,
          actorId,
          rowsFound: dashboardSourceCandidate.summary.rowCount,
          rowCount: dashboardSourceCandidate.summary.rowCount,
          rowsImported: dashboardSourceCandidate.summary.rowCount,
          reportStartDate: dashboardSourceCandidate.summary.businessDateStart,
          reportEndDate: dashboardSourceCandidate.summary.businessDateEnd,
          detectedMinDatetime: dashboardSourceCandidate.summary.detectedMinDatetime,
          detectedMaxDatetime: dashboardSourceCandidate.summary.detectedMaxDatetime,
          successfulRowsCount: dashboardSourceCandidate.summary.successfulRowsCount,
          failedRowsCount: dashboardSourceCandidate.summary.failedRowsCount,
          refundedRowsCount: dashboardSourceCandidate.summary.refundedRowsCount,
          totalSuccessfulSales: dashboardSourceCandidate.summary.totalSuccessfulSales,
        });

        if (repairResult.ok) {
          sourceInfo = {
            ...sourceInfo,
            status: "imported",
            isActive: true,
          };
          summary.existingDashboardSource = sourceInfo;
          summary.updatedTargets = Array.from(new Set([...summary.updatedTargets, "Sales dashboard"]));
          summary.resultMessage = sourceState === "deleted"
            ? `Rows matched a deleted batch. Restored and activated it for the dashboard: ${repairedSourceLabel}`
            : `File already imported. Reactivated existing batch for dashboard: ${repairedSourceLabel}`;
          revalidateVmsDataSourcePaths(dashboardSourceCandidate.batch.id);
        } else {
          logVmsBatchMutationFailure({
            queryName: "vms_import_batches.update.duplicate_order_details_reactivate",
            error: repairResult.error,
            payload: repairResult.payload,
            profile,
            selectedImportBatchId: dashboardSourceCandidate.batch.id,
            currentStep: "confirm_import",
          });
          summary.errors.push(sourceState === "deleted"
            ? "Rows already exist, but Snacky OS could not restore the deleted dashboard batch automatically."
            : "Rows already exist, but Snacky OS could not reactivate the existing dashboard batch automatically.");
          summary.failedTargets = Array.from(new Set([...summary.failedTargets, "Sales dashboard"]));
          summary.resultMessage = sourceState === "deleted"
            ? `Rows already exist, but Snacky OS could not restore the deleted dashboard batch automatically: ${sourceLabel}`
            : `Rows already exist, but Snacky OS could not reactivate the existing dashboard batch automatically: ${sourceLabel}`;
        }
      }
    }
  }
  const status = isMachineStockReport(reportType) && effectiveImportedRows > 0
    ? "imported"
    : reportType === "vms_order_details_weekly"
      ? (effectiveImportedRows > 0 || duplicateOnlyOrderDetailsReupload ? "imported" : "failed")
      : importResult.status;
  const detectedMinDatetime = isMachineStockReport(reportType)
    ? (persistedStockSummary?.detectedMinDatetime ?? stockDetectedMinDatetime ?? stockFallbackTimestamp)
    : reportType === "vms_order_details_weekly"
      ? (persistedOrderDetailsSummary?.detectedMinDatetime ?? (effectiveReportStartDate ? startOfDateIso(effectiveReportStartDate) : null))
    : (effectiveReportStartDate ? startOfDateIso(effectiveReportStartDate) : null);
  const detectedMaxDatetime = isMachineStockReport(reportType)
    ? (persistedStockSummary?.detectedMaxDatetime ?? stockDetectedMaxDatetime ?? stockFallbackTimestamp)
    : reportType === "vms_order_details_weekly"
      ? (persistedOrderDetailsSummary?.detectedMaxDatetime ?? (effectiveReportEndDate ? endOfDateIso(effectiveReportEndDate) : null))
    : (effectiveReportEndDate ? endOfDateIso(effectiveReportEndDate) : null);
  const latestErrorText = status === "imported"
    ? null
    : (summary.errors.length ? summary.errors.join("; ").slice(0, 2000) : null);
  const finalizedReportStartDate = reportType === "vms_order_details_weekly"
    ? (persistedOrderDetailsBusinessDateStart ?? effectiveReportStartDate)
    : effectiveReportStartDate;
  const finalizedReportEndDate = reportType === "vms_order_details_weekly"
    ? (persistedOrderDetailsBusinessDateEnd ?? effectiveReportEndDate)
    : effectiveReportEndDate;
  const batchUpdate = {
    status,
    is_active: isMachineStockReport(reportType) || reportType === "vms_order_details_weekly" ? effectiveImportedRows > 0 : importResult.active,
    imported_by: profile.team_member_id ?? profile.id ?? null,
    imported_at: new Date().toISOString(),
    report_type: finalizedReportType,
    file_name: fileName,
    file_type: fileType,
    sheet_name: sheetName,
    source_usage: vmsSourceUsage(finalizedReportType),
    dashboard_usage: vmsSourceUsage(finalizedReportType),
    latest_error: latestErrorText,
    last_error: latestErrorText,
    updated_at: new Date().toISOString(),
    rows_found: summary.rowsFound,
    row_count: summary.rowsFound,
    rows_skipped: summary.skippedRows,
    report_start_date: finalizedReportStartDate,
    report_end_date: finalizedReportEndDate,
    file_hash: fileHash,
    storage_path: storagePath,
    detected_min_datetime: detectedMinDatetime,
    detected_max_datetime: detectedMaxDatetime,
    total_successful_sales: reportType === "vms_order_details_weekly"
      ? orderDetailsTotalSuccessfulSalesForMetadata
      : effectiveImportedRows > 0
        ? summary.estimatedSuccessfulSales ?? 0
        : 0,
    successful_rows_count: reportType === "vms_order_details_weekly"
      ? orderDetailsSuccessfulRowsForMetadata
      : effectiveImportedRows,
    failed_rows_count: reportType === "vms_order_details_weekly"
      ? (orderDetailsFailedVendRowsForMetadata + orderDetailsFailedPaymentRowsForMetadata + orderDetailsNeedsReviewRowsForMetadata)
      : 0,
    refunded_rows_count: reportType === "vms_order_details_weekly"
      ? orderDetailsRefundedRowsForMetadata
      : summary.refundedRows ?? 0,
    rows_imported: effectiveImportedRows,
    rows_skipped_duplicate: summary.rowsSkippedDuplicate,
    rows_needing_review: summary.rowsNeedingReview,
    error_count: summary.errors.length,
    errors: summary.errors,
    unknown_machines: summary.unknownMachines,
    unmapped_products: summary.unmappedProducts,
    preview_summary: summary,
    review_summary: {
      unknown_machines: summary.unknownMachines,
      unmapped_products: summary.unmappedProducts,
      errors: summary.errors,
    },
    parse_diagnostics: {
      reportType: finalizedReportType,
      fileType,
      sheetName,
      headers: headerNames,
      rowsFound: summary.rowsFound,
      importedRows: effectiveImportedRows,
      rowsNeedingReview: summary.rowsNeedingReview,
    },
    notes: JSON.stringify({
      reportType: finalizedReportType,
      importType: effectiveImportMode,
      fileName,
      fileType,
      sheetName,
      status,
      totalRows: summary.totalRows,
      message: summary.resultMessage,
      resultMessage: summary.resultMessage,
      updatedTargets: summary.updatedTargets,
      failedTargets: summary.failedTargets,
      importedRows: effectiveImportedRows,
      rowsFound: summary.rowsFound,
      skippedRows: summary.skippedRows,
      needsProductMappingRows: summary.needsProductMappingRows,
      unknownMachineRows: summary.unknownMachineRows,
      invalidRows: summary.invalidRows,
      rowsSkippedDuplicate: summary.rowsSkippedDuplicate,
      rowsNeedingReview: summary.rowsNeedingReview,
      orderDetailsReportPeriod: summary.orderDetailsReportPeriod,
      successfulSalesRows: orderDetailsSuccessfulRowsForMetadata,
      failedVendRows: orderDetailsFailedVendRowsForMetadata,
      refundedRows: orderDetailsRefundedRowsForMetadata,
      failedPaymentRows: orderDetailsFailedPaymentRowsForMetadata,
      needsReviewTransactionRows: orderDetailsNeedsReviewRowsForMetadata,
      estimatedSuccessfulSales: orderDetailsTotalSuccessfulSalesForMetadata,
      errors: summary.errors,
      unknownMachines: summary.unknownMachines,
      unmappedProducts: summary.unmappedProducts,
    }),
  };

  const finalUpdateResult = await runVmsImportBatchMutationWithMetadataFallback({
    queryName: "vms_import_batches.update.final",
    currentStep: "confirm_import",
    selectedImportBatchId: batch.id,
    payload: batchUpdate,
    run: (payload) => supabase
      .from("vms_import_batches")
      .update(payload)
      .eq("id", batch.id)
      .select("id, status, is_active, rows_imported, imported_at, updated_at")
      .maybeSingle(),
  });
  const finalUpdateProblem = finalUpdateResult.timedOut
    ? { code: "TIMEOUT", message: "VMS import final batch update took too long." }
    : finalUpdateResult.error
      ?? finalUpdateResult.value?.error
      ?? (!batchMutationReturnedRow(finalUpdateResult.value)
        ? missingBatchMutationRowError({
            queryName: "vms_import_batches.update.final",
            currentStep: "confirm_import",
            selectedImportBatchId: batch.id,
          })
        : null);
  if (finalUpdateProblem) {
    logVmsBatchMutationFailure({
      queryName: "vms_import_batches.update.final",
      error: finalUpdateProblem,
      payload: finalUpdateResult.payload,
      profile,
      selectedImportBatchId: batch.id,
      currentStep: "confirm_import",
    });
    if (effectiveImportedRows <= 0) {
      errorRedirect(batchMutationErrorMessage(finalUpdateProblem));
      return;
    }
    const metadataWarning = `Imported data was preserved, but final batch metadata could not update: ${batchMutationErrorMessage(finalUpdateProblem)}`;
    summary.errors.push(metadataWarning);
    summary.failedTargets = Array.from(new Set([...summary.failedTargets, "Import metadata"]));
    summary.resultMessage = reportType === "vms_order_details_weekly"
      ? "Detailed Order Details rows were saved. Snacky OS repaired the batch state from the imported rows."
      : "Imported data was preserved. Some metadata could not update.";
    const metadataFallbackUpdate = await runVmsImportBatchMutationWithMetadataFallback({
      queryName: "vms_import_batches.update.final_metadata_fallback",
      currentStep: "confirm_import",
      selectedImportBatchId: batch.id,
      payload: {
        status: "imported",
        is_active: true,
        imported_by: profile.team_member_id ?? profile.id ?? null,
        imported_at: new Date().toISOString(),
        report_type: finalizedReportType,
        source_usage: vmsSourceUsage(finalizedReportType),
        dashboard_usage: vmsSourceUsage(finalizedReportType),
        latest_error: null,
        last_error: null,
        updated_at: new Date().toISOString(),
        rows_found: summary.rowsFound,
        row_count: summary.rowsFound,
        rows_imported: effectiveImportedRows,
        rows_skipped_duplicate: summary.rowsSkippedDuplicate,
        rows_needing_review: summary.rowsNeedingReview,
        detected_min_datetime: detectedMinDatetime,
        detected_max_datetime: detectedMaxDatetime,
        notes: JSON.stringify({
          ...summary,
          reportType: finalizedReportType,
          importedRows: effectiveImportedRows,
          status: "imported",
          metadata_warning: metadataWarning,
        }),
      },
      run: (payload) => supabase
        .from("vms_import_batches")
        .update(payload)
        .eq("id", batch.id)
        .select("id, status, is_active, rows_imported, imported_at, updated_at")
        .maybeSingle(),
    });
    if (metadataFallbackUpdate.timedOut || metadataFallbackUpdate.error || metadataFallbackUpdate.value?.error) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.update.final_metadata_fallback",
        error: metadataFallbackUpdate.error ?? metadataFallbackUpdate.value?.error ?? { code: "TIMEOUT", message: "VMS import metadata fallback update took too long." },
        payload: metadataFallbackUpdate.payload,
        profile,
        selectedImportBatchId: batch.id,
        currentStep: "confirm_import",
      });
    }
  }

  await ensureConfirmedStockImportBatchIsUsable({
    supabase,
    profile,
    batchId: batch.id,
    reportType,
    summary,
    detectedMinDatetime: stockDetectedMinDatetime ?? stockFallbackTimestamp,
    detectedMaxDatetime: stockDetectedMaxDatetime ?? stockFallbackTimestamp,
  });
  const orderDetailsBatchUsable = await ensureConfirmedOrderDetailsImportBatchIsUsable({
    supabase,
    profile,
    batchId: batch.id,
    reportType,
    summary,
    reportStartDate: finalizedReportStartDate,
    reportEndDate: finalizedReportEndDate,
    detectedMinDatetime,
    detectedMaxDatetime,
  });
  if (!orderDetailsBatchUsable && reportType === "vms_order_details_weekly" && effectiveImportedRows > 0) {
    errorRedirect("Detailed Order Details rows were saved, but Snacky OS could not finalize the batch metadata automatically. Use Finalize file from the batch page.");
    return;
  }

  await deactivateOlderActiveStockBatches({
    supabase,
    currentBatchId: batch.id,
    reportType,
    updatedAt: new Date().toISOString(),
  });
  if (reportType === "monthly_product_profit" && effectiveImportedRows > 0) {
    await deactivateOlderActiveMonthlyProfitBatches({
      supabase,
      currentBatchId: batch.id,
      reportStartDate: finalizedReportStartDate,
      reportEndDate: finalizedReportEndDate,
      fileHash,
      updatedAt: new Date().toISOString(),
    });
  }

  await saveHeaderMappingMemory({ supabase, profile, reportType, headerNames, mapping: columnMapping });

  await logActivity({
    profile,
    action: "import_vms",
    entityType: "vms_import",
    entityId: batch.id,
    entityLabel: `${reportType} ${fileType.toUpperCase()} ${fileName}`,
    afterData: summary,
    metadata: { report_type: reportType, file_name: fileName, file_type: fileType, sheet_name: sheetName },
    summary: `${existingBatchId && recordReprocess ? "Reprocessed" : "Imported"} ${summary.importedRows} ${reportType} rows from VMS ${fileType.toUpperCase()}`,
  });

  await refreshRefillRecommendationsAfterStockImport({
    supabase,
    batchId: batch.id,
    reportType,
    importedRows: summary.importedRows,
  });

  revalidatePath("/vms-import");
  revalidatePath("/vms-mappings");
  revalidatePath("/products");
  revalidatePath("/machines");
  revalidatePath("/planograms");
  revalidatePath("/refills");
  revalidatePath("/routes/new");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/sales");
  revalidatePath("/products-dashboard");
  revalidatePath("/machines-dashboard");
  revalidatePath("/inventory-dashboard");
  redirect(`/vms-import/${batch.id}?success=${encodeURIComponent(summary.resultMessage || (existingBatchId && recordReprocess ? "VMS import reprocessed successfully." : "VMS import confirmed successfully."))}`);
}

type VmsPreviewSheetPayload = { name: string; rows: string[][] };

const VMS_ORIGINAL_FILE_UPLOAD_SOFT_TIMEOUT_MS = 8000;
const VMS_PREVIEW_ROW_INSERT_LIMIT = 500;
const VMS_SAVE_QUERY_TIMEOUT_MS = 30000;
const VMS_TRANSACTION_DUPLICATE_LOOKUP_CHUNK_SIZE = 50;
const VMS_TRANSACTION_SAVE_CHUNK_SIZE = 250;

type SoftTimeoutResult<T> =
  | { timedOut: true }
  | { timedOut: false; value: T }
  | { timedOut: false; error: unknown };

async function withSoftTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<SoftTimeoutResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ timedOut: false as const, value }),
      (error) => ({ timedOut: false as const, error }),
    ),
    timeout,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return result;
}

function isMissingPreviewRowsSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const supabaseError = error as { code?: string; message?: string; details?: string; hint?: string };
  const text = `${supabaseError.message ?? ""} ${supabaseError.details ?? ""} ${supabaseError.hint ?? ""}`.toLowerCase();
  return supabaseError.code === "42P01"
    || supabaseError.code === "42703"
    || supabaseError.code === "PGRST204"
    || supabaseError.code === "PGRST205"
    || text.includes("does not exist")
    || text.includes("schema cache");
}

function isPermissionPreviewError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const supabaseError = error as { code?: string; message?: string; details?: string; hint?: string };
  const text = `${supabaseError.message ?? ""} ${supabaseError.details ?? ""} ${supabaseError.hint ?? ""}`.toLowerCase();
  return supabaseError.code === "42501" || text.includes("permission denied") || text.includes("row-level security") || text.includes("rls");
}

function isMissingColumnPreviewError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const supabaseError = error as { code?: string; message?: string; details?: string; hint?: string };
  const text = `${supabaseError.message ?? ""} ${supabaseError.details ?? ""} ${supabaseError.hint ?? ""}`.toLowerCase();
  return supabaseError.code === "42703" || supabaseError.code === "PGRST204" || text.includes("column") || text.includes("schema cache");
}

function previewErrorMessage(error: unknown, tableName: string) {
  const supabaseError = error && typeof error === "object" ? error as { code?: string; message?: string; details?: string; hint?: string } : null;
  const schemaMessage = vmsSchemaIssueMessage(error);
  if (schemaMessage) return schemaMessage;
  if (supabaseError?.code === "MISSING_SCHEMA" && supabaseError.message) return supabaseError.message;
  if (isPermissionPreviewError(error)) return "You do not have permission to create VMS import previews.";
  if (supabaseError?.code === "42P01" || supabaseError?.code === "PGRST205") return "VMS import setup is incomplete. Please contact admin.";
  if (isMissingColumnPreviewError(error)) {
    const issue = extractVmsSchemaIssue(error);
    const column = issue?.type === "missing_column" ? issue.column : null;
    return column ? "VMS import setup is missing a required field. Please contact admin." : "VMS import setup is incomplete. Please contact admin.";
  }
  return `${tableName} could not prepare the VMS import preview. Please contact admin.`;
}

function supabaseMutationError(error: unknown) {
  return error && typeof error === "object" ? error as { code?: string; message?: string; details?: string; hint?: string } : null;
}

function mutationErrorText(error: unknown) {
  const supabaseError = supabaseMutationError(error);
  return `${supabaseError?.code ?? ""} ${supabaseError?.message ?? ""} ${supabaseError?.details ?? ""} ${supabaseError?.hint ?? ""}`.toLowerCase();
}

function missingColumnName(error: unknown) {
  const issue = extractVmsSchemaIssue(error, "vms_import_batches.mutation");
  if (issue?.type === "missing_column") return issue.column;
  const supabaseError = supabaseMutationError(error);
  const text = `${supabaseError?.message ?? ""} ${supabaseError?.details ?? ""} ${supabaseError?.hint ?? ""}`;
  return text.match(/column ['"]?([a-zA-Z0-9_]+)['"]? does not exist/i)?.[1] ?? null;
}

function isBatchMissingTableError(error: unknown) {
  const supabaseError = supabaseMutationError(error);
  const text = mutationErrorText(error);
  return supabaseError?.code === "42P01" || supabaseError?.code === "PGRST205" || text.includes("does not exist");
}

function isBatchMissingColumnError(error: unknown) {
  const supabaseError = supabaseMutationError(error);
  const text = mutationErrorText(error);
  return supabaseError?.code === "42703" || supabaseError?.code === "PGRST204" || text.includes("column") || text.includes("schema cache");
}

function isBatchPermissionError(error: unknown) {
  const supabaseError = supabaseMutationError(error);
  const text = mutationErrorText(error);
  return supabaseError?.code === "42501" || text.includes("permission denied") || text.includes("row-level security") || text.includes("rls");
}

function isBatchConstraintError(error: unknown) {
  const supabaseError = supabaseMutationError(error);
  const text = mutationErrorText(error);
  return supabaseError?.code === "23514" || text.includes("violates check constraint") || text.includes("import_mode") || text.includes("status");
}

function batchMutationErrorMessage(error: unknown) {
  const supabaseError = supabaseMutationError(error);
  const schemaMessage = vmsSchemaIssueMessage(error, "vms_import_batches.mutation");
  if (schemaMessage) return schemaMessage;
  if (supabaseError?.code === "TIMEOUT") return "Save took too long. Please check your connection and retry.";
  if (isBatchPermissionError(error)) return "You do not have permission to create or confirm VMS imports.";
  if (isBatchMissingTableError(error)) return "VMS import setup is incomplete. Please contact admin.";
  if (isBatchMissingColumnError(error)) {
    const column = missingColumnName(error);
    return column ? "VMS import setup is missing a required field. Please contact admin." : "VMS import setup is incomplete. Please contact admin.";
  }
  if (isBatchConstraintError(error)) {
    return `VMS import batch status or import mode was rejected by the database constraint. Technical detail: ${supabaseError?.message ?? "check constraint failed"}`;
  }
  if (supabaseError?.code === "23505") return "This VMS import batch already exists. Open the existing import or reprocess it instead of creating a duplicate.";
  return "Could not save VMS import batch. Please contact admin.";
}

type VmsBatchMutationResponse<T> = {
  data?: T | null;
  error?: unknown;
};

type VmsBatchMutationResult<T> = {
  timedOut: boolean;
  error?: unknown;
  value?: VmsBatchMutationResponse<T>;
  payload: Record<string, unknown>;
  droppedOptionalColumns: string[];
};

function missingBatchMutationRowError({
  queryName,
  currentStep,
  selectedImportBatchId,
}: {
  queryName: string;
  currentStep: string;
  selectedImportBatchId?: string | null;
}) {
  return {
    code: "NO_ROWS",
    message: "VMS import batch update did not affect any rows.",
    details: `query=${queryName}; step=${currentStep}; batch_id=${selectedImportBatchId ?? "unknown"}`,
  };
}

type CoreActivatedStockBatch = {
  id?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  rows_imported?: number | null;
  report_type?: string | null;
  latest_error?: string | null;
  last_error?: string | null;
  detected_min_datetime?: string | null;
  detected_max_datetime?: string | null;
};

function batchMutationReturnedRow<T>(value: VmsBatchMutationResponse<T> | undefined) {
  const data = value?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return typeof (data as { id?: unknown }).id === "string" && String((data as { id?: unknown }).id ?? "").trim().length > 0;
}

function removeMissingOptionalBatchColumn(payload: Record<string, unknown>, error: unknown) {
  const column = missingColumnName(error);
  if (!column || !Object.prototype.hasOwnProperty.call(payload, column) || !isOptionalVmsImportBatchMetadataField(column)) return null;
  const nextPayload = { ...payload };
  delete nextPayload[column];
  return { column, payload: nextPayload };
}

async function runVmsImportBatchMutationWithMetadataFallback<T>({
  queryName,
  currentStep,
  selectedImportBatchId,
  payload,
  run,
}: {
  queryName: string;
  currentStep: string;
  selectedImportBatchId?: string | null;
  payload: Record<string, unknown>;
  run: (payload: Record<string, unknown>) => PromiseLike<VmsBatchMutationResponse<T>>;
}): Promise<VmsBatchMutationResult<T>> {
  let activePayload = sanitizeVmsImportBatchPayload(payload, { queryName, currentStep, selectedImportBatchId });
  const droppedOptionalColumns: string[] = [];

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await withSoftTimeout(run(activePayload), VMS_SAVE_QUERY_TIMEOUT_MS);
    if (result.timedOut) return { timedOut: true, payload: activePayload, droppedOptionalColumns };
    if ("error" in result) {
      const fallback = removeMissingOptionalBatchColumn(activePayload, result.error);
      if (fallback) {
        activePayload = fallback.payload;
        droppedOptionalColumns.push(fallback.column);
        console.warn("[vms-import] Retrying vms_import_batches mutation without optional metadata column", {
          queryName,
          currentStep,
          selectedImportBatchId: selectedImportBatchId ?? null,
          missingColumn: fallback.column,
        });
        continue;
      }
      return { timedOut: false, error: result.error, payload: activePayload, droppedOptionalColumns };
    }

    const value = result.value;
    if (value?.error) {
      const fallback = removeMissingOptionalBatchColumn(activePayload, value.error);
      if (fallback) {
        activePayload = fallback.payload;
        droppedOptionalColumns.push(fallback.column);
        console.warn("[vms-import] Retrying vms_import_batches mutation without optional metadata column", {
          queryName,
          currentStep,
          selectedImportBatchId: selectedImportBatchId ?? null,
          missingColumn: fallback.column,
        });
        continue;
      }
    }

    return { timedOut: false, value, payload: activePayload, droppedOptionalColumns };
  }

  return {
    timedOut: false,
    error: { code: "MISSING_SCHEMA", message: "Too many optional VMS import batch metadata columns are missing." },
    payload: activePayload,
    droppedOptionalColumns,
  };
}

async function activateStockBatchWithCoreMetadata({
  supabase,
  batchId,
  reportType,
  actorId,
  rowsFound,
  rowCount,
  rowsImported,
  detectedMinDatetime,
  detectedMaxDatetime,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchId: string;
  reportType: VmsReportType;
  actorId: string | null;
  rowsFound: number;
  rowCount: number;
  rowsImported: number;
  detectedMinDatetime: string | null;
  detectedMaxDatetime: string | null;
}) {
  const now = new Date().toISOString();
  const normalizedReportType = canonicalImportedReportType(reportType);
  const corePayload = {
    status: "imported",
    is_active: true,
    report_type: normalizedReportType,
    imported_by: actorId,
    imported_at: now,
    updated_at: now,
    rows_found: rowsFound,
    row_count: rowCount,
    rows_imported: rowsImported,
    detected_min_datetime: detectedMinDatetime,
    detected_max_datetime: detectedMaxDatetime,
    latest_error: null,
    last_error: null,
  };

  const updateResult = await withSoftTimeout(
    supabase
      .from("vms_import_batches")
      .update(corePayload)
      .eq("id", batchId),
    VMS_SAVE_QUERY_TIMEOUT_MS,
  );

  if (updateResult.timedOut) {
    return {
      ok: false as const,
      error: { code: "TIMEOUT", message: "Core stock batch activation timed out." },
      payload: corePayload,
      batch: null,
    };
  }

  if ("error" in updateResult) {
    return {
      ok: false as const,
      error: updateResult.error,
      payload: corePayload,
      batch: null,
    };
  }

  if (updateResult.value?.error) {
    return {
      ok: false as const,
      error: updateResult.value.error,
      payload: corePayload,
      batch: null,
    };
  }

  const verificationResult = await supabase
    .from("vms_import_batches")
    .select("id, status, is_active, rows_imported, report_type, latest_error, last_error, detected_min_datetime, detected_max_datetime")
    .eq("id", batchId)
    .maybeSingle();

  if (verificationResult.error) {
    return {
      ok: false as const,
      error: verificationResult.error,
      payload: corePayload,
      batch: null,
    };
  }

  return {
    ok: true as const,
    error: null,
    payload: corePayload,
    batch: (verificationResult.data ?? null) as CoreActivatedStockBatch | null,
  };
}

type CoreActivatedOrderDetailsBatch = {
  id?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  rows_imported?: number | null;
  report_type?: string | null;
};

async function activateOrderDetailsBatchWithCoreMetadata({
  supabase,
  batchId,
  actorId,
  rowsFound,
  rowCount,
  rowsImported,
  reportStartDate = null,
  reportEndDate = null,
  detectedMinDatetime = null,
  detectedMaxDatetime = null,
  successfulRowsCount = null,
  failedRowsCount = null,
  refundedRowsCount = null,
  totalSuccessfulSales = null,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchId: string;
  actorId: string | null;
  rowsFound: number;
  rowCount: number;
  rowsImported: number;
  reportStartDate?: string | null;
  reportEndDate?: string | null;
  detectedMinDatetime?: string | null;
  detectedMaxDatetime?: string | null;
  successfulRowsCount?: number | null;
  failedRowsCount?: number | null;
  refundedRowsCount?: number | null;
  totalSuccessfulSales?: number | null;
}) {
  const now = new Date().toISOString();
  const corePayload = {
    status: "imported",
    is_active: true,
    report_type: "vms_order_details_weekly",
    imported_by: actorId,
    imported_at: now,
    updated_at: now,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    disabled_at: null,
    disabled_by: null,
    disable_reason: null,
    rows_found: rowsFound,
    row_count: rowCount,
    rows_imported: rowsImported,
    report_start_date: reportStartDate,
    report_end_date: reportEndDate,
    detected_min_datetime: detectedMinDatetime,
    detected_max_datetime: detectedMaxDatetime,
    successful_rows_count: successfulRowsCount ?? rowsImported,
    failed_rows_count: failedRowsCount ?? 0,
    refunded_rows_count: refundedRowsCount ?? 0,
    total_successful_sales: totalSuccessfulSales ?? 0,
    latest_error: null,
    last_error: null,
  };

  const updateResult = await withSoftTimeout(
    supabase
      .from("vms_import_batches")
      .update(corePayload)
      .eq("id", batchId),
    VMS_SAVE_QUERY_TIMEOUT_MS,
  );

  if (updateResult.timedOut) {
    return {
      ok: false as const,
      error: { code: "TIMEOUT", message: "Core Order Details batch activation timed out." },
      payload: corePayload,
      batch: null,
    };
  }

  if ("error" in updateResult) {
    return {
      ok: false as const,
      error: updateResult.error,
      payload: corePayload,
      batch: null,
    };
  }

  if (updateResult.value?.error) {
    return {
      ok: false as const,
      error: updateResult.value.error,
      payload: corePayload,
      batch: null,
    };
  }

  const verificationResult = await supabase
    .from("vms_import_batches")
    .select("id, status, is_active, rows_imported, report_type")
    .eq("id", batchId)
    .maybeSingle();

  if (verificationResult.error) {
    return {
      ok: false as const,
      error: verificationResult.error,
      payload: corePayload,
      batch: null,
    };
  }

  return {
    ok: true as const,
    error: null,
    payload: corePayload,
    batch: (verificationResult.data ?? null) as CoreActivatedOrderDetailsBatch | null,
  };
}

type OrderDetailsRestoreConflictBatch = {
  id?: string | null;
  file_name?: string | null;
  original_file_name?: string | null;
  file_hash?: string | null;
  report_start_date?: string | null;
  report_end_date?: string | null;
};

async function findActiveOrderDetailsRestoreConflict({
  supabase,
  batchId,
  batch,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchId: string;
  batch: Record<string, unknown>;
}) {
  const fileHash = textValue(batch.file_hash);
  const reportStartDate = textValue(batch.report_start_date);
  const reportEndDate = textValue(batch.report_end_date);
  let query = supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, file_hash, status, is_active, deleted_at, report_start_date, report_end_date")
    .eq("report_type", "vms_order_details_weekly")
    .neq("id", batchId)
    .in("status", ["imported", "imported_with_warnings", "partially_imported"])
    .eq("is_active", true)
    .is("deleted_at", null);

  if (fileHash) {
    query = query.eq("file_hash", fileHash);
  } else if (reportStartDate || reportEndDate) {
    if (reportStartDate) query = query.eq("report_start_date", reportStartDate);
    if (reportEndDate) query = query.eq("report_end_date", reportEndDate);
  } else {
    return null;
  }

  const { data, error } = await query.limit(1);
  if (error) {
    return { error } as const;
  }

  return { conflict: ((data ?? []) as OrderDetailsRestoreConflictBatch[])[0] ?? null } as const;
}

async function ensureConfirmedOrderDetailsImportBatchIsUsable({
  supabase,
  profile,
  batchId,
  reportType,
  summary,
  reportStartDate,
  reportEndDate,
  detectedMinDatetime,
  detectedMaxDatetime,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  batchId: string;
  reportType: VmsReportType;
  summary: ImportSummary;
  reportStartDate: string | null;
  reportEndDate: string | null;
  detectedMinDatetime: string | null;
  detectedMaxDatetime: string | null;
}) {
  if (reportType !== "vms_order_details_weekly") return true;

  const persistedOrderDetailsSummary = await loadPersistedOrderDetailsBatchSummary({ supabase, batchId });
  if (persistedOrderDetailsSummary.error) {
    console.warn("[vms-import] Could not count persisted detailed rows during confirm postcondition check", {
      batchId,
      reportType,
      error: persistedOrderDetailsSummary.error,
    });
  }

  const effectiveImportedRows = persistedOrderDetailsSummary.rowCount > 0 ? persistedOrderDetailsSummary.rowCount : summary.importedRows;
  if (effectiveImportedRows <= 0) return true;

  const { data: currentBatch, error: currentBatchError } = await supabase
    .from("vms_import_batches")
    .select("id, status, is_active, rows_imported")
    .eq("id", batchId)
    .maybeSingle();

  if (currentBatchError || !currentBatch?.id) {
    console.warn("[vms-import] Could not verify final Order Details batch usability after confirm", {
      batchId,
      reportType,
      error: currentBatchError,
    });
    return false;
  }

  const currentStatus = String(currentBatch.status ?? "").trim().toLowerCase();
  const currentRowsImported = wholeNumberValue(currentBatch.rows_imported);
  const usableStatus = currentStatus === "imported" || currentStatus === "imported_with_warnings";
  const isUsable = usableStatus && currentBatch.is_active !== false && currentRowsImported > 0;
  if (isUsable) return true;

  console.warn("[vms-import] Repairing Order Details batch metadata after confirm because the final state is not usable", {
    batchId,
    reportType,
    currentStatus,
    isActive: currentBatch.is_active ?? null,
    currentRowsImported,
    expectedRowsImported: effectiveImportedRows,
  });

  const actorId = profile?.team_member_id ?? profile?.id ?? null;
  const now = new Date().toISOString();
  const recoveredWarning = `Recovered Order Details import metadata after confirm because the batch was left in ${currentStatus || "an unusable"} state.`;
  const nextErrors = summary.errors.includes(recoveredWarning) ? summary.errors : [...summary.errors, recoveredWarning];
  const rowsFound = Math.max(summary.rowsFound, effectiveImportedRows);
  const rowCount = Math.max(summary.rowsFound, summary.totalRows, effectiveImportedRows);
  const repairedDetectedMinDatetime = persistedOrderDetailsSummary.detectedMinDatetime || detectedMinDatetime || null;
  const repairedDetectedMaxDatetime = persistedOrderDetailsSummary.detectedMaxDatetime || detectedMaxDatetime || repairedDetectedMinDatetime;
  const repairedReportStartDate = persistedOrderDetailsSummary.businessDateStart || reportStartDate || null;
  const repairedReportEndDate = persistedOrderDetailsSummary.businessDateEnd || reportEndDate || repairedReportStartDate;
  const repairPayload = {
    status: "imported",
    is_active: true,
    imported_by: actorId,
    imported_at: now,
    report_type: "vms_order_details_weekly",
    updated_at: now,
    source_usage: vmsSourceUsage("vms_order_details_weekly"),
    dashboard_usage: vmsSourceUsage("vms_order_details_weekly"),
    rows_found: rowsFound,
    row_count: rowCount,
    rows_imported: effectiveImportedRows,
    rows_skipped: summary.skippedRows,
    rows_skipped_duplicate: summary.rowsSkippedDuplicate,
    rows_needing_review: summary.rowsNeedingReview,
    error_count: nextErrors.length,
    errors: nextErrors,
    latest_error: null,
    last_error: null,
    report_start_date: repairedReportStartDate,
    report_end_date: repairedReportEndDate,
    detected_min_datetime: repairedDetectedMinDatetime,
    detected_max_datetime: repairedDetectedMaxDatetime,
    total_successful_sales: persistedOrderDetailsSummary.totalSuccessfulSales,
    successful_rows_count: persistedOrderDetailsSummary.successfulRowsCount,
    failed_rows_count: persistedOrderDetailsSummary.failedRowsCount,
    refunded_rows_count: persistedOrderDetailsSummary.refundedRowsCount,
    notes: JSON.stringify({
      ...summary,
      status: "imported",
      errors: nextErrors,
      postconditionRepair: {
        repaired_at: now,
        previous_status: currentStatus || null,
        previous_is_active: currentBatch.is_active ?? null,
        previous_rows_imported: currentRowsImported,
        recovered_rows_imported: effectiveImportedRows,
      },
    }),
  };

  const repairResult = await runVmsImportBatchMutationWithMetadataFallback({
    queryName: "vms_import_batches.update.confirm_order_details_postcondition",
    currentStep: "confirm_import",
    selectedImportBatchId: batchId,
    payload: repairPayload,
    run: (payload) => supabase
      .from("vms_import_batches")
      .update(payload)
      .eq("id", batchId)
      .select("id, status, is_active, rows_imported")
      .maybeSingle(),
  });

  const repairProblem = repairResult.timedOut
    ? { code: "TIMEOUT", message: "Order Details import postcondition repair timed out." }
    : repairResult.error
      ?? repairResult.value?.error
      ?? (!batchMutationReturnedRow(repairResult.value)
        ? missingBatchMutationRowError({
            queryName: "vms_import_batches.update.confirm_order_details_postcondition",
            currentStep: "confirm_import",
            selectedImportBatchId: batchId,
          })
        : null);

  if (repairProblem) {
    logVmsBatchMutationFailure({
      queryName: "vms_import_batches.update.confirm_order_details_postcondition",
      error: repairProblem,
      payload: repairResult.payload,
      profile,
      selectedImportBatchId: batchId,
      currentStep: "confirm_import",
    });

    const fallbackActivation = await activateOrderDetailsBatchWithCoreMetadata({
      supabase,
      batchId,
      actorId,
      rowsFound,
      rowCount,
      rowsImported: effectiveImportedRows,
      reportStartDate,
      reportEndDate,
      detectedMinDatetime,
      detectedMaxDatetime,
      successfulRowsCount: persistedOrderDetailsSummary.successfulRowsCount,
      failedRowsCount: persistedOrderDetailsSummary.failedRowsCount,
      refundedRowsCount: persistedOrderDetailsSummary.refundedRowsCount,
      totalSuccessfulSales: persistedOrderDetailsSummary.totalSuccessfulSales,
    });

    if (!fallbackActivation.ok) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.update.confirm_order_details_postcondition.minimal_activation",
        error: fallbackActivation.error,
        payload: fallbackActivation.payload,
        profile,
        selectedImportBatchId: batchId,
        currentStep: "confirm_import",
      });
      return false;
    }
  }

  return true;
}

function logVmsBatchMutationFailure({
  queryName,
  error,
  payload,
  profile,
  selectedImportBatchId,
  currentStep,
}: {
  queryName: string;
  error: unknown;
  payload?: unknown;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  selectedImportBatchId?: string | null;
  currentStep: string;
}) {
  const supabaseError = supabaseMutationError(error);
  console.error("[vms-import] VMS import batch mutation failed", {
    queryName,
    code: supabaseError?.code,
    message: supabaseError?.message,
    details: supabaseError?.details,
    hint: supabaseError?.hint,
    schemaIssue: extractVmsSchemaIssue(error, queryName),
    payload,
    currentUserId: profile?.id ?? profile?.team_member_id ?? null,
    sessionExists: Boolean(profile),
    effectivePermissions: profile ? getEffectivePermissions(profile) : [],
    selectedImportBatchId: selectedImportBatchId ?? null,
    currentStep,
  });
}

function previewDebugContext({
  file,
  parsed,
  reportType,
  batchId,
  currentUserId,
  effectivePermissions,
}: {
  file: File;
  parsed?: { fileType: string; sheets: VmsPreviewSheetPayload[] } | null;
  reportType?: VmsReportType | "custom" | null;
  batchId?: string | null;
  currentUserId?: string | null;
  effectivePermissions?: string[];
}) {
  const firstSheet = parsed?.sheets?.[0] ?? null;
  const detectedHeaderRowIndex = firstSheet ? detectHeaderRowIndex(firstSheet.rows, reportType && reportType !== "custom" ? reportType : undefined) : null;
  const headerRow = detectedHeaderRowIndex !== null && firstSheet ? firstSheet.rows[detectedHeaderRowIndex] ?? [] : [];
  const normalizedHeaderCounts = new Map<string, number>();
  headerRow.forEach((header) => {
    const normalized = normalizeHeader(String(header ?? ""));
    if (normalized) normalizedHeaderCounts.set(normalized, (normalizedHeaderCounts.get(normalized) ?? 0) + 1);
  });
  return {
    fileName: file.name,
    fileType: parsed?.fileType ?? file.name.split(".").pop()?.toLowerCase() ?? null,
    fileSize: file.size,
    detectedReportType: reportType ?? null,
    detectedHeaderRowIndex,
    headersFound: headerRow,
    duplicateHeadersFound: [...normalizedHeaderCounts.entries()].filter(([, count]) => count > 1).map(([header]) => header),
    rowsParsedCount: parsed?.sheets?.reduce((sum, sheet) => sum + sheet.rows.length, 0) ?? 0,
    importBatchId: batchId ?? null,
    currentUserId: currentUserId ?? null,
    effectivePermissions: effectivePermissions ?? [],
  };
}

function detectPreviewImportDateRange(parsed: { sheets: VmsPreviewSheetPayload[] }, reportType: VmsReportType) {
  if (reportType !== "vms_order_details_weekly") return { start: null as string | null, end: null as string | null };

  for (const sheet of parsed.sheets) {
    const records = sheetRowsToRecords(sheet.rows, { reportType }).records;
    const range = detectOrderDetailsDateRange(records);
    if (range.start && range.end) return { start: range.start, end: range.end };
  }

  return { start: null as string | null, end: null as string | null };
}

async function createPreviewImportBatch({
  supabase,
  profile,
  file,
  parsed,
  reportType,
  fileHash,
  storageBucket,
  storagePath,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  file: File;
  parsed: { fileType: string; sheets: VmsPreviewSheetPayload[] };
  reportType: VmsReportType;
  fileHash: string | null;
  storageBucket: string | null;
  storagePath: string | null;
}) {
  const rowsFound = parsed.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  // Validate basic invariants before creating a DB batch record
  if (!file?.name) {
    console.error("[vms-import] Refusing to create preview batch: missing file name", {
      queryName: "vms_import_batches.insert.rich_preview.validate",
      currentUserId: profile?.id ?? profile?.team_member_id ?? null,
      rowsFound,
    });
    return { id: null, error: { code: "BAD_INPUT", message: "Missing file name; aborting preview batch creation." }, warning: null as string | null };
  }
  if (!profile?.team_member_id && !profile?.id) {
    console.error("[vms-import] Refusing to create preview batch: missing uploader identity", {
      queryName: "vms_import_batches.insert.rich_preview.validate",
      fileName: file.name,
      rowsFound,
    });
    return { id: null, error: { code: "BAD_INPUT", message: "Missing uploader identity; aborting preview batch creation." }, warning: null as string | null };
  }
  if (rowsFound === 0) {
    console.error("[vms-import] Refusing to create preview batch: parsed file contained zero rows", {
      queryName: "vms_import_batches.insert.rich_preview.validate",
      fileName: file.name,
      currentUserId: profile?.id ?? profile?.team_member_id ?? null,
    });
    return { id: null, error: { code: "NO_ROWS", message: "Parsed VMS file contains no rows; aborting preview batch creation." }, warning: null as string | null };
  }
  // Ensure required VMS import tables exist before creating a preview batch.
  const missing = await checkVmsRequiredTables(supabase, reportType, "preview");
  if (missing.length) {
    console.error("[vms-import] Refusing to create preview batch: missing required vms tables", {
      queryName: "vms_import_batches.insert.rich_preview.validate",
      missing,
      fileName: file?.name ?? null,
      currentUserId: profile?.id ?? profile?.team_member_id ?? null,
    });
    return { id: null, error: { code: "MISSING_SCHEMA", message: requiredTablesMessage(missing, reportType, "preview") }, warning: null as string | null };
  }
  const dateRange = detectPreviewImportDateRange(parsed, reportType);
  const basePayload = {
    file_name: file.name,
    report_type: reportType,
    uploaded_by: profile?.team_member_id ?? null,
    uploaded_at: new Date().toISOString(),
    status: "previewed",
    rows_found: rowsFound,
    report_start_date: dateRange.start,
    report_end_date: dateRange.end,
    rows_imported: 0,
    rows_skipped_duplicate: 0,
    rows_needing_review: 0,
    notes: JSON.stringify({
      reportType,
      fileName: file.name,
      fileType: parsed.fileType,
      sheetName: parsed.sheets[0]?.name ?? null,
      rowsFound,
      previewOnly: true,
    }),
  };
  const richPayload = {
    ...basePayload,
    is_active: false,
    source_usage: vmsSourceUsage(reportType),
    dashboard_usage: vmsSourceUsage(reportType),
    latest_error: null,
    file_hash: fileHash,
    storage_path: storagePath,
    detected_min_datetime: dateRange.start ? startOfDateIso(dateRange.start) : null,
    detected_max_datetime: dateRange.end ? endOfDateIso(dateRange.end) : null,
    parse_diagnostics: {
      reportType,
      fileType: parsed.fileType,
      sheetCount: parsed.sheets.length,
      rowsFound,
      detectedDateRange: dateRange,
    },
  };

  const richResult = await runVmsImportBatchMutationWithMetadataFallback<{ id: string }>({
    queryName: "vms_import_batches.insert.rich_preview",
    currentStep: "create_preview_batch",
    selectedImportBatchId: null,
    payload: richPayload,
    run: (payload) => supabase.from("vms_import_batches").insert(payload).select("id").single(),
  });
  if (richResult.timedOut) {
    return {
      id: null,
      error: { code: "TIMEOUT", message: "VMS import batch save took too long. Please check your connection and retry." },
      warning: null as string | null,
    };
  }
  if (richResult.error) {
    return { id: null, error: richResult.error, warning: null as string | null };
  }
  const rich = richResult.value;
  if (!rich?.error && rich?.data?.id) {
    const warning = richResult.droppedOptionalColumns.length
      ? `VMS import batch metadata columns need the latest migration: ${richResult.droppedOptionalColumns.join(", ")}. Import preview can continue.`
      : null;
    return { id: String(rich.data.id), warning };
  }
  console.error("[vms-import] Preview batch rich insert failed", {
    queryName: "vms_import_batches.insert.rich_preview",
    code: supabaseMutationError(rich?.error)?.code,
    message: supabaseMutationError(rich?.error)?.message,
    details: supabaseMutationError(rich?.error)?.details,
    hint: supabaseMutationError(rich?.error)?.hint,
  });

  if (isMissingColumnPreviewError(rich?.error)) {
    console.error("[vms-import] Preview batch insert failed because a required batch column is missing", {
      queryName: "vms_import_batches.insert.rich_preview",
      schemaIssue: extractVmsSchemaIssue(rich?.error, "vms_import_batches.insert.rich_preview"),
      fileName: file.name,
      reportType,
      rowsFound,
    });
  }
  return {
    id: null,
    error: rich?.error ?? { code: "UNKNOWN", message: "VMS import batch insert returned no id." },
    warning: null as string | null,
  };
}

async function saveVmsPreviewRows({
  supabase,
  previewId,
  batchId,
  sheets,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  previewId: string;
  batchId: string | null;
  sheets: VmsPreviewSheetPayload[];
}) {
  const rows: Array<{
    preview_id: string;
    import_batch_id: string | null;
    sheet_name: string;
    row_number: number;
    raw_row: string[];
    normalized_row: Record<string, never>;
    status: "pending";
  }> = [];
  const totalRows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);

  for (const sheet of sheets) {
    for (const [index, row] of sheet.rows.entries()) {
      if (rows.length >= VMS_PREVIEW_ROW_INSERT_LIMIT) break;
      rows.push({
        preview_id: previewId,
        import_batch_id: batchId,
        sheet_name: sheet.name,
        row_number: index + 1,
        raw_row: row,
        normalized_row: {},
        status: "pending",
      });
    }
    if (rows.length >= VMS_PREVIEW_ROW_INSERT_LIMIT) break;
  }
  if (!rows.length) return;

  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    const insertResult = await withSoftTimeout(
      supabase.from("vms_import_preview_rows").insert(chunk),
      VMS_SAVE_QUERY_TIMEOUT_MS,
    );
    if (insertResult.timedOut) {
      console.error("[vms-import] Preview row insert timed out", {
        queryName: "vms_import_preview_rows.insert",
        previewId,
        importBatchId: batchId,
        chunkStart: index,
        chunkSize: chunk.length,
        timeoutMs: VMS_SAVE_QUERY_TIMEOUT_MS,
      });
      redirect(`/vms-import?error=${encodeURIComponent("Save took too long. Please check your connection and retry.")}`);
    }
    if ("error" in insertResult) {
      console.error("[vms-import] Preview row insert threw", {
        queryName: "vms_import_preview_rows.insert",
        previewId,
        importBatchId: batchId,
        chunkStart: index,
        chunkSize: chunk.length,
        error: insertResult.error instanceof Error ? insertResult.error.message : String(insertResult.error),
      });
      redirect(`/vms-import?error=${encodeURIComponent("Could not save VMS preview rows. Please retry.")}`);
    }
    const { error } = insertResult.value;
    if (!error) continue;

    if (isMissingPreviewRowsSchemaError(error)) {
      console.warn("[vms-import] Preview row rich insert failed; trying legacy preview row shape", {
        queryName: "vms_import_preview_rows.insert.rich",
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      const legacyChunk = chunk.map((row) => ({
        preview_id: row.preview_id,
        sheet_name: row.sheet_name,
        row_number: row.row_number,
        raw_row: row.raw_row,
      }));
      const legacyResult = await withSoftTimeout(
        supabase.from("vms_import_preview_rows").insert(legacyChunk),
        VMS_SAVE_QUERY_TIMEOUT_MS,
      );
      if (legacyResult.timedOut) {
        console.error("[vms-import] Legacy preview row insert timed out", {
          queryName: "vms_import_preview_rows.insert.legacy",
          previewId,
          importBatchId: batchId,
          chunkStart: index,
          chunkSize: legacyChunk.length,
          timeoutMs: VMS_SAVE_QUERY_TIMEOUT_MS,
        });
        redirect(`/vms-import?error=${encodeURIComponent("Save took too long. Please check your connection and retry.")}`);
      }
      if ("error" in legacyResult) {
        console.error("[vms-import] Legacy preview row insert threw", {
          queryName: "vms_import_preview_rows.insert.legacy",
          previewId,
          importBatchId: batchId,
          chunkStart: index,
          chunkSize: legacyChunk.length,
          error: legacyResult.error instanceof Error ? legacyResult.error.message : String(legacyResult.error),
        });
        redirect(`/vms-import?error=${encodeURIComponent("Could not save VMS preview rows. Please retry.")}`);
      }
      const legacy = legacyResult.value;
      if (!legacy.error) continue;
      console.error("[vms-import] Legacy preview row insert failed", {
        queryName: "vms_import_preview_rows.insert.legacy",
        code: legacy.error.code,
        message: legacy.error.message,
        details: legacy.error.details,
        hint: legacy.error.hint,
      });
      redirect(`/vms-import?error=${encodeURIComponent(previewErrorMessage(legacy.error, "Preview rows"))}`);
    }

    console.error("[vms-import] Failed to save preview rows", {
      queryName: "vms_import_preview_rows.insert",
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    redirect(`/vms-import?error=${encodeURIComponent(previewErrorMessage(error, "Preview rows"))}`);
  }

  console.info("[vms-import] Saved VMS preview rows", {
    queryName: "vms_import_preview_rows.insert",
    previewId,
    importBatchId: batchId,
    rowsInserted: rows.length,
    totalRowsAvailable: totalRows,
    capped: totalRows > rows.length,
  });
}

export async function prepareVmsImport(formData: FormData) {
  const previewStartedAt = Date.now();
  const profile = await getCurrentProfile();
  if (!profile || !canCreateVmsImports(profile)) redirect("/unauthorized");
  const effectivePermissions = getEffectivePermissions(profile);
  const currentUserId = profile.id ?? profile.team_member_id ?? null;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const requestedReportType = parseReportType(formData.get("report_type") || formData.get("import_type"));
  let reportType = requestedReportType ?? "custom";
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/vms-import?error=Upload%20a%20VMS%20Excel%20or%20CSV%20file.");

  let parsed: Awaited<ReturnType<typeof parseVmsUpload>>;
  try {
    console.info("[vms-import] Reading uploaded VMS file", {
      queryName: "parseVmsUpload",
      fileName: file.name,
      fileType: file.name.split(".").pop()?.toLowerCase() ?? null,
      fileSize: file.size,
      currentUserId,
      effectivePermissions,
    });
    parsed = await parseVmsUpload(file);
    console.info("[vms-import] File parsed for preview", {
      queryName: "parseVmsUpload",
      fileName: file.name,
      elapsedMs: Date.now() - previewStartedAt,
    });
  } catch (error) {
    console.error("[vms-import] File read or workbook parsing failed", {
      queryName: "parseVmsUpload",
      fileName: file.name,
      fileType: file.name.split(".").pop()?.toLowerCase() ?? null,
      fileSize: file.size,
      currentUserId,
      effectivePermissions,
      error: error instanceof Error ? error.message : String(error),
    });
    redirect(`/vms-import?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not parse VMS file.")}`);
  }
  const rowsParsedCount = parsed.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  if (!parsed.sheets.length || rowsParsedCount === 0) {
    console.warn("[vms-import] Parsed VMS file contained no rows", {
      ...previewDebugContext({ file, parsed, reportType, currentUserId, effectivePermissions }),
      queryName: "parseVmsUpload",
    });
    redirect("/vms-import?error=No%20VMS%20rows%20found%20in%20this%20file.%20Please%20check%20that%20the%20file%20contains%20exported%20VMS%20data.");
  }

  const detectedReportType = parsed.sheets.map((sheet) => detectVmsReportTypeFromRows(sheet.rows)).find(Boolean) ?? null;
  if (!requestedReportType && detectedReportType) reportType = detectedReportType;
  const debugContext = previewDebugContext({ file, parsed, reportType, currentUserId, effectivePermissions });
  console.info("[vms-import] Parsed VMS file for preview", {
    ...debugContext,
    queryName: "loadVmsPreviewFile",
    requestedReportType: requestedReportType ?? null,
    detectedReportType,
    sheetCount: parsed.sheets.length,
  });

  // Additional detailed diagnostics requested for traceability
  const firstSheet = parsed.sheets[0];
  const detectedHeaderRowIndex = firstSheet ? detectHeaderRowIndex(firstSheet.rows, reportType && reportType !== "custom" ? reportType : undefined) : null;
  const detectedHeaders = detectedHeaderRowIndex !== null && firstSheet ? (firstSheet.rows[detectedHeaderRowIndex] ?? []).map(String) : [];
  const parsedRowsCount = parsed.sheets.reduce((sum, s) => sum + s.rows.length, 0);
  console.info("[vms-import] Parse diagnostics", {
    queryName: "prepareVmsImport.parse_diagnostics",
    fileName: file.name,
    fileSize: file.size,
    detectedHeaders: detectedHeaders.slice(0, 20),
    detectedHeadersCount: detectedHeaders.length,
    parsedRowsCount,
    detectedReportType,
    currentUserId,
  });

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(fileBuffer).digest("hex");
  console.info("[vms-import] VMS file hash prepared", {
    queryName: "prepareVmsImport.hash_file",
    fileName: file.name,
    fileSize: file.size,
    elapsedMs: Date.now() - previewStartedAt,
  });
  const storageBucket = "vms-imports";
  const storagePath = `${profile.team_member_id ?? profile.id ?? "unknown"}/${Date.now()}-${fileHash.slice(0, 12)}-${safeStorageFileName(file.name)}`;
  let savedStoragePath: string | null = null;
  if (reportType !== "vms_order_details_weekly") {
    console.info("[vms-import] Original file storage skipped for fast preview", {
      queryName: "storage.vms_imports.upload.skipped",
      fileName: file.name,
      reportType,
      fileHash,
      elapsedMs: Date.now() - previewStartedAt,
    });
  } else {
    const uploadResult = await withSoftTimeout(
      supabase.storage
        .from(storageBucket)
        .upload(storagePath, fileBuffer, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        }),
      VMS_ORIGINAL_FILE_UPLOAD_SOFT_TIMEOUT_MS,
    );
    if (uploadResult.timedOut) {
      console.warn("[vms-import] Original file storage upload timed out; continuing without download reference", {
        queryName: "storage.vms_imports.upload",
        fileName: file.name,
        fileHash,
        timeoutMs: VMS_ORIGINAL_FILE_UPLOAD_SOFT_TIMEOUT_MS,
        elapsedMs: Date.now() - previewStartedAt,
      });
    } else if ("error" in uploadResult) {
      console.warn("[vms-import] Original file storage upload threw; continuing without download reference", {
        queryName: "storage.vms_imports.upload",
        fileName: file.name,
        fileHash,
        error: uploadResult.error instanceof Error ? uploadResult.error.message : String(uploadResult.error),
        elapsedMs: Date.now() - previewStartedAt,
      });
    } else if (uploadResult.value.error) {
      console.warn("[vms-import] Original file storage upload failed; continuing without download reference", {
        queryName: "storage.vms_imports.upload",
        fileName: file.name,
        fileHash,
        errorCode: uploadResult.value.error.name,
        errorMessage: uploadResult.value.error.message,
        elapsedMs: Date.now() - previewStartedAt,
      });
    } else {
      savedStoragePath = storagePath;
      console.info("[vms-import] Original file stored for audit", {
        queryName: "storage.vms_imports.upload",
        fileName: file.name,
        storageBucket,
        storagePath,
        elapsedMs: Date.now() - previewStartedAt,
      });
    }
  }

  const batchResult = await createPreviewImportBatch({
    supabase,
    profile,
    file,
    parsed,
    reportType,
    fileHash,
    storageBucket: savedStoragePath ? storageBucket : null,
    storagePath: savedStoragePath,
  });

  if (!batchResult.id) {
    const batchError = ("error" in batchResult ? batchResult.error : null) as { code?: string; message?: string; details?: string; hint?: string } | null;
    console.error("[vms-import] Failed to create preview import batch", {
      ...previewDebugContext({ file, parsed, reportType, batchId: null, currentUserId, effectivePermissions }),
      queryName: "vms_import_batches.insert.preview",
      code: batchError?.code,
      message: batchError?.message,
      details: batchError?.details,
      hint: batchError?.hint,
    });
    redirect(`/vms-import?error=${encodeURIComponent(previewErrorMessage(batchError, "VMS import batches"))}`);
  }
  if (batchResult.warning) {
    console.warn("[vms-import] Preview batch created with schema warning", {
      queryName: "vms_import_batches.insert.preview",
      warning: batchResult.warning,
      importBatchId: batchResult.id,
    });
  }
  console.info("[vms-import] Preview import batch ready", {
    queryName: "vms_import_batches.insert.preview",
    importBatchId: batchResult.id,
    elapsedMs: Date.now() - previewStartedAt,
  });

  let previewId: string | null = null;
  const richPreviewPayload = {
    import_batch_id: batchResult.id,
    file_name: file.name,
    file_type: parsed.fileType,
    file_size_bytes: file.size,
    report_type: reportType,
    sheets: parsed.sheets,
    uploaded_by: profile.team_member_id,
    file_hash: fileHash,
    storage_bucket: savedStoragePath ? storageBucket : null,
    storage_path: savedStoragePath,
    original_file_name: file.name,
  };
  const previewInsertResult = await withSoftTimeout(
    supabase
      .from("vms_import_previews")
      .insert(richPreviewPayload)
      .select("id")
      .single(),
    VMS_SAVE_QUERY_TIMEOUT_MS,
  );

  if (previewInsertResult.timedOut) {
    console.error("[vms-import] Preview insert timed out", {
      ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
      queryName: "vms_import_previews.insert.rich",
      timeoutMs: VMS_SAVE_QUERY_TIMEOUT_MS,
    });
    redirect(`/vms-import?error=${encodeURIComponent("Save took too long. Please check your connection and retry.")}`);
  }
  if ("error" in previewInsertResult) {
    console.error("[vms-import] Preview insert threw", {
      ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
      queryName: "vms_import_previews.insert.rich",
      error: previewInsertResult.error instanceof Error ? previewInsertResult.error.message : String(previewInsertResult.error),
    });
    redirect(`/vms-import?error=${encodeURIComponent("Could not save VMS import preview. Please retry.")}`);
  }

  const previewInsert = previewInsertResult.value;

  if (!previewInsert.error && previewInsert.data?.id) {
    previewId = String(previewInsert.data.id);
    console.info("[vms-import] VMS import preview row created", {
      queryName: "vms_import_previews.insert.rich",
      previewId,
      importBatchId: batchResult.id,
      elapsedMs: Date.now() - previewStartedAt,
    });
  } else {
    console.error("[vms-import] Failed to create rich preview", {
      ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
      queryName: "vms_import_previews.insert.rich",
      code: previewInsert.error?.code,
      message: previewInsert.error?.message,
      details: previewInsert.error?.details,
      hint: previewInsert.error?.hint,
    });

    if (!isMissingColumnPreviewError(previewInsert.error)) {
      redirect(`/vms-import?error=${encodeURIComponent(previewErrorMessage(previewInsert.error, "VMS import previews"))}`);
    }

    const fallbackResult = await withSoftTimeout(
      supabase
        .from("vms_import_previews")
        .insert({
          file_name: file.name,
          file_type: parsed.fileType,
          report_type: reportType,
          sheets: parsed.sheets,
          uploaded_by: profile.team_member_id,
        })
        .select("id")
        .single(),
      VMS_SAVE_QUERY_TIMEOUT_MS,
    );
    if (fallbackResult.timedOut) {
      console.error("[vms-import] Legacy preview insert timed out", {
        ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
        queryName: "vms_import_previews.insert.legacy",
        timeoutMs: VMS_SAVE_QUERY_TIMEOUT_MS,
      });
      redirect(`/vms-import?error=${encodeURIComponent("Save took too long. Please check your connection and retry.")}`);
    }
    if ("error" in fallbackResult) {
      console.error("[vms-import] Legacy preview insert threw", {
        ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
        queryName: "vms_import_previews.insert.legacy",
        error: fallbackResult.error instanceof Error ? fallbackResult.error.message : String(fallbackResult.error),
      });
      redirect(`/vms-import?error=${encodeURIComponent("Could not save VMS import preview. Please retry.")}`);
    }
    const fallback = fallbackResult.value;
    if (fallback.error || !fallback.data?.id) {
      console.error("[vms-import] Failed to create legacy preview", {
        ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
        queryName: "vms_import_previews.insert.legacy",
        code: fallback.error?.code,
        message: fallback.error?.message,
        details: fallback.error?.details,
        hint: fallback.error?.hint,
      });
      redirect(`/vms-import?error=${encodeURIComponent(previewErrorMessage(fallback.error, "VMS import previews"))}`);
    }
    previewId = String(fallback.data.id);
    console.warn("[vms-import] Preview created with legacy schema", {
      queryName: "vms_import_previews.insert.legacy",
      importBatchId: batchResult.id,
      previewId,
      elapsedMs: Date.now() - previewStartedAt,
    });
  }

  if (!previewId) {
    console.error("[vms-import] Preview insert returned no id", {
      ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
      queryName: "vms_import_previews.insert",
    });
    redirect("/vms-import?error=VMS%20import%20preview%20failed%20because%20the%20preview%20insert%20returned%20no%20id.%20Technical%20details%20are%20in%20the%20server%20console.");
  }

  await saveVmsPreviewRows({
    supabase,
    previewId,
    batchId: batchResult.id,
    sheets: parsed.sheets,
  });

  console.info("[vms-import] Prepared VMS import preview", {
    ...previewDebugContext({ file, parsed, reportType, batchId: batchResult.id, currentUserId, effectivePermissions }),
    queryName: "prepareVmsImport",
    previewId,
    numberOfMappingsLoaded: null,
    numberOfProductsLoaded: null,
    elapsedMs: Date.now() - previewStartedAt,
  });

  // Include small parse diagnostics in the redirect so the UI can show them before confirmation
  const firstSheetName = parsed.sheets[0]?.name ?? "";
  const headerPreview = detectedHeaders.slice(0, 20).join(",");
  redirect(`/vms-import?previewId=${previewId}&importBatchId=${batchResult.id}&sheet=${encodeURIComponent(firstSheetName)}&reportType=${reportType}&step=5&rows=${parsedRowsCount}&headers=${encodeURIComponent(headerPreview)}&detected=${encodeURIComponent(String(detectedReportType))}&uid=${encodeURIComponent(String(currentUserId ?? ""))}`);
}

export async function importVmsCsv(formData: FormData) {
  return prepareVmsImport(formData);
}

export async function completeVmsImport(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const previewId = String(formData.get("preview_id") || "");
  const sheetName = String(formData.get("sheet_name") || "");
  const reportType = parseReportType(formData.get("report_type"));
  const headerRowRaw = Number(formData.get("header_row") ?? 0);
  const headerRowIndex = Number.isFinite(headerRowRaw) ? Math.max(0, Math.floor(headerRowRaw)) : 0;
  const autoCreateMissingProducts = booleanOption(formData.get("auto_create_products"), true);
  const updateCostFromVms = booleanOption(formData.get("update_cost_from_vms"), false);
  const importMode = parseVmsImportMode(formData.get("import_mode"));
  const effectiveImportMode = reportType === "vms_order_details_weekly" ? VMS_IMPORT_MODES.APPEND_NEW : importMode;
  const submittedReportStartDate = String(formData.get("report_start_date") || "").trim() || null;
  const submittedReportEndDate = String(formData.get("report_end_date") || "").trim() || null;
  const submittedImportBatchId = String(formData.get("import_batch_id") || formData.get("importBatchId") || "").trim() || undefined;
  if (!previewId || !sheetName || !reportType) redirect("/vms-import?error=Missing%20VMS%20import%20preview%20details.");

  const previewLookupResult = await withSoftTimeout(
    supabase.from("vms_import_previews").select("*").eq("id", previewId).maybeSingle(),
    VMS_SAVE_QUERY_TIMEOUT_MS,
  );
  if (previewLookupResult.timedOut) {
    const timeoutError = { code: "TIMEOUT", message: "VMS import preview lookup took too long." };
    logVmsBatchMutationFailure({
      queryName: "vms_import_previews.select.confirm",
      error: timeoutError,
      profile,
      selectedImportBatchId: submittedImportBatchId ?? null,
      currentStep: "confirm_import",
    });
    redirect(`/vms-import?error=${encodeURIComponent("Save took too long. Please check your connection and retry.")}`);
  }
  if ("error" in previewLookupResult) {
    logVmsBatchMutationFailure({
      queryName: "vms_import_previews.select.confirm",
      error: previewLookupResult.error,
      profile,
      selectedImportBatchId: submittedImportBatchId ?? null,
      currentStep: "confirm_import",
    });
    redirect(`/vms-import?error=${encodeURIComponent("Could not load the VMS import preview before confirming. Please contact admin.")}`);
  }
  const previewLookupValue = (!previewLookupResult.timedOut && Object.prototype.hasOwnProperty.call(previewLookupResult, 'value'))
    ? (previewLookupResult as any).value
    : null;
  const { data: preview, error: previewLookupError } = previewLookupValue ?? { data: null, error: null };
  if (previewLookupError) {
    logVmsBatchMutationFailure({
      queryName: "vms_import_previews.select.confirm",
      error: previewLookupError,
      profile,
      selectedImportBatchId: submittedImportBatchId ?? null,
      currentStep: "confirm_import",
    });
    redirect(`/vms-import?error=${encodeURIComponent(previewErrorMessage(previewLookupError, "VMS import previews"))}`);
  }
  if (!preview) redirect("/vms-import?error=VMS%20import%20preview%20not%20found.");
  let previewBatchId = submittedImportBatchId || String((preview as { import_batch_id?: string | null }).import_batch_id ?? "").trim() || undefined;

  const sheets = (preview.sheets ?? []) as { name: string; rows: string[][] }[];
  const sheet = sheets.find((candidate) => candidate.name === sheetName) ?? sheets[0];
  if (!sheet) redirect("/vms-import?error=Selected%20sheet%20was%20not%20found.");

  if (!previewBatchId) {
    const previewRowBatchResult = await withSoftTimeout(
      supabase
        .from("vms_import_preview_rows")
        .select("import_batch_id")
        .eq("preview_id", previewId)
        .not("import_batch_id", "is", null)
        .limit(1)
        .maybeSingle(),
      VMS_SAVE_QUERY_TIMEOUT_MS,
    );
    if (!previewRowBatchResult.timedOut && !("error" in previewRowBatchResult)) {
      const { data: previewRowBatch, error: previewRowBatchError } = previewRowBatchResult.value;
      if (!previewRowBatchError && previewRowBatch?.import_batch_id) {
        previewBatchId = String(previewRowBatch.import_batch_id);
      } else if (previewRowBatchError && !isMissingPreviewRowsSchemaError(previewRowBatchError)) {
        logVmsBatchMutationFailure({
          queryName: "vms_import_preview_rows.select.batch_link",
          error: previewRowBatchError,
          profile,
          selectedImportBatchId: null,
          currentStep: "confirm_import",
        });
      }
    } else {
      const linkLookupError = previewRowBatchResult.timedOut
        ? { code: "TIMEOUT", message: "VMS import preview row batch link lookup took too long." }
        : previewRowBatchResult.error;
      logVmsBatchMutationFailure({
        queryName: "vms_import_preview_rows.select.batch_link",
        error: linkLookupError,
        profile,
        selectedImportBatchId: null,
        currentStep: "confirm_import",
      });
    }
  }

  if (!previewBatchId) {
    console.error("[vms-import] Confirm import missing preview batch link", {
      queryName: "completeVmsImport.preview_batch_link",
      previewId,
      submittedImportBatchId: submittedImportBatchId ?? null,
      sheetName,
      reportType,
      currentUserId: profile.id ?? profile.team_member_id ?? null,
      effectivePermissions: getEffectivePermissions(profile),
    });
    await previewRedirect(
      formData,
      previewId,
      sheet.name,
      reportType,
      "VMS import preview is missing its import batch link. Re-upload the file after running the latest migration.",
      headerRowIndex,
    );
  }

  const mapping = readMapping(formData, reportType);
  const missing = requiredMissing(mapping, reportType);
  if (missing.length) await previewRedirect(formData, previewId, sheet.name, reportType, `Map required fields: ${missing.join(", ")}`, headerRowIndex, previewBatchId);

  const { headers, records } = sheetRowsToRecords(sheet.rows, { reportType, headerRowIndex });
  const rows = applyColumnMapping(records, mapping);
  if (!rows.length) await previewRedirect(formData, previewId, sheet.name, reportType, "Selected sheet has no data rows.", headerRowIndex, previewBatchId);
  const salesReportPeriod = reportType === "sales" || reportType === "monthly_product_profit"
    ? findSalesReportPeriod(sheet.rows, headerRowIndex)
    : null;
  if (reportType === "sales" && !salesReportPeriod && !hasSalesRowDate(rows)) {
    await previewRedirect(formData, previewId, sheet.name, reportType, VMS_SALES_DATE_RANGE_ERROR, headerRowIndex, previewBatchId);
  }
  const resolvedReportStartDate = submittedReportStartDate ?? salesReportPeriod?.reportStartDate ?? null;
  const resolvedReportEndDate = submittedReportEndDate ?? salesReportPeriod?.reportEndDate ?? null;
  if (reportType === "monthly_product_profit" && (!resolvedReportStartDate || !resolvedReportEndDate)) {
    redirect(`/vms-import?error=${encodeURIComponent("Select the report start and end date for the Monthly Profit Report.")}`);
    return;
  }

  await runVmsImport({
    supabase,
    profile,
    existingBatchId: previewBatchId,
    recordReprocess: false,
    reportType,
    importMode: effectiveImportMode,
    fileName: preview.file_name,
    fileType: preview.file_type,
    sheetName: sheet.name,
    originalFileName: preview.original_file_name ?? preview.file_name,
    fileHash: preview.file_hash ?? null,
    storageBucket: preview.storage_bucket ?? null,
    storagePath: preview.storage_path ?? null,
    headerNames: headers,
    rows,
    originalRows: records,
    columnMapping: mapping,
    firstDataRowNumber: headerRowIndex + 2,
    salesReportPeriod,
    reportStartDate: resolvedReportStartDate,
    reportEndDate: resolvedReportEndDate,
    autoCreateMissingProducts,
    updateCostFromVms,
    errorState: {
      previewId,
      importBatchId: previewBatchId,
      sheetName: sheet.name,
      reportType,
      headerRow: headerRowIndex,
      importMode: effectiveImportMode,
      reportStartDate: resolvedReportStartDate,
      reportEndDate: resolvedReportEndDate,
      mapping,
      autoCreateProducts: autoCreateMissingProducts,
      updateCostFromVms: updateCostFromVms,
      step: 7,
    },
  });
}

function isMissingTableMutationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const supabaseError = error as { code?: string; message?: string };
  const text = String(supabaseError.message ?? "").toLowerCase();
  return supabaseError.code === "42P01"
    || supabaseError.code === "42703"
    || supabaseError.code === "PGRST204"
    || supabaseError.code === "PGRST205"
    || text.includes("does not exist")
    || text.includes("schema cache");
}

async function hardDeleteBatchRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  table: string,
  batchId: string,
) {
  const { error } = await supabase.from(table).delete().eq("import_batch_id", batchId);
  if (error && !isMissingTableMutationError(error)) throw error;
}

async function refreshRefillRecommendationsAfterStockImport({
  supabase,
  batchId,
  reportType,
  importedRows,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  batchId: string;
  reportType: VmsReportType;
  importedRows: number;
}) {
  if (!isMachineStockReport(reportType) || importedRows <= 0) return;

  const { data, error } = await supabase.rpc("refresh_refill_recommendations_from_latest_stock_snapshot");
  if (error) {
    console.warn("[vms-import] Refill recommendation refresh check failed after stock import", {
      batchId,
      reportType,
      error,
    });
    return;
  }

  const result = Array.isArray(data) ? data[0] : data;
  console.info("[vms-import] Refill recommendation refresh check completed", {
    batchId,
    reportType,
    result,
  });
}

async function deactivateOlderActiveStockBatches({
  supabase,
  currentBatchId,
  reportType,
  updatedAt,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  currentBatchId: string;
  reportType: VmsReportType;
  updatedAt: string;
}) {
  if (!isMachineStockReport(reportType)) return;

  const { data: activeBatches, error: activeBatchError } = await supabase
    .from("vms_import_batches")
    .select("id")
    .in("report_type", ["stock", "machine_stock_snapshot"])
    .in("status", ["imported", "imported_with_warnings", "partially_imported"])
    .eq("is_active", true)
    .is("deleted_at", null)
    .neq("id", currentBatchId);

  if (activeBatchError) {
    console.warn("[vms-import] Could not load older active stock batches to deactivate", {
      currentBatchId,
      reportType,
      error: activeBatchError,
    });
    return;
  }

  const staleBatchIds = ((activeBatches ?? []) as Array<{ id?: string | null }>)
    .map((batch) => String(batch.id ?? "").trim())
    .filter(Boolean);

  if (!staleBatchIds.length) return;

  const { error: deactivateError } = await supabase
    .from("vms_import_batches")
    .update({
      is_active: false,
      updated_at: updatedAt,
    })
    .in("id", staleBatchIds);

  if (deactivateError) {
    console.warn("[vms-import] Could not deactivate older stock batches after confirming latest snapshot", {
      currentBatchId,
      reportType,
      staleBatchIds,
      error: deactivateError,
    });
  }
}

async function deactivateOlderActiveMonthlyProfitBatches({
  supabase,
  currentBatchId,
  reportStartDate,
  reportEndDate,
  fileHash,
  updatedAt,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  currentBatchId: string;
  reportStartDate: string | null;
  reportEndDate: string | null;
  fileHash: string | null;
  updatedAt: string;
}) {
  const hasDateRange = Boolean(reportStartDate && reportEndDate);
  const hasFileHash = Boolean(fileHash);
  if (!hasDateRange && !hasFileHash) return;

  let query = supabase
    .from("vms_import_batches")
    .select("id")
    .eq("report_type", "monthly_product_profit")
    .in("status", ["imported", "imported_with_warnings", "partially_imported"])
    .eq("is_active", true)
    .is("deleted_at", null)
    .neq("id", currentBatchId);

  if (hasDateRange && reportStartDate && reportEndDate) {
    query = query.eq("report_start_date", reportStartDate).eq("report_end_date", reportEndDate);
  } else if (hasFileHash && fileHash) {
    query = query.eq("file_hash", fileHash);
  }

  const { data: activeBatches, error: activeBatchError } = await query;
  if (activeBatchError) {
    console.warn("[vms-import] Could not load older active monthly profit batches to deactivate", {
      currentBatchId,
      reportStartDate,
      reportEndDate,
      fileHash,
      error: activeBatchError,
    });
    return;
  }

  const staleBatchIds = ((activeBatches ?? []) as Array<{ id?: string | null }>)
    .map((batch) => String(batch.id ?? "").trim())
    .filter(Boolean);

  if (!staleBatchIds.length) return;

  const { error: deactivateError } = await supabase
    .from("vms_import_batches")
    .update({
      is_active: false,
      updated_at: updatedAt,
    })
    .in("id", staleBatchIds);

  if (deactivateError) {
    console.warn("[vms-import] Could not deactivate older monthly profit batches after confirming latest report", {
      currentBatchId,
      reportStartDate,
      reportEndDate,
      fileHash,
      staleBatchIds,
      error: deactivateError,
    });
  }
}

async function ensureConfirmedStockImportBatchIsUsable({
  supabase,
  profile,
  batchId,
  reportType,
  summary,
  detectedMinDatetime,
  detectedMaxDatetime,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  batchId: string;
  reportType: VmsReportType;
  summary: ImportSummary;
  detectedMinDatetime: string | null;
  detectedMaxDatetime: string | null;
}) {
  if (!isMachineStockReport(reportType)) return;

  const persistedStockSummary = await loadPersistedStockSnapshotBatchSummary({ supabase, batchId });
  if (persistedStockSummary.error) {
    console.warn("[vms-import] Could not count persisted stock rows during confirm postcondition check", {
      batchId,
      reportType,
      error: persistedStockSummary.error,
    });
  }
  const effectiveImportedRows = persistedStockSummary.importedRowCount > 0 ? persistedStockSummary.importedRowCount : summary.importedRows;
  if (effectiveImportedRows <= 0) return;

  const { data: currentBatch, error: currentBatchError } = await supabase
    .from("vms_import_batches")
    .select("id, status, is_active, rows_imported, detected_min_datetime, detected_max_datetime")
    .eq("id", batchId)
    .maybeSingle();

  if (currentBatchError || !currentBatch?.id) {
    console.warn("[vms-import] Could not verify final stock batch usability after confirm", {
      batchId,
      reportType,
      error: currentBatchError,
    });
    return;
  }

  const currentStatus = String(currentBatch.status ?? "").trim();
  const currentRowsImported = wholeNumberValue(currentBatch.rows_imported);
  const usableStatus = currentStatus === "imported";
  const isUsable = usableStatus && currentBatch.is_active !== false && currentRowsImported > 0;
  if (isUsable) return;

  console.warn("[vms-import] Repairing stock batch metadata after confirm because the final state is not usable", {
    batchId,
    reportType,
    currentStatus,
    isActive: currentBatch.is_active ?? null,
    currentRowsImported,
    expectedRowsImported: effectiveImportedRows,
  });

  const now = new Date().toISOString();
  const recoveredWarning = `Recovered stock import metadata after confirm because the batch was left in ${currentStatus || "an unusable"} state.`;
  const nextErrors = summary.errors.includes(recoveredWarning) ? summary.errors : [...summary.errors, recoveredWarning];
  const normalizedReportType = canonicalImportedReportType(reportType);
  const repairedDetectedMinDatetime = persistedStockSummary.detectedMinDatetime || detectedMinDatetime || textValue(currentBatch.detected_min_datetime) || now;
  const repairedDetectedMaxDatetime = persistedStockSummary.detectedMaxDatetime || detectedMaxDatetime || textValue(currentBatch.detected_max_datetime) || repairedDetectedMinDatetime;
  const repairPayload = {
    status: "imported",
    is_active: true,
    imported_by: profile?.team_member_id ?? profile?.id ?? null,
    imported_at: now,
    report_type: normalizedReportType,
    updated_at: now,
    source_usage: vmsSourceUsage(normalizedReportType),
    dashboard_usage: vmsSourceUsage(normalizedReportType),
    rows_found: Math.max(summary.rowsFound, effectiveImportedRows),
    row_count: Math.max(summary.rowsFound, summary.totalRows, effectiveImportedRows),
    rows_imported: effectiveImportedRows,
    rows_skipped: summary.skippedRows,
    rows_skipped_duplicate: summary.rowsSkippedDuplicate,
    rows_needing_review: summary.rowsNeedingReview,
    error_count: nextErrors.length,
    errors: nextErrors,
    latest_error: null,
    last_error: null,
    detected_min_datetime: repairedDetectedMinDatetime,
    detected_max_datetime: repairedDetectedMaxDatetime,
    notes: JSON.stringify({
      ...summary,
      status: "imported",
      errors: nextErrors,
      postconditionRepair: {
        repaired_at: now,
        previous_status: currentStatus || null,
        previous_is_active: currentBatch.is_active ?? null,
        previous_rows_imported: currentRowsImported,
        recovered_rows_imported: effectiveImportedRows,
      },
    }),
  };

  const repairResult = await runVmsImportBatchMutationWithMetadataFallback({
    queryName: "vms_import_batches.update.confirm_postcondition",
    currentStep: "confirm_import",
    selectedImportBatchId: batchId,
    payload: repairPayload,
    run: (payload) => supabase
      .from("vms_import_batches")
      .update(payload)
      .eq("id", batchId)
      .select("id, status, is_active, rows_imported")
      .maybeSingle(),
  });

  const repairProblem = repairResult.timedOut
    ? { code: "TIMEOUT", message: "VMS import postcondition repair timed out." }
    : repairResult.error
      ?? repairResult.value?.error
      ?? (!batchMutationReturnedRow(repairResult.value)
        ? missingBatchMutationRowError({
            queryName: "vms_import_batches.update.confirm_postcondition",
            currentStep: "confirm_import",
            selectedImportBatchId: batchId,
          })
        : null);

  if (repairProblem) {
    logVmsBatchMutationFailure({
      queryName: "vms_import_batches.update.confirm_postcondition",
      error: repairProblem,
      payload: repairResult.payload,
      profile,
      selectedImportBatchId: batchId,
      currentStep: "confirm_import",
    });

    const fallbackActivation = await activateStockBatchWithCoreMetadata({
      supabase,
      batchId,
      reportType: normalizedReportType,
      actorId: profile?.team_member_id ?? profile?.id ?? null,
      rowsFound: Math.max(summary.rowsFound, effectiveImportedRows),
      rowCount: Math.max(summary.rowsFound, summary.totalRows, effectiveImportedRows),
      rowsImported: effectiveImportedRows,
      detectedMinDatetime: repairedDetectedMinDatetime,
      detectedMaxDatetime: repairedDetectedMaxDatetime,
    });

    if (!fallbackActivation.ok) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.update.confirm_postcondition.minimal_activation",
        error: fallbackActivation.error,
        payload: fallbackActivation.payload,
        profile,
        selectedImportBatchId: batchId,
        currentStep: "confirm_import",
      });
    }
  }
}

function revalidateVmsDataSourcePaths(batchId?: string) {
  revalidatePath("/vms-import");
  if (batchId) revalidatePath(`/vms-import/${batchId}`);
  revalidatePath("/dashboard");
  revalidatePath("/sales");
  revalidatePath("/products-dashboard");
  revalidatePath("/machines-dashboard");
  revalidatePath("/inventory-dashboard");
  revalidatePath("/refills");
  revalidatePath("/routes/new");
  revalidatePath("/reports");
}

async function finalizeDetailedOrderDetailsImportBatch({
  supabase,
  profile,
  batchId,
  batch,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  batchId: string;
  batch: Record<string, unknown>;
}) {
  const reportType = parseReportType(textValue(batch.report_type) || null);
  if (reportType !== "vms_order_details_weekly") {
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Only detailed Order Details imports can be finalized from saved rows.")}`);
  }
  if (!isOwnerAdminRole(profile)) {
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Only owner/admin users can finalize imported Order Details rows.")}`);
  }

  const actorId = profile?.team_member_id ?? profile?.id ?? null;
  const now = new Date().toISOString();
  const persistedSummary = await loadPersistedOrderDetailsBatchSummary({ supabase, batchId });
  if (persistedSummary.error) {
    console.error("[vms-import] Order Details finalize row lookup failed", { batchId, error: persistedSummary.error });
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not inspect saved Order Details rows for this batch.")}`);
  }
  if (persistedSummary.rowCount <= 0) {
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("This file does not have saved Order Details rows to finalize yet.")}`);
  }

  const previousStatus = textValue(batch.status);
  const rowsFound = Math.max(wholeNumberValue(batch.rows_found ?? batch.row_count), persistedSummary.rowCount);
  const rowCount = Math.max(wholeNumberValue(batch.row_count), rowsFound, persistedSummary.rowCount);
  const warningMessages: string[] = [];

  if (previousStatus && previousStatus !== "imported") {
    warningMessages.push(`Recovered ${persistedSummary.rowCount} saved Order Details row(s) from a batch that was left in ${previousStatus}.`);
  }
  if (wholeNumberValue(batch.rows_imported) !== persistedSummary.rowCount) {
    warningMessages.push(`Reset rows_imported to ${persistedSummary.rowCount} based on linked rows in vms_transactions_raw.`);
  }

  let previousNotes = objectRecord(null);
  try {
    previousNotes = objectRecord(textValue(batch.notes) ? JSON.parse(textValue(batch.notes)) : null);
  } catch {
    previousNotes = {};
  }

  const finalizePayload = {
    status: "imported",
    is_active: true,
    imported_by: actorId,
    imported_at: now,
    report_type: "vms_order_details_weekly",
    updated_at: now,
    source_usage: vmsSourceUsage("vms_order_details_weekly"),
    dashboard_usage: vmsSourceUsage("vms_order_details_weekly"),
    rows_found: rowsFound,
    row_count: rowCount,
    rows_imported: persistedSummary.rowCount,
    rows_skipped_duplicate: wholeNumberValue(batch.rows_skipped_duplicate),
    rows_needing_review: wholeNumberValue(batch.rows_needing_review),
    error_count: warningMessages.length,
    errors: warningMessages,
    latest_error: null,
    last_error: null,
    report_start_date: persistedSummary.businessDateStart || textValue(batch.report_start_date) || null,
    report_end_date: persistedSummary.businessDateEnd || textValue(batch.report_end_date) || persistedSummary.businessDateStart || null,
    detected_min_datetime: persistedSummary.detectedMinDatetime || textValue(batch.detected_min_datetime) || null,
    detected_max_datetime: persistedSummary.detectedMaxDatetime || textValue(batch.detected_max_datetime) || persistedSummary.detectedMinDatetime || null,
    total_successful_sales: persistedSummary.totalSuccessfulSales,
    successful_rows_count: persistedSummary.successfulRowsCount,
    failed_rows_count: persistedSummary.failedRowsCount,
    refunded_rows_count: persistedSummary.refundedRowsCount,
    notes: JSON.stringify({
      ...previousNotes,
      warnings: warningMessages,
      repair: {
        finalized_at: now,
        finalized_by: actorId,
        repair_mode: previousStatus === "imported" || (previousStatus && ["imported_with_warnings", "partially_imported"].includes(previousStatus))
          ? "reactivate_finalized_batch"
          : "finalize_existing_rows",
        transaction_rows: persistedSummary.rowCount,
        successful_rows: persistedSummary.successfulRowsCount,
        failed_rows: persistedSummary.failedRowsCount,
        refunded_rows: persistedSummary.refundedRowsCount,
        business_date_start: persistedSummary.businessDateStart,
        business_date_end: persistedSummary.businessDateEnd,
      },
    }),
  };

  const finalizeResult = await runVmsImportBatchMutationWithMetadataFallback<Record<string, unknown>>({
    queryName: "vms_import_batches.update.finalize_order_details",
    currentStep: "finalize_order_details",
    selectedImportBatchId: batchId,
    payload: finalizePayload,
    run: (payload) => supabase
      .from("vms_import_batches")
      .update(payload)
      .eq("id", batchId)
      .select("id, status, is_active, rows_imported, report_type, latest_error, last_error, detected_min_datetime, detected_max_datetime")
      .maybeSingle(),
  });

  const finalizeProblem = finalizeResult.timedOut
    ? { code: "TIMEOUT", message: "Order Details finalize batch metadata update timed out." }
    : finalizeResult.error
      ?? finalizeResult.value?.error
      ?? (!batchMutationReturnedRow(finalizeResult.value)
        ? missingBatchMutationRowError({
            queryName: "vms_import_batches.update.finalize_order_details",
            currentStep: "finalize_order_details",
            selectedImportBatchId: batchId,
          })
        : null);

  if (finalizeProblem) {
    console.error("[vms-import] Order Details finalize batch metadata update failed", {
      batchId,
      error: finalizeProblem,
      droppedOptionalColumns: finalizeResult.droppedOptionalColumns,
      payload: finalizeResult.payload,
    });

    const fallbackActivation = await activateOrderDetailsBatchWithCoreMetadata({
      supabase,
      batchId,
      actorId,
      rowsFound,
      rowCount,
      rowsImported: persistedSummary.rowCount,
      reportStartDate: persistedSummary.businessDateStart || textValue(batch.report_start_date) || null,
      reportEndDate: persistedSummary.businessDateEnd || textValue(batch.report_end_date) || persistedSummary.businessDateStart || null,
      detectedMinDatetime: persistedSummary.detectedMinDatetime || textValue(batch.detected_min_datetime) || null,
      detectedMaxDatetime: persistedSummary.detectedMaxDatetime || textValue(batch.detected_max_datetime) || persistedSummary.detectedMinDatetime || null,
      successfulRowsCount: persistedSummary.successfulRowsCount,
      failedRowsCount: persistedSummary.failedRowsCount,
      refundedRowsCount: persistedSummary.refundedRowsCount,
      totalSuccessfulSales: persistedSummary.totalSuccessfulSales,
    });

    if (!fallbackActivation.ok) {
      console.error("[vms-import] Order Details finalize minimal activation failed", {
        batchId,
        error: fallbackActivation.error,
        payload: fallbackActivation.payload,
      });
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not finalize imported Order Details rows for this batch.")}`);
    }

    await logActivity({
      profile,
      action: "update",
      entityType: "vms_import",
      entityId: batchId,
      entityLabel: textValue(batch.file_name) || batchId,
      beforeData: batch,
      afterData: fallbackActivation.batch ?? fallbackActivation.payload,
      summary: `Activated saved Order Details rows for ${textValue(batch.file_name) || batchId}`,
    });

    revalidateVmsDataSourcePaths(batchId);
    redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Activated ${persistedSummary.rowCount} saved Order Details row(s) for dashboards.`)}`);
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "vms_import",
    entityId: batchId,
    entityLabel: textValue(batch.file_name) || batchId,
    beforeData: batch,
    afterData: finalizeResult.value?.data ?? finalizePayload,
    summary: `Finalized imported Order Details rows for ${textValue(batch.file_name) || batchId}`,
  });

  revalidateVmsDataSourcePaths(batchId);
  redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Finalized ${persistedSummary.rowCount} Order Details row(s) and activated this file for dashboards.`)}`);
}

async function finalizePreviewStockImportBatch({
  supabase,
  profile,
  batchId,
  batch,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  batchId: string;
  batch: Record<string, unknown>;
}) {
  const reportType = parseReportType(textValue(batch.report_type) || null);
  if (!reportType || !isMachineStockReport(reportType)) {
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Only stock snapshot imports can be finalized from preview.")}`);
  }

  const actorId = profile?.team_member_id ?? profile?.id ?? null;
  const now = new Date().toISOString();
  const finalizedReportType = canonicalImportedReportType(reportType);
  const rowsFound = wholeNumberValue(batch.rows_found ?? batch.row_count);
  const existingRowsImported = wholeNumberValue(batch.rows_imported);
  const warningMessages: string[] = [];
  let repairMode: "metadata_finalize" | "audit_backfill" | "reprocess" = "metadata_finalize";

  const [
    stockSnapshotRowsResult,
    stockCountResult,
    auditCountResult,
    rawRowsCountResult,
  ] = await Promise.all([
    supabase
      .from("vms_stock_snapshots")
      .select("import_row_number, machine_id, product_id, captured_at, created_at")
      .eq("import_batch_id", batchId)
      .order("import_row_number", { ascending: true }),
    supabase
      .from("vms_stock_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId),
    supabase
      .from("vms_machine_stock_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId),
    supabase
      .from("vms_import_rows")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId),
  ]);

  if (stockSnapshotRowsResult.error) {
    console.error("[vms-import] Preview finalize stock row lookup failed", { batchId, error: stockSnapshotRowsResult.error });
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not inspect saved stock snapshot rows for this batch.")}`);
  }
  if (stockCountResult.error) {
    console.error("[vms-import] Preview finalize stock row count failed", { batchId, error: stockCountResult.error });
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not count saved stock snapshot rows for this batch.")}`);
  }
  if (auditCountResult.error) {
    console.error("[vms-import] Preview finalize audit row count failed", { batchId, error: auditCountResult.error });
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not count saved audit rows for this batch.")}`);
  }
  if (rawRowsCountResult.error) {
    console.error("[vms-import] Preview finalize raw row count failed", { batchId, error: rawRowsCountResult.error });
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not count saved rows for this batch. Please contact admin.")}`);
  }

  let stockSnapshotRows = (stockSnapshotRowsResult.data ?? []) as Array<{
    import_row_number?: number | null;
    machine_id?: string | null;
    product_id?: string | null;
    captured_at?: string | null;
    created_at?: string | null;
  }>;
  let stockRowCount = Number(stockCountResult.count ?? 0);
  const auditRowCount = Number(auditCountResult.count ?? 0);
  const rawRowCount = Number(rawRowsCountResult.count ?? 0);

  if (stockRowCount <= 0 && rawRowCount > 0) {
    repairMode = "reprocess";
    await rerunSavedVmsImportBatch({
      supabase,
      profile,
      batchId,
      batch: {
        id: batchId,
        file_name: textValue(batch.file_name) || null,
        file_type: textValue(batch.file_type) || null,
        sheet_name: textValue(batch.sheet_name) || null,
        report_type: textValue(batch.report_type) || null,
        column_mapping: batch.column_mapping ?? {},
        notes: textValue(batch.notes) || null,
        original_file_name: textValue(batch.original_file_name) || null,
        file_hash: textValue(batch.file_hash) || null,
        storage_bucket: textValue(batch.storage_bucket) || null,
        storage_path: textValue(batch.storage_path) || null,
      },
    });
    return;
  }

  if (stockRowCount <= 0 && auditRowCount > 0) {
    repairMode = "audit_backfill";
    const auditRowsResult = await supabase
      .from("vms_machine_stock_snapshots")
      .select("row_number, machine_id, product_id, machine_code, vms_product_code, vms_product_name, inventory_quantity, inventory_capacity, point_name, raw_row, created_at")
      .eq("import_batch_id", batchId)
      .order("row_number", { ascending: true });

    if (auditRowsResult.error) {
      console.error("[vms-import] Preview finalize audit row load failed", { batchId, error: auditRowsResult.error });
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not load audit rows needed to rebuild stock snapshots.")}`);
    }

    const fallbackCapturedAt = textValue(batch.detected_max_datetime)
      || textValue(batch.detected_min_datetime)
      || textValue(batch.imported_at)
      || textValue(batch.created_at)
      || now;

    const backfillRows = ((auditRowsResult.data ?? []) as Array<Record<string, unknown>>)
      .map((row) => {
        const machineId = textValue(row.machine_id);
        const currentQty = Number(row.inventory_quantity ?? null);
        if (!machineId || !Number.isFinite(currentQty) || currentQty < 0) return null;
        return {
          import_batch_id: batchId,
          import_row_number: wholeNumberValue(row.row_number),
          import_row_status: "imported",
          machine_id: machineId,
          vms_machine_id: textValue(row.machine_code) || null,
          slot_code: null,
          vms_product_id: textValue(row.vms_product_code) || null,
          vms_product_name: textValue(row.vms_product_name) || null,
          product_id: textValue(row.product_id) || null,
          current_qty: Math.floor(currentQty),
          capacity: Number.isFinite(Number(row.inventory_capacity ?? null)) ? Number(row.inventory_capacity) : null,
          captured_at: fallbackCapturedAt,
          metadata: {
            repair_path: "audit_backfill",
            point_name: textValue(row.point_name) || null,
            raw_row: row.raw_row ?? null,
          },
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    if (!backfillRows.length) {
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("This preview batch has audit rows, but none of them could be promoted into stock snapshot rows.")}`);
    }

    const { error: backfillError } = await supabase
      .from("vms_stock_snapshots")
      .upsert(backfillRows, { onConflict: "import_batch_id,import_row_number" });

    if (backfillError) {
      console.error("[vms-import] Preview finalize stock backfill failed", { batchId, error: backfillError });
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not rebuild stock snapshot rows from the saved audit rows.")}`);
    }

    warningMessages.push("Rebuilt vms_stock_snapshots from saved audit rows because the preview batch had no finalized stock rows. Slot codes were unavailable in audit rows, so route matching falls back to product-level matching where needed.");
    stockSnapshotRows = backfillRows.map((row) => ({
      import_row_number: Number(row.import_row_number ?? 0),
      machine_id: typeof row.machine_id === "string" ? row.machine_id : null,
      product_id: typeof row.product_id === "string" ? row.product_id : null,
      captured_at: typeof row.captured_at === "string" ? row.captured_at : null,
      created_at: null,
    }));
    stockRowCount = backfillRows.length;
  }

  if (stockRowCount <= 0) {
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("This preview batch does not have saved stock rows to finalize yet. Reprocess it or upload the file again.")}`);
  }

  if (existingRowsImported <= 0) {
    warningMessages.push(`Recovered ${stockRowCount} saved stock snapshot row(s) from a preview batch whose metadata was never finalized.`);
  }
  if (rowsFound > 0 && stockRowCount < rowsFound) {
    warningMessages.push(`Imported ${stockRowCount} usable stock row(s) out of ${rowsFound} parsed row(s). Review the skipped or unmapped rows if route coverage still looks incomplete.`);
  }

  const capturedAtValues = stockSnapshotRows
    .flatMap((row) => [row.captured_at, row.created_at])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const detectedMinDatetime = capturedAtValues.length
    ? [...capturedAtValues].sort((a, b) => a.localeCompare(b))[0]
    : (textValue(batch.detected_min_datetime) || now);
  const detectedMaxDatetime = capturedAtValues.length
    ? [...capturedAtValues].sort((a, b) => b.localeCompare(a))[0]
    : (textValue(batch.detected_max_datetime) || detectedMinDatetime);
  const rowsNeedingReview = Math.max(wholeNumberValue(batch.rows_needing_review), rowsFound > 0 ? Math.max(0, rowsFound - stockRowCount) : 0);
  let previousNotes = objectRecord(null);
  try {
    previousNotes = objectRecord(textValue(batch.notes) ? JSON.parse(textValue(batch.notes)) : null);
  } catch {
    previousNotes = {};
  }

  const importedRowCount = auditRowCount > 0 ? auditRowCount : stockRowCount;
  const status = "imported";
  const finalizePayload = {
    status,
    is_active: true,
    imported_by: actorId,
    imported_at: now,
    report_type: finalizedReportType,
    updated_at: now,
    source_usage: vmsSourceUsage(finalizedReportType),
    dashboard_usage: vmsSourceUsage(finalizedReportType),
    rows_found: rowsFound || importedRowCount,
    row_count: Math.max(rowsFound, wholeNumberValue(batch.row_count), importedRowCount),
    rows_imported: importedRowCount,
    rows_needing_review: rowsNeedingReview,
    error_count: warningMessages.length,
    errors: warningMessages,
    latest_error: null,
    last_error: null,
    detected_min_datetime: detectedMinDatetime,
    detected_max_datetime: detectedMaxDatetime,
    notes: JSON.stringify({
      ...previousNotes,
      warnings: warningMessages,
      repair: {
        finalized_at: now,
        finalized_by: actorId,
        repair_mode: repairMode,
        stock_rows: stockRowCount,
        audit_rows: auditRowCount,
        raw_rows: rawRowCount,
      },
    }),
  };

  const finalizeResult = await runVmsImportBatchMutationWithMetadataFallback<Record<string, unknown>>({
    queryName: "vms_import_batches.update.finalize_preview",
    currentStep: "finalize_preview",
    selectedImportBatchId: batchId,
    payload: finalizePayload,
    run: (safePayload) => supabase
      .from("vms_import_batches")
      .update(safePayload)
      .eq("id", batchId)
      .select("id, status, is_active, rows_imported, report_type, latest_error, last_error, detected_min_datetime, detected_max_datetime")
      .maybeSingle(),
  });
  const finalizeError = finalizeResult.error ?? finalizeResult.value?.error ?? null;
  if (finalizeResult.timedOut || finalizeError) {
    const finalizeProblem = finalizeError ?? { code: "TIMEOUT", message: "Preview finalize batch metadata update timed out." };
    console.error("[vms-import] Preview finalize batch metadata update failed", {
      batchId,
      error: finalizeProblem,
      droppedOptionalColumns: finalizeResult.droppedOptionalColumns,
      payload: finalizeResult.payload,
    });

    const fallbackActivation = await activateStockBatchWithCoreMetadata({
      supabase,
      batchId,
      reportType: finalizedReportType,
      actorId,
      rowsFound: rowsFound || importedRowCount,
      rowCount: Math.max(rowsFound, wholeNumberValue(batch.row_count), importedRowCount),
      rowsImported: importedRowCount,
      detectedMinDatetime,
      detectedMaxDatetime,
    });

    if (!fallbackActivation.ok) {
      console.error("[vms-import] Preview finalize minimal activation failed", {
        batchId,
        error: fallbackActivation.error,
        payload: fallbackActivation.payload,
      });
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not finalize this preview batch metadata. The saved stock rows were preserved.")}`);
    }

    await deactivateOlderActiveStockBatches({
      supabase,
      currentBatchId: batchId,
      reportType: finalizedReportType,
      updatedAt: now,
    });
    await refreshRefillRecommendationsAfterStockImport({
      supabase,
      batchId,
      reportType: finalizedReportType,
      importedRows: importedRowCount,
    });

    await logActivity({
      profile,
      action: "update",
      entityType: "vms_import",
      entityId: batchId,
      entityLabel: textValue(batch.file_name) || batchId,
      beforeData: batch,
      afterData: fallbackActivation.batch ?? fallbackActivation.payload,
      summary: `Activated preview stock import with minimal metadata ${textValue(batch.file_name) || batchId}`,
    });

    revalidateVmsDataSourcePaths(batchId);
    redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Activated ${importedRowCount} stock row(s) and rebuilt route recommendations.`)}`);
  }

  await deactivateOlderActiveStockBatches({
    supabase,
    currentBatchId: batchId,
    reportType: finalizedReportType,
    updatedAt: now,
  });
  await refreshRefillRecommendationsAfterStockImport({
    supabase,
    batchId,
    reportType: finalizedReportType,
    importedRows: importedRowCount,
  });

  await logActivity({
    profile,
    action: "update",
    entityType: "vms_import",
    entityId: batchId,
    entityLabel: textValue(batch.file_name) || batchId,
    beforeData: batch,
    afterData: finalizeResult.value?.data ?? finalizePayload,
    summary: `Finalized preview stock import ${textValue(batch.file_name) || batchId}`,
  });

  revalidateVmsDataSourcePaths(batchId);
  redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Finalized ${stockRowCount} stock row(s) and activated this batch for route recommendations.`)}`);
}

export async function updateVmsImportBatchState(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const batchId = String(formData.get("batch_id") || "");
  const action = String(formData.get("action") || "");
  const reason = String(formData.get("reason") || "").trim();
  const confirmation = String(formData.get("confirmation") || "").trim();
  if (!batchId) redirect("/vms-import?error=Missing%20VMS%20import%20batch.");

  const { data: beforeBatch, error: beforeError } = await supabase
    .from("vms_import_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  if (beforeError || !beforeBatch?.id) {
    console.error("[vms-import] Batch state lookup failed", beforeError);
    redirect("/vms-import?error=Could%20not%20find%20that%20VMS%20import%20batch.");
  }

  const actorId = profile.team_member_id ?? profile.id ?? null;
  const now = new Date().toISOString();
  const beforeReportType = parseReportType(textValue(beforeBatch.report_type) || null);
  const shouldCheckOrderDetailsRestoreConflict = (action === "enable" || action === "restore")
    && beforeReportType === "vms_order_details_weekly"
    && (String(beforeBatch.status ?? "") === "deleted" || beforeBatch.is_active === false || Boolean(beforeBatch.deleted_at));
  if (shouldCheckOrderDetailsRestoreConflict) {
    const restoreConflictResult = await findActiveOrderDetailsRestoreConflict({
      supabase,
      batchId,
      batch: objectRecord(beforeBatch),
    });
    if (restoreConflictResult && "error" in restoreConflictResult && restoreConflictResult.error) {
      console.error("[vms-import] Order Details restore conflict lookup failed", {
        batchId,
        error: restoreConflictResult.error,
      });
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not verify whether this deleted Order Details batch can be restored. Please try again.")}`);
    }
    if (restoreConflictResult && "conflict" in restoreConflictResult && restoreConflictResult.conflict) {
      const conflictLabel = textValue(restoreConflictResult.conflict.original_file_name) || textValue(restoreConflictResult.conflict.file_name) || "an active dashboard source";
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent(`This deleted Order Details batch already matches ${conflictLabel}. Restore was blocked to avoid double counting.`)}`);
    }
  }
  let payload: Record<string, unknown> | null = null;
  let activitySummary = "";

  if (action === "disable") {
    payload = {
      status: "disabled",
      is_active: false,
      disabled_at: now,
      disabled_by: actorId,
      disable_reason: reason || null,
      updated_at: now,
    };
    activitySummary = `Disabled VMS import ${beforeBatch.file_name ?? batchId}`;
  } else if (action === "finalize_import") {
    if (beforeReportType === "vms_order_details_weekly") {
      await finalizeDetailedOrderDetailsImportBatch({
        supabase,
        profile,
        batchId,
        batch: objectRecord(beforeBatch),
      });
    } else {
      await finalizePreviewStockImportBatch({
        supabase,
        profile,
        batchId,
        batch: objectRecord(beforeBatch),
      });
    }
    return;
  } else if ((action === "enable" || action === "restore")
    && beforeReportType
    && isMachineStockReport(beforeReportType)
    && String(beforeBatch.status ?? "") === "previewed") {
    await finalizePreviewStockImportBatch({
      supabase,
      profile,
      batchId,
      batch: objectRecord(beforeBatch),
    });
    return;
  } else if ((action === "enable" || action === "restore")
    && beforeReportType === "vms_order_details_weekly"
    && String(beforeBatch.status ?? "") !== "deleted") {
    await finalizeDetailedOrderDetailsImportBatch({
      supabase,
      profile,
      batchId,
      batch: objectRecord(beforeBatch),
    });
    return;
  } else if ((action === "enable" || action === "restore")
    && beforeReportType === "vms_order_details_weekly"
    && String(beforeBatch.status ?? "") === "deleted") {
    const persistedSummary = await loadPersistedOrderDetailsBatchSummary({ supabase, batchId });
    const restoredRows = persistedSummary.rowCount > 0
      ? persistedSummary.rowCount
      : wholeNumberValue(beforeBatch.rows_imported ?? beforeBatch.rows_found ?? beforeBatch.row_count);
    const actorIdForRestore = profile.team_member_id ?? profile.id ?? null;
    const restoreResult = await activateOrderDetailsBatchWithCoreMetadata({
      supabase,
      batchId,
      actorId: actorIdForRestore,
      rowsFound: persistedSummary.rowCount > 0 ? persistedSummary.rowCount : wholeNumberValue(beforeBatch.rows_found ?? beforeBatch.row_count),
      rowCount: persistedSummary.rowCount > 0 ? persistedSummary.rowCount : wholeNumberValue(beforeBatch.rows_found ?? beforeBatch.row_count),
      rowsImported: restoredRows,
      reportStartDate: persistedSummary.businessDateStart || textValue(beforeBatch.report_start_date) || null,
      reportEndDate: persistedSummary.businessDateEnd || textValue(beforeBatch.report_end_date) || persistedSummary.businessDateStart || null,
      detectedMinDatetime: persistedSummary.detectedMinDatetime || textValue(beforeBatch.detected_min_datetime) || null,
      detectedMaxDatetime: persistedSummary.detectedMaxDatetime || textValue(beforeBatch.detected_max_datetime) || persistedSummary.detectedMinDatetime || null,
      successfulRowsCount: persistedSummary.successfulRowsCount,
      failedRowsCount: persistedSummary.failedRowsCount,
      refundedRowsCount: persistedSummary.refundedRowsCount,
      totalSuccessfulSales: persistedSummary.totalSuccessfulSales,
    });
    if (!restoreResult.ok) {
      logVmsBatchMutationFailure({
        queryName: "vms_import_batches.update.restore_deleted_order_details",
        error: restoreResult.error,
        payload: restoreResult.payload,
        profile,
        selectedImportBatchId: batchId,
        currentStep: "restore_deleted_batch",
      });
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not restore the deleted Order Details batch. Please try again.")}`);
    }

    await logActivity({
      profile,
      action: "update",
      entityType: "vms_import",
      entityId: batchId,
      entityLabel: textValue(beforeBatch.file_name) || batchId,
      beforeData: beforeBatch,
      afterData: restoreResult.batch ?? restoreResult.payload,
      summary: `Restored deleted Order Details batch ${textValue(beforeBatch.file_name) || batchId}`,
    });

    revalidateVmsDataSourcePaths(batchId);
    redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Restored ${restoredRows} Order Details row(s) and reactivated this deleted batch.`)}`);
  } else if (action === "enable" || action === "restore") {
    const restoredReportType = beforeReportType ? canonicalImportedReportType(beforeReportType) : null;
    payload = {
      status: beforeReportType && isMachineStockReport(beforeReportType)
        ? "imported"
        : "imported",
      is_active: true,
      report_type: restoredReportType ?? beforeBatch.report_type ?? null,
      disabled_at: null,
      disabled_by: null,
      disable_reason: null,
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
      updated_at: now,
    };
    activitySummary = `Restored VMS import ${beforeBatch.file_name ?? batchId}`;
  } else if (action === "soft_delete") {
    payload = {
      status: "deleted",
      is_active: false,
      deleted_at: now,
      deleted_by: actorId,
      delete_reason: reason || null,
      updated_at: now,
    };
    activitySummary = `Soft deleted VMS import ${beforeBatch.file_name ?? batchId}`;
  } else if (action === "hard_delete") {
    if (!isOwnerAdminRole(profile)) redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Only owner/admin users can hard delete VMS imports.")}`);
    if (confirmation !== "DELETE") redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Type DELETE to permanently remove this VMS import.")}`);

    for (const table of [
      "vms_machine_stock_snapshots",
      "vms_transactions_raw",
      "vms_sales_raw",
      "vms_sales_snapshots",
      "vms_stock_snapshots",
      "vms_import_rows",
      "vms_import_raw_rows",
      "vms_import_preview_rows",
    ]) {
      await hardDeleteBatchRows(supabase, table, batchId);
    }
    if (beforeBatch.storage_bucket && beforeBatch.storage_path) {
      await supabase.storage.from(String(beforeBatch.storage_bucket)).remove([String(beforeBatch.storage_path)]);
    }
    await supabase.from("vms_import_batches").delete().eq("id", batchId);
    await logActivity({
      profile,
      action: "delete",
      entityType: "vms_import",
      entityId: batchId,
      entityLabel: beforeBatch.file_name ?? batchId,
      beforeData: beforeBatch,
      summary: `Hard deleted VMS import ${beforeBatch.file_name ?? batchId}`,
    });
    revalidateVmsDataSourcePaths(batchId);
    redirect("/vms-import?error=VMS%20import%20was%20permanently%20deleted.");
  } else {
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Unknown VMS import action.")}`);
  }

  if (!payload) redirect(`/vms-import/${batchId}?error=${encodeURIComponent("No VMS import action was applied.")}`);
  const stateUpdateResult = await runVmsImportBatchMutationWithMetadataFallback<Record<string, unknown>>({
    queryName: "vms_import_batches.update.state",
    currentStep: "batch_state",
    selectedImportBatchId: batchId,
    payload,
    run: (safePayload) => supabase
      .from("vms_import_batches")
      .update(safePayload)
      .eq("id", batchId)
      .select("*")
      .maybeSingle(),
  });
  const afterBatch = stateUpdateResult.value?.data;
  const afterBatchFileName = typeof afterBatch?.file_name === "string" ? afterBatch.file_name : null;
  const error = stateUpdateResult.error ?? stateUpdateResult.value?.error ?? null;
  if (stateUpdateResult.timedOut || error) {
    console.error("[vms-import] Batch state update failed", error ?? "timeout");
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Could not update this VMS import batch. Please contact admin.")}`);
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "vms_import",
    entityId: batchId,
    entityLabel: afterBatchFileName ?? beforeBatch.file_name ?? batchId,
    beforeData: beforeBatch,
    afterData: afterBatch,
    summary: activitySummary,
  });

  const restoredReportType = parseReportType(textValue(afterBatch?.report_type ?? beforeBatch.report_type) || null);
  if ((action === "enable" || action === "restore") && restoredReportType && isMachineStockReport(restoredReportType)) {
    await deactivateOlderActiveStockBatches({
      supabase,
      currentBatchId: batchId,
      reportType: restoredReportType,
      updatedAt: now,
    });
    await refreshRefillRecommendationsAfterStockImport({
      supabase,
      batchId,
      reportType: restoredReportType,
      importedRows: wholeNumberValue(afterBatch?.rows_imported ?? beforeBatch.rows_imported),
    });
  }

  revalidateVmsDataSourcePaths(batchId);
  redirect(`/vms-import/${batchId}`);
}

function jsonRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? "")]),
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function wholeNumberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

type SavedVmsImportBatchRow = {
  id: string;
  file_name: string | null;
  file_type: string | null;
  sheet_name: string | null;
  report_type: string | null;
  column_mapping: unknown;
  notes: string | null;
  original_file_name: string | null;
  file_hash: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

async function rerunSavedVmsImportBatch({
  supabase,
  profile,
  batchId,
  batch,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  batchId: string;
  batch: SavedVmsImportBatchRow;
}) {
  const reportType = parseReportType(batch.report_type);
  if (!reportType) redirect(`/vms-import/${batchId}?error=That%20batch%20does%20not%20have%20a%20valid%20report%20type.`);
  type SavedImportRow = {
    row_number?: number | null;
    raw_data?: unknown;
    normalized_data?: unknown;
  };

  const { data: rawRows, error: rawRowsError } = await supabase
    .from("vms_import_rows")
    .select("row_number, raw_data, normalized_data")
    .eq("import_batch_id", batchId)
    .order("row_number", { ascending: true });

  if (rawRowsError) {
    console.error("[vms-import:reprocess] Raw row lookup failed", rawRowsError);
    redirect(`/vms-import/${batchId}?error=Could%20not%20load%20raw%20rows%20for%20that%20batch.`);
  }

  if (!rawRows?.length) {
    redirect(`/vms-import/${batchId}?error=This%20batch%20does%20not%20have%20saved%20raw%20rows.%20Upload%20the%20file%20again%20once%20to%20enable%20reprocessing.`);
  }

  let previousSummary: Partial<ImportSummary> = {};
  try {
    previousSummary = batch.notes ? JSON.parse(String(batch.notes)) as Partial<ImportSummary> : {};
  } catch {
    previousSummary = {};
  }

  await runVmsImport({
    supabase,
    profile,
    existingBatchId: batchId,
    reportType,
    fileName: batch.file_name ?? "VMS import",
    fileType: batch.file_type ?? "csv",
    sheetName: batch.sheet_name ?? "Sheet",
    originalFileName: batch.original_file_name ?? batch.file_name ?? "VMS import",
    fileHash: batch.file_hash ?? null,
    storageBucket: batch.storage_bucket ?? null,
    storagePath: batch.storage_path ?? null,
    rows: (rawRows as SavedImportRow[]).map((row) => jsonRecord(row.normalized_data)),
    originalRows: (rawRows as SavedImportRow[]).map((row) => jsonRecord(row.raw_data)),
    columnMapping: jsonRecord(batch.column_mapping),
    sourceRowNumbers: (rawRows as SavedImportRow[]).map((row) => Number(row.row_number)),
    salesReportPeriod: previousSummary.salesReportPeriod ?? null,
    reportStartDate: previousSummary.orderDetailsReportPeriod?.reportStartDate ?? previousSummary.salesReportPeriod?.reportStartDate ?? null,
    reportEndDate: previousSummary.orderDetailsReportPeriod?.reportEndDate ?? previousSummary.salesReportPeriod?.reportEndDate ?? null,
    autoCreateMissingProducts: previousSummary.autoCreateMissingProducts ?? true,
    updateCostFromVms: previousSummary.updateCostFromVms ?? false,
  });
}

export async function reprocessVmsImportBatch(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const batchId = String(formData.get("batch_id") || "");
  if (!batchId) redirect("/vms-import?error=Missing%20VMS%20import%20batch.");

  const { data: batch, error: batchError } = await supabase
    .from("vms_import_batches")
    .select("id, file_name, file_type, sheet_name, report_type, column_mapping, notes, original_file_name, file_hash, storage_bucket, storage_path")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError || !batch?.id) {
    console.error("[vms-import:reprocess] Batch lookup failed", batchError);
    redirect("/vms-import?error=Could%20not%20find%20that%20VMS%20import%20batch.");
  }

  await rerunSavedVmsImportBatch({
    supabase,
    profile,
    batchId,
    batch: batch as SavedVmsImportBatchRow,
  });
}
