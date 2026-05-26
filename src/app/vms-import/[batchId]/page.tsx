import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DataTable, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { reprocessVmsImportBatch } from "@/lib/vms-import-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { parseReportType, vmsExpectedFields, vmsReportTypes } from "@/lib/vms-parser";

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
  unmappedProducts?: string[];
  unknownMachines?: string[];
  errors?: string[];
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

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
  searchParams: Promise<{ error?: string }>;
}) {
  const { batchId } = await params;
  const { error = "" } = await searchParams;
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: batch }, { data: rows }] = await Promise.all([
    supabase
      .from("vms_import_batches")
      .select("id, source_type, file_name, file_type, sheet_name, report_type, imported_by, imported_at, status, row_count, rows_imported, rows_skipped, rows_skipped_duplicate, rows_needing_review, import_mode, report_start_date, report_end_date, error_count, notes, column_mapping, last_reprocessed_at, reprocess_count")
      .eq("id", batchId)
      .maybeSingle(),
    supabase
      .from("vms_import_rows")
      .select("id, row_number, raw_data, normalized_data, validation_status, validation_errors, machine_match_status, product_match_status, matched_machine_id, matched_product_id")
      .eq("import_batch_id", batchId)
      .order("row_number", { ascending: true }),
  ]);

  if (!batch) notFound();

  const { data: importer } = batch.imported_by
    ? await supabase.from("team_members").select("id, full_name").eq("id", batch.imported_by).maybeSingle()
    : { data: null };

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
            {rowList.length ? (
              <form action={reprocessVmsImportBatch}>
                <input type="hidden" name="batch_id" value={batch.id} />
                <button className="btn-primary">Reprocess after mapping</button>
              </form>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Total rows" value={summary?.totalRows ?? batch.row_count ?? rowList.length} />
          <StatCard label="Imported" value={summary?.importedRows ?? batch.rows_imported ?? importedRows.length} />
          <StatCard label="Duplicates skipped" value={summary?.rowsSkippedDuplicate ?? batch.rows_skipped_duplicate ?? 0} />
          <StatCard label="Needs mapping" value={summary?.needsProductMappingRows ?? needsMappingRows.length} />
          <StatCard label="Unknown machines" value={summary?.unknownMachineRows ?? unknownMachineRows.length} />
          <StatCard label="Invalid rows" value={summary?.invalidRows ?? invalidRows.length} />
          <StatCard label="Saved rows" value={rowList.length} />
        </div>
        {batch.report_type === "sales" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <StatCard label="Import mode" value={String(batch.import_mode ?? summary?.importType ?? "append_new").replaceAll("_", " ")} />
            <StatCard label="Report start" value={batch.report_start_date ?? "-"} />
            <StatCard label="Report end" value={batch.report_end_date ?? "-"} />
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
      </section>

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
