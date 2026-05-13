import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function RoutesPage() {
  const supabase = getSupabaseServerClient();
  const { data: routes } = supabase
    ? await supabase
        .from("routes")
        .select("id, route_date, status, operator(id, full_name), route_stops(id)")
        .order("route_date", { ascending: false })
    : { data: [] };

  return (
    <AppShell>
      <PageHeader
        title="Routes"
        subtitle="Plan refill routes, assign operators, and track machine stops."
        action={<PrimaryButton href="/routes/new">Create route</PrimaryButton>}
      />
      {!routes?.length ? (
        <EmptyState
          title="No routes yet"
          body="Create your first refill route from recommendations or add machine stops manually."
        />
      ) : (
        <DataTable headers={["Date", "Operator", "Status", "Stops", "Details"]}>
          {routes.map((route: any) => (
            <tr key={route.id}>
              <td>{route.route_date}</td>
              <td>{route.operator?.full_name ?? "Unassigned"}</td>
              <td><StatusBadge status={route.status} /></td>
              <td>{route.route_stops?.length ?? 0}</td>
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
