import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("en-US") : "-";
}

export default async function TeamMemberActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ action?: string; date_from?: string; date_to?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const { id } = await params;
  const { action = "", date_from = "", date_to = "" } = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const { data: member } = await supabase.from("team_members").select("id, full_name, email, phone, role, active_status").eq("id", id).maybeSingle();
  if (!member) notFound();

  let activityQuery = supabase
    .from("system_activity_logs")
    .select("id, action, entity_type, entity_id, entity_label, summary, metadata, created_at")
    .eq("actor_team_member_id", id);
  if (action) activityQuery = activityQuery.eq("action", action);
  if (date_from) activityQuery = activityQuery.gte("created_at", `${date_from}T00:00:00`);
  if (date_to) activityQuery = activityQuery.lte("created_at", `${date_to}T23:59:59`);

  const [{ data: activity }, { data: routes }, { data: movements }, { data: cash }, { data: issues }, { data: actions }] = await Promise.all([
    activityQuery.order("created_at", { ascending: false }).limit(200),
    supabase.from("routes").select("id, route_date, status, completed_at").eq("operator_id", id).order("route_date", { ascending: false }).limit(100),
    supabase
      .from("inventory_movements")
      .select("id, quantity, reason, related_route_id, notes, created_at, product:products(name, sku)")
      .eq("created_by", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("cash_collections")
      .select("id, route_id, machine_id, actual_cash_collected, variance, review_status, collected_at, machine:machines(name)")
      .eq("operator_id", id)
      .order("collected_at", { ascending: false })
      .limit(100),
    supabase
      .from("issues")
      .select("id, issue_type, priority, status, created_at, machine:machines(name)")
      .eq("reported_by", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("system_activity_logs").select("action").eq("actor_team_member_id", id).order("action"),
  ]);

  const routeRows = (routes ?? []) as any[];
  const completedRoutes = routeRows.filter((route) => ["completed", "reviewed"].includes(route.status)).length;
  const actionOptions = Array.from(new Set((actions ?? []).map((row: any) => row.action).filter(Boolean)));

  return (
    <AppShell>
      <PageHeader
        title={member.full_name}
        subtitle="Team member activity, route execution, movement history, cash variance, and issue reporting."
        action={<SecondaryButton href={`/team/${id}/edit`}>Edit member</SecondaryButton>}
      />

      <section className="grid gap-4 md:grid-cols-4">
        <div className="surface-card"><div className="text-sm text-slate-500">Role</div><div className="mt-2"><StatusBadge status={member.role} /></div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Assigned routes</div><div className="mt-1 text-3xl font-semibold">{routeRows.length}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Completed routes</div><div className="mt-1 text-3xl font-semibold">{completedRoutes}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Cash records</div><div className="mt-1 text-3xl font-semibold">{cash?.length ?? 0}</div></div>
      </section>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Activity</h2>
        <form className="mb-4 grid gap-3 md:grid-cols-4">
          <select name="action" defaultValue={action} className="field-input">
            <option value="">All actions</option>
            {actionOptions.map((item) => <option key={item} value={item}>{String(item).replaceAll("_", " ")}</option>)}
          </select>
          <input name="date_from" type="date" defaultValue={date_from} className="field-input" />
          <input name="date_to" type="date" defaultValue={date_to} className="field-input" />
          <button className="btn-primary">Filter</button>
        </form>
        {!activity?.length ? <EmptyState title="No activity found" body="Audited actions by this team member will appear here." /> : (
          <DataTable headers={["Date", "Action", "Entity", "Summary"]}>
            {activity.map((row: any) => <tr key={row.id}><td>{formatDate(row.created_at)}</td><td><StatusBadge status={row.action} /></td><td>{row.entity_label ?? row.entity_type}</td><td>{row.summary ?? "-"}</td></tr>)}
          </DataTable>
        )}
      </section>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Routes</h2>
        {!routeRows.length ? <EmptyState title="No assigned routes" body="Assigned and completed routes will appear here." /> : (
          <DataTable headers={["Date", "Status", "Completed", "Route"]}>
            {routeRows.map((route: any) => <tr key={route.id}><td>{route.route_date}</td><td><StatusBadge status={route.status} /></td><td>{formatDate(route.completed_at)}</td><td><Link href={`/routes/${route.id}`} className="link-secondary">Open route</Link></td></tr>)}
          </DataTable>
        )}
      </section>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Inventory movements</h2>
        {!movements?.length ? <EmptyState title="No stock movements" body="Movements created by this user will appear here." /> : (
          <DataTable headers={["Date", "Product", "Qty", "Reason", "Route", "Notes"]}>
            {movements.map((movement: any) => <tr key={movement.id}><td>{formatDate(movement.created_at)}</td><td>{movement.product?.name ?? "-"}</td><td>{movement.quantity}</td><td><StatusBadge status={movement.reason} /></td><td>{movement.related_route_id ? <Link href={`/routes/${movement.related_route_id}`} className="link-secondary">Open route</Link> : "-"}</td><td>{movement.notes ?? "-"}</td></tr>)}
          </DataTable>
        )}
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-2">
        <div className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Cash variances</h2>
          {!cash?.length ? <EmptyState title="No cash collections" body="Cash collection records entered by this user will appear here." /> : (
            <DataTable headers={["Date", "Machine", "Actual", "Variance", "Status"]}>
              {cash.map((row: any) => <tr key={row.id}><td>{formatDate(row.collected_at)}</td><td>{row.machine?.name ?? "-"}</td><td>{lyd(Number(row.actual_cash_collected ?? 0))}</td><td>{lyd(Number(row.variance ?? 0))}</td><td><StatusBadge status={row.review_status} /></td></tr>)}
            </DataTable>
          )}
        </div>
        <div className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Issues reported</h2>
          {!issues?.length ? <EmptyState title="No issues reported" body="Machine issues reported by this user will appear here." /> : (
            <DataTable headers={["Date", "Machine", "Type", "Priority", "Status"]}>
              {issues.map((issue: any) => <tr key={issue.id}><td>{formatDate(issue.created_at)}</td><td>{issue.machine?.name ?? "-"}</td><td>{issue.issue_type}</td><td><StatusBadge status={issue.priority} /></td><td><StatusBadge status={issue.status} /></td></tr>)}
            </DataTable>
          )}
        </div>
      </section>
    </AppShell>
  );
}
