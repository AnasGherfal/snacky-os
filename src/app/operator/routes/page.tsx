import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, ErrorState, PageHeader, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes, canManageOperations } from "@/lib/authz";
import { loadAccessibleOperatorIds, preferredOperatorViewerId } from "@/lib/operator-route-access";
import { loadOperatorRoutePayPreviewMap, type OperatorRoutePreviewRow, type OperatorRoutePreviewStopRow } from "@/lib/payroll-server";
import { moneyLabel } from "@/lib/payroll";
import { isOperatorVisibleRouteStatus, isRouteStopDoneStatus, isTerminalRouteStatus, routeDisplayStatus } from "@/lib/route-workflow";

type OperatorPayrollPeriodSummary = {
  id: string;
  net_total_lyd?: number | string | null;
  status?: string | null;
};

function routeProgress(route: OperatorRoutePreviewRow) {
  const completedStops = route.route_stops?.filter((stop: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(stop.status)).length ?? 0;
  const totalStops = route.route_stops?.length ?? 0;
  const progress = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;
  return { completedStops, totalStops, progress };
}

function RouteCard({
  route,
  payText,
  subtitle,
}: {
  route: OperatorRoutePreviewRow;
  payText: string;
  subtitle: string;
}) {
  const { completedStops, totalStops, progress } = routeProgress(route);

  return (
    <Link
      href={`/operator/routes/${route.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
    >
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
          <p className="text-sm text-slate-500">{subtitle}</p>
          <p className="mt-2 text-sm font-medium text-slate-700">{payText}</p>
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
}

export default async function OperatorRoutesPage() {
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!profile || !canExecuteRoutes(profile)) redirect("/unauthorized");

  if (!supabase) {
    return (
      <>
        <ErrorState title="Routes unavailable" body="Supabase is not configured, so Snacky OS cannot load operator routes." />
      </>
    );
  }

  const canManageAllRoutes = canManageOperations(profile);
  const accessibleOperatorIds = await loadAccessibleOperatorIds(supabase, profile);
  const currentViewerOperatorId = preferredOperatorViewerId(profile, accessibleOperatorIds);
  const currentMonthStart = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();

  const routeSelect = "id, route_date, status, operator_id, storage_location_id, distance_km, distance_zone, distance_source, load_difficulty_pay_lyd, route_stops(id, status, stop_order, machine_id)";

  const assignedQuery = canManageAllRoutes
    ? supabase.from("routes").select(routeSelect).not("operator_id", "is", null).order("route_date", { ascending: false })
    : accessibleOperatorIds.length
      ? supabase.from("routes").select(routeSelect).in("operator_id", accessibleOperatorIds).order("route_date", { ascending: false })
      : Promise.resolve({ data: [], error: null });
  const availableQuery = supabase
    .from("routes")
    .select(routeSelect)
    .is("operator_id", null)
    .order("route_date", { ascending: true });

  const [assignedResult, availableResult, currentPayrollPeriodResult] = await Promise.all([
    assignedQuery,
    availableQuery,
    currentViewerOperatorId
      ? supabase.from("payroll_periods").select("id, net_total_lyd, status").eq("operator_id", currentViewerOperatorId).eq("period_start", currentMonthStart).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const error = assignedResult.error ?? availableResult.error;
  if (error) {
    console.error("[operator:routes] Failed to load operator routes", {
      error,
      authUserId: profile.id,
      linkedOperatorIds: accessibleOperatorIds,
    });
    return (
      <>
        <ErrorState title="Could not load routes" body="Snacky OS could not load the operator route list." />
      </>
    );
  }

  const assignedRoutes = (assignedResult.data ?? []) as OperatorRoutePreviewRow[];
  const availableRoutes = ((availableResult.data ?? []) as OperatorRoutePreviewRow[]).filter((route) => isOperatorVisibleRouteStatus(route.status));
  const assignedOpenRoutes = assignedRoutes.filter((route) => !isTerminalRouteStatus(route.status));
  const completedRoutes = assignedRoutes
    .filter((route) => isTerminalRouteStatus(route.status))
    .sort((a, b) => String(b.route_date ?? "").localeCompare(String(a.route_date ?? "")));
  const previewRoutes = [...assignedRoutes, ...availableRoutes]
    .filter((route, index, rows) => rows.findIndex((candidate) => candidate.id === route.id) === index);
  const { previewByRouteId } = await loadOperatorRoutePayPreviewMap({
    supabase,
    routes: previewRoutes,
    viewerTeamMemberId: currentViewerOperatorId,
  });

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Operator Routes"
          subtitle={canManageAllRoutes ? "Assigned, unassigned, and completed routes across the team." : "See your assigned work, open routes you can claim, and completed history in one place."}
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

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{canManageAllRoutes ? "Assigned routes" : "Assigned to me"}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {canManageAllRoutes ? "Routes already assigned across the team." : "Routes already assigned to your linked operator identity."}
            </p>
          </div>
          {!assignedOpenRoutes.length ? (
            <EmptyState title="No assigned open routes" body="Assigned routes will appear here when they are ready to start or continue." />
          ) : (
            <div className="space-y-4">
              {assignedOpenRoutes.map((route) => {
                const payPreview = previewByRouteId.get(route.id);
                return (
                  <RouteCard
                    key={route.id}
                    route={route}
                    subtitle={`${route.route_stops?.length ?? 0} machine stops`}
                    payText={
                      payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                        ? `${payPreview.source === "saved" ? "Stored route pay" : "Estimated pay"}: ${moneyLabel(payPreview.totalPay)}`
                        : "Route pay estimate appears after a payroll profile is assigned."
                    }
                  />
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Unassigned</h2>
            <p className="mt-1 text-sm text-slate-500">Open routes you can claim when the route is left available.</p>
          </div>
          {!availableRoutes.length ? (
            <EmptyState title="No unassigned routes" body="Available routes will appear here when admin leaves them open." />
          ) : (
            <div className="space-y-4">
              {availableRoutes.map((route) => {
                const payPreview = previewByRouteId.get(route.id);
                return (
                  <RouteCard
                    key={route.id}
                    route={route}
                    subtitle={`${route.route_stops?.length ?? 0} machine stops - ready to claim`}
                    payText={
                      payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                        ? `Estimated pay: ${moneyLabel(payPreview.totalPay)}`
                        : "Route pay estimate appears after a payroll profile is assigned."
                    }
                  />
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Completed / Past routes</h2>
            <p className="mt-1 text-sm text-slate-500">Finished routes stay visible with their stored pay while payroll is reviewed and paid.</p>
          </div>
          {!completedRoutes.length ? (
            <EmptyState title="No completed routes yet" body="Completed routes will stay visible here after route closure." />
          ) : (
            <div className="space-y-4">
              {completedRoutes.map((route) => {
                const payPreview = previewByRouteId.get(route.id);
                return (
                  <RouteCard
                    key={route.id}
                    route={route}
                    subtitle={`${route.route_stops?.length ?? 0} machine stops`}
                    payText={
                      payPreview?.totalPay !== null && payPreview?.totalPay !== undefined
                        ? `${payPreview.source === "saved" ? "Completed route pay" : "Estimated route pay"}: ${moneyLabel(payPreview.totalPay)}`
                        : "Route pay becomes visible after a payroll profile is assigned."
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
