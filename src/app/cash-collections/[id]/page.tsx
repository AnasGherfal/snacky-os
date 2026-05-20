import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormField, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { getCashCollectionStatus, isCriticalCashVariance, isLargeCashVariance } from "@/lib/cash-collections";
import { confirmCashCollectionCount, voidCashCollection } from "@/lib/cash-actions";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

function money(value: number | string | null | undefined) {
  return value === null || value === undefined ? "-" : lyd(Number(value));
}

function varianceTone(variance: number | null | undefined) {
  if (variance === null || variance === undefined) return "border-slate-200 bg-slate-50 text-slate-700";
  if (isCriticalCashVariance(variance)) return "border-rose-200 bg-rose-50 text-rose-800";
  if (isLargeCashVariance(variance)) return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium text-slate-900">{children}</dd>
    </div>
  );
}

export default async function CashCollectionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error = "" } = await searchParams;
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/cash-collections")) {
    redirect("/unauthorized");
  }
  const canReviewMoney = canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });

  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: collection }, { data: finance }] = await Promise.all([
    supabase
      .from("cash_collections")
      .select(
        "id, route_id, machine_id, operator_id, collected_at, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, counted_at, counted_by, voided_at, void_reason, notes, machine:machines(id, name, machine_code), operator:team_members!cash_collections_operator_id_fkey(id, full_name), counted_by_member:team_members!cash_collections_counted_by_fkey(id, full_name), route:routes(id, route_date, status)",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("financial_transactions")
      .select("id, transaction_status, signed_amount, transaction_date")
      .eq("related_cash_collection_id", id)
      .eq("transaction_kind", "cash_collection")
      .maybeSingle(),
  ]);

  if (!collection) notFound();

  const collectionRow: any = collection;
  const variance = collectionRow.variance === null || collectionRow.variance === undefined ? null : Number(collectionRow.variance);
  const status = getCashCollectionStatus(collectionRow.review_status, variance);
  const needsCount = status === "pending_collection" || status === "collected_pending_count";

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Cash Collection"
          subtitle={`${collectionRow.machine?.name ?? "Machine"} collected on ${formatDate(collectionRow.collected_at)}`}
          breadcrumbs={[
            { label: "Finance", href: "/finance" },
            { label: "Cash Collections", href: "/cash-collections" },
            { label: collectionRow.machine?.name ?? "Collection" },
          ]}
          action={
            <div className="flex flex-wrap gap-2">
              <SecondaryButton href="/cash-collections">Back to cash</SecondaryButton>
              {canReviewMoney && status !== "voided" ? <SecondaryButton href={`/cash-collections/${id}/edit`}>Edit</SecondaryButton> : null}
              {canReviewMoney && status !== "voided" ? (
                <ConfirmDialog
                  action={voidCashCollection}
                  triggerLabel="Void collection"
                  title="Void cash collection?"
                  description="The cash collection stays in history and its linked finance transaction will be voided so it no longer affects balance."
                  confirmLabel="Void collection"
                  buttonClassName="btn-danger"
                  confirmButtonClassName="btn-danger"
                  hiddenFields={[{ name: "id", value: id }]}
                />
              ) : null}
            </div>
          }
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}

        <div className="grid gap-4 lg:grid-cols-4">
          <SectionCard><div className="text-sm text-slate-500">Expected cash</div><div className="mt-2 text-2xl font-semibold text-slate-900">{money(collectionRow.vms_expected_cash)}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{money(collectionRow.actual_cash_collected)}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Variance</div><div className="mt-2 text-2xl font-semibold text-slate-900">{money(variance)}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Status</div><div className="mt-3"><StatusBadge status={status.replaceAll("_", " ")} /></div></SectionCard>
        </div>

        <div className={`rounded-lg border p-4 text-sm ${varianceTone(variance)}`}>
          {status === "voided"
            ? `This collection was voided. ${collectionRow.void_reason ?? ""}`
            : needsCount
              ? "Operator collection has been recorded. Finance still needs to count and confirm the envelope before balance changes."
              : status === "variance_review"
                ? "This collection has a variance that should be reviewed before closing the cash cycle."
                : "This collection has been counted and posted to finance."}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <SectionCard>
            <h2 className="mb-4 text-lg font-semibold">Collection details</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <DetailItem label="Machine">{collectionRow.machine?.name ?? "Unknown machine"}<div className="text-sm text-slate-500">{collectionRow.machine?.machine_code ?? "-"}</div></DetailItem>
              <DetailItem label="Collected by">{collectionRow.operator?.full_name ?? "Unassigned"}</DetailItem>
              <DetailItem label="Route">{collectionRow.route?.id ? <Link href={`/routes/${collectionRow.route.id}`} className="link-secondary">{collectionRow.route.route_date}</Link> : "-"}</DetailItem>
              <DetailItem label="Route status">{collectionRow.route?.status ? <StatusBadge status={collectionRow.route.status} /> : "-"}</DetailItem>
              <DetailItem label="Cash bag">{collectionRow.cash_bag_id ?? "-"}</DetailItem>
              <DetailItem label="Counted by">{collectionRow.counted_by_member?.full_name ?? "-"}</DetailItem>
              <DetailItem label="Counted at">{formatDate(collectionRow.counted_at)}</DetailItem>
              <DetailItem label="Finance transaction">
                {finance?.id ? <Link href={`/finance/transactions/${finance.id}`} className="link-secondary">{finance.transaction_status ?? "active"}</Link> : "Not posted yet"}
              </DetailItem>
            </dl>
            <div className="mt-6">
              <div className="text-sm text-slate-500">Notes</div>
              <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{collectionRow.notes || "No notes recorded."}</p>
            </div>
          </SectionCard>

          <SectionCard>
            <h2 className="text-lg font-semibold">Count and confirm</h2>
            <p className="mt-1 text-sm text-slate-500">Finance posts money-in only after the envelope is counted.</p>
            {canReviewMoney && status !== "voided" ? (
              <form action={confirmCashCollectionCount} className="mt-5 space-y-4">
                <input type="hidden" name="id" value={collectionRow.id} />
                <FormField label="Counted amount LYD" required>
                  <input name="counted_amount_lyd" type="number" min="0" step="0.01" required defaultValue={collectionRow.actual_cash_collected ?? ""} className="field-input" />
                </FormField>
                <FormField label="Expected cash LYD">
                  <input name="expected_cash_lyd" type="number" min="0" step="0.01" defaultValue={collectionRow.vms_expected_cash ?? ""} className="field-input" />
                </FormField>
                <FormField label="Cash bag / envelope ID">
                  <input name="cash_bag_id" defaultValue={collectionRow.cash_bag_id ?? ""} className="field-input" />
                </FormField>
                <FormField label="Count notes">
                  <textarea name="notes" rows={4} defaultValue={collectionRow.notes ?? ""} className="field-input" />
                </FormField>
                <button type="submit" className="btn-primary w-full">Confirm count and post finance</button>
              </form>
            ) : (
              <p className="mt-4 text-sm text-slate-500">No count action is available for this collection.</p>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
