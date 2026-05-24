import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes } from "@/lib/authz";
import { availableRouteStatuses, isTerminalRouteStatus } from "@/lib/route-workflow";

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
  
  const routeSelect = "id, route_date, status, operator_id, route_stops(id, status, stop_order)";
  const assignedQuery = profile.team_member_id
    ? supabase
        .from("routes")
        .select(routeSelect)
        .eq("operator_id", profile.team_member_id)
        .not("status", "in", "(completed,reviewed,cancelled,canceled)")
        .order("route_date", { ascending: true })
    : Promise.resolve({ data: [], error: null });
  const availableQuery = supabase
    .from("routes")
    .select(routeSelect)
    .is("operator_id", null)
    .in("status", [...availableRouteStatuses])
    .order("route_date", { ascending: true });

  const [assignedResult, availableResult] = await Promise.all([assignedQuery, availableQuery]);
  const error = assignedResult.error ?? availableResult.error;
  const routes = showAvailable
    ? (availableResult.data ?? [])
    : [...(assignedResult.data ?? []), ...(availableResult.data ?? [])]
        .filter((route: any, index, rows) => rows.findIndex((candidate: any) => candidate.id === route.id) === index)
        .filter((route: any) => !isTerminalRouteStatus(route.status));

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
        <div className="flex flex-wrap gap-2">
          <Link href="/operator/routes" className={!showAvailable ? "btn-primary" : "btn-secondary"}>My Routes</Link>
          <Link href="/operator/routes?view=available" className={showAvailable ? "btn-primary" : "btn-secondary"}>Available Routes</Link>
        </div>

        {!routes?.length ? (
          <EmptyState
            title={showAvailable ? "No available routes" : "No routes assigned"}
            body={showAvailable ? "Unassigned routes will appear here when admin leaves them available." : process.env.NODE_ENV === "development" ? `Check assignments for team member ${profile?.team_member_id ?? "not matched"}.` : "Check back later for new route assignments."}
          />
        ) : (
          <div className="space-y-4">
            {routes.map((route: any) => {
              const completedStops = route.route_stops?.filter((s: any) => s.status === "completed").length ?? 0;
              const totalStops = route.route_stops?.length ?? 0;
              const progress = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;
              const isAvailable = !route.operator_id && availableRouteStatuses.includes(String(route.status) as any);

              return (
                <Link
                  key={route.id}
                  href={`/operator/routes/${route.id}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 hover:shadow-md transition-shadow"
                >
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
                      <p className="text-sm text-slate-500">{totalStops} machine stops{isAvailable ? " - available to claim" : ""}</p>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={route.status} />
                    </div>
                  </div>
                  
                  <div className="mb-3">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs text-slate-600">Progress</span>
                      <span className="text-xs font-semibold text-slate-700">{progress}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className="bg-green-500 h-2 rounded-full transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="text-sm text-slate-600">
                    {completedStops}/{totalStops} completed
                  </div>
                </Link>
              );
            })}
          </div>
        )}

      </div>
    </>
  );
}
