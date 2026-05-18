import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { isBalanceAffectingTransaction, signedAmount } from "@/lib/finance-balance";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function FinanceReportsPage() {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  const { data } = supabase
    ? await supabase.from("financial_transactions").select("transaction_date, direction, signed_amount, final_bucket, transaction_kind, needs_review, transaction_status").eq("transaction_status", "active").order("transaction_date", { ascending: false }).limit(2000)
    : { data: [] };
  const rows = (data ?? []) as any[];
  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const moneyIn = balanceRows.filter((row) => row.direction === "money_in").reduce((sum, row) => sum + signedAmount(row), 0);
  const moneyOut = Math.abs(balanceRows.filter((row) => row.direction === "money_out").reduce((sum, row) => sum + signedAmount(row), 0));
  const byBucket = new Map<string, number>();
  balanceRows.forEach((row) => byBucket.set(row.final_bucket ?? "Unbucketed", (byBucket.get(row.final_bucket ?? "Unbucketed") ?? 0) + signedAmount(row)));
  const bucketRows = Array.from(byBucket.entries()).map(([bucket, amount]) => ({ bucket, amount })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return (
    <AppShell>
      <PageHeader title="Finance Reports" subtitle="Approved active money in/out from Snacky OS financial transactions." action={<SecondaryButton href="/finance">Back to finance</SecondaryButton>} />
      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card"><div className="text-sm text-slate-500">Money in</div><div className="mt-1 text-3xl font-semibold">{lyd(moneyIn)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Money out</div><div className="mt-1 text-3xl font-semibold">{lyd(moneyOut)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Net</div><div className="mt-1 text-3xl font-semibold">{lyd(moneyIn - moneyOut)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Needs review</div><div className="mt-1 text-3xl font-semibold">{rows.filter((row) => row.needs_review).length}</div></div>
      </section>
      {!bucketRows.length ? (
        <EmptyState title="No finance data yet" body="Import historical transactions or add manual transactions to populate reports." />
      ) : (
        <DataTable headers={["Bucket", "Net amount"]}>
          {bucketRows.map((row) => <tr key={row.bucket}><td>{row.bucket}</td><td className="font-semibold">{lyd(row.amount)}</td></tr>)}
        </DataTable>
      )}
    </AppShell>
  );
}
