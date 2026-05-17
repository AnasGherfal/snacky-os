import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { importHistoricalFinanceTransactions } from "@/lib/finance-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function FinanceImportPage({ searchParams }: { searchParams: Promise<{ imported?: string; skipped?: string; error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");
  const params = await searchParams;
  const supabase = getSupabaseServerClient();
  const { data } = supabase
    ? await supabase.from("financial_transactions").select("id, transaction_date, description, signed_amount, source_sheet, source_row, needs_review").eq("source_sheet", "financial_transactions.csv").order("source_row", { ascending: false }).limit(10)
    : { data: [] };

  return (
    <AppShell>
      <PageHeader title="Finance Import" subtitle="One-time import from docs/current-data/financial_transactions.csv. Daily finance continues inside Snacky OS." action={<SecondaryButton href="/finance">Back to finance</SecondaryButton>} />
      {params.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{params.error}</div> : null}
      {params.imported !== undefined ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">Imported {params.imported} rows. Skipped {params.skipped ?? 0} rows already in Snacky OS.</div> : null}

      <section className="surface-card mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Import historical spreadsheet rows</h2>
        <p className="mt-2 text-sm text-slate-500">This importer is idempotent by source sheet and source row. It preserves Arabic descriptions exactly as stored in the CSV and marks TO_CONFIRM/Review rows for admin review.</p>
        <form action={importHistoricalFinanceTransactions} className="mt-4">
          <PrimaryButton>Import CSV rows</PrimaryButton>
        </form>
      </section>

      {!data?.length ? (
        <EmptyState title="No imported finance rows yet" body="Run the import once to load historical spreadsheet transactions." />
      ) : (
        <DataTable headers={["Source row", "Date", "Description", "Amount", "Review"]}>
          {data.map((row: any) => (
            <tr key={row.id}>
              <td>{row.source_sheet}:{row.source_row}</td>
              <td>{row.transaction_date}</td>
              <td>{row.description ?? "-"}</td>
              <td>{row.signed_amount}</td>
              <td><StatusBadge status={row.needs_review ? "needs_review" : "confirmed"} /></td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
