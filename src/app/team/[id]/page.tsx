import Link from "next/link";
import { redirect } from "next/navigation";
import OperatorMoneyLedgerClient from "@/app/operator-money/OperatorMoneyLedgerClient";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, normalizeRoles } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const HIDDEN_HISTORY_STATUSES = new Set(["cancelled", "canceled", "voided", "rejected", "deleted"]);

function sum(rows: any[], field: string) {
  return rows.reduce((total, row) => total + Number(row?.[field] ?? 0), 0);
}

function time(value: unknown) {
  return value ? new Date(String(value)).toLocaleString("en-US") : "-";
}

function historyStatus(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isVisibleHistoryRow(row: any) {
  return !HIDDEN_HISTORY_STATUSES.has(historyStatus(row?.status));
}

export default async function TeamMemberProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getCurrentProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent(`/team/${id}`)}`);
  const manager = isOwnerAdminRole(profile);
  const viewingSelf = Boolean(profile.team_member_id && profile.team_member_id === id);
  if (!manager && !viewingSelf) redirect("/unauthorized");

  const client = getSupabaseAdminClient() ?? getSupabaseServerClient();
  if (!client) return <ErrorState title="Team profile unavailable" body="Supabase is not configured." />;

  const { data: member, error: memberError } = await client
    .from("team_members")
    .select("id, full_name, email, phone, role, roles, active, active_status")
    .eq("id", id)
    .maybeSingle();

  if (memberError || !member) {
    return <ErrorState title="Team member not found" body="This team member could not be loaded." action={manager ? <SecondaryButton href="/team">Back to team</SecondaryButton> : undefined} />;
  }

  const { data: routes, error: routesError } = await client
    .from("routes")
    .select("id, route_date, status, operator_id, created_at, started_at, completed_at")
    .eq("operator_id", id)
    .order("route_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  const routeIds = (routes ?? []).map((route: any) => route.id);
  const [stopsResult, fillsResult, salesResult, adjustmentsResult, movementsResult] = await Promise.all([
    routeIds.length
      ? client.from("route_stops").select("id, route_id, machine_id, stop_order, status").in("route_id", routeIds).order("stop_order", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    routeIds.length
      ? client.from("route_stop_fill_lines").select("id, route_id, machine_id, product_id, missing_product_name, actual_qty, action_type, created_at, product:products!route_stop_fill_lines_product_id_fkey(name)").in("route_id", routeIds).order("created_at", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    routeIds.length
      ? client.from("route_manual_sales").select("id, route_id, machine_id, product_name, quantity, total_amount_lyd, payment_method, sale_time, status").in("route_id", routeIds).order("sale_time", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    routeIds.length
      ? client.from("inventory_adjustments").select("id, route_id, machine_id, adjustment_type, product_name, quantity, reason, notes, status, created_at").in("route_id", routeIds).order("created_at", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    routeIds.length
      ? client.from("inventory_movements").select("id, related_route_id, related_machine_id, quantity, reason, movement_type, from_entity_type, to_entity_type, created_at, product:products(name)").in("related_route_id", routeIds).order("created_at", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const stops = stopsResult.error ? [] : (stopsResult.data ?? []);
  const machineIds = Array.from(new Set(stops.map((row: any) => row.machine_id).filter(Boolean)));
  const { data: machines, error: machinesError } = machineIds.length
    ? await client.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", machineIds)
    : { data: [], error: null };

  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  const stopsByRoute = new Map<string, any[]>();
  stops.forEach((stop: any) => stopsByRoute.set(stop.route_id, [...(stopsByRoute.get(stop.route_id) ?? []), stop]));

  const fills = fillsResult.error ? [] : (fillsResult.data ?? []);
  const sales = salesResult.error ? [] : (salesResult.data ?? []).filter(isVisibleHistoryRow);
  const adjustments = adjustmentsResult.error ? [] : (adjustmentsResult.data ?? []).filter(isVisibleHistoryRow);
  const movements = movementsResult.error ? [] : (movementsResult.data ?? []);
  const damaged = adjustments.filter((row: any) => historyStatus(row.adjustment_type) === "damaged");
  const returned = adjustments.filter((row: any) => historyStatus(row.adjustment_type) === "returned_from_machine");
  const machineStorage = movements.filter((row: any) => {
    const reason = historyStatus(row.reason);
    return row.to_entity_type === "machine_storage"
      || row.movement_type === "route_to_machine_storage"
      || reason === "extra_stock_left_at_machine"
      || reason === "machine_storage";
  });
  const completedRoutes = (routes ?? []).filter((route: any) => ["completed", "verified", "payroll_pending", "paid", "reviewed"].includes(historyStatus(route.status)));
  const historyLoadError = routesError || stopsResult.error || fillsResult.error || salesResult.error || adjustmentsResult.error || movementsResult.error || machinesError;
  const headerActions = manager
    ? <div className="flex gap-2"><SecondaryButton href={`/team/${id}/activity`}>Activity log</SecondaryButton><SecondaryButton href={`/team/${id}/edit`}>Edit</SecondaryButton></div>
    : <SecondaryButton href="/operator/routes">My routes</SecondaryButton>;

  return <div className="space-y-6">
    <PageHeader title={member.full_name} subtitle={`${normalizeRoles(member.roles, member.role).join(", ")} · ${member.email ?? "No email"}`} breadcrumbs={manager ? [{ label: "Team", href: "/team" }, { label: member.full_name }] : [{ label: "My profile" }]} action={headerActions} />

    {historyLoadError ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Some operator history could not load. Available profile details are still shown.</div> : null}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Routes</div><div className="mt-1 text-2xl font-semibold">{(routes ?? []).length}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Completed</div><div className="mt-1 text-2xl font-semibold">{completedRoutes.length}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Machines visited</div><div className="mt-1 text-2xl font-semibold">{machineIds.length}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Units filled</div><div className="mt-1 text-2xl font-semibold">{sum(fills, "actual_qty")}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Manual sales</div><div className="mt-1 text-2xl font-semibold">{lyd(sum(sales, "total_amount_lyd"))}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">Damaged / returned</div><div className="mt-1 text-2xl font-semibold">{sum(damaged, "quantity")} / {sum(returned, "quantity")}</div></div></SectionCard>
    </div>

    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Money, debt, purchases, and expenses</h2>
        <p className="mt-1 text-sm text-slate-500">Personal storage purchases, operator advances, work expenses, repayments, and returned money belong to this person.</p>
      </div>
      <OperatorMoneyLedgerClient initialPersonId={id} lockPerson />
    </section>

    <section className="surface-card p-4">
      <h2 className="text-lg font-semibold">Route history</h2>
      {!(routes ?? []).length ? <EmptyState title="No routes" body="No routes are assigned to this team member." /> : <DataTable headers={["Date & time", "Status", "Machine stops", "Filled units", "Manual sales", "Route"]}>{(routes ?? []).map((route: any) => { const routeStops = stopsByRoute.get(route.id) ?? []; const routeFills = fills.filter((row: any) => row.route_id === route.id); const routeSales = sales.filter((row: any) => row.route_id === route.id); return <tr key={route.id}><td><div>{route.route_date}</div><div className="text-xs text-slate-500">{time(route.created_at)}</div></td><td><StatusBadge status={route.status} /></td><td><div className="max-w-xl">{routeStops.map((stop: any) => formatMachineDisplayName(machineById.get(stop.machine_id) ?? null, { includeArea: true })).join(" · ") || "-"}</div></td><td>{sum(routeFills, "actual_qty")}</td><td>{lyd(sum(routeSales, "total_amount_lyd"))}</td><td><Link className="link-secondary" href={`/routes/${route.id}`}>Open</Link></td></tr>; })}</DataTable>}
    </section>

    <div className="grid gap-4 xl:grid-cols-2">
      <section className="surface-card p-4">
        <h2 className="text-lg font-semibold">Manual sales made on routes</h2>
        {!sales.length ? <EmptyState title="No manual sales" body="Manual route sales will appear here." /> : <DataTable headers={["Time", "Machine", "Product", "Qty", "Total", "Status", "Route"]}>{sales.map((sale: any) => <tr key={sale.id}><td>{time(sale.sale_time)}</td><td>{sale.machine_id ? <Link className="link-secondary" href={`/machines/${sale.machine_id}`}>{formatMachineDisplayName(machineById.get(sale.machine_id) ?? null, { includeArea: true })}</Link> : "-"}</td><td>{sale.product_name ?? "Product"}</td><td>{sale.quantity}</td><td>{lyd(Number(sale.total_amount_lyd ?? 0))}</td><td><StatusBadge status={historyStatus(sale.status) || "recorded"} /></td><td><Link className="link-secondary" href={`/routes/${sale.route_id}`}>Route</Link></td></tr>)}</DataTable>}
      </section>

      <section className="surface-card p-4">
        <h2 className="text-lg font-semibold">Products filled</h2>
        {!fills.length ? <EmptyState title="No fill history" body="Completed fill activity will appear here." /> : <DataTable headers={["Time", "Machine", "Product", "Qty", "Route"]}>{fills.map((row: any) => <tr key={row.id}><td>{time(row.created_at)}</td><td>{row.machine_id ? <Link className="link-secondary" href={`/machines/${row.machine_id}`}>{formatMachineDisplayName(machineById.get(row.machine_id) ?? null, { includeArea: true })}</Link> : "-"}</td><td>{row.product?.name ?? row.missing_product_name ?? "Product"}</td><td>{row.actual_qty}</td><td><Link className="link-secondary" href={`/routes/${row.route_id}`}>Route</Link></td></tr>)}</DataTable>}
      </section>
    </div>

    <section className="surface-card p-4">
      <h2 className="text-lg font-semibold">Damaged, returned, and machine storage</h2>
      {!adjustments.length && !machineStorage.length ? <EmptyState title="No product adjustments" body="Operator-assigned damaged, returned, and machine-storage records will appear here." /> : <DataTable headers={["Time", "Type", "Machine", "Product", "Qty", "Status", "Route", "Reason"]}>{[...adjustments.map((row: any) => ({ id: row.id, time: row.created_at, type: row.adjustment_type, machine_id: row.machine_id, product: row.product_name, quantity: row.quantity, status: historyStatus(row.status) || "recorded", route_id: row.route_id, reason: row.reason ?? row.notes })), ...machineStorage.map((row: any) => ({ id: row.id, time: row.created_at, type: "machine_storage", machine_id: row.related_machine_id, product: row.product?.name, quantity: row.quantity, status: "recorded", route_id: row.related_route_id, reason: row.reason }))].sort((a: any, b: any) => String(b.time).localeCompare(String(a.time))).map((row: any) => <tr key={`${row.type}-${row.id}`}><td>{time(row.time)}</td><td><StatusBadge status={row.type} /></td><td>{row.machine_id ? <Link className="link-secondary" href={`/machines/${row.machine_id}`}>{formatMachineDisplayName(machineById.get(row.machine_id) ?? null, { includeArea: true })}</Link> : "-"}</td><td>{row.product ?? "Product"}</td><td>{row.quantity}</td><td><StatusBadge status={row.status} /></td><td>{row.route_id ? <Link className="link-secondary" href={`/routes/${row.route_id}`}>Route</Link> : "-"}</td><td>{row.reason ?? "-"}</td></tr>)}</DataTable>}
    </section>
  </div>;
}
