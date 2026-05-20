import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { FinanceTransactionStatusActions } from "@/components/FinanceTransactionStatusActions";
import { PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { isBalanceAffectingTransaction } from "@/lib/finance-balance";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function label(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "-";
}

function category(row: any) {
  return row.final_bucket ?? row.transaction_type ?? String(row.transaction_kind ?? "transaction").replaceAll("_", " ");
}

function DetailItem({ label: itemLabel, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-slate-500">{itemLabel}</div>
      <div className="mt-1 font-medium text-slate-900">{children}</div>
    </div>
  );
}

export default async function FinanceTransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; saved?: string; status?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");

  const { id } = await params;
  const flags = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const { data: transaction } = await supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle();
  if (!transaction) notFound();
  const row = transaction as any;
  const affectsBalance = isBalanceAffectingTransaction(row);

  const [purchase, route, machine, location] = await Promise.all([
    row.related_purchase_id ? supabase.from("purchase_orders").select("id, receipt_number, order_date, payment_method, receipt_url").eq("id", row.related_purchase_id).maybeSingle() : Promise.resolve({ data: null }),
    row.related_route_id ? supabase.from("routes").select("id, route_date, status").eq("id", row.related_route_id).maybeSingle() : Promise.resolve({ data: null }),
    row.related_machine_id ? supabase.from("machines").select("id, name, machine_code").eq("id", row.related_machine_id).maybeSingle() : Promise.resolve({ data: null }),
    row.related_location_id ? supabase.from("locations").select("id, name").eq("id", row.related_location_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  return (
    <>
      <PageHeader
        title="Finance Transaction"
        subtitle="Ledger detail, source context, and audit-safe status actions."
        breadcrumbs={[
          { label: "Finance", href: "/finance" },
          { label: "Transactions", href: "/finance/transactions" },
          { label: row.description ? String(row.description).slice(0, 40) : id.slice(0, 8) },
        ]}
        action={<SecondaryButton href="/finance/transactions">Back to transactions</SecondaryButton>}
      />
      {flags.error ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800 shadow-lg">{flags.error}</div> : null}
      {flags.created ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg">Transaction created.</div> : null}
      {flags.saved ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg">Transaction saved.</div> : null}
      {flags.status ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg">Transaction {flags.status}.</div> : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <section className="surface-card">
          <div className="grid gap-5 md:grid-cols-3">
            <DetailItem label="Date">{row.transaction_date}</DetailItem>
            <DetailItem label="Direction"><StatusBadge status={label(row.direction)} /></DetailItem>
            <DetailItem label="Status"><StatusBadge status={row.transaction_status ?? "active"} /></DetailItem>
            <DetailItem label="Balance impact"><StatusBadge status={affectsBalance ? "included" : "excluded"} /></DetailItem>
            <DetailItem label="Category">{category(row)}</DetailItem>
            <DetailItem label="Amount"><span className={Number(row.signed_amount ?? 0) < 0 ? "text-rose-700" : "text-emerald-700"}>{lyd(Number(row.signed_amount ?? 0))}</span></DetailItem>
            <DetailItem label="Payment method">{label(row.payment_method)}</DetailItem>
            <DetailItem label="Kind">{label(row.transaction_kind)}</DetailItem>
            <DetailItem label="Review"><StatusBadge status={row.needs_review ? "needs_review" : row.review_status} /></DetailItem>
            <DetailItem label="Receipt">{row.receipt_url ? <a href={row.receipt_url} target="_blank" rel="noreferrer" className="link-secondary">Open receipt</a> : "-"}</DetailItem>
          </div>
          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-medium uppercase text-slate-500">Description / notes</div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{row.description ?? row.notes ?? "-"}</p>
          </div>
        </section>

        <section className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">Actions</h2>
          <div className="mt-4 space-y-3">
            <Link href={`/finance/transactions/${id}/edit`} className="btn-primary w-full">Edit transaction</Link>
            <FinanceTransactionStatusActions id={id} status={row.transaction_status ?? "active"} />
          </div>
        </section>
      </div>

      <section className="surface-card mt-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Related records</h2>
        <div className="grid gap-5 md:grid-cols-4">
          <DetailItem label="Purchase">{purchase.data ? <Link href={`/purchases/${purchase.data.id}`} className="link-secondary">{purchase.data.receipt_number ?? purchase.data.id.slice(0, 8)}</Link> : "-"}</DetailItem>
          <DetailItem label="Route">{route.data ? <Link href={`/routes/${route.data.id}`} className="link-secondary">{route.data.route_date}</Link> : "-"}</DetailItem>
          <DetailItem label="Machine">{machine.data ? <Link href={`/machines/${machine.data.id}/edit`} className="link-secondary">{machine.data.machine_code ?? machine.data.name}</Link> : "-"}</DetailItem>
          <DetailItem label="Location">{location.data ? <Link href={`/locations/${location.data.id}`} className="link-secondary">{location.data.name}</Link> : row.location ?? "-"}</DetailItem>
        </div>
      </section>

      <section className="surface-card mt-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Source and audit</h2>
        <div className="grid gap-5 md:grid-cols-4">
          <DetailItem label="Source">{row.source_sheet ? `${row.source_sheet}:${row.source_row}` : "Manual"}</DetailItem>
          <DetailItem label="Original description">{row.original_description ?? "-"}</DetailItem>
          <DetailItem label="Voided at">{row.voided_at ? new Date(row.voided_at).toLocaleString("en-US") : "-"}</DetailItem>
          <DetailItem label="Archived at">{row.archived_at ? new Date(row.archived_at).toLocaleString("en-US") : "-"}</DetailItem>
        </div>
        {row.status_reason ? <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{row.status_reason}</p> : null}
      </section>
    </>
  );
}
