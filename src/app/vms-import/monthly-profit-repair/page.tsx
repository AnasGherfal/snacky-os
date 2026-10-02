import Link from "next/link";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports } from "@/lib/authz";
import { activateMonthlyProfitImportBatch } from "@/lib/vms-monthly-profit-actions";

export const dynamic = "force-dynamic";

function text(value: unknown, fallback = "-") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function formatDate(value: unknown) {
  const candidate = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "-";
}

export default async function MonthlyProfitRepairPage() {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Monthly Profit repair unavailable" body="Supabase is not configured." />;

  const [batchesResult, rowsResult] = await Promise.all([
    supabase
      .from("vms_import_batches")
      .select("id, file_name, status, is_active, report_start_date, report_end_date, rows_imported, imported_at")
      .eq("report_type", "monthly_product_profit")
      .order("report_end_date", { ascending: false })
      .order("imported_at", { ascending: false })
      .limit(200),
    supabase.from("vms_monthly_product_profit").select("import_batch_id").limit(50000),
  ]);

  if (batchesResult.error || rowsResult.error) {
    console.error("[vms-import] Could not load Monthly Product Profit repair page", {
      batchesError: batchesResult.error,
      rowsError: rowsResult.error,
    });
    return (
      <ErrorState
        title="Could not inspect Monthly Product Profit imports"
        body="Snacky OS could not load the import batches and their saved profit rows."
        action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>}
      />
    );
  }

  const savedRowsByBatch = new Map<string, number>();
  (rowsResult.data ?? []).forEach((row: any) => {
    const batchId = String(row.import_batch_id ?? "").trim();
    if (!batchId) return;
    savedRowsByBatch.set(batchId, (savedRowsByBatch.get(batchId) ?? 0) + 1);
  });

  const batches = (batchesResult.data ?? []).map((batch: any) => {
    const status = String(batch.status ?? "");
    return {
      ...batch,
      savedRows: savedRowsByBatch.get(String(batch.id)) ?? 0,
      usable: ["imported", "imported_with_warnings", "partially_imported"].includes(status) && batch.is_active !== false,
      eligible: !["deleted", "disabled"].includes(status),
    };
  });

  return (
    <>
      <PageHeader
        title="Monthly Product Profit Activation"
        subtitle="Repair an uploaded monthly profit file whose saved rows exist but whose batch was left inactive. Only one partial upload remains active for each business month."
        breadcrumbs={[{ label: "Admin", href: "/vms-import" }, { label: "Monthly Profit Activation" }]}
        action={<SecondaryButton href="/vms-import">Back to VMS import</SecondaryButton>}
      />

      <div className="mb-6 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
        <div className="font-semibold">Safe activation rule</div>
        <p className="mt-1">Snacky OS verifies saved monthly profit rows before activation. A newer partial upload disables older uploads for the same month without deleting their rows.</p>
      </div>

      {!batches.length ? (
        <EmptyState title="No Monthly Product Profit imports" body="Upload a Monthly Product Profit report first." action={<Link href="/vms-import" className="btn-primary">Upload VMS report</Link>} />
      ) : (
        <DataTable headers={["File", "Coverage", "Saved rows", "Batch rows", "Status", "Dashboard", "Action"]}>
          {batches.map((batch: any) => (
            <tr key={batch.id}>
              <td>
                <Link href={`/vms-import/${batch.id}`} className="font-semibold text-slate-950 hover:underline">{text(batch.file_name)}</Link>
                <div className="mt-1 text-xs text-slate-500">{String(batch.id).slice(0, 8)}</div>
              </td>
              <td>{formatDate(batch.report_start_date)} → {formatDate(batch.report_end_date)}</td>
              <td className="font-semibold">{batch.savedRows}</td>
              <td>{Number(batch.rows_imported ?? 0)}</td>
              <td><StatusBadge status={String(batch.status ?? "unknown")} /></td>
              <td><StatusBadge status={batch.usable ? "active" : "inactive"} label={batch.usable ? "Active" : "Inactive"} /></td>
              <td>
                {batch.usable ? (
                  <span className="text-sm text-slate-500">No action needed</span>
                ) : batch.savedRows > 0 && batch.eligible ? (
                  <form action={activateMonthlyProfitImportBatch}>
                    <input type="hidden" name="batch_id" value={String(batch.id)} />
                    <FormSubmitButton className="btn-primary" pendingLabel="Activating...">Activate saved rows</FormSubmitButton>
                  </form>
                ) : (
                  <span className="text-sm text-amber-700">Reprocess or re-upload</span>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
