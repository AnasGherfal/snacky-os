import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getCashCollectionStatus, isCriticalCashVariance, isLargeCashVariance } from "@/lib/cash-collections";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function varianceClassName(variance: number) {
  if (isCriticalCashVariance(variance)) return "font-semibold text-rose-700";
  if (isLargeCashVariance(variance)) return "font-semibold text-amber-700";
  return "font-medium text-slate-700";
}

export default async function CashCollectionsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error = "" } = await searchParams;
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/cash-collections")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  const { data: collections } = supabase
    ? await supabase
        .from("cash_collections")
        .select(
          "id, collected_at, vms_expected_cash, actual_cash_collected, variance, review_status, machine:machines(id, name, machine_code), operator:team_members!cash_collections_operator_id_fkey(id, full_name), route:routes(id, route_date)"
        )
        .order("collected_at", { ascending: false })
    : { data: null };

  const rows = collections ?? [];
  const totalExpected = rows.reduce((sum: number, row: any) => sum + Number(row.vms_expected_cash ?? 0), 0);
  const totalActual = rows.reduce((sum: number, row: any) => sum + Number(row.actual_cash_collected ?? 0), 0);
  const openReviews = rows.filter((row: any) => getCashCollectionStatus(row.review_status, row.variance) === "needs_review").length;

  return (
    <AppShell>
      <PageHeader
        title="Cash Collections"
        subtitle="Compare operator cash collections against expected VMS cash and resolve variances."
      />
      {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate cash collections" body="Add environment variables and restart the app." />
      ) : !rows.length ? (
        <EmptyState title="No cash collections yet" body="Completed operator machine stops will appear here after cash is recorded." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <SectionCard>
              <div className="text-sm text-slate-500">Expected cash</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalExpected)}</div>
            </SectionCard>
            <SectionCard>
              <div className="text-sm text-slate-500">Actual collected</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalActual)}</div>
            </SectionCard>
            <SectionCard>
              <div className="text-sm text-slate-500">Needs review</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{openReviews}</div>
            </SectionCard>
          </div>

          <DataTable headers={["Date", "Machine", "Operator", "Route", "Expected", "Actual", "Variance", "Status", "Review"]}>
            {rows.map((collection: any) => {
              const variance = Number(collection.variance ?? 0);
              const status = getCashCollectionStatus(collection.review_status, variance);

              return (
                <tr key={collection.id} className={isLargeCashVariance(variance) && status !== "resolved" ? "bg-amber-50/60" : undefined}>
                  <td>{formatDate(collection.collected_at)}</td>
                  <td>
                    <div className="font-medium text-slate-900">{collection.machine?.name ?? "Unknown machine"}</div>
                    <div className="text-xs text-slate-500">{collection.machine?.machine_code ?? "-"}</div>
                  </td>
                  <td>{collection.operator?.full_name ?? "Unassigned"}</td>
                  <td>{collection.route?.route_date ?? "-"}</td>
                  <td>{lyd(collection.vms_expected_cash)}</td>
                  <td>{lyd(collection.actual_cash_collected)}</td>
                  <td className={varianceClassName(variance)}>{lyd(variance)}</td>
                  <td><StatusBadge status={status} /></td>
                  <td>
                    <Link className="link-secondary" href={`/cash-collections/${collection.id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </div>
      )}
    </AppShell>
  );
}
