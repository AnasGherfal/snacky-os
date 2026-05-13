import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function OperatorRoutesPage() {
  const supabase = getSupabaseServerClient();
  
  // Get today's routes (in production, filter by current operator)
  // For MVP, show all routes assigned to an operator
  const { data: routes } = supabase
    ? await supabase
        .from("routes")
        .select("id, route_date, status, operator_id, operator(id, full_name), route_stops(id, status)")
        .gte("route_date", new Date().toISOString().split("T")[0])
        .order("route_date", { ascending: true })
    : { data: [] };

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
            body="Check back later for new route assignments."
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
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
                      <p className="text-sm text-slate-500">{totalStops} machine stops</p>
                    </div>
                    <StatusBadge status={route.status} />
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

        <div className="mt-8 rounded-lg bg-blue-50 border border-blue-200 p-4">
          <h3 className="font-semibold text-blue-900 mb-2">How to use this app:</h3>
          <ol className="text-sm text-blue-800 space-y-1 ml-4 list-decimal">
            <li>Select a route to start your day</li>
            <li>Pick stock from storage as instructed</li>
            <li>Visit each machine stop in order</li>
            <li>Fill machines with the exact quantities shown</li>
            <li>Record cash collected at each stop</li>
            <li>Return any leftovers to storage</li>
          </ol>
        </div>
      </div>
    </AppShell>
  );
}
