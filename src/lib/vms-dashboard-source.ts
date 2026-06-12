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
  error_count?: number | null;
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
