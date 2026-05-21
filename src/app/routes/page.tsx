import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function RoutesPage() {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Routes unavailable" body="Supabase is not configured, so Snacky OS cannot load routes." />
      </>
    );
  }
  const { data: routes, error: routesError } = await supabase.from("routes").select("id, route_date, status, operator_id").order("route_date", { ascending: false });
  if (routesError) {
    console.error("[routes] Failed to load routes", routesError);
    return (
      <>
        <ErrorState title="Could not load routes" body="Snacky OS could not load route records from Supabase." action={<SecondaryButton href="/routes">Retry</SecondaryButton>} />
      </>
    );
  }
  const routeRows = routes ?? [];
  const operatorIds = Array.from(new Set(routeRows.map((route: any) => route.operator_id).filter(Boolean)));
  const routeIds = routeRows.map((route: any) => route.id);
  const [{ data: operators, error: operatorsError }, { data: stops, error: stopsError }] = await Promise.all([
    operatorIds.length ? supabase.from("team_members").select("id, full_name").in("id", operatorIds) : Promise.resolve({ data: [], error: null }),
    routeIds.length ? supabase.from("route_stops").select("id, route_id").in("route_id", routeIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const setupError = operatorsError ?? stopsError;
  if (setupError) {
    console.error("[routes] Failed to load route supporting data", setupError);
    return (
      <>
        <ErrorState title="Could not load route summary" body="Routes loaded, but operator or stop summary data could not be read." action={<SecondaryButton href="/routes">Retry</SecondaryButton>} />
      </>
    );
  }
  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator]));
  const stopsByRouteId = new Map<string, number>();
  (stops ?? []).forEach((stop: any) => {
    stopsByRouteId.set(stop.route_id, (stopsByRouteId.get(stop.route_id) ?? 0) + 1);
  });

  const groups = [
    { title: "Unassigned / Available", rows: routeRows.filter((route: any) => !route.operator_id && !["completed", "reviewed", "cancelled"].includes(route.status)) },
    { title: "In progress", rows: routeRows.filter((route: any) => route.status === "in_progress") },
    { title: "Assigned routes", rows: routeRows.filter((route: any) => route.operator_id && !["in_progress", "completed", "reviewed", "cancelled"].includes(route.status)) },
    { title: "Completed", rows: routeRows.filter((route: any) => ["completed", "reviewed"].includes(route.status)) },
  ].filter((group) => group.rows.length);

  const renderRouteCards = (rows: any[]) => (
    <MobileCardList>
      {rows.map((route: any) => (
        <MobileRecordCard key={route.id}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words text-base font-semibold text-slate-900">{route.route_date}</h2>
              <p className="mt-1 text-sm text-slate-500">{operatorById.get(route.operator_id)?.full_name ?? "Available"}</p>
            </div>
            <StatusBadge status={!route.operator_id ? "available" : route.status} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MobileField label="Stops">{stopsByRouteId.get(route.id) ?? 0}</MobileField>
            <MobileField label="Performer">{operatorById.get(route.operator_id)?.full_name ?? "Unassigned"}</MobileField>
          </div>
          <Link className="btn-secondary mt-4 w-full" href={`/routes/${route.id}`}>
            View route
          </Link>
        </MobileRecordCard>
      ))}
    </MobileCardList>
  );

  const renderRouteTable = (rows: any[]) => (
    <DataTable className="hidden md:block" headers={["Date", "Performer", "Status", "Stops", "Details"]}>
      {rows.map((route: any) => (
        <tr key={route.id}>
          <td>{route.route_date}</td>
          <td>{operatorById.get(route.operator_id)?.full_name ?? "Unassigned"}</td>
          <td><StatusBadge status={!route.operator_id ? "available" : route.status} /></td>
          <td>{stopsByRouteId.get(route.id) ?? 0}</td>
          <td>
            <Link className="link-secondary" href={`/routes/${route.id}`}>
              View route
            </Link>
          </td>
        </tr>
      ))}
    </DataTable>
  );

  return (
    <>
      <PageHeader
        title="Routes"
        subtitle="Plan refill routes, assign operators, and track machine stops."
        action={<PrimaryButton href="/routes/new">Create route</PrimaryButton>}
      />
      {!routeRows.length ? (
        <EmptyState
          title="No routes yet"
          body="Create your first refill route from recommendations or add machine stops manually."
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.title} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-900">{group.title}</h2>
                <span className="text-sm text-slate-500">{group.rows.length}</span>
              </div>
              {renderRouteCards(group.rows)}
              {renderRouteTable(group.rows)}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
