import { redirect } from "next/navigation";
import { ActivityLogTable } from "@/app/activity/ActivityLogTable";
import { PaginationControls } from "@/components/PaginationControls";
import { EmptyState, ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { AppRole, appRoles, isOwnerAdminRole } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function canViewActivity(profile: Awaited<ReturnType<typeof getCurrentProfile>> | null) {
  return isOwnerAdminRole(profile);
}

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord & { user_id?: string; role?: string; action?: string; entity_type?: string; date_from?: string; date_to?: string; q?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewActivity(profile)) redirect("/unauthorized");

  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const user_id = String(params.user_id ?? "");
  const role = String(params.role ?? "");
  const action = String(params.action ?? "");
  const entity_type = String(params.entity_type ?? "");
  const date_from = String(params.date_from ?? "");
  const date_to = String(params.date_to ?? "");
  const q = String(params.q ?? "");
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Activity log unavailable" body="Supabase is not configured, so Snacky OS cannot load system_activity_logs." action={<SecondaryButton href="/dashboard">Back to dashboard</SecondaryButton>} />
      </>
    );
  }

  const [{ data: users, error: usersError }, { data: actions, error: actionsError }, { data: entityTypes, error: entityTypesError }, activityResult] = await Promise.all([
    supabase.from("team_members").select("id, full_name").order("full_name"),
    supabase.from("system_activity_logs").select("action").order("action").limit(500),
    supabase.from("system_activity_logs").select("entity_type").order("entity_type").limit(500),
    (() => {
      let query = supabase
        .from("system_activity_logs")
        .select("id, actor_team_member_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, summary, before_data, after_data, metadata, created_at, actor:team_members(full_name)", { count: "exact" });
      if (user_id) query = query.eq("actor_team_member_id", user_id);
      if (role && appRoles.includes(role as AppRole)) query = query.eq("actor_role", role);
      if (action) query = query.eq("action", action);
      if (entity_type) query = query.eq("entity_type", entity_type);
      if (date_from) query = query.gte("created_at", `${date_from}T00:00:00`);
      if (date_to) query = query.lte("created_at", `${date_to}T23:59:59`);
      if (q.trim()) {
        const pattern = supabaseLikePattern(q.replaceAll(",", " "));
        query = query.or(["actor_name", "actor_role", "action", "entity_type", "entity_label", "summary"].map((column) => `${column}.ilike.${pattern}`).join(","));
      }
      return query.order("created_at", { ascending: false }).range(from, to);
    })(),
  ]);

  const loadError = usersError ?? actionsError ?? entityTypesError ?? (activityResult as any).error;
  if (loadError) {
    console.error("[activity] Failed to load system_activity_logs", loadError);
    return (
      <>
        <ErrorState title="Could not load activity log" body="The activity page reads real system_activity_logs rows, but the database query failed." action={<SecondaryButton href="/activity">Retry</SecondaryButton>} />
      </>
    );
  }

  const rows = (activityResult as any).data ?? [];
  const actionOptions = Array.from(new Set((actions ?? []).map((row: any) => row.action).filter(Boolean)));
  const entityOptions = Array.from(new Set((entityTypes ?? []).map((row: any) => row.entity_type).filter(Boolean)));
  const roleOptions = appRoles;

  return (
    <>
      <PageHeader title="System Activity Log" subtitle="Audit trail of user actions recorded by Snacky OS." />

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <input type="hidden" name="pageSize" value={pageSize} />
          <input name="q" defaultValue={q} placeholder="Search action, entity, or summary..." className="field-input" />
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
        <>
          <ActivityLogTable rows={rows as any} />
          <PaginationControls basePath="/activity" searchParams={params} page={page} pageSize={pageSize} totalCount={(activityResult as any).count ?? 0} itemLabel="activity logs" />
        </>
      )}
    </>
  );
}
