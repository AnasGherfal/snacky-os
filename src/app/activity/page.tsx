import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ActivityLogTable } from "@/app/activity/ActivityLogTable";
import { EmptyState, ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { AppRole, appRoles, isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const operationalEntityTypes = new Set(["route", "route_stop", "inventory_movement", "cash_collection", "issue"]);

function canViewActivity(role: AppRole | null | undefined) {
  return isOwnerAdminRole(role) || isSupervisorRole(role);
}

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{ user_id?: string; role?: string; action?: string; entity_type?: string; date_from?: string; date_to?: string; q?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewActivity(profile.role)) redirect("/unauthorized");

  const { user_id = "", role = "", action = "", entity_type = "", date_from = "", date_to = "", q = "" } = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <AppShell>
        <ErrorState title="Activity log unavailable" body="Supabase is not configured, so Snacky OS cannot load system_activity_logs." action={<SecondaryButton href="/dashboard">Back to dashboard</SecondaryButton>} />
      </AppShell>
    );
  }

  const [{ data: users, error: usersError }, { data: actions, error: actionsError }, { data: entityTypes, error: entityTypesError }, activityResult] = await Promise.all([
    supabase.from("team_members").select("id, full_name").order("full_name"),
    supabase.from("system_activity_logs").select("action").order("action"),
    supabase.from("system_activity_logs").select("entity_type").order("entity_type"),
    (() => {
      let query = supabase
        .from("system_activity_logs")
        .select("id, actor_team_member_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, summary, before_data, after_data, metadata, created_at, actor:team_members(full_name)");
      if (user_id) query = query.eq("actor_team_member_id", user_id);
      if (role && appRoles.includes(role as AppRole)) query = query.eq("actor_role", role);
      if (action) query = query.eq("action", action);
      if (entity_type) query = query.eq("entity_type", entity_type);
      if (date_from) query = query.gte("created_at", `${date_from}T00:00:00`);
      if (date_to) query = query.lte("created_at", `${date_to}T23:59:59`);
      if (isSupervisorRole(profile.role)) query = query.in("entity_type", [...operationalEntityTypes]);
      return query.order("created_at", { ascending: false }).limit(300);
    })(),
  ]);

  const loadError = usersError ?? actionsError ?? entityTypesError ?? (activityResult as any).error;
  if (loadError) {
    console.error("[activity] Failed to load system_activity_logs", loadError);
    return (
      <AppShell>
        <ErrorState title="Could not load activity log" body="The activity page reads real system_activity_logs rows, but the database query failed." action={<SecondaryButton href="/activity">Retry</SecondaryButton>} />
      </AppShell>
    );
  }

  const search = q.trim().toLowerCase();
  const rows = ((activityResult as any).data ?? []).filter((row: any) => {
    if (!search) return true;
    return [row.actor_name, row.actor_role, row.action, row.entity_type, row.entity_label, row.summary, JSON.stringify(row.metadata ?? {})].join(" ").toLowerCase().includes(search);
  });
  const actionOptions = Array.from(new Set((actions ?? []).map((row: any) => row.action).filter(Boolean)));
  const entityOptions = Array.from(new Set((entityTypes ?? []).map((row: any) => row.entity_type).filter((type: string) => type && (!isSupervisorRole(profile.role) || operationalEntityTypes.has(type)))));
  const roleOptions = appRoles.filter((item) => !isSupervisorRole(profile.role) || item === "supervisor" || item === "operator" || item === "warehouse");

  return (
    <AppShell>
      <PageHeader title="System Activity Log" subtitle="Audit trail of user actions recorded by Snacky OS." />

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <input name="q" defaultValue={q} placeholder="Search action, entity, summary, metadata..." className="field-input" />
          <select name="user_id" defaultValue={user_id} className="field-input">
            <option value="">All users</option>
            {users?.map((user: any) => <option key={user.id} value={user.id}>{user.full_name}</option>)}
          </select>
          <select name="role" defaultValue={role} className="field-input">
            <option value="">All roles</option>
            {roleOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select name="action" defaultValue={action} className="field-input">
            <option value="">All actions</option>
            {actionOptions.map((item) => <option key={item} value={item}>{String(item).replaceAll("_", " ")}</option>)}
          </select>
          <select name="entity_type" defaultValue={entity_type} className="field-input">
            <option value="">All entity types</option>
            {entityOptions.map((item) => <option key={item} value={item}>{String(item).replaceAll("_", " ")}</option>)}
          </select>
          <input name="date_from" type="date" defaultValue={date_from} className="field-input" />
          <input name="date_to" type="date" defaultValue={date_to} className="field-input" />
          <button className="btn-primary">Filter</button>
        </form>
      </section>

      {!rows.length ? (
        <EmptyState title="No activity found" body="New audited actions will appear here as the team uses the system." />
      ) : (
        <ActivityLogTable rows={rows as any} />
      )}
    </AppShell>
  );
}
