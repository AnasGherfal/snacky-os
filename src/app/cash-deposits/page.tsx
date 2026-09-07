import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canBankCash } from "@/lib/authz";
import { lyd } from "@/lib/format";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(new Date(value));
}

export default async function CashDepositsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const messages = await searchParams;
  const profile = await getCurrentProfile();
  const context = profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null;
  if (!profile || !canAccessPath(context, "/cash-deposits")) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Bank deposits unavailable" body="Supabase is not configured." />;
  const { data, error } = await supabase
    .from("cash_bank_deposits")
    .select("id, deposited_at, amount_lyd, deposit_reference, destination_account, status, notes, recorded_by, recorder:team_members!cash_bank_deposits_recorded_by_fkey(id, full_name), allocations:cash_bank_deposit_allocations(id, cash_collection_id, amount_lyd)")
    .order("deposited_at", { ascending: false })
    .limit(500);
  if (error) {
    console.error("[cash] Failed to load bank deposits", error);
    return <ErrorState title="Could not load bank deposits" body="Apply the cash-chain migration together with this application version." action={<SecondaryButton href="/cash-deposits">Retry</SecondaryButton>} />;
  }
  const rows = data ?? [];
  const active = rows.filter((row: any) => row.status === "banked");
  const total = active.reduce((sum: number, row: any) => sum + Number(row.amount_lyd ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Cash Bank Deposits" subtitle="One bank receipt can close several fully reconciled cash bags, but its amount must equal their combined physical count exactly." action={<div className="flex gap-2"><SecondaryButton href="/cash-collections">Cash custody</SecondaryButton>{canBankCash(context) ? <PrimaryButton href="/cash-deposits/new">Record deposit</PrimaryButton> : null}</div>} />
      {messages.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{messages.error}</div> : null}
      {messages.success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{messages.success}</div> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <SectionCard><div className="text-sm text-slate-500">Active deposited total</div><div className="mt-2 text-2xl font-semibold">{lyd(total)}</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Active deposits</div><div className="mt-2 text-2xl font-semibold">{active.length}</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Batches closed</div><div className="mt-2 text-2xl font-semibold">{active.reduce((sum: number, row: any) => sum + (row.allocations?.length ?? 0), 0)}</div></SectionCard>
      </div>
      {!rows.length ? <EmptyState title="No bank deposits recorded" body="Reconcile cash batches first, then record the exact combined bank deposit and receipt." action={canBankCash(context) ? <PrimaryButton href="/cash-deposits/new">Record deposit</PrimaryButton> : undefined} /> : <>
        <MobileCardList>{rows.map((row: any) => <MobileRecordCard key={row.id}><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">{row.deposit_reference}</h2><p className="mt-1 text-xs text-slate-500">{row.destination_account}</p></div><StatusBadge status={row.status} /></div><div className="mt-4 grid grid-cols-2 gap-3"><MobileField label="Amount">{lyd(Number(row.amount_lyd ?? 0))}</MobileField><MobileField label="Deposited">{formatDate(row.deposited_at)}</MobileField><MobileField label="Batches">{row.allocations?.length ?? 0}</MobileField><MobileField label="Recorded by">{row.recorder?.full_name ?? "—"}</MobileField></div><Link href={`/cash-deposits/${row.id}`} className="btn-secondary mt-4 w-full">Open receipt</Link></MobileRecordCard>)}</MobileCardList>
        <DataTable className="hidden md:block" headers={["Reference", "Deposited", "Amount", "Batches", "Account", "Recorded by", "Status", "Action"]}>{rows.map((row: any) => <tr key={row.id}><td className="font-semibold">{row.deposit_reference}</td><td>{formatDate(row.deposited_at)}</td><td>{lyd(Number(row.amount_lyd ?? 0))}</td><td>{row.allocations?.length ?? 0}</td><td>{row.destination_account}</td><td>{row.recorder?.full_name ?? "—"}</td><td><StatusBadge status={row.status} /></td><td><Link href={`/cash-deposits/${row.id}`} className="btn-secondary px-3 py-2">Open</Link></td></tr>)}</DataTable>
      </>}
    </div>
  );
}
