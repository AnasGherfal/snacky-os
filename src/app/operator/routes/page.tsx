import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOperatorRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function OperatorRoutesPage() {
  const supabase = getSupabaseServerClient();
  const profile = await getCurrentProfile();
  
  let routesQuery = supabase
    ?.from("routes")
    .select("id, route_date, status, operator_id, route_stops(id, status)")
    .gte("route_date", new Date().toISOString().split("T")[0])
    .order("route_date", { ascending: true });

  if (routesQuery && isOperatorRole(profile?.role)) {
    routesQuery = routesQuery.eq("operator_id", profile?.team_member_id ?? "");
  }

  const { data: routes, error } = routesQuery ? await routesQuery : { data: [], error: null };
  if (error) console.error("[operator:routes] Failed to load assigned routes", { error, authUserId: profile?.id, teamMemberId: profile?.team_member_id });

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          title="My Routes"
          subtitle="View and execute your assigned routes for today."
        />

        {!routes?.length ? (
          <EmptyState
            title="No routes assigned"
            body={process.env.NODE_ENV === "development" ? `Check assignments for team member ${profile?.team_member_id ?? "not matched"}.` : "Check back later for new route assignments."}
          />
        ) : (
          <div className="space-y-4">
            {routes.map((route: any) => {
              const completedStops = route.route_stops?.filter((s: any) => s.status === "completed").length ?? 0;
              const totalStops = route.route_stops?.length ?? 0;
              const progress = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;

              return (
                <Link
                  key={route.id}
                  href={`/operator/routes/${route.id}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 hover:shadow-md transition-shadow"
                >
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
                      <p className="text-sm text-slate-500">{totalStops} machine stops</p>
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
    </AppShell>
  );
}
