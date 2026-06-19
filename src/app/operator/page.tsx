import Link from "next/link";
import { EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes, canManageOperations } from "@/lib/authz";
import { loadAccessibleOperatorIds, preferredOperatorViewerId } from "@/lib/operator-route-access";
import { type OperatorRoutePreviewRow, type OperatorRoutePreviewStopRow } from "@/lib/operator-route-types";
import { isOperatorVisibleRouteStatus, isRouteStopDoneStatus, isTerminalRouteStatus, routeDisplayStatus } from "@/lib/route-workflow";

export const dynamic = "force-dynamic";

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

  if (!profile || !canExecuteRoutes(profile)) {
    return (
      <>
        <ErrorState title="Operator routes unavailable" body="Your account cannot execute routes." />
      </>
    );
  }

  const canManageAllRoutes = canManageOperations(profile);
  const accessibleOperatorIds = await loadAccessibleOperatorIds(supabase, profile);
  const routeSelect = "id, route_date, status, operator_id, route_stops(id, status, stop_order, machine_id)";
  const [assignedResult, availableResult] = await Promise.all([
    canManageAllRoutes
      ? supabase
        .from("routes")
        .select(routeSelect)
        .not("operator_id", "is", null)
        .order("route_date", { ascending: false })
      : accessibleOperatorIds.length
        ? supabase
          .from("routes")
          .select(routeSelect)
          .in("operator_id", accessibleOperatorIds)
          .order("route_date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("routes")
      .select(routeSelect)
      .is("operator_id", null)
      .order("route_date", { ascending: true }),
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
            <h2 className="text-base font-semibold text-slate-900">Route snapshot</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">Open assigned</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{activeAssignedRoutes.length}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">Available</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{availableRoutes.length}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">Completed</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{completedAssignedRoutes.length}</div>
              </div>
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
              return (
                <Link key={route.id} href={`/operator/routes/${route.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:shadow-md">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">{route.route_date}</div>
                      <div className="mt-1 text-sm text-slate-500">{completedStops}/{totalStops} stops completed or skipped</div>
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
                  <p className="mt-1 text-sm text-slate-500">Completed routes stay visible here for quick history and follow-up.</p>
                </div>
                <SecondaryButton href="/operator/routes">View all routes</SecondaryButton>
              </div>
              <div className="mt-4 space-y-3">
              {completedAssignedRoutes.map((route) => {
                const completedStops = route.route_stops?.filter((stop: OperatorRoutePreviewStopRow) => isRouteStopDoneStatus(stop.status)).length ?? 0;
                const totalStops = route.route_stops?.length ?? 0;
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
