import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, ErrorState, PageHeader, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes } from "@/lib/authz";
import { loadOperatorRoutePayPreviewMap, type OperatorRoutePreviewRow, type OperatorRoutePreviewStopRow } from "@/lib/payroll-server";
import { moneyLabel } from "@/lib/payroll";
import { isOperatorVisibleRouteStatus, isRouteStopDoneStatus, isTerminalRouteStatus, routeDisplayStatus } from "@/lib/route-workflow";

type OperatorPayrollPeriodSummary = {
  id: string;
  net_total_lyd?: number | string | null;
  status?: string | null;
};

export default async function OperatorRoutesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view = "my" } = await searchParams;
  const showAvailable = view === "available";
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!profile || !canExecuteRoutes(profile)) redirect("/unauthorized");

  if (!supabase) {
    return (
      <>
        <ErrorState title="Routes unavailable" body="Supabase is not configured, so Snacky OS cannot load assigned operator routes." />
      </>
    );
  }

  const currentMonthStart = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();

  const routeSelect = "id, route_date, status, operator_id, storage_location_id, distance_km, distance_zone, distance_source, load_difficulty_pay_lyd, route_stops(id, status, stop_order, machine_id)";
  const assignedQuery = profile.team_member_id
    ? supabase
      .from("routes")
      .select(routeSelect)
      .eq("operator_id", profile.team_member_id)
      .order("route_date", { ascending: false })
    : Promise.resolve({ data: [], error: null });
  const availableQuery = supabase
    .from("routes")
    .select(routeSelect)
    .is("operator_id", null)
    .order("route_date", { ascending: true });

  const [assignedResult, availableResult, currentPayrollPeriodResult] = await Promise.all([
    assignedQuery,
    availableQuery,
    profile.team_member_id
      ? supabase.from("payroll_periods").select("id, net_total_lyd, status").eq("operator_id", profile.team_member_id).eq("period_start", currentMonthStart).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const error = assignedResult.error ?? availableResult.error;
  const assignedRoutes = (assignedResult.data ?? []) as OperatorRoutePreviewRow[];
  const activeAssignedRoutes = assignedRoutes.filter((route) => !isTerminalRouteStatus(route.status));
  const completedAssignedRoutes = assignedRoutes
    .filter((route) => isTerminalRouteStatus(route.status))
    .sort((a, b) => String(b.route_date ?? "").localeCompare(String(a.route_date ?? "")));
  const availableRoutes = ((availableResult.data ?? []) as OperatorRoutePreviewRow[]).filter((route) => isOperatorVisibleRouteStatus(route.status));
  const previewRoutes = showAvailable ? availableRoutes : [...activeAssignedRoutes, ...completedAssignedRoutes];
  const { previewByRouteId } = await loadOperatorRoutePayPreviewMap({
    supabase,
    routes: previewRoutes,
    viewerTeamMemberId: profile.team_member_id,
  });

  if (error) {
    console.error("[operator:routes] Failed to load assigned routes", { error, authUserId: profile?.id, teamMemberId: profile?.team_member_id });
    return (
      <>
        <ErrorState title="Could not load routes" body="Snacky OS could not load your assigned operator routes." />
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title={showAvailable ? "Available Routes" : "My Routes"}
          subtitle={showAvailable ? "Claim an unassigned route when you are ready to execute it." : "View and execute your assigned routes for today."}
        />

        <SectionCard>
          <div className="p-4">
            <h2 className="text-base font-semibold text-slate-900">Monthly earned total</h2>
            <div className="mt-3 text-3xl font-semibold text-slate-900">{moneyLabel((currentPayrollPeriodResult.data as OperatorPayrollPeriodSummary | null)?.net_total_lyd ?? 0)}</div>
            <div className="mt-2 text-sm text-slate-500">
              {currentPayrollPeriodResult.data ? `Current period status: ${(currentPayrollPeriodResult.data as OperatorPayrollPeriodSummary).status}` : "Current month payroll period has not been created yet."}
            </div>
          </div>
        </SectionCard>

        <div className="flex flex-wrap gap-2">
          <Link href="/operator/routes" className={!showAvailable ? "btn-primary" : "btn-secondary"}>My Routes</Link>
          <Link href="/operator/routes?view=available" className={showAvailable ? "btn-primary" : "btn-secondary"}>Available Routes</Link>
        </div>

        {showAvailable ? (
          !availableRoutes.length ? (
            <EmptyState
              title="No available routes"
              body="Unassigned routes will appear here when admin leaves them available."
            />
          ) : (
            <div className="space-y-4">
              {availableRoutes.map((route) => {
                const completedStops = route.route_stops?.filter((s: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(s.status)).length ?? 0;
                const totalStops = route.route_stops?.length ?? 0;
                const progress = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;
                const payPreview = previewByRouteId.get(route.id);

                return (
                  <Link
                    key={route.id}
                    href={`/operator/routes/${route.id}`}
                    className="block rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
                  >
                    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
                        <p className="text-sm text-slate-500">{totalStops} machine stops - available to claim</p>
                        <p className="mt-2 text-sm font-medium text-slate-700">
                          {payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                            ? `Estimated pay: ${moneyLabel(payPreview.totalPay)}`
                            : "Route pay estimate appears after a payroll profile is assigned."}
                        </p>
                      </div>
                      <div className="shrink-0">
                        <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                      </div>
                    </div>

                    <div className="mb-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs text-slate-600">Progress</span>
                        <span className="text-xs font-semibold text-slate-700">{progress}%</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-slate-200">
                        <div className="h-2 rounded-full bg-green-500 transition-all" style={{ width: `${progress}%` }} />
                      </div>
                    </div>

                    <div className="text-sm text-slate-600">
                      {completedStops}/{totalStops} completed or skipped
                    </div>
                  </Link>
                );
              })}
            </div>
          )
        ) : (
          <>
            {!activeAssignedRoutes.length ? (
              <EmptyState
                title="No open routes assigned"
                body={process.env.NODE_ENV === "development" ? `Check assignments for team member ${profile?.team_member_id ?? "not matched"}.` : "Check back later for new route assignments."}
              />
            ) : (
              <section className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Open routes</h2>
                  <p className="mt-1 text-sm text-slate-500">These are the routes you can still start or continue today.</p>
                </div>
                <div className="space-y-4">
                  {activeAssignedRoutes.map((route) => {
                    const completedStops = route.route_stops?.filter((s: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(s.status)).length ?? 0;
                    const totalStops = route.route_stops?.length ?? 0;
                    const progress = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;
                    const payPreview = previewByRouteId.get(route.id);

                    return (
                      <Link
                        key={route.id}
                        href={`/operator/routes/${route.id}`}
                        className="block rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
                      >
                        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
                            <p className="text-sm text-slate-500">{totalStops} machine stops</p>
                            <p className="mt-2 text-sm font-medium text-slate-700">
                              {payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                                ? `${payPreview.source === "saved" ? "Stored route pay" : "Estimated pay"}: ${moneyLabel(payPreview.totalPay)}`
                                : "Route pay estimate appears after a payroll profile is assigned."}
                            </p>
                          </div>
                          <div className="shrink-0">
                            <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                          </div>
                        </div>

                        <div className="mb-3">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs text-slate-600">Progress</span>
                            <span className="text-xs font-semibold text-slate-700">{progress}%</span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-slate-200">
                            <div className="h-2 rounded-full bg-green-500 transition-all" style={{ width: `${progress}%` }} />
                          </div>
                        </div>

                        <div className="text-sm text-slate-600">
                          {completedStops}/{totalStops} completed or skipped
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {completedAssignedRoutes.length ? (
              <section className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Completed and payroll routes</h2>
                  <p className="mt-1 text-sm text-slate-500">Finished routes stay visible here with their route pay while payroll is verified and paid.</p>
                </div>
                <div className="space-y-4">
                  {completedAssignedRoutes.map((route) => {
                    const completedStops = route.route_stops?.filter((s: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(s.status)).length ?? 0;
                    const totalStops = route.route_stops?.length ?? 0;
                    const payPreview = previewByRouteId.get(route.id);

                    return (
                      <Link
                        key={route.id}
                        href={`/operator/routes/${route.id}`}
                        className="block rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
                            <p className="text-sm text-slate-500">{completedStops}/{totalStops} completed or skipped</p>
                            <p className="mt-2 text-sm font-medium text-slate-700">
                              {payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                                ? `${payPreview.source === "saved" ? "Completed route pay" : "Estimated route pay"}: ${moneyLabel(payPreview.totalPay)}`
                                : "Route pay becomes visible after a payroll profile is assigned."}
                            </p>
                          </div>
                          <div className="shrink-0">
                            <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </>
        )}

      </div>
    </>
  );
}
