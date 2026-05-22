import { notFound } from "next/navigation";
import Link from "next/link";
import { EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge, SectionCard } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function OperatorRouteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: routeId } = await params;
  const supabase = getSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!supabase) notFound();

  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, status, operator_id, started_at, completed_at")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) console.error("[operator:route] Failed to load route", { routeId, error: routeError });
  if (!route) notFound();

  const routeRow: any = route;
  const canAccess = canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, routeRow.operator_id);

  const [{ data: operator }, { data: stops, error: stopsError }, { data: routeStock }] = await Promise.all([
    routeRow.operator_id
      ? supabase.from("team_members").select("id, full_name").eq("id", routeRow.operator_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("route_stops")
      .select("id, stop_order, status, machine_id")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true }),
    supabase
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name)")
      .eq("route_id", routeId),
  ]);
  if (stopsError) console.error("[operator:route] Failed to load stops", { routeId, error: stopsError });

  if (!canAccess) {
    return (
      <>
        <ErrorState
          title="Route unavailable"
          body={process.env.NODE_ENV === "development"
            ? `This route is assigned to ${routeRow.operator_id}. You are matched to team member ${profile?.team_member_id ?? "none"} for auth user ${profile?.id ?? "none"}.`
            : "This route is not assigned to you."}
          action={<SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>}
        />
      </>
    );
  }
  const routeStops = stops ?? [];
  const machineIds = routeStops.map((stop: any) => stop.machine_id).filter(Boolean);
  const { data: machines } = machineIds.length
    ? await supabase.from("machines").select("id, name, machine_code").in("id", machineIds)
    : { data: [] };
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  const completedStops = routeStops.filter((s: any) => s.status === "completed").length;
  const totalStops = routeStops.length;
  const pickItems = routeStock ?? [];
  const primaryAction =
    routeRow.status === "draft" || routeRow.status === "assigned"
      ? { href: `/operator/routes/${routeId}/pick-list?start=1`, label: routeRow.operator_id ? "Start Route" : "Claim & Start" }
      : routeRow.status === "in_progress"
        ? { href: `/operator/routes/${routeId}/leftovers`, label: "End Route" }
        : null;

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title={`Route for ${routeRow.route_date}`}
          subtitle={`${operator?.full_name ?? "Available to claim"} - ${totalStops} machine stops`}
          action={<SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>}
        />

        {/* Route Status Cards */}
        <div className="grid gap-3 sm:grid-cols-3">
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
              {primaryAction ? (
                <Link href={primaryAction.href} className="btn-primary w-full text-base">
                  {primaryAction.label}
                </Link>
              ) : (
                <div className="text-sm text-slate-600">Route completed</div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Pick List Section */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Pick list</h2>
          {routeRow.status === "draft" || routeRow.status === "assigned" ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <strong>Ready to start?</strong> Click "{routeRow.operator_id ? "Start Route" : "Claim & Start"}" above to view your pick list and begin picking stock from storage.
            </div>
          ) : null}
          {!pickItems.length ? (
            <EmptyState title="No pick list yet" body="This route has no products assigned to pick from storage." />
          ) : (
            <div className="mb-4 space-y-2">
              {pickItems.map((item: any) => (
                <div key={item.id} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words font-medium text-slate-900">{item.product?.name ?? "Unknown product"}</span>
                  <span className="shrink-0 text-slate-600">{item.picked_qty || item.planned_qty} / {item.planned_qty} picked</span>
                </div>
              ))}
            </div>
          )}
          <Link
            href={`/operator/routes/${routeId}/pick-list`}
            className="btn-secondary w-full sm:w-auto"
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
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700">
                        {stop.stop_order}
                      </div>
                      <div className="min-w-0">
                        <h3 className="break-words font-semibold text-slate-900">{machineById.get(stop.machine_id)?.name ?? "Unknown machine"}</h3>
                        <p className="text-sm text-slate-500">
                          Code: {machineById.get(stop.machine_id)?.machine_code ?? "-"}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={stop.status} />
                    </div>
                  </div>

                  {routeRow.status === "in_progress" || routeRow.status === "completed" ? (
                    <Link
                      href={`/operator/routes/${routeId}/stops/${stop.id}`}
                      className="btn-primary mt-1 w-full text-base sm:w-auto"
                    >
                      {stop.status === "completed" ? "View stop" : "Continue filling"}
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {primaryAction ? (
          <div className="sticky bottom-3 z-10 -mx-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:hidden">
            <Link href={primaryAction.href} className="btn-primary w-full text-base">
              {primaryAction.label}
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
