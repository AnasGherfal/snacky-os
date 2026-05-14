import { notFound } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { EmptyState, ErrorState, SecondaryButton, StatusBadge, PrimaryButton, SectionCard } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function OperatorRouteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: routeId } = await params;
  const supabase = getSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!supabase) notFound();

  // Fetch route, stops, and refill order data
  const [{ data: route }, { data: stops }] = await Promise.all([
    supabase
      .from("routes")
      .select("id, route_date, status, operator_id, operator(id, full_name)")
      .eq("id", routeId)
      .single(),
    supabase
      .from("route_stops")
      .select(
        `id, stop_order, status, machine_id, machine(id, name, machine_code, location_id)`,
      )
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true }),
  ]);

  if (!route) notFound();

  const routeRow: any = route;
  if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, routeRow.operator_id)) {
    return (
      <AppShell>
        <ErrorState title="Route unavailable" body="This route is not assigned to you." action={<SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>} />
      </AppShell>
    );
  }
  const routeStops = stops ?? [];
  const completedStops = routeStops.filter((s: any) => s.status === "completed").length;
  const totalStops = routeStops.length;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">
              Route for {routeRow.route_date}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {routeRow.operator?.full_name} - {totalStops} machine stops
            </p>
          </div>
          <SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>
        </div>

        {/* Route Status Cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">Status</div>
              <StatusBadge status={routeRow.status} />
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">Progress</div>
              <div className="font-semibold text-lg">
                {completedStops}/{totalStops}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">Action</div>
              {routeRow.status === "draft" || routeRow.status === "assigned" ? (
                <PrimaryButton href={`/operator/routes/${routeId}/pick-list`}>
                  Start Route
                </PrimaryButton>
              ) : routeRow.status === "in_progress" ? (
                <PrimaryButton href={`/operator/routes/${routeId}/leftovers`}>
                  End Route
                </PrimaryButton>
              ) : (
                <div className="text-sm text-slate-600">Route completed</div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Pick List Section */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Refill Summary</h2>
          {routeRow.status === "draft" || routeRow.status === "assigned" ? (
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800 mb-4">
              <strong>Ready to start?</strong> Click "Start Route" above to view your pick list and begin picking stock from storage.
            </div>
          ) : null}
          <Link
            href={`/operator/routes/${routeId}/pick-list`}
            className="inline-block rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition"
          >
            View Pick List
          </Link>
        </section>

        {/* Machine Stops */}
        <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="p-4 md:p-6 border-b border-slate-200">
            <h2 className="text-lg font-semibold">Machine Stops ({totalStops})</h2>
          </div>
          {!routeStops.length ? (
            <EmptyState
              title="No stops"
              body="This route currently has no machine stops."
            />
          ) : (
            <div className="divide-y divide-slate-200">
              {routeStops.map((stop: any) => (
                <div key={stop.id} className="p-4 md:p-6 hover:bg-slate-50 transition">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-slate-200 text-sm font-semibold text-slate-700">
                        {stop.stop_order}
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-900">{stop.machine?.name}</h3>
                        <p className="text-sm text-slate-500">
                          Code: {stop.machine?.machine_code}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={stop.status} />
                  </div>

                  {routeRow.status === "in_progress" || routeRow.status === "completed" ? (
                    <Link
                      href={`/operator/routes/${routeId}/stops/${stop.id}`}
                      className="inline-block rounded-lg border border-blue-300 bg-blue-50 hover:bg-blue-100 px-3 py-1 text-sm font-medium text-blue-700 transition"
                    >
                      {stop.status === "completed" ? "View stop" : "Continue filling"}
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
