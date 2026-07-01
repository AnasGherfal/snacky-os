import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActivityLogTable } from "@/app/activity/ActivityLogTable";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { isCompletedRouteStatus } from "@/lib/route-workflow";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { formatMachineDisplayName } from "@/lib/machine-site-display";

export const dynamic = "force-dynamic";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

function inDateRange<T extends Record<string, any>>(rows: T[] | null | undefined, key: keyof T, dateFrom: string, dateTo: string) {
  return (rows ?? []).filter((row) => {
    const raw = row[key];
    if (!raw) return true;
    const value = new Date(String(raw)).getTime();
    if (dateFrom && value < new Date(`${dateFrom}T00:00:00`).getTime()) return false;
    if (dateTo && value > new Date(`${dateTo}T23:59:59`).getTime()) return false;
    return true;
  });
}

export default async function TeamMemberActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ action?: string; entity_type?: string; date_from?: string; date_to?: string; q?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const { id } = await params;
  const filters = await searchParams;
  const dateFrom = filters.date_from ?? "";
  const dateTo = filters.date_to ?? "";
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const { data: member } = await supabase.from("team_members").select("id, full_name, email, role, active_status").eq("id", id).maybeSingle();
  if (!member) notFound();

  const [{ data: actions }, { data: entityTypes }] = await Promise.all([
    supabase.from("system_activity_logs").select("action").eq("actor_team_member_id", id).order("action"),
    supabase.from("system_activity_logs").select("entity_type").eq("actor_team_member_id", id).order("entity_type"),
  ]);

  let activityQuery = supabase
    .from("system_activity_logs")
    .select("id, actor_name, actor_role, action, entity_type, entity_id, entity_label, summary, before_data, after_data, metadata, created_at, actor:team_members(full_name)")
    .eq("actor_team_member_id", id);

  if (filters.action) activityQuery = activityQuery.eq("action", filters.action);
  if (filters.entity_type) activityQuery = activityQuery.eq("entity_type", filters.entity_type);
  if (dateFrom) activityQuery = activityQuery.gte("created_at", `${dateFrom}T00:00:00`);
  if (dateTo) activityQuery = activityQuery.lte("created_at", `${dateTo}T23:59:59`);

  let movementQuery = supabase
    .from("inventory_movements")
    .select("id, quantity, reason, related_route_id, notes, created_at, product:products(id, name, sku)")
    .eq("created_by", id);
  if (dateFrom) movementQuery = movementQuery.gte("created_at", `${dateFrom}T00:00:00`);
  if (dateTo) movementQuery = movementQuery.lte("created_at", `${dateTo}T23:59:59`);

  const [{ data: activity }, { data: movements }, { data: routes }, { data: cashCollections }, { data: issues }] = await Promise.all([
    activityQuery.order("created_at", { ascending: false }).limit(300),
    movementQuery.order("created_at", { ascending: false }).limit(200),
    supabase
      .from("routes")
      .select("id, route_date, status, started_at, completed_at, created_at")
      .eq("operator_id", id)
      .order("route_date", { ascending: false })
      .limit(200),
    supabase
      .from("cash_collections")
      .select("id, route_id, machine_id, vms_expected_cash, actual_cash_collected, variance, review_status, collected_at, machine:machines(id, name, machine_code, display_name, location:locations(id, name)), route:routes(id, route_date)")
      .eq("operator_id", id)
      .order("collected_at", { ascending: false })
      .limit(200),
    supabase
      .from("issues")
      .select("id, machine_id, issue_type, priority, status, description, created_at, resolved_at, machine:machines(id, name, machine_code, display_name, location:locations(id, name))")
      .eq("reported_by", id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const search = String(filters.q ?? "").trim().toLowerCase();
  const rows = (activity ?? []).filter((row: any) => {
    if (!search) return true;
    return [row.action, row.entity_type, row.entity_label, row.summary, JSON.stringify(row.metadata ?? {})].join(" ").toLowerCase().includes(search);
  });
  const actionOptions = Array.from(new Set((actions ?? []).map((row: any) => row.action).filter(Boolean)));
  const entityOptions = Array.from(new Set((entityTypes ?? []).map((row: any) => row.entity_type).filter(Boolean)));
  const routeRows = inDateRange(routes as any[], "route_date", dateFrom, dateTo);
  const completedRoutes = routeRows.filter((route) => isCompletedRouteStatus(route.status)).length;
  const cashRows = inDateRange(cashCollections as any[], "collected_at", dateFrom, dateTo);
  const issueRows = inDateRange(issues as any[], "created_at", dateFrom, dateTo);
  const movementRows = (movements ?? []) as any[];
  const totalCashVariance = cashRows.reduce((sum, row) => sum + Number(row.variance ?? 0), 0);

  return (
    <>
      <PageHeader
        title={`${member.full_name} Activity`}
        subtitle={`${member.email ?? "No email"} - audited actions, movements, routes, cash, and issues for this team member.`}
        action={<SecondaryButton href="/team">Back to team</SecondaryButton>}
      />

      <section className="mb-6 grid gap-4 md:grid-cols-4 xl:grid-cols-6">
        <div className="surface-card"><div className="text-sm text-slate-500">Role</div><div className="mt-2"><StatusBadge status={member.role} /></div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Audited actions</div><div className="mt-1 text-3xl font-semibold">{activity?.length ?? 0}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Inventory movements</div><div className="mt-1 text-3xl font-semibold">{movementRows.length}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Assigned routes</div><div className="mt-1 text-3xl font-semibold">{routeRows.length}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Completed routes</div><div className="mt-1 text-3xl font-semibold">{completedRoutes}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Cash variance</div><div className="mt-1 text-2xl font-semibold">{lyd(totalCashVariance)}</div></div>
      </section>

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <input name="q" defaultValue={filters.q ?? ""} placeholder="Search action, entity, summary..." className="field-input xl:col-span-2" />
          <select name="action" defaultValue={filters.action ?? ""} className="field-input">
            <option value="">All actions</option>
            {actionOptions.map((action) => <option key={action} value={action}>{String(action).replaceAll("_", " ")}</option>)}
          </select>
          <select name="entity_type" defaultValue={filters.entity_type ?? ""} className="field-input">
            <option value="">All entity types</option>
            {entityOptions.map((type) => <option key={type} value={type}>{String(type).replaceAll("_", " ")}</option>)}
          </select>
          <input name="date_from" type="date" defaultValue={dateFrom} className="field-input" />
          <input name="date_to" type="date" defaultValue={dateTo} className="field-input" />
          <div className="flex gap-2">
            <button className="btn-primary">Filter</button>
            <Link href={`/team/${id}/activity`} className="btn-secondary">Reset</Link>
          </div>
        </form>
      </section>

      <section className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">System activity</h2>
        {!rows.length ? (
          <EmptyState title="No audited actions found" body="Actions appear here only when system_activity_logs rows exist for this team member." />
        ) : (
          <ActivityLogTable rows={rows as any} />
        )}
      </section>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Inventory movements by user</h2>
        {!movementRows.length ? (
          <EmptyState title="No inventory movements" body="Product movements created by this team member will appear here." />
        ) : (
          <DataTable headers={["Date / Time", "Product", "SKU", "Qty", "Reason", "Route", "Notes"]}>
            {movementRows.map((movement: any) => (
              <tr key={movement.id}>
                <td>{formatDateTime(movement.created_at)}</td>
                <td>{movement.product?.id ? <Link href={`/products/${movement.product.id}`} className="link-secondary">{movement.product.name ?? "Unknown product"}</Link> : movement.product?.name ?? "Unknown product"}</td>
                <td>{movement.product?.sku ?? "-"}</td>
                <td className="font-semibold">{movement.quantity}</td>
                <td><StatusBadge status={String(movement.reason).replaceAll("_", " ")} /></td>
                <td>{movement.related_route_id ? <Link href={`/routes/${movement.related_route_id}`} className="link-secondary">Open route</Link> : "-"}</td>
                <td>{movement.notes ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Assigned and completed routes</h2>
        {!routeRows.length ? (
          <EmptyState title="No routes found" body="Assigned and completed routes for this team member will appear here." />
        ) : (
          <DataTable headers={["Route date", "Status", "Started", "Completed", "Route"]}>
            {routeRows.map((route: any) => (
              <tr key={route.id}>
                <td>{route.route_date}</td>
                <td><StatusBadge status={route.status} /></td>
                <td>{formatDateTime(route.started_at)}</td>
                <td>{formatDateTime(route.completed_at)}</td>
                <td><Link href={`/routes/${route.id}`} className="link-secondary">Open route</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-2">
        <div className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Cash collections</h2>
          {!cashRows.length ? (
            <EmptyState title="No cash collections" body="Cash records collected by this team member will appear here." />
          ) : (
            <DataTable headers={["Date / Time", "Machine", "Expected", "Counted", "Variance", "Status"]}>
              {cashRows.map((cash: any) => (
                <tr key={cash.id}>
                  <td>{formatDateTime(cash.collected_at)}</td>
                  <td>{formatMachineDisplayName(cash.machine as any, { includeArea: true })}</td>
                  <td>{cash.vms_expected_cash === null ? "-" : lyd(Number(cash.vms_expected_cash ?? 0))}</td>
                  <td>{cash.actual_cash_collected === null ? "-" : lyd(Number(cash.actual_cash_collected ?? 0))}</td>
                  <td>{cash.variance === null ? "-" : lyd(Number(cash.variance ?? 0))}</td>
                  <td><StatusBadge status={String(cash.review_status ?? "").replaceAll("_", " ")} /></td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        <div className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Issues reported</h2>
          {!issueRows.length ? (
            <EmptyState title="No issues reported" body="Issues reported by this team member will appear here." />
          ) : (
            <DataTable headers={["Date / Time", "Machine", "Type", "Priority", "Status"]}>
              {issueRows.map((issue: any) => (
                <tr key={issue.id}>
                  <td>{formatDateTime(issue.created_at)}</td>
                  <td>{formatMachineDisplayName(issue.machine as any, { includeArea: true })}</td>
                  <td>{issue.issue_type}</td>
                  <td><StatusBadge status={issue.priority} /></td>
                  <td><StatusBadge status={issue.status} /></td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      </section>
    </>
  );
}
