import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CashCountForm } from "@/components/CashCustodyForms";
import { EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canCountCash, canViewFinancials } from "@/lib/authz";
import { confirmCashCollectionCount } from "@/lib/cash-actions";
import { currentLibyaCashMonth } from "@/lib/cash-current-period";
import { CASH_EVIDENCE_BUCKET, privateStorageObjectUrl } from "@/lib/storage-buckets";

export const dynamic = "force-dynamic";

type CashToCount = {
  id: string;
  cash_bag_id: string | null;
  collected_at: string;
  custody_status: "removed" | "in_storage";
  storage_seal_condition: string | null;
  operator: { full_name: string | null } | null;
  machine_links: Array<{
    machine: { name: string | null; machine_code: string | null } | null;
    expectation_metadata?: {
      owner_reported_cash_count_pending_confirmation?: {
        amount_lyd?: string | number | null;
        physical_counter_name?: string | null;
      } | null;
    } | null;
  }>;
};

function dateTime(value: string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli",
  }).format(new Date(value));
}

function Photo({
  path, label,
}: { path: string | null | undefined; label: string }) {
  const url = privateStorageObjectUrl(CASH_EVIDENCE_BUCKET, path);
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-2">
      <div className="mb-2 text-xs font-semibold text-slate-700">{label}</div>
      {url ? (
        <Link href={url} target="_blank" rel="noopener noreferrer" aria-label={`View ${label}`}>
          <Image src={url} alt={label} width={520} height={300} unoptimized
            className="h-40 w-full rounded-lg bg-white object-contain" />
          <span className="mt-1 block text-xs font-medium text-emerald-800">Open full photo ↗</span>
        </Link>
      ) : <p className="flex h-40 items-center justify-center rounded-lg bg-white p-3 text-center text-xs text-amber-800">No photo recorded for this step</p>}
    </div>
  );
}

