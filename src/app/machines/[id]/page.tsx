import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName, formatSiteLabel } from "@/lib/machine-site-display";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function sum(rows: any[], field: string) { return rows.reduce((total, row) => total + Number(row?.[field] ?? 0), 0); }
function time(value: unknown) { return value ? new Date(String(value)).toLocaleString("en-US") : "-"; }

export default async function MachineHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/machines")) redirect("/unauthorized");
  const authClient = await getAuthenticatedSupabaseServerClient();
  if (!authClient) return <ErrorState title="Machine unavailable" body="Supabase is not configured." />;
  const client = getSupabaseAdminClient() ?? authClient;
  const { data: machine, error: machineError } = await client.from("machines").select("*, location:locations(*)").eq("id", id).maybeSingle();
  if (machineError || !machine) return <ErrorState title="Machine not found" body="This machine could not be loaded." action={<SecondaryButton href="/machines">Back to machines</SecondaryButton>} />;

  const stopsResult = await client.from("route_stops").select("id, route_id, stop_order, status").eq("machine_id", id).limit(500);
  let stops: any[] = stopsResult.data ?? [];
  let stopsError = stopsResult.error;
  if (!stops.length) {
    const [stopItemsResult, refillOrdersResult, refillHistoryResult] = await Promise.all([
      client.from("route_stop_items").select("route_id, route_stop_id, machine_id").eq("machine_id", id).limit(1000),
      client.from("refill_orders").select("route_id, machine_id").eq("machine_id", id).limit(1000),
      client.from("machine_refill_history").select("route_id, machine_id").eq("machine_id", id).limit(1000),
    ]);
    const fallbackRouteIds = Array.from(new Set([
      ...(stopItemsResult.data ?? []).map((row: any) => row.route_id),
      ...(refillOrdersResult.data ?? []).map((row: any) => row.route_id),
      ...(refillHistoryResult.data ?? []).map((row: any) => row.route_id),
    ].filter(Boolean)));
    if (fallbackRouteIds.length) {
      stops = fallbackRouteIds.map((routeId, index) => ({ id: `history-${index}-${routeId}`, route_id: routeId, stop_order: null, status: null }));
      stopsError = null;
    }
  }
  const routeIds = Array.from(new Set(stops.map((row: any) => row.route_id).filter(Boolean)));
  const [routesResult, fillsResult, salesResult, adjustmentsResult, cashResult, movementsResult] = await Promise.all([
    routeIds.length ? client.from("routes").select("id, route_date, status, operator_id, created_at, started_at, completed_at").in("id", routeIds).order("route_date", { ascending: false }).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    client.from("route_stop_fill_lines").select("id, route_id, product_id, substitute_product_id, missing_product_name, actual_qty, action_type, created_at, product:products!route_stop_fill_lines_product_id_fkey(name)").eq("machine_id", id).order("created_at", { ascending: false }).limit(500),
    client.from("route_manual_sales").select("id, route_id, product_name, quantity, total_amount_lyd, payment_method, sale_time, status").eq("machine_id", id).order("sale_time", { ascending: false }).limit(500),
    client.from("inventory_adjustments").select("id, route_id, adjustment_type, product_name, quantity, reason, notes, status, created_at").eq("machine_id", id).neq("status", "cancelled").order("created_at", { ascending: false }).limit(500),
    client.from("cash_collections").select("id, route_id, vms_expected_cash, actual_cash_collected, variance, collected_at").eq("machine_id", id).order("collected_at", { ascending: false }).limit(250),
    client.from("inventory_movements").select("id, related_route_id, quantity, reason, movement_type, from_entity_type, to_entity_type, created_at, product:products(name)").eq("related_machine_id", id).order("created_at", { ascending: false }).limit(500),
  ]);
  const routes = routesResult.data ?? [];
  const operatorIds = Array.from(new Set(routes.map((route: any) => route.operator_id).filter(Boolean)));
  const { data: operators } = operatorIds.length ? await client.from("team_members").select("id, full_name").in("id", operatorIds) : { data: [] };
  const operatorById = new Map((operators ?? []).map((row: any) => [row.id, row]));
  const stopByRouteId = new Map((stops ?? []).map((row: any) => [row.route_id, row]));
  const fills = fillsResult.error ? [] : (fillsResult.data ?? []);
  const sales = salesResult.error ? [] : (salesResult.data ?? []).filter((row: any) => String(row.status ?? "confirmed") === "confirmed");
  const adjustments = adjustmentsResult.error ? [] : (adjustmentsResult.data ?? []);
  const cash = cashResult.error ? [] : (cashResult.data ?? []);
  const movements = movementsResult.error ? [] : (movementsResult.data ?? []);
  const damaged = adjustments.filter((row: any) => row.adjustment_type === "damaged");
  const returned = adjustments.filter((row: any) => row.adjustment_type === "returned_from_machine");
  const machineStorage = movements.filter((row: any) => {
    const reason = String(row.reason ?? "").toLowerCase();
    return row.to_entity_type === "machine_storage"
      || row.movement_type === "route_to_machine_storage"
      || reason === "extra_stock_left_at_machine"
      || reason === "machine_storage";
  });
  const filledByProduct = new Map<string, number>();
  fills.forEach((row: any) => { const name = row.product?.name ?? row.missing_product_name ?? "Unknown product"; filledByProduct.set(name, (filledByProduct.get(name) ?? 0) + Number(row.actual_qty ?? 0)); });

  return <div className="space-y-6">
    <PageHeader title={formatMachineDisplayName(machine, { includeArea: true })} subtitle={`${machine.machine_code} · ${formatSiteLabel(machine.location, { includeArea: true, fallback: "No site" })}`} breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: machine.machine_code }]} action={<div className="flex gap-2"><SecondaryButton href={`/machines/${id}/edit`}>Edit machine</SecondaryButton><SecondaryButton href="/machines">Back</SecondaryButton></div>} />
    {(stopsError || routesResult.error) ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Some machine history could not load.</div> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Routes</div><div className="mt-1 text-2xl font-semibold">{routes.length}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Units filled</div><div className="mt-1 text-2xl font-semibold">{sum(fills, "actual_qty")}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Manual sales</div><div className="mt-1 text-2xl font-semibold">{lyd(sum(sales, "total_amount_lyd"))}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Damaged / returned</div><div className="mt-1 text-2xl font-semibold">{sum(damaged, "quantity")} / {sum(returned, "quantity")}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Machine storage</div><div className="mt-1 text-2xl font-semibold">{sum(machineStorage, "quantity")}</div></div></SectionCard>
    </div>

    <section className="surface-card p-4"><h2 className="text-lg font-semibold">Route history</h2>{!routes.length ? <EmptyState title="No routes" body="No route has visited this machine yet." /> : <DataTable headers={["Date & time", "Operator", "Stop", "Status", "Route"]}>{routes.map((route: any) => <tr key={route.id}><td><div>{route.route_date}</div><div className="text-xs text-slate-500">{time(route.created_at)}</div></td><td>{operatorById.get(route.operator_id)?.full_name ? <Link className="link-secondary" href={`/team/${route.operator_id}`}>{operatorById.get(route.operator_id)?.full_name}</Link> : "-"}</td><td>{stopByRouteId.get(route.id)?.stop_order ?? "-"}</td><td><StatusBadge status={route.status} /></td><td><Link className="link-secondary" href={`/routes/${route.id}`}>Open route</Link></td></tr>)}</DataTable>}</section>

    <section className="surface-card p-4"><h2 className="text-lg font-semibold">Products filled</h2>{!filledByProduct.size ? <EmptyState title="No fill history" body="Completed fill quantities will appear here." /> : <DataTable headers={["Product", "Total filled"]}>{Array.from(filledByProduct.entries()).sort((a,b)=>b[1]-a[1]).map(([name, quantity]) => <tr key={name}><td>{name}</td><td>{quantity}</td></tr>)}</DataTable>}</section>

    <div className="grid gap-4 xl:grid-cols-2">
      <section className="surface-card p-4"><h2 className="text-lg font-semibold">Manual sales</h2>{!sales.length ? <EmptyState title="No manual sales" body="Manual route sales for this machine will appear here." /> : <DataTable headers={["Time", "Product", "Qty", "Total", "Route"]}>{sales.map((sale: any)=><tr key={sale.id}><td>{time(sale.sale_time)}</td><td>{sale.product_name ?? "Product"}</td><td>{sale.quantity}</td><td>{lyd(Number(sale.total_amount_lyd ?? 0))}</td><td>{sale.route_id ? <Link className="link-secondary" href={`/routes/${sale.route_id}`}>Route</Link> : "-"}</td></tr>)}</DataTable>}</section>
      <section className="surface-card p-4"><h2 className="text-lg font-semibold">Cash collections</h2>{!cash.length ? <EmptyState title="No cash history" body="Cash records will appear here." /> : <DataTable headers={["Time", "Counted", "Expected", "Variance"]}>{cash.map((row: any)=><tr key={row.id}><td>{time(row.collected_at)}</td><td>{lyd(Number(row.actual_cash_collected ?? 0))}</td><td>{row.vms_expected_cash == null ? "-" : lyd(Number(row.vms_expected_cash))}</td><td>{row.variance == null ? "-" : lyd(Number(row.variance))}</td></tr>)}</DataTable>}</section>
    </div>

    <section className="surface-card p-4"><h2 className="text-lg font-semibold">Damaged, returned, and machine storage</h2>{!adjustments.length && !machineStorage.length ? <EmptyState title="No adjustments" body="Damaged, returned, and machine-storage records will appear here." /> : <DataTable headers={["Time", "Type", "Product", "Qty", "Route", "Notes"]}>{[...adjustments.map((row: any)=>({ id: row.id, created_at: row.created_at, type: row.adjustment_type, product: row.product_name, quantity: row.quantity, route_id: row.route_id, notes: row.reason ?? row.notes })), ...machineStorage.map((row: any)=>({ id: row.id, created_at: row.created_at, type: "machine_storage", product: row.product?.name, quantity: row.quantity, route_id: row.related_route_id, notes: row.reason }))].sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at))).map((row:any)=><tr key={`${row.type}-${row.id}`}><td>{time(row.created_at)}</td><td><StatusBadge status={row.type} /></td><td>{row.product ?? "Product"}</td><td>{row.quantity}</td><td>{row.route_id ? <Link className="link-secondary" href={`/routes/${row.route_id}`}>Route</Link> : "-"}</td><td>{row.notes ?? "-"}</td></tr>)}</DataTable>}</section>
  </div>;
}
