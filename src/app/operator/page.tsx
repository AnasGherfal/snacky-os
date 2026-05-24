import Link from "next/link";
import { EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes } from "@/lib/authz";
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

  const routeSelect = "id, route_date, status, operator_id, route_stops(id, status)";
  const [assignedResult, availableResult] = await Promise.all([
    profile.team_member_id
      ? supabase
        .from("routes")
        .select(routeSelect)
        .eq("operator_id", profile.team_member_id)
          .order("route_date", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("routes")
      .select(routeSelect)
      .is("operator_id", null)
      .order("route_date", { ascending: true }),
  ]);
  const routesError = assignedResult.error ?? availableResult.error;
  const assignedRoutes = (assignedResult.data ?? []).filter((route: any) => !isTerminalRouteStatus(route.status));
  const availableRoutes = (availableResult.data ?? []).filter((route: any) => isOperatorVisibleRouteStatus(route.status));
  const routes = [...assignedRoutes, ...availableRoutes]
    .filter((route: any, index, rows) => rows.findIndex((candidate: any) => candidate.id === route.id) === index)
    .filter((route: any) => !isTerminalRouteStatus(route.status));
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

        {!routes?.length ? (
          <EmptyState title="No assigned routes" body="Assigned routes for today and upcoming dates will appear here." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {routes.map((route: any) => {
              const completedStops = route.route_stops?.filter((stop: any) => isRouteStopDoneStatus(stop.status)).length ?? 0;
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