export default async function CashCountCurrentMonthPage() {
  const profile = await getCurrentProfile();
  const context = profile ? {
    id: profile.id, role: profile.role, roles: profile.roles,
    teamMemberId: profile.team_member_id, activeStatus: profile.active_status,
    canAddProducts: profile.can_add_products,
  } : null;
  if (!profile || !canAccessPath(context, "/cash-collections") ||
      !canCountCash(context) || !canViewFinancials(context)) redirect("/unauthorized");
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return <ErrorState title="Cash count unavailable" body="Could not open your signed-in cash records." />;
  const period = currentLibyaCashMonth();

  const { data, error, count } = await db.from("cash_collections")
    .select("id,cash_bag_id,collected_at,custody_status,actual_cash_collected,storage_location,storage_received_at,storage_seal_condition,operator:team_members!cash_collections_operator_id_fkey(full_name),machine_links:cash_collection_machines(expectation_metadata,machine:machines(name,machine_code))", { count: "exact" })
    .is("voided_at", null)
    .is("actual_cash_collected", null)
    .in("custody_status", ["removed", "in_storage"])
    .gte("collected_at", period.startTimestamp)
    .order("collected_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[cash-count] Could not load uncounted removals", error);
    return <ErrorState title="Cash count unavailable" body="Could not verify the existing cash removal records. No amount was changed." />;
  }
  if (count !== null && count !== undefined && (data ?? []).length !== count)
    return <ErrorState title="Cash count list incomplete" body="Some current removals were not loaded. No counts were changed. Use Cash Custody to review the full list." />;
  const rows = (data ?? []) as unknown as CashToCount[];
  const ids = rows.map((row) => String(row.id));
  const [receipts, events] = ids.length ? await Promise.all([
    db.from("cash_removal_receipts").select("cash_collection_id,removal_evidence_path").in("cash_collection_id", ids),
    db.from("cash_collection_events").select("cash_collection_id,event_type,evidence_storage_path,event_at")
      .in("cash_collection_id", ids).in("event_type", ["removed", "stored"]).order("event_at", { ascending: false }),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (receipts.error || events.error)
    return <ErrorState title="Photos unavailable" body="Cash evidence could not be loaded. No counts were changed; retry before identifying physical bags." />;

  const receiptByCollection = new Map((receipts.data ?? []).map((r) => [r.cash_collection_id, r.removal_evidence_path]));
  const latestStoragePhoto = new Map<string, string>();
  const removalEventPhoto = new Map<string, string>();
  for (const event of events.data ?? []) {
    if (!event.evidence_storage_path) continue;
    if (event.event_type === "stored" && !latestStoragePhoto.has(event.cash_collection_id))
      latestStoragePhoto.set(event.cash_collection_id, event.evidence_storage_path);
    if (event.event_type === "removed" && !removalEventPhoto.has(event.cash_collection_id))
      removalEventPhoto.set(event.cash_collection_id, event.evidence_storage_path);
  }
  const sorted = rows.sort((a, b) => {
    const byStage = Number(b.custody_status === "in_storage") - Number(a.custody_status === "in_storage");
    return byStage || Date.parse(b.collected_at) - Date.parse(a.collected_at);
  });
  const ready = rows.filter((r) => r.custody_status === "in_storage").length;
  const toReceive = rows.length - ready;

  return (
    <div className="space-y-6">
      <PageHeader title="Count cash — this month"
        subtitle={`${period.label}: count real money against the operator's EXISTING machine removal. No duplicate collection and no need to enter VMS figures now.`}
        action={<div className="flex gap-2"><SecondaryButton href="/cash-collections/owner-reported">Finish Anas reported counts</SecondaryButton><SecondaryButton href="/cash-collections">Cash custody</SecondaryButton><SecondaryButton href="/cash-collections?scope=all&status=waiting">Older records</SecondaryButton></div>} />
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="text-sm font-medium text-emerald-900">In storage · ready for physical count</div><div className="mt-1 text-3xl font-bold">{ready}</div></div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="text-sm font-medium text-amber-900">Removed · storage receipt needed</div><div className="mt-1 text-3xl font-bold">{toReceive}</div></div>
      </section>
      <p className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
        Check the physical bag against the machine, pickup time and both photos before saving. A digital UNNUMBERED reference is not a printed seal. The original removal date stays unchanged; the actual count is dated when you save it. Any XY comparison is separate.
      </p>
      {!rows.length ? <EmptyState title="No current removals awaiting count" body="There are no uncounted cash removals recorded for this month. Historical entries remain available separately." /> : null}
      <div className="space-y-5">
        {sorted.map((row) => {
          const bagLabel = String(row.cash_bag_id ?? "").startsWith("UNNUMBERED_") ? "Unnumbered physical bag" : row.cash_bag_id || "No printed bag reference";
          const machines = (row.machine_links ?? []).map((item) => item.machine?.name || item.machine?.machine_code).filter(Boolean);
          const removalPath = receiptByCollection.get(row.id) ?? removalEventPhoto.get(row.id);
          const storagePath = latestStoragePhoto.get(row.id);
          const operator = row.operator?.full_name ?? "Not recorded";
          const provisionalReport = row.machine_links?.length === 1
            ? row.machine_links[0]?.expectation_metadata?.owner_reported_cash_count_pending_confirmation
            : null;
          const provisionalRaw = provisionalReport?.amount_lyd;
          const provisionalAmount = provisionalRaw === null || provisionalRaw === undefined
            ? null : Number(provisionalRaw);
          const validProvisionalAmount = provisionalAmount !== null && Number.isFinite(provisionalAmount)
            && provisionalAmount >= 0 && provisionalAmount <= 9999999
            ? provisionalAmount.toFixed(2) : null;
          const isUnnumberedEnrolledBag = String(row.cash_bag_id ?? "").startsWith("UNNUMBERED_");
          const receiveHref = `/cash-handling/receive?id=${encodeURIComponent(row.id)}${validProvisionalAmount ? `&reported_amount=${encodeURIComponent(validProvisionalAmount)}` : ""}`;
          return (
            <section key={row.id} id={`cash-count-${row.id}`} className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-950">{machines.join(" + ") || "Machine not linked"}</h2>
                  <p className="mt-1 text-sm text-slate-600">Removed by <strong>{operator}</strong> · {dateTime(row.collected_at)} (Libya time)</p>
                  <p className="mt-1 text-xs text-slate-500">{bagLabel} · Existing removal</p>
                </div>
                <StatusBadge status={row.custody_status} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Photo path={removalPath} label="Photo when removed" />
                <Photo path={storagePath} label="Photo in storage" />
              </div>
              {validProvisionalAmount ? <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950" role="note">
                <strong>Owner-reported physical count: {validProvisionalAmount} LYD</strong>
                <p className="mt-1">Reported counter: {provisionalReport?.physical_counter_name ?? "Not recorded"}.
                  This figure is saved as a draft reference only. It has not yet been posted as a counted Finance transaction. Confirm against the original bag before finalizing.</p>
              </div> : null}
              {row.custody_status === "in_storage" ? (
                <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                  <h3 className="text-base font-bold text-emerald-950">Record the count on this existing removal</h3>
                  <p className="mt-1 text-sm text-emerald-900">Verify the physical cash and its matching removal. A completed count posts exactly once to Snacky Finance; XY reconciliation is a separate step.</p>
                  {row.storage_seal_condition === "mismatch" ? <p className="mt-2 text-sm text-amber-900">An unnumbered digital bag ID is not a printed seal and does not, by itself, establish a shortage or damaged seal. Compare both photos and the machine.</p> : null}
                  {isUnnumberedEnrolledBag ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-sm text-slate-700">This bag uses the protected Cash Handling receipt-and-count flow. The regular count field cannot post it until you confirm that you physically received the matching bag.</p>
                      <Link href={receiveHref} className="btn-primary inline-flex">Confirm receipt and count this bag</Link>
                    </div>
                  ) : (
                    <CashCountForm action={confirmCashCollectionCount} id={row.id}
                      clientSubmissionId={crypto.randomUUID()} />
                  )}
                </div>
              ) : (
                <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  <strong>Storage receipt not recorded.</strong> If you already have this exact bag, record its actual receipt first; then save its cash count on the same removal. No new removal is created.
                  <Link className="mt-3 block font-semibold underline" href={`/cash-collections/${row.id}#cash-storage-receipt`}>Record storage receipt →</Link>
                </div>
              )}
              <Link href={`/cash-collections/${row.id}`} className="mt-4 inline-block text-sm font-semibold text-emerald-800 underline">Open removal history and photos</Link>
            </section>
          );
        })}
      </div>
    </div>
  );
}
