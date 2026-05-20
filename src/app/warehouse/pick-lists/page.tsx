import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function WarehousePickListsPage() {
  const supabase = getSupabaseServerClient();
  const { data: routes } = supabase
    ? await supabase
        .from("routes")
        .select("id, route_date, status, operator_id, route_stock_lines(id, planned_qty, picked_qty, product:products(name))")
        .in("status", ["draft", "assigned", "in_progress"])
        .order("route_date", { ascending: true })
    : { data: [] };

  const routeRows = (routes ?? []) as any[];
  const operatorIds = Array.from(new Set(routeRows.map((route) => route.operator_id).filter(Boolean)));
  const { data: operators } = supabase && operatorIds.length
    ? await supabase.from("team_members").select("id, full_name").in("id", operatorIds)
    : { data: [] };
  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator.full_name]));

  return (
    <>
      <PageHeader title="Pick Lists" subtitle="Storage pick demand for draft, assigned, and in-progress routes." />

      {!routeRows.length ? (
        <EmptyState title="No active pick lists" body="Routes that need stock picked from storage will appear here." />
      ) : (
        <DataTable headers={["Route Date", "Operator", "Status", "Pick List", "Remaining"]}>
          {routeRows.map((route) => {
            const lines = route.route_stock_lines ?? [];
            const plannedQty = lines.reduce((sum: number, line: any) => sum + Number(line.planned_qty ?? 0), 0);
            const pickedQty = lines.reduce((sum: number, line: any) => sum + Number(line.picked_qty ?? 0), 0);
            const productSummary = lines
              .slice(0, 3)
              .map((line: any) => `${line.product?.name ?? "Product"}: ${Number(line.picked_qty ?? 0) || Number(line.planned_qty ?? 0)}/${Number(line.planned_qty ?? 0)}`)
              .join(", ");

            return (
              <tr key={route.id}>
                <td className="font-medium text-slate-900">{route.route_date}</td>
                <td>{operatorById.get(route.operator_id) ?? "Unassigned"}</td>
                <td><StatusBadge status={route.status} /></td>
                <td>{productSummary || "No stock lines"}{lines.length > 3 ? `, +${lines.length - 3} more` : ""}</td>
                <td className="font-semibold">{Math.max(0, plannedQty - pickedQty)} / {plannedQty}</td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </>
  );
}
