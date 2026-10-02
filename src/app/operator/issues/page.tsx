import { redirect } from "next/navigation";
import Link from "next/link";
import { EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { OperatorIssueClaimButton } from "@/components/CrmIssueFieldQueue";
import { getCurrentProfile } from "@/lib/auth";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { isOperatorRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}

export default async function OperatorIssuesPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = getSupabaseAdminClient();
  let query = supabase
    ?.from("issues")
    .select("id, issue_type, priority, status, description, created_at, sla_due_at, machine:machines(id, name, machine_code, location:locations(id, name))")
    .order("created_at", { ascending: false });

  if (query && isOperatorRole(profile)) {
    query = query.eq("reported_by", profile.team_member_id ?? "");
  }

  const { data: issues } = query ? await query : { data: [] };
  const memberId=profile.team_member_id ?? "";
  const [{data:availableTasks},{data:myTasks}]=supabase ? await Promise.all([
    supabase.from("crm_tasks")
      .select("id,title,priority,due_date,notes,issue:issues(id,issue_type,description,location:locations(name,address,distance_from_storage_km),machine:machines(name,machine_code))")
      .eq("task_type","field_action").eq("dispatch_state","available").is("assigned_to",null).is("archived_at",null).neq("status","completed").order("created_at",{ascending:true}),
    memberId ? supabase.from("crm_tasks")
      .select("id,title,priority,status,dispatch_state,due_date,issue:issues(id,issue_type,location:locations(name,address,distance_from_storage_km),machine:machines(name,machine_code))")
      .eq("task_type","field_action").eq("assigned_to",memberId).is("archived_at",null).neq("status","completed").order("created_at",{ascending:true})
      : Promise.resolve({data:[]})
  ]) : [{data:[]},{data:[]}];

  return (
    <>
      <PageHeader
        title="Issues"
        subtitle="Claim shared machine issues, complete field work, and review issues you reported."
        action={<SecondaryButton href="/operator/routes">Back to my routes</SecondaryButton>}
      />

      <section className="mb-6 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Available machine issues</h2>
          <p className="text-sm text-slate-500">Shared queue. Claim an issue before travelling to the location.</p>
        </div>
        {!availableTasks?.length ? <EmptyState title="No unclaimed machine issues" body="New field issues from CRM will appear here for all operators." /> :
          availableTasks.map((task:any)=><article key={task.id} className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap gap-2"><StatusBadge status={task.priority}/><span className="text-xs text-slate-500">{task.due_date??"-"}</span></div>
                <h3 className="mt-2 font-semibold text-slate-900">{task.title}</h3>
                <p className="mt-1 text-sm text-slate-700">{task.issue?.location?.name??""}{task.issue?.machine?.name?` · ${task.issue.machine.name}`:""}</p>
                <p className="mt-1 text-xs text-slate-600">{task.issue?.location?.address??""}{task.issue?.location?.distance_from_storage_km!==null&&task.issue?.location?.distance_from_storage_km!==undefined?`${task.issue.location.address?" · ":""}${Number(task.issue.location.distance_from_storage_km).toFixed(1)} km one way from storage`:""}</p>
                <p className="mt-2 text-sm text-slate-700">{task.issue?.description??task.notes??"-"}</p>
              </div>
              <OperatorIssueClaimButton taskId={task.id}/>
            </div>
          </article>)}
      </section>

      <section className="mb-6 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">My claimed field work</h2>
          <p className="text-sm text-slate-500">Open the task to accept, travel, report the repair and attach proof.</p>
        </div>
        {!myTasks?.length ? <EmptyState title="No claimed field work" body="Claim an available machine issue when you are able to handle it." /> :
          myTasks.map((task:any)=><article key={task.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-semibold text-slate-900">{task.title}</h3><p className="mt-1 text-sm text-slate-500">{task.issue?.location?.name??""}{task.issue?.machine?.name?` · ${task.issue.machine.name}`:""}</p><p className="mt-1 text-xs text-slate-500">{task.issue?.location?.distance_from_storage_km!==null&&task.issue?.location?.distance_from_storage_km!==undefined?`${Number(task.issue.location.distance_from_storage_km).toFixed(1)} km one way from storage`:"Distance not set"}</p></div>
              <div className="flex gap-2"><StatusBadge status={task.dispatch_state??task.status}/><Link className="link-secondary" href={`/follow-ups/${task.id}`}>Open</Link></div>
            </div>
          </article>)}
      </section>

      <h2 className="mb-3 text-lg font-semibold text-slate-900">Issues I reported</h2>
      {!issues?.length ? (
        <EmptyState title="No issues reported" body="Report machine problems from a route stop while completing your refill workflow." />
      ) : (
        <div className="space-y-3">
          {issues.map((issue: any) => (
            <article key={issue.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-xs text-slate-500">{formatDate(issue.created_at)}</div>
                  <h2 className="mt-1 font-semibold text-slate-900">{issue.issue_type}</h2>
                  <div className="mt-1 text-sm text-slate-500">{formatMachineDisplayName(issue.machine ?? null, { includeArea: true })}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status={issue.priority} />
                  <StatusBadge status={issue.status} />
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-700">{issue.description ?? "-"}</p>
              <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                SLA due: <span className="font-medium text-slate-900">{formatDate(issue.sla_due_at)}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
