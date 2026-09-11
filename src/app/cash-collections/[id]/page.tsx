import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  CashCountForm,
  CashReconciliationForms,
  CashStorageReceiptForm,
  CashVarianceResolutionForm,
} from "@/components/CashCustodyForms";
import { PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import {
  canAccessPath,
  canApproveCashVariance,
  canCountCash,
  canReceiveCashStorage,
  canReconcileCash,
  canViewFinancials,
  hasAnyRole,
} from "@/lib/authz";
import {
  calculateCashExpectation,
  confirmCashCollectionCount,
  receiveCashIntoStorage,
  reconcileCashCollection,
  resolveCashVariance,
  voidCashCollection,
} from "@/lib/cash-actions";
import { cashCustodyStatusLabel, getCashCustodyAlerts, missingCashAmount } from "@/lib/cash-custody";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { CASH_EVIDENCE_BUCKET, privateStorageObjectUrl } from "@/lib/storage-buckets";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Tripoli",
  }).format(new Date(value));
}

function formatDateInput(value: string | null | undefined) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Africa/Tripoli",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function money(value: number | string | null | undefined) {
  return value === null || value === undefined ? "—" : lyd(Number(value));
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-sm text-slate-500">{label}</dt><dd className="mt-1 break-words font-medium text-slate-900">{children}</dd></div>;
}

