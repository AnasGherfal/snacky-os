import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getCashCollectionStatus, isCriticalCashVariance, isLargeCashVariance } from "@/lib/cash-collections";
import { reviewCashCollection } from "@/lib/cash-actions";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

function varianceTone(variance: number) {
  if (isCriticalCashVariance(variance)) return "border-rose-200 bg-rose-50 text-rose-800";
  if (isLargeCashVariance(variance)) return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
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

  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const { data: collection } = await supabase
    .from("cash_collections")
    .select(
      "id, collected_at, vms_expected_cash, actual_cash_collected, variance, review_status, notes, machine:machines(id, name, machine_code), operator:team_members!cash_collections_operator_id_fkey(id, full_name), route:routes(id, route_date, status)"
    )
    .eq("id", id)
    .single();

  if (!collection) notFound();

  const collectionRow: any = collection;
  const variance = Number(collectionRow.variance ?? 0);
  const status = getCashCollectionStatus(collectionRow.review_status, variance);

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          title="Cash Collection Review"
          subtitle={`${collectionRow.machine?.name ?? "Machine"} collected on ${formatDate(collectionRow.collected_at)}`}
          action={<SecondaryButton href="/cash-collections">Back to cash</SecondaryButton>}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}

        <div className="grid gap-4 lg:grid-cols-4">
          <SectionCard>
            <div className="text-sm text-slate-500">Expected from VMS</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(collectionRow.vms_expected_cash)}</div>
          </SectionCard>
          <SectionCard>
            <div className="text-sm text-slate-500">Actual collected</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(collectionRow.actual_cash_collected)}</div>
          </SectionCard>
          <SectionCard>
            <div className="text-sm text-slate-500">Variance</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(variance)}</div>
          </SectionCard>
          <SectionCard>
            <div className="text-sm text-slate-500">Status</div>
            <div className="mt-3"><StatusBadge status={status} /></div>
          </SectionCard>
        </div>

        <div className={`rounded-xl border p-4 text-sm ${varianceTone(variance)}`}>
          {isLargeCashVariance(variance)
            ? "This collection has a large variance and should be reviewed before closing the route cash cycle."
            : "This collection is within the normal variance threshold."}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <SectionCard>
            <h2 className="mb-4 text-lg font-semibold">Collection details</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-slate-500">Machine</dt>
                <dd className="mt-1 font-medium text-slate-900">{collectionRow.machine?.name ?? "Unknown machine"}</dd>
                <dd className="text-sm text-slate-500">{collectionRow.machine?.machine_code ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">Operator</dt>
                <dd className="mt-1 font-medium text-slate-900">{collectionRow.operator?.full_name ?? "Unassigned"}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">Route date</dt>
                <dd className="mt-1 font-medium text-slate-900">{collectionRow.route?.route_date ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">Route status</dt>
                <dd className="mt-1"><StatusBadge status={collectionRow.route?.status ?? "unknown"} /></dd>
              </div>
            </dl>
            <div className="mt-6">
              <div className="text-sm text-slate-500">Notes</div>
              <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {collectionRow.notes || "No notes recorded."}
              </p>
            </div>
          </SectionCard>

          <SectionCard>
            <h2 className="text-lg font-semibold">Review action</h2>
            <p className="mt-1 text-sm text-slate-500">Resolve the collection after finance reviews the variance and records the reason.</p>
            <form action={reviewCashCollection} className="mt-5 space-y-4">
              <input type="hidden" name="id" value={collectionRow.id} />
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-800">Review notes</span>
                <textarea
                  name="notes"
                  rows={5}
                  defaultValue={collectionRow.notes ?? ""}
                  className="field-input"
                  placeholder="Reason for variance, cash count result, or correction note"
                />
              </label>
              <button type="submit" className="btn-primary w-full">
                Mark as resolved
              </button>
            </form>
          </SectionCard>
        </div>
      </div>
    </AppShell>
  );
}
