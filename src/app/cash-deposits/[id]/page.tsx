import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canApproveCashVariance } from "@/lib/authz";
import { voidCashBankDeposit } from "@/lib/cash-actions";
import { lyd } from "@/lib/format";
import { CASH_EVIDENCE_BUCKET, privateStorageObjectUrl } from "@/lib/storage-buckets";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(new Date(value));
}

export default async function CashDepositDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const { id } = await params;
  const messages = await searchParams;
  const profile = await getCurrentProfile();
  const context = profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null;
  if (!profile || !canAccessPath(context, `/cash-deposits/${id}`)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) notFound();
  const { data, error } = await supabase
    .from("cash_bank_deposits")
    .select("id, deposited_at, amount_lyd, deposit_reference, destination_account, receipt_storage_path, receipt_file_name, notes, status, recorded_by, voided_at, void_reason, recorder:team_members!cash_bank_deposits_recorded_by_fkey(id, full_name), voider:team_members!cash_bank_deposits_voided_by_fkey(id, full_name), allocations:cash_bank_deposit_allocations(id, cash_collection_id, amount_lyd, cash:cash_collections(id, cash_bag_id, actual_cash_collected, custody_status, reconciled_at))")
    .eq("id", id)
    .maybeSingle();
  if (error) console.error("[cash] Failed to load bank deposit", error);
  if (!data) notFound();
  const row: any = data;
  const receiptUrl = privateStorageObjectUrl(CASH_EVIDENCE_BUCKET, row.receipt_storage_path);
  const allocationTotal = (row.allocations ?? []).reduce((sum: number, allocation: any) => sum + Number(allocation.amount_lyd ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title={`Bank Deposit ${row.deposit_reference}`} subtitle="This receipt closes the exact combined total of every linked reconciled cash bag." breadcrumbs={[{ label: "Cash Custody", href: "/cash-collections" }, { label: "Bank Deposits", href: "/cash-deposits" }, { label: row.deposit_reference }]} action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/cash-deposits">Back</SecondaryButton>{row.status === "banked" && canApproveCashVariance(context) ? <ConfirmDialog action={voidCashBankDeposit} triggerLabel="Void deposit" title="Void this bank deposit?" description="All linked cash bags will reopen as reconciled but unbanked. The original receipt and history remain." confirmLabel="Void deposit" buttonClassName="btn-danger" confirmButtonClassName="btn-danger" hiddenFields={[{ name: "id", value: id }]} /> : null}</div>} />
      {messages.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{messages.error}</div> : null}
      {messages.success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{messages.success}</div> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <SectionCard><div className="text-sm text-slate-500">Bank receipt amount</div><div className="mt-2 text-3xl font-semibold">{lyd(Number(row.amount_lyd ?? 0))}</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Linked batch total</div><div className="mt-2 text-3xl font-semibold">{lyd(allocationTotal)}</div><div className="mt-1 text-xs text-emerald-700">Exact match enforced by database</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Status</div><div className="mt-3"><StatusBadge status={row.status} /></div></SectionCard>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <SectionCard>
          <h2 className="text-lg font-semibold">Cash bags on this receipt</h2>
          <div className="mt-4 space-y-2">{(row.allocations ?? []).map((allocation: any) => { const cash = Array.isArray(allocation.cash) ? allocation.cash[0] : allocation.cash; return <div key={allocation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-4"><div><Link href={`/cash-collections/${allocation.cash_collection_id}`} className="font-semibold link-secondary">Bag {cash?.cash_bag_id ?? allocation.cash_collection_id.slice(0, 8)}</Link><div className="mt-1 text-xs text-slate-500">Reconciled {formatDate(cash?.reconciled_at)}</div></div><div className="text-end"><div className="font-semibold">{lyd(Number(allocation.amount_lyd ?? 0))}</div><StatusBadge status={cash?.custody_status ?? row.status} /></div></div>; })}</div>
        </SectionCard>
        <SectionCard>
          <h2 className="text-lg font-semibold">Receipt details</h2>
          <dl className="mt-4 space-y-4 text-sm"><div><dt className="text-slate-500">Deposited at</dt><dd className="mt-1 font-semibold">{formatDate(row.deposited_at)}</dd></div><div><dt className="text-slate-500">Destination</dt><dd className="mt-1 font-semibold">{row.destination_account}</dd></div><div><dt className="text-slate-500">Recorded by</dt><dd className="mt-1 font-semibold">{row.recorder?.full_name ?? "—"}</dd></div><div><dt className="text-slate-500">Bank receipt</dt><dd className="mt-1">{receiptUrl ? <Link href={receiptUrl} target="_blank" className="link-secondary">Open {row.receipt_file_name ?? "receipt"}</Link> : "—"}</dd></div><div><dt className="text-slate-500">Notes</dt><dd className="mt-1 text-slate-700">{row.notes || "—"}</dd></div>{row.status === "voided" ? <><div><dt className="text-slate-500">Voided at</dt><dd className="mt-1 font-semibold text-rose-800">{formatDate(row.voided_at)}</dd></div><div><dt className="text-slate-500">Voided by / reason</dt><dd className="mt-1 text-rose-800">{row.voider?.full_name ?? "—"}: {row.void_reason}</dd></div></> : null}</dl>
        </SectionCard>
      </div>
    </div>
  );
}