function CustodyStages({ status }: { status: string }) {
  const stages = [
    { key: "waiting", label: "Waiting to be counted", complete: ["counted", "reconciled", "banked"].includes(status) },
    { key: "reconciled", label: status === "counted" ? "VMS check — do later" : "Counted & reconciled", complete: ["reconciled", "banked"].includes(status) },
  ];
  return (
    <ol className="grid gap-2 sm:grid-cols-2" aria-label="Cash custody stages">
      {stages.map(({ key, label, complete }, index) => {
        return (
          <li key={key} className={`rounded-lg border p-3 text-center text-sm font-semibold ${complete ? "border-emerald-200 bg-emerald-50 text-emerald-900" : status === "voided" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
            <div className="text-xs font-bold">{complete ? "✓" : index + 1}</div>
            <div className="mt-1">{label}</div>
          </li>
        );
      })}
    </ol>
  );
}

function machineSummary(machineLinks: any[]) {
  if (machineLinks.length === 1) return formatMachineDisplayName(machineLinks[0]?.machine ?? null, { includeArea: true });
  if (machineLinks.length > 1) return `${machineLinks.length} machines in one sealed batch`;
  return "Cash custody batch";
}

const eventLabels: Record<string, string> = {
  removed: "Cash removed and bag sealed",
  stored: "Bag received into storage",
  counted: "Cash total counted",
  expectation_calculated: "VMS expectation calculated",
  reconciled: "Combined total reconciled",
  variance_flagged: "Owner review required",
  variance_resolved: "Variance resolved by owner/admin",
  banked: "Legacy bank deposit recorded",
  bank_deposit_voided: "Legacy bank deposit voided",
  voided: "Cash batch voided",
};

export default async function CashCollectionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const messages = await searchParams;
  const profile = await getCurrentProfile();
  const context = profile ? {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  } : null;
  if (!profile || !canAccessPath(context, `/cash-collections/${id}`)) redirect("/unauthorized");

  const canSeeMoney = canViewFinancials(context);
  const canReceive = canReceiveCashStorage(context);
  const canCount = canCountCash(context);
  const canReconcile = canReconcileCash(context);
  const canResolve = canApproveCashVariance(context);
  const isOwnerOrAdmin = hasAnyRole(context, ["owner", "admin"]);
  const backHref = canSeeMoney || canReceive ? "/cash-collections" : "/operator/routes";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) notFound();

  if (!canSeeMoney) {
    const { data: receipt, error: receiptError } = await supabase
      .from("cash_removal_receipts")
      .select("cash_collection_id, operator_id, cash_bag_id, collected_at, custody_status, storage_received_at, storage_received_by, storage_location, removal_evidence_path, removal_evidence_file_name, removal_notes, operator:team_members!cash_removal_receipts_operator_id_fkey(id, full_name), receiver:team_members!cash_removal_receipts_storage_received_by_fkey(id, full_name), machine_links:cash_removal_receipt_machines(removal_type, compartments, machine:machines(id, name, machine_code, location:locations(id, name)))")
      .eq("cash_collection_id", id)
      .maybeSingle();
    if (receiptError) console.error("[cash] Failed to load amount-free custody receipt", receiptError);
    if (!receipt) notFound();
    const row: any = receipt;
    const machines = (row.machine_links ?? []) as any[];
    const summary = machineSummary(machines);
    const isOwnCollection = row.operator_id === profile.team_member_id;
    const mayAcknowledge = canReceive && (!isOwnCollection || isOwnerOrAdmin);
    const removalEvidenceUrl = privateStorageObjectUrl(CASH_EVIDENCE_BUCKET, row.removal_evidence_path);

    return (
      <div className="space-y-6">
        <PageHeader
          title={`Cash Bag ${row.cash_bag_id}`}
          subtitle={`${summary} — no cash amount is visible in this operational receipt.`}
          breadcrumbs={[{ label: canReceive ? "Cash Custody" : "Operations", href: backHref }, { label: row.cash_bag_id }]}
          action={<SecondaryButton href={backHref}>Back</SecondaryButton>}
        />
        {messages.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{messages.error}</div> : null}
        {messages.success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{messages.success}</div> : null}
        <SectionCard><CustodyStages status={row.custody_status} /></SectionCard>
        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <SectionCard>
            <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Amount-free custody receipt</h2><StatusBadge status={row.custody_status} label={cashCustodyStatusLabel(row.custody_status)} /></div>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <DetailItem label="Bag / seal ID">{row.cash_bag_id}</DetailItem>
              <DetailItem label="Removed at">{formatDate(row.collected_at)}</DetailItem>
              <DetailItem label="Collected by">{row.operator?.full_name ?? "—"}</DetailItem>
              <DetailItem label="Storage received at">{formatDate(row.storage_received_at)}</DetailItem>
              <DetailItem label="Received by">{row.receiver?.full_name ?? "—"}</DetailItem>
              <DetailItem label="Storage location">{row.storage_location ?? "—"}</DetailItem>
              <DetailItem label="Removal evidence">{removalEvidenceUrl ? <Link className="link-secondary" href={removalEvidenceUrl} target="_blank">Open sealed-bag photo</Link> : "—"}</DetailItem>
              <DetailItem label="Route">Not connected to a route</DetailItem>
            </dl>
            <div className="mt-6">
              <div className="text-sm text-slate-500">Machines and compartments</div>
              <div className="mt-2 space-y-2">
                {machines.map((entry, index) => <div key={entry.machine?.id ?? index} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"><div className="font-semibold text-slate-900">{formatMachineDisplayName(entry.machine ?? null, { includeArea: true })}</div><div className="mt-1 text-slate-600">{entry.removal_type === "partial" ? "Partial removal" : "Fully emptied"} · {(entry.compartments ?? []).join(", ")}</div></div>)}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <h2 className="text-lg font-semibold">Storage handoff</h2>
            {row.custody_status === "removed" && mayAcknowledge ? (
              <><p className="mt-1 text-sm text-slate-500">{isOwnCollection ? "Owner/admin self-receipt is allowed and recorded in the audit history." : "A different authorized person verifies and receives the sealed bag."}</p><CashStorageReceiptForm action={receiveCashIntoStorage} id={id} clientSubmissionId={crypto.randomUUID()} /></>
            ) : row.custody_status === "removed" && canReceive ? (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">The collector cannot acknowledge their own handoff. Ask a different warehouse, supervisor, finance, owner, or admin user to receive this sealed bag.</p>
            ) : (
              <p className="mt-4 text-sm text-slate-600">{row.custody_status === "voided" ? "This receipt is voided." : "Handoff is complete. Finance continues the count and VMS check without exposing amounts here."}</p>
            )}
          </SectionCard>
        </div>
      </div>
    );
  }

  const [{ data: collection, error: collectionError }, { data: events }, { data: finance }] = await Promise.all([
    supabase
      .from("cash_collections")
      .select("id, route_id, machine_id, operator_id, collected_at, cash_period_start, cash_period_end, vms_expected_cash, actual_cash_collected, variance, review_status, custody_status, reconciliation_status, cash_bag_id, storage_received_at, storage_received_by, storage_location, storage_seal_condition, storage_notes, counted_at, counted_by, expected_source, expected_calculated_at, reconciled_at, reconciled_by, reconciliation_note, variance_resolution, voided_at, void_reason, notes, operator:team_members!cash_collections_operator_id_fkey(id, full_name), storage_receiver:team_members!cash_collections_storage_received_by_fkey(id, full_name), counter:team_members!cash_collections_counted_by_fkey(id, full_name), reconciler:team_members!cash_collections_reconciled_by_fkey(id, full_name), machine_links:cash_collection_machines(machine_id, removal_type, compartments, interval_start_at, interval_end_at, expectation_status, expectation_source, vms_sales_count, machine:machines(id, name, machine_code, location:locations(id, name)))")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("cash_collection_events")
      .select("id, event_type, event_at, amount_lyd, seal_condition, evidence_storage_path, evidence_file_name, notes, metadata, actor:team_members!cash_collection_events_actor_team_member_id_fkey(id, full_name)")
      .eq("cash_collection_id", id)
      .order("event_at", { ascending: true }),
    supabase
      .from("financial_transactions")
      .select("id, transaction_status")
      .or(`related_cash_collection_id.eq.${id},linked_cash_collection_id.eq.${id},and(source_type.eq.cash_collection,source_id.eq.${id})`)
      .order("transaction_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (collectionError) console.error("[cash] Failed to load custody batch", collectionError);
  if (!collection) notFound();

  const row: any = collection;
  const machines = (row.machine_links ?? []) as any[];
  const summary = machineSummary(machines);
  const variance = row.variance === null || row.variance === undefined ? null : Number(row.variance);
  const shortage = missingCashAmount(row.actual_cash_collected, row.vms_expected_cash);
  const alerts = getCashCustodyAlerts(row);
  const isOwnCollection = row.operator_id === profile.team_member_id;
  const mayReceive = canReceive && (!isOwnCollection || isOwnerOrAdmin);
  const status = String(row.custody_status ?? "removed");

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Cash Bag ${row.cash_bag_id ?? id.slice(0, 8)}`}
        subtitle={`${summary} removed ${formatDate(row.collected_at)}. Reconciliation is always on the combined batch total.`}
        breadcrumbs={[{ label: "Cash Custody", href: "/cash-collections" }, { label: row.cash_bag_id ?? id.slice(0, 8) }]}
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/cash-collections">Back</SecondaryButton>{canResolve && status !== "voided" ? <ConfirmDialog action={voidCashCollection} triggerLabel="Void batch" title="Void this immutable cash batch?" description="Use this only for a duplicate or invalid record. History and evidence remain." confirmLabel="Void batch" buttonClassName="btn-danger" confirmButtonClassName="btn-danger" hiddenFields={[{ name: "id", value: id }]} /> : null}</div>}
      />
      {messages.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{messages.error}</div> : null}
      {messages.success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{messages.success}</div> : null}
      {alerts.map((alert, index) => <div key={`${alert.label}-${index}`} className={`rounded-lg border p-4 text-sm ${alert.severity === "critical" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}><div className="font-semibold">{alert.label}</div><p className="mt-1">{alert.detail}</p></div>)}

      <SectionCard><CustodyStages status={status} /></SectionCard>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SectionCard><div className="text-sm text-slate-500">Combined VMS cash expected</div><div className="mt-2 text-2xl font-semibold text-slate-900">{money(row.vms_expected_cash)}</div><div className="mt-1 text-xs text-slate-500">{row.expected_source?.replaceAll("_", " ") ?? "Not calculated"}</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Combined physical count</div><div className="mt-2 text-2xl font-semibold text-slate-900">{money(row.actual_cash_collected)}</div><div className="mt-1 text-xs text-slate-500">One total, never a made-up machine split</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Missing cash</div><div className={`mt-2 text-2xl font-semibold ${shortage && shortage > 0 ? "text-rose-700" : "text-slate-900"}`}>{money(shortage)}</div><div className="mt-1 text-xs text-slate-500">{variance !== null && variance > 0 ? `Overage ${money(variance)}` : "Expected minus counted"}</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Custody status</div><div className="mt-3"><StatusBadge status={status} label={cashCustodyStatusLabel(status)} /></div><div className="mt-2 text-xs text-slate-500">Reconciliation: {String(row.reconciliation_status ?? "pending").replaceAll("_", " ")}</div></SectionCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_430px]">
        <div className="space-y-6">
          <SectionCard>
            <h2 className="text-lg font-semibold">Custody and combined-total details</h2>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailItem label="Bag / seal ID">{row.cash_bag_id ?? "Legacy record"}</DetailItem>
              <DetailItem label="Removed at">{formatDate(row.collected_at)}</DetailItem>
              <DetailItem label="Collected by">{row.operator?.full_name ?? "—"}</DetailItem>
              <DetailItem label="Storage received">{formatDate(row.storage_received_at)}</DetailItem>
              <DetailItem label="Received by">{row.storage_receiver?.full_name ?? "—"}</DetailItem>
              <DetailItem label="Storage location">{row.storage_location ?? "—"}</DetailItem>
              <DetailItem label="Storage seal">{row.storage_seal_condition ?? "—"}</DetailItem>
              <DetailItem label="Counted at">{formatDate(row.counted_at)}</DetailItem>
              <DetailItem label="Counted by">{row.counter?.full_name ?? "—"}</DetailItem>
              <DetailItem label="Cash period">{row.cash_period_start && row.cash_period_end ? `${row.cash_period_start} → ${row.cash_period_end}` : "Legacy count"}</DetailItem>
              <DetailItem label="Reconciled at">{formatDate(row.reconciled_at)}</DetailItem>
              <DetailItem label="Reconciled by">{row.reconciler?.full_name ?? "—"}</DetailItem>
              <DetailItem label="Finance ledger">{finance?.id ? <Link href={`/finance/transactions/${finance.id}`} className="link-secondary">Open {finance.transaction_status ?? "active"} entry</Link> : "Not posted"}</DetailItem>
              <DetailItem label="Route">{row.route_id ? "Legacy reference only" : "Not connected to a route"}</DetailItem>
            </dl>
            {(row.notes || row.storage_notes || row.reconciliation_note || row.void_reason) ? <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"><div className="font-semibold text-slate-900">Notes and resolution</div>{row.notes ? <p className="mt-2">Removal: {row.notes}</p> : null}{row.storage_notes ? <p className="mt-2">Storage: {row.storage_notes}</p> : null}{row.reconciliation_note ? <p className="mt-2">Reconciliation: {row.reconciliation_note}</p> : null}{row.variance_resolution ? <p className="mt-2">Resolution category: {row.variance_resolution.replaceAll("_", " ")}</p> : null}{row.void_reason ? <p className="mt-2 text-rose-800">Void reason: {row.void_reason}</p> : null}</div> : null}
          </SectionCard>

          <SectionCard>
            <h2 className="text-lg font-semibold">Machines included—diagnostics only</h2>
            <p className="mt-1 text-sm text-slate-500">Machine intervals establish the VMS source. Snacky OS compares only their combined expected total with the one physical bag count.</p>
            <div className="mt-4 space-y-3">
              {machines.map((entry, index) => <div key={entry.machine_id ?? index} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-semibold text-slate-900">{formatMachineDisplayName(entry.machine ?? null, { includeArea: true })}</div><div className="mt-1 text-xs text-slate-500">{entry.removal_type === "partial" ? "Partial removal" : "Fully emptied"} · {(entry.compartments ?? []).join(", ")}</div></div><StatusBadge status={entry.expectation_status} /></div><div className="mt-3 text-xs text-slate-600">VMS interval: {formatDate(entry.interval_start_at)} → {formatDate(entry.interval_end_at)} · {entry.vms_sales_count ?? "—"} deduplicated sales</div></div>)}
            </div>
          </SectionCard>

          <SectionCard>
            <h2 className="text-lg font-semibold">Immutable custody history</h2>
            <div className="mt-4 space-y-3">
              {(events ?? []).map((event: any) => {
                const evidenceUrl = privateStorageObjectUrl(CASH_EVIDENCE_BUCKET, event.evidence_storage_path);
                return <div key={event.id} className="border-s border-slate-300 ps-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold text-slate-900">{eventLabels[event.event_type] ?? event.event_type.replaceAll("_", " ")}</div><div className="text-xs text-slate-500">{formatDate(event.event_at)}</div></div><div className="mt-1 text-sm text-slate-600">By {event.actor?.full_name ?? "system"}{event.seal_condition ? ` · Seal ${event.seal_condition}` : ""}{event.amount_lyd !== null && event.amount_lyd !== undefined ? ` · ${money(event.amount_lyd)}` : ""}</div>{event.notes ? <p className="mt-1 text-sm text-slate-600">{event.notes}</p> : null}{evidenceUrl ? <Link href={evidenceUrl} target="_blank" className="mt-1 inline-block text-sm link-secondary">Open evidence: {event.evidence_file_name ?? "file"}</Link> : null}</div>;
              })}
              {!events?.length ? <p className="text-sm text-slate-500">No custody events recorded.</p> : null}
            </div>
          </SectionCard>

        </div>

        <div className="space-y-6">
          {status === "removed" && mayReceive ? <SectionCard><h2 className="text-lg font-semibold">Receive into storage</h2><p className="mt-1 text-sm text-slate-500">{isOwnCollection ? "You collected this bag. As owner/admin, you can receive it into storage yourself; Snacky OS records that it was a self-receipt." : "A different person verifies the seal, photographs the handoff, and records the exact safe location."}</p><CashStorageReceiptForm action={receiveCashIntoStorage} id={id} clientSubmissionId={crypto.randomUUID()} /></SectionCard> : null}
          {status === "removed" && canReceive && !mayReceive ? <SectionCard><h2 className="text-lg font-semibold">Independent handoff required</h2><p className="mt-3 text-sm text-amber-800">The collector cannot acknowledge their own storage handoff. A different authorized user must receive this bag.</p></SectionCard> : null}
          {status === "in_storage" && canCount ? <SectionCard><h2 className="text-lg font-semibold">Count the stored bag</h2><p className="mt-1 text-sm text-slate-500">Enter only the period and one total for the whole bag. Snacky OS records who counted it automatically.</p><CashCountForm action={confirmCashCollectionCount} id={id} clientSubmissionId={crypto.randomUUID()} defaultPeriodEnd={formatDateInput(row.collected_at)} /></SectionCard> : null}
          {status === "counted" && row.reconciliation_status !== "variance_review" && canReconcile ? <SectionCard><h2 className="text-lg font-semibold">Optional follow-up: compare with VMS</h2><p className="mt-1 text-sm text-slate-500">The cash count is already saved and available in Snacky LYD. This comparison is not required now—you can return and complete it later.</p><CashReconciliationForms calculateAction={calculateCashExpectation} reconcileAction={reconcileCashCollection} id={id} calculateSubmissionId={crypto.randomUUID()} reconcileSubmissionId={crypto.randomUUID()} /></SectionCard> : null}
          {status === "counted" && row.reconciliation_status === "variance_review" && canResolve ? <SectionCard><h2 className="text-lg font-semibold text-rose-800">Owner variance decision</h2><p className="mt-1 text-sm text-slate-600">Missing cash is {money(shortage)}. Verify the total and evidence before accepting a cause. “Unknown” is not a resolution.</p><CashVarianceResolutionForm action={resolveCashVariance} id={id} clientSubmissionId={crypto.randomUUID()} /></SectionCard> : null}
          {["reconciled", "banked"].includes(status) ? <SectionCard><h2 className="text-lg font-semibold text-emerald-800">Counted & reconciled</h2><p className="mt-2 text-sm text-slate-600">This cash is already included in the Snacky LYD balance and is available to spend. No extra cash step is required.</p></SectionCard> : null}
          {status === "voided" ? <SectionCard><h2 className="text-lg font-semibold text-rose-800">Voided record</h2><p className="mt-2 text-sm text-slate-600">This record remains visible for audit and cannot be edited or reused.</p></SectionCard> : null}
        </div>
      </div>
    </div>
  );
}
