export type VmsDashboardBatch = {
  id: string;
  file_name?: string | null;
  report_type?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  report_start_date?: string | null;
  report_end_date?: string | null;
  uploaded_at?: string | null;
  imported_at?: string | null;
  deleted_at?: string | null;
  original_file_name?: string | null;
  detected_min_datetime?: string | null;
  detected_max_datetime?: string | null;
  row_count?: number | null;
  rows_found?: number | null;
  rows_imported?: number | null;
  rows_skipped_duplicate?: number | null;
  rows_needing_review?: number | null;
  error_count?: number | null;
  dashboard_usage?: unknown;
  source_usage?: unknown;
};

type SupabaseLikeError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

type SupabaseLikeResult<T> = {
  data?: T[] | null;
  error?: SupabaseLikeError | null;
  count?: number | null;
};

export type VmsDashboardUsageKey =
  | "dashboard"
  | "sales"
  | "products"
  | "machines"
  | "inventory"
  | "refills"
  | "restock"
  | "routes"
  | "reconciliation"
  | "failed_vends";

export const vmsDashboardBatchSelect = [
  "id",
  "file_name",
  "original_file_name",
  "report_type",
  "status",
  "is_active",
  "report_start_date",
  "report_end_date",
  "uploaded_at",
  "imported_at",
  "deleted_at",
  "detected_min_datetime",
  "detected_max_datetime",
  "row_count",
  "rows_found",
  "rows_imported",
  "rows_skipped_duplicate",
  "rows_needing_review",
  "error_count",
  "dashboard_usage",
  "source_usage",
].join(", ");

const legacyVmsDashboardBatchSelect = [
  "id",
  "file_name",
  "original_file_name",
  "report_type",
  "status",
  "is_active",
  "report_start_date",
  "report_end_date",
  "uploaded_at",
  "imported_at",
  "row_count",
  "rows_found",
  "rows_imported",
  "error_count",
].join(", ");

const dashboardUsageLabels: Record<VmsDashboardUsageKey | "routes", string> = {
  dashboard: "Overview Dashboard",
  sales: "Sales Dashboard",
  products: "Product Dashboard",
  machines: "Machine Dashboard",
  inventory: "Inventory Dashboard",
  refills: "Refill Recommendations",
  restock: "Restock Priority",
  reconciliation: "Reconciliation",
  failed_vends: "Failed Vend / Refund Report",
  routes: "Route Creation",
};

function dateOnly(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return dateOnly(new Date(Date.UTC(year, month - 1, day + days)));
}

export function isActiveImportedVmsBatch(batch: VmsDashboardBatch) {
  return ["imported", "imported_with_warnings", "partially_imported"].includes(String(batch.status ?? ""))
    && batch.is_active !== false
    && !batch.deleted_at;
}

function isDashboardBatchSchemaError(error: unknown) {
  const payload = error && typeof error === "object" ? error as SupabaseLikeError : null;
  const text = [payload?.code, payload?.message, payload?.details, payload?.hint]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  return payload?.code === "42703" || payload?.code === "PGRST204" || text.includes("column") || text.includes("schema cache");
}

export async function queryVmsDashboardBatches(
  supabase: any,
  {
    reportTypes,
    orderBy = "uploaded_at",
    ascending = false,
  }: {
    reportTypes: string[];
    orderBy?: string;
    ascending?: boolean;
  },
) {
  const preferred = await (supabase
    .from("vms_import_batches")
    .select(vmsDashboardBatchSelect)
    .in("report_type", reportTypes)
    .order(orderBy, { ascending, nullsFirst: false }) as Promise<SupabaseLikeResult<VmsDashboardBatch>>);

  if (!preferred.error || !isDashboardBatchSchemaError(preferred.error)) return preferred;

  return supabase
    .from("vms_import_batches")
    .select(legacyVmsDashboardBatchSelect)
    .in("report_type", reportTypes)
    .order(orderBy, { ascending, nullsFirst: false }) as Promise<SupabaseLikeResult<VmsDashboardBatch>>;
}

function fallbackDashboardUsageKeys(reportType: string | null | undefined): VmsDashboardUsageKey[] {
  if (reportType === "vms_order_details_weekly") return ["dashboard", "sales", "products", "machines", "restock", "failed_vends"];
  if (reportType === "sales") return ["reconciliation"];
  if (["stock", "machine_stock_snapshot", "planogram"].includes(String(reportType ?? ""))) return ["dashboard", "inventory", "products", "machines", "refills", "restock", "routes"];
  return [];
}

export function dashboardUsageKeys(value: unknown, reportType?: string | null) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (value && typeof value === "object") {
    const record = value as { dashboards?: unknown };
    if (Array.isArray(record.dashboards)) {
      return record.dashboards.map((entry) => String(entry ?? "").trim()).filter(Boolean);
    }
  }
  return fallbackDashboardUsageKeys(reportType);
}

