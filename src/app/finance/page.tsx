import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function financeAllowed(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return profile && canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });
}

export default async function FinancePage() {
  const profile = await getCurrentProfile();
  if (!financeAllowed(profile)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  const { data } = supabase
    ? await supabase.from("financial_transactions").select("id, transaction_date, direction, transaction_kind, transaction_type, description, signed_amount, review_status, needs_review").order("transaction_date", { ascending: false }).limit(10)
    : { data: [] };

  const rows = (data ?? []) as any[];
  const totalIn = rows.filter((row) => row.direction === "money_in").reduce((sum, row) => sum + Number(row.signed_amount ?? 0), 0);
  const totalOut = Math.abs(rows.filter((row) => row.direction === "money_out").reduce((sum, row) => sum + Number(row.signed_amount ?? 0), 0));
  const reviewCount = rows.filter((row) => row.needs_review).length;

  return (
    <AppShell>
      <PageHeader
        title="Finance"
        subtitle="Snacky OS finance source of truth after the historical spreadsheet import."
        action={<PrimaryButton href="/finance/transactions/new">Manual money in/out</PrimaryButton>}
      />

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          <SecondaryButton href="/finance/transactions">Transactions</SecondaryButton>
          <SecondaryButton href="/cash-collections">Cash Collections</SecondaryButton>
          <SecondaryButton href="/finance/transactions?q=rent">Rent</SecondaryButton>
          <SecondaryButton href="/finance/transactions?q=machine%20investment">Machine Investments</SecondaryButton>
          <SecondaryButton href="/finance/transactions?direction=money_out">Expenses</SecondaryButton>
          <SecondaryButton href="/finance/transactions?direction=money_in">Revenue</SecondaryButton>
          <SecondaryButton href="/finance/reports">Reports</SecondaryButton>
          <SecondaryButton href="/finance/import">Import History</SecondaryButton>
        </div>
      </div>

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card"><div className="text-sm text-slate-500">Recent money in</div><div className="mt-1 text-3xl font-semibold">{lyd(totalIn)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Recent money out</div><div className="mt-1 text-3xl font-semibold">{lyd(totalOut)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Recent net</div><div className="mt-1 text-3xl font-semibold">{lyd(totalIn - totalOut)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Needs review</div><div className="mt-1 text-3xl font-semibold">{reviewCount}</div></div>
      </section>

      {!rows.length ? (
        <EmptyState title="No finance transactions yet" body="Import the historical CSV once or add a manual money in/out transaction." />
      ) : (
        <DataTable headers={["Date", "Direction", "Kind", "Type", "Description", "Amount", "Review"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.transaction_date}</td>
              <td><StatusBadge status={row.direction.replace("_", " ")} /></td>
              <td>{row.transaction_kind.replaceAll("_", " ")}</td>
              <td>{row.transaction_type ?? "-"}</td>
              <td>{row.description ?? "-"}</td>
              <td>{lyd(Number(row.signed_amount ?? 0))}</td>
              <td><StatusBadge status={row.review_status} /></td>
            </tr>
          ))}
        </DataTable>
      )}
      <div className="mt-4"><Link href="/finance/transactions" className="link-secondary">Open all transactions</Link></div>
    </AppShell>
  );
}
