import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, FormField, PageHeader, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { importVmsCsv } from "@/lib/vms-import-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type ImportSummary = {
  importType?: string;
  fileName?: string;
  totalRows?: number;
  importedRows?: number;
  skippedRows?: number;
  unknownMachines?: string[];
  unmappedProducts?: string[];
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

function UploadCard({ type, title, body }: { type: "stock" | "sales"; title: string; body: string }) {
  return (
    <SectionCard>
      <form action={importVmsCsv} className="space-y-4 p-4">
        <input type="hidden" name="import_type" value={type} />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">{body}</p>
        </div>
        <FormField label="CSV file" required>
          <input name="file" type="file" accept=".csv,text/csv" required className="field-input" />
        </FormField>
        <button className="btn-primary w-full">Upload {type} CSV</button>
      </form>
    </SectionCard>
  );
}

export default async function VmsImportPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const { batchId, error } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: batches }, { data: selectedBatch }] = supabase
    ? await Promise.all([
        supabase
          .from("vms_import_batches")
          .select("id, source_type, file_name, imported_at, status, row_count, error_count, notes")
          .order("imported_at", { ascending: false })
          .limit(20),
        batchId
          ? supabase
              .from("vms_import_batches")
              .select("id, source_type, file_name, imported_at, status, row_count, error_count, notes")
              .eq("id", batchId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ])
    : [{ data: [] }, { data: null }];

  const summary = parseSummary(selectedBatch?.notes);

  return (
    <AppShell>
      <PageHeader
        title="VMS Import"
        subtitle="Upload recurring VMS stock and sales reports into Supabase snapshots. CSV files are inputs only; the database remains the source of truth."
      />

      {error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {error}
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <UploadCard
          type="stock"
          title="Upload stock CSV"
          body="Updates VMS stock snapshots by machine and slot. Refill recommendations refresh from the latest stock snapshots."
        />
        <UploadCard
          type="sales"
          title="Upload sales CSV"
          body="Updates VMS sales snapshots used by sales, product, and machine dashboards."
        />
      </div>

      {summary ? (
        <section className="surface-card mb-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Import summary</h2>
              <p className="text-sm text-slate-500">{summary.fileName} - {summary.importType} import</p>
            </div>
            <StatusBadge status={selectedBatch?.status} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-500">Total rows</div>
              <div className="text-2xl font-semibold">{summary.totalRows ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-500">Imported</div>
              <div className="text-2xl font-semibold">{summary.importedRows ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-500">Skipped</div>
              <div className="text-2xl font-semibold">{summary.skippedRows ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-500">Unknown machines</div>
              <div className="text-2xl font-semibold">{summary.unknownMachines?.length ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-500">Unmapped products</div>
              <div className="text-2xl font-semibold">{summary.unmappedProducts?.length ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-500">Errors</div>
              <div className="text-2xl font-semibold">{summary.errors?.length ?? 0}</div>
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="font-semibold text-slate-900">Unknown machines</h3>
              {summary.unknownMachines?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                  {summary.unknownMachines.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : <p className="mt-2 text-sm text-slate-500">None</p>}
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="font-semibold text-slate-900">Unmapped products</h3>
              {summary.unmappedProducts?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                  {summary.unmappedProducts.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : <p className="mt-2 text-sm text-slate-500">None</p>}
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="font-semibold text-slate-900">Errors</h3>
              {summary.errors?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                  {summary.errors.slice(0, 12).map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : <p className="mt-2 text-sm text-slate-500">None</p>}
            </div>
          </div>
        </section>
      ) : null}

      <section className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Recent imports</h2>
        {!batches?.length ? (
          <EmptyState title="No VMS imports yet" body="Upload a stock or sales CSV to create the first import batch." />
        ) : (
          <DataTable headers={["Imported", "Type", "File", "Rows", "Errors", "Status"]}>
            {batches.map((batch: any) => (
              <tr key={batch.id}>
                <td>{new Date(batch.imported_at).toLocaleString("en-US")}</td>
                <td>{batch.source_type}</td>
                <td>{batch.file_name ?? "-"}</td>
                <td>{batch.row_count ?? 0}</td>
                <td>{batch.error_count ?? 0}</td>
                <td><StatusBadge status={batch.status} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </AppShell>
  );
}
