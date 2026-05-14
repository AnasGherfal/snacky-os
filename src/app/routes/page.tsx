import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
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
  const { data: routes } = supabase
    ? await supabase.from("routes").select("id, route_date, status, operator_id").order("route_date", { ascending: false })
    : { data: [] };
  const routeRows = routes ?? [];
  const operatorIds = Array.from(new Set(routeRows.map((route: any) => route.operator_id).filter(Boolean)));
  const routeIds = routeRows.map((route: any) => route.id);
  const [{ data: operators }, { data: stops }] = supabase
    ? await Promise.all([
        operatorIds.length ? supabase.from("team_members").select("id, full_name").in("id", operatorIds) : Promise.resolve({ data: [] }),
        routeIds.length ? supabase.from("route_stops").select("id, route_id").in("route_id", routeIds) : Promise.resolve({ data: [] }),
      ])
    : [{ data: [] }, { data: [] }];
  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator]));
  const stopsByRouteId = new Map<string, number>();
  (stops ?? []).forEach((stop: any) => {
    stopsByRouteId.set(stop.route_id, (stopsByRouteId.get(stop.route_id) ?? 0) + 1);
  });

  return (
    <AppShell>
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
        <DataTable headers={["Date", "Operator", "Status", "Stops", "Details"]}>
          {routeRows.map((route: any) => (
            <tr key={route.id}>
              <td>{route.route_date}</td>
              <td>{operatorById.get(route.operator_id)?.full_name ?? "Unassigned"}</td>
              <td><StatusBadge status={route.status} /></td>
              <td>{stopsByRouteId.get(route.id) ?? 0}</td>
              <td>
                <Link className="link-secondary" href={`/routes/${route.id}`}>
                  View route
                </Link>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