function titleCaseUsageKey(key: string) {
  return key
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function dashboardUsageNames(value: unknown, reportType?: string | null) {
  return dashboardUsageKeys(value, reportType).map((key) => dashboardUsageLabels[key as keyof typeof dashboardUsageLabels] ?? titleCaseUsageKey(key));
}

export function activeDetailedBatches(batches: VmsDashboardBatch[]) {
  return batches
    .filter((batch) => batch.report_type === "vms_order_details_weekly" && isActiveImportedVmsBatch(batch))
    .sort((a, b) => String(a.report_start_date ?? "").localeCompare(String(b.report_start_date ?? "")));
}

export function vmsCoverageSummary(batches: VmsDashboardBatch[]) {
  const active = activeDetailedBatches(batches);
  const ranges = active
    .map((batch) => ({ start: batch.report_start_date ?? "", end: batch.report_end_date ?? "" }))
    .filter((range) => range.start && range.end);
  const gaps: { start: string; end: string }[] = [];
  for (let index = 1; index < ranges.length; index += 1) {
    const expected = addDays(ranges[index - 1].end, 1);
    if (expected < ranges[index].start) gaps.push({ start: expected, end: addDays(ranges[index].start, -1) });
  }
  const latest = [...active].sort((a, b) => String(b.uploaded_at ?? b.imported_at ?? "").localeCompare(String(a.uploaded_at ?? a.imported_at ?? "")))[0] ?? null;
  return {
    active,
    gaps,
    start: ranges[0]?.start ?? "",
    end: ranges.at(-1)?.end ?? "",
    latest,
  };
}

export function sourceFileName(batch: VmsDashboardBatch | null | undefined) {
  return batch?.original_file_name || batch?.file_name || "unknown file";
}

export function formatVmsDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US");
}

export function batchImportedRows(batch: VmsDashboardBatch | null | undefined) {
  const parsed = Number(batch?.rows_imported ?? batch?.rows_found ?? batch?.row_count ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function batchLastUpdatedAt(batch: VmsDashboardBatch | null | undefined) {
  return batch?.imported_at ?? batch?.uploaded_at ?? batch?.detected_max_datetime ?? batch?.detected_min_datetime ?? null;
}

export function batchDateRangeLabel(batch: VmsDashboardBatch | null | undefined) {
  if (!batch) return "-";
  if (batch.report_start_date && batch.report_end_date) return `${batch.report_start_date} to ${batch.report_end_date}`;
  if (batch.detected_min_datetime && batch.detected_max_datetime) {
    const start = formatVmsDateTime(batch.detected_min_datetime);
    const end = formatVmsDateTime(batch.detected_max_datetime);
    return start === end ? start : `${start} to ${end}`;
  }
  if (batch.detected_max_datetime || batch.detected_min_datetime) return formatVmsDateTime(batch.detected_max_datetime ?? batch.detected_min_datetime);
  return formatVmsDateTime(batch.imported_at ?? batch.uploaded_at);
}

export function detailedSalesSourceMessage(batches: VmsDashboardBatch[], summaryFiles: VmsDashboardBatch[] = []) {
  const coverage = vmsCoverageSummary(batches);
  if (coverage.active.length) {
    return `Using detailed sales transactions from ${coverage.active.length} active file(s)${coverage.start && coverage.end ? ` covering ${coverage.start} to ${coverage.end}` : ""}. Latest: ${sourceFileName(coverage.latest)}.`;
  }
  const activeSummary = summaryFiles.filter(isActiveImportedVmsBatch);
  if (activeSummary.length) return "Using sales summary report for reconciliation only. Detailed sales transactions not imported yet.";
  return "Detailed sales transactions not imported yet.";
}

export function activeStockBatches(batches: VmsDashboardBatch[]) {
  return batches
    .filter((batch) => ["stock", "machine_stock_snapshot", "planogram"].includes(String(batch.report_type ?? "")) && isActiveImportedVmsBatch(batch))
    .sort((a, b) => String(b.detected_max_datetime ?? b.detected_min_datetime ?? b.uploaded_at ?? b.imported_at ?? "").localeCompare(String(a.detected_max_datetime ?? a.detected_min_datetime ?? a.uploaded_at ?? a.imported_at ?? "")));
}

export function stockSourceMessage(batches: VmsDashboardBatch[]) {
  const latest = activeStockBatches(batches)[0] ?? null;
  if (!latest) return "Refill recommendations are using manual planogram/storage fallback until a stock snapshot is imported.";
  const snapshot = latest.detected_max_datetime ?? latest.detected_min_datetime ?? latest.uploaded_at ?? latest.imported_at ?? "";
  return `Refill recommendations are using stock snapshot file ${sourceFileName(latest)}${snapshot ? ` (${new Date(snapshot).toLocaleString("en-US")})` : ""}.`;
}

export function batchUsageSummary(batch: VmsDashboardBatch | null | undefined) {
  return dashboardUsageNames(batch?.dashboard_usage, batch?.report_type);
}
