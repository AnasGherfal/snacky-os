import Link from "next/link";
import { EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes } from "@/lib/authz";
import { loadOperatorRoutePayPreviewMap, type OperatorRoutePreviewRow, type OperatorRoutePreviewStopRow } from "@/lib/payroll-server";
import { moneyLabel } from "@/lib/payroll";
import { isOperatorVisibleRouteStatus, isRouteStopDoneStatus, isTerminalRouteStatus, routeDisplayStatus } from "@/lib/route-workflow";

export const dynamic = "force-dynamic";

type OperatorPayrollPeriodSummary = {
  id: string;
  net_total_lyd?: number | string | null;
  status?: string | null;
};

export default async function OperatorPage() {
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Operator routes unavailable" body="Supabase is not configured, so Snacky OS cannot load assigned routes." />
      </>
    );
  }

  const currentMonthStart = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();

  if (!profile || !canExecuteRoutes(profile)) {
    return (
      <>
        <ErrorState title="Operator routes unavailable" body="Your account cannot execute routes." />
      </>
    );
  }

  const routeSelect = "id, route_date, status, operator_id, storage_location_id, distance_km, distance_zone, distance_source, load_difficulty_pay_lyd, route_stops(id, status, stop_order, machine_id)";
  const [assignedResult, availableResult, currentPayrollPeriodResult] = await Promise.all([
    profile.team_member_id
      ? supabase
        .from("routes")
        .select(routeSelect)
        .eq("operator_id", profile.team_member_id)
        .order("route_date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("routes")
      .select(routeSelect)
      .is("operator_id", null)
      .order("route_date", { ascending: true }),
    profile.team_member_id
      ? supabase.from("payroll_periods").select("id, net_total_lyd, status").eq("operator_id", profile.team_member_id).eq("period_start", currentMonthStart).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const routesError = assignedResult.error ?? availableResult.error;
  const assignedRoutes = (assignedResult.data ?? []) as OperatorRoutePreviewRow[];
  const activeAssignedRoutes = assignedRoutes.filter((route) => !isTerminalRouteStatus(route.status));
  const completedAssignedRoutes = assignedRoutes
    .filter((route) => isTerminalRouteStatus(route.status))
    .sort((a, b) => String(b.route_date ?? "").localeCompare(String(a.route_date ?? "")))
    .slice(0, 6);
  const availableRoutes = ((availableResult.data ?? []) as OperatorRoutePreviewRow[]).filter((route) => isOperatorVisibleRouteStatus(route.status));
  const routes = [...activeAssignedRoutes, ...availableRoutes]
    .filter((route, index, rows) => rows.findIndex((candidate) => candidate.id === route.id) === index)
    .filter((route) => !isTerminalRouteStatus(route.status));
  const previewRoutes = [...routes, ...completedAssignedRoutes]
    .filter((route, index, rows) => rows.findIndex((candidate) => candidate.id === route.id) === index);
  const { previewByRouteId } = await loadOperatorRoutePayPreviewMap({
    supabase,
    routes: previewRoutes,
    viewerTeamMemberId: profile.team_member_id,
  });

  if (routesError) {
    console.error("[operator] Failed to load assigned routes", routesError);
    return (
      <>
        <ErrorState title="Could not load assigned routes" body="Snacky OS could not load the operator route list." action={<SecondaryButton href="/operator">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Operator"
          subtitle="Assigned refill routes and daily execution workflow."
          action={<PrimaryButton href="/operator/routes">All my routes</PrimaryButton>}
        />

        <SectionCard>
          <div className="p-4">
            <h2 className="text-base font-semibold text-slate-900">Monthly earned total</h2>
            <div className="mt-3 text-3xl font-semibold text-slate-900">
              {moneyLabel((currentPayrollPeriodResult.data as OperatorPayrollPeriodSummary | null)?.net_total_lyd ?? 0)}
            </div>
            <div className="mt-2 text-sm text-slate-500">
              {currentPayrollPeriodResult.data ? `Current period status: ${(currentPayrollPeriodResult.data as OperatorPayrollPeriodSummary).status}` : "Current month payroll period has not been created yet."}
            </div>
          </div>
        </SectionCard>

        {!routes?.length ? (
          <EmptyState title="No assigned routes" body="Assigned routes for today and upcoming dates will appear here." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {routes.map((route) => {
              const completedStops = route.route_stops?.filter((stop: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(stop.status)).length ?? 0;
              const totalStops = route.route_stops?.length ?? 0;
              const payPreview = previewByRouteId.get(route.id);
              return (
                <Link key={route.id} href={`/operator/routes/${route.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:shadow-md">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">{route.route_date}</div>
                      <div className="mt-1 text-sm text-slate-500">{completedStops}/{totalStops} stops completed or skipped</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">
                        {payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                          ? `${payPreview.source === "saved" ? "Route pay" : "Estimated pay"}: ${moneyLabel(payPreview.totalPay)}`
                          : "Route pay estimate appears after a payroll profile is assigned."}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-slate-200">
                    <div className="h-2 rounded-full bg-emerald-500" style={{ width: totalStops ? `${Math.round((completedStops / totalStops) * 100)}%` : "0%" }} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {completedAssignedRoutes.length ? (
          <SectionCard>
            <div className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Recent completed routes</h2>
                  <p className="mt-1 text-sm text-slate-500">Completed work keeps its stored pay breakdown here while payroll is being verified or paid.</p>
                </div>
                <SecondaryButton href="/operator/routes">View all routes</SecondaryButton>
              </div>
              <div className="mt-4 space-y-3">
                {completedAssignedRoutes.map((route) => {
                  const completedStops = route.route_stops?.filter((stop: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(stop.status)).length ?? 0;
                  const totalStops = route.route_stops?.length ?? 0;
                  const payPreview = previewByRouteId.get(route.id);
                  return (
                    <Link
                      key={route.id}
                      href={`/operator/routes/${route.id}`}
                      className="block rounded-lg border border-slate-200 bg-white px-4 py-3 transition hover:shadow-sm"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="font-semibold text-slate-900">{route.route_date}</div>
                          <div className="mt-1 text-sm text-slate-500">{completedStops}/{totalStops} stops completed or skipped</div>
                          <div className="mt-2 text-sm font-medium text-slate-700">
                            {payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                              ? `${payPreview.source === "saved" ? "Completed route pay" : "Estimated route pay"}: ${moneyLabel(payPreview.totalPay)}`
                              : "Route pay becomes visible after a payroll profile is assigned."}
                          </div>
                        </div>
                        <div className="shrink-0">
                          <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard>
          <div className="p-4">
            <h2 className="text-base font-semibold text-slate-900">Route workflow</h2>
            <div className="mt-3 grid gap-3 text-sm text-slate-600 md:grid-cols-5">
              {["Pick stock", "Visit stops", "Fill machines", "Record cash", "Return leftovers"].map((step) => (
                <div key={step} className="rounded-lg border border-slate-200 bg-white p-3 font-medium text-slate-800">
                  {step}
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
