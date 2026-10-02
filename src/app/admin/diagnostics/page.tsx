import { redirect } from "next/navigation";
import { DataTable, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type CountCheck = {
  label: string;
  table: string;
  count: number | null;
  ok: boolean;
  error: string | null;
};

function formatDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

function environmentName() {
  return process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || "unknown";
}

function publicSupabaseHost() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "Not configured";
  try {
    return new URL(url).host;
  } catch {
    return "Invalid URL";
  }
}

async function countRows(supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, table: string, label: string): Promise<CountCheck> {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  return {
    label,
    table,
    count: error ? null : count ?? 0,
    ok: !error,
    error: error?.message ?? null,
  };
}

export default async function AdminDiagnosticsPage() {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return (
      <>
        <PageHeader title="Diagnostics" subtitle="Pilot-readiness checks for Snacky OS." action={<SecondaryButton href="/admin">Back to admin</SecondaryButton>} />
        <ErrorState title="Supabase is not configured" body="Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY before pilot testing." />
      </>
    );
  }

  const [products, machines, routes, movements, lastImportResult] = await Promise.all([
    countRows(supabase, "products", "Products"),
    countRows(supabase, "machines", "Machines"),
    countRows(supabase, "routes", "Routes"),
    countRows(supabase, "inventory_movements", "Inventory movements"),
    supabase
      .from("vms_import_batches")
      .select("id, file_name, report_type, status, imported_at, row_count, rows_imported, error_count")
      .order("imported_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const countChecks = [products, machines, routes, movements];
  const lastImport = lastImportResult.error ? null : lastImportResult.data;

  return (
    <>
      <PageHeader
        title="Diagnostics"
        subtitle="Read-only pilot checks for environment, Supabase connection, current profile, VMS import status, and core operating counts."
        action={<SecondaryButton href="/admin">Back to admin</SecondaryButton>}
      />

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Environment</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{environmentName()}</div>
          <div className="mt-2 text-sm text-slate-500">App URL: {process.env.NEXT_PUBLIC_APP_URL || "Not configured"}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Supabase</div>
          <div className="mt-2"><StatusBadge status="connected" /></div>
          <div className="mt-2 text-sm text-slate-500">{publicSupabaseHost()}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Current user</div>
          <div className="mt-2 text-lg font-semibold text-slate-900">{profile.full_name}</div>
          <div className="mt-2"><StatusBadge status={profile.role} /></div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Profile status</div>
          <div className="mt-2"><StatusBadge status={profile.active_status} /></div>
          <div className="mt-2 text-sm text-slate-500">Team ID: {profile.team_member_id?.slice(0, 8) ?? "-"}</div>
        </div>
      </section>

      <section className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Core Counts</h2>
        <DataTable headers={["Check", "Table", "Count", "Status", "Error"]}>
          {countChecks.map((check) => (
            <tr key={check.table}>
              <td className="font-medium">{check.label}</td>
              <td>{check.table}</td>
              <td>{check.count === null ? "-" : check.count}</td>
              <td><StatusBadge status={check.ok ? "ok" : "failed"} /></td>
              <td>{check.error ?? "-"}</td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Last VMS Import</h2>
        {lastImportResult.error ? (
          <ErrorState title="Could not load VMS import status" body={lastImportResult.error.message} />
        ) : !lastImport ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">No VMS import batches found yet.</div>
        ) : (
          <DataTable headers={["Imported", "Report type", "File", "Status", "Rows", "Imported rows", "Errors"]}>
            <tr>
              <td>{formatDate(lastImport.imported_at)}</td>
              <td>{String(lastImport.report_type ?? "-").replaceAll("_", " ")}</td>
              <td>{lastImport.file_name ?? "-"}</td>
              <td><StatusBadge status={lastImport.status} /></td>
              <td>{lastImport.row_count ?? 0}</td>
              <td>{lastImport.rows_imported ?? 0}</td>
              <td>{lastImport.error_count ?? 0}</td>
            </tr>
          </DataTable>
        )}
      </section>
    </>
  );
}
