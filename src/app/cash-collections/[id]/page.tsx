import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { getCashCollectionStatus } from "@/lib/cash-collections";
import { confirmCashCollectionCount, voidCashCollection } from "@/lib/cash-actions";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName } from "@/lib/machine-site-display";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

function money(value: number | string | null | undefined) {
  return value === null || value === undefined ? "-" : lyd(Number(value));
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
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/cash-collections")) {
    redirect("/unauthorized");
  }
  const canReviewMoney = canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: collection }, { data: finance }] = await Promise.all([
    supabase
      .from("cash_collections")
      .select(
        "id, route_id, machine_id, operator_id, collected_at, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, counted_at, counted_by, voided_at, void_reason, notes, machine:machines(id, name, machine_code, location:locations(id, name)), operator:team_members!cash_collections_operator_id_fkey(id, full_name), counted_by_member:team_members!cash_collections_counted_by_fkey(id, full_name), route:routes(id, route_date, status)",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("financial_transactions")
      .select("id, transaction_status, signed_amount, transaction_date, related_cash_collection_id, linked_cash_collection_id, source_type, source_id")
      .or(`related_cash_collection_id.eq.${id},linked_cash_collection_id.eq.${id},and(source_type.eq.cash_collection,source_id.eq.${id})`)
      .order("transaction_date", { ascending: false })
      .limit(1)
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
          subtitle={`${formatMachineDisplayName(collectionRow.machine ?? null, { includeArea: true })} collected on ${formatDate(collectionRow.collected_at)}`}
          breadcrumbs={[
            { label: "Finance", href: "/finance" },
            { label: "Cash Collections", href: "/cash-collections" },
            { label: formatMachineDisplayName(collectionRow.machine ?? null, { includeArea: true }) },
          ]}
          action={
            <div className="flex flex-wrap gap-2">
              <SecondaryButton href="/cash-collections">Back to cash</SecondaryButton>
              <SecondaryButton href="/finance/operations">Monthly reconciliation</SecondaryButton>
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
          <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{money(collectionRow.actual_cash_collected)}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Cash removed</div><div className="mt-2 text-base font-semibold text-slate-900">{formatDate(collectionRow.collected_at)}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Counted at</div><div className="mt-2 text-base font-semibold text-slate-900">{formatDate(collectionRow.counted_at)}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Status</div><div className="mt-3"><StatusBadge status={status.replaceAll("_", " ")} /></div></SectionCard>
        </div>

        <div className={`rounded-lg border p-4 text-sm ${status === "voided" ? "border-rose-200 bg-rose-50 text-rose-800" : needsCount ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-200 bg-sky-50 text-sky-950"}`}>
          {status === "voided"
            ? `This collection was voided. ${collectionRow.void_reason ?? ""}`
            : needsCount
              ? "Operator collection has been recorded. Finance still needs to count and confirm the envelope before balance changes."
              : "This pickup has been counted and posted to finance. Expected cash and shortage/overage are calculated for the complete machine month in Finance Operations, not for this individual pickup."}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <SectionCard>
            <h2 className="mb-4 text-lg font-semibold">Collection details</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <DetailItem label="Machine">{formatMachineDisplayName(collectionRow.machine ?? null, { includeArea: true })}<div className="text-sm text-slate-500">{collectionRow.machine?.machine_code ?? "-"}</div></DetailItem>
              <DetailItem label="Collected by">{collectionRow.operator?.full_name ?? "Unassigned"}</DetailItem>
              <DetailItem label="Route">{collectionRow.route?.id ? <Link href={`/routes/${collectionRow.route.id}`} className="link-secondary">{collectionRow.route.route_date}</Link> : "-"}</DetailItem>
              <DetailItem label="Route status">{collectionRow.route?.status ? <StatusBadge status={collectionRow.route.status} /> : "-"}</DetailItem>
              <DetailItem label="Cash bag">{collectionRow.cash_bag_id ?? "-"}</DetailItem>
              <DetailItem label="Counted by">{collectionRow.counted_by_member?.full_name ?? "-"}</DetailItem>
              <DetailItem label="Counted at">{formatDate(collectionRow.counted_at)}</DetailItem>
              <DetailItem label="Finance transaction status">
                {finance?.id ? <Link href={`/finance/transactions/${finance.id}`} className="link-secondary">View finance transaction ({finance.transaction_status ?? "active"})</Link> : "Not posted yet"}
              </DetailItem>
            </dl>
            <div className="mt-6">
              <div className="text-sm text-slate-500">Notes</div>
              <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{collectionRow.notes || "No notes recorded."}</p>
            </div>
          </SectionCard>

          <SectionCard>
            <h2 className="text-lg font-semibold">Count and confirm</h2>
            <p className="mt-1 text-sm text-slate-500">Enter only the physical amount counted from this envelope. Finance posts money-in after confirmation.</p>
            {canReviewMoney && status !== "voided" ? (
              <LocalDraftForm action={confirmCashCollectionCount} formType="cash-collection-count" draftKeyParts={[collectionRow.id]} className="mt-5 space-y-4">
                <input type="hidden" name="id" value={collectionRow.id} />
                <FormField label="Counted amount LYD" required hint="This pickup will be added to the machine's other pickups for the monthly close.">
                  <input name="counted_amount_lyd" type="number" min="0" step="0.01" required defaultValue={collectionRow.actual_cash_collected ?? ""} className="field-input" />
                </FormField>
                <FormField label="Cash bag / envelope ID">
                  <input name="cash_bag_id" defaultValue={collectionRow.cash_bag_id ?? ""} className="field-input" />
                </FormField>
                <FormField label="Count notes">
                  <textarea name="notes" rows={4} defaultValue={collectionRow.notes ?? ""} className="field-input" />
                </FormField>
                <button type="submit" className="btn-primary w-full">Confirm count and post finance</button>
              </LocalDraftForm>
            ) : (
              <p className="mt-4 text-sm text-slate-500">No count action is available for this collection.</p>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
