import { redirect } from "next/navigation";
import Link from "next/link";
import { EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { OperatorIssueClaimButton, OperatorIssueReleaseButton } from "@/components/CrmIssueFieldQueue";
import { getCurrentProfile } from "@/lib/auth";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { isOperatorRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}
function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(new Date(value));
}
function mapsSearchHref(address: string | null | undefined) {
  const value=String(address??"").trim();
  return value ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}` : null;
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
  const [{data:availableTasks},{data:myTasks},{data:teamMembers},{data:activeFieldTasks}]=supabase ? await Promise.all([
    supabase.from("crm_tasks")
      .select("id,title,priority,due_date,notes,created_at,issue:issues(id,issue_type,description,created_at,location:locations(name,address,distance_from_storage_km),machine:machines(id,name,machine_code))")
      .eq("task_type","field_action").eq("dispatch_state","available").is("assigned_to",null).is("archived_at",null).neq("status","completed").order("created_at",{ascending:true}),
    memberId ? supabase.from("crm_tasks")
      .select("id,title,priority,status,dispatch_state,due_date,created_at,issue:issues(id,issue_type,description,created_at,location:locations(name,address,distance_from_storage_km),machine:machines(id,name,machine_code))")
      .eq("task_type","field_action").eq("assigned_to",memberId).is("archived_at",null).neq("status","completed").order("created_at",{ascending:true})
      : Promise.resolve({data:[]}),
    supabase.from("team_members").select("id,full_name,role,roles").eq("active",true).eq("active_status","active").order("full_name"),
    supabase.from("crm_tasks").select("assigned_to,priority,dispatch_state,status").eq("task_type","field_action").is("archived_at",null).neq("status","completed").not("assigned_to","is",null)
  ]) : [{data:[]},{data:[]},{data:[]},{data:[]}];
  const operators=(teamMembers??[]).filter((row:any)=>row.role==="operator"||(Array.isArray(row.roles)&&row.roles.includes("operator")));
  const workload=operators.map((operator:any)=>{
    const tasks=(activeFieldTasks??[]).filter((task:any)=>task.assigned_to===operator.id);
    return {id:operator.id,name:operator.full_name??"Operator",active:tasks.length,urgent:tasks.filter((task:any)=>task.priority==="urgent").length};
  });

  return (
    <>
      <PageHeader
        title="Issues"
        subtitle="Claim shared machine issues, complete field work, and review issues you reported."
        action={<SecondaryButton href="/operator/routes">Back to my routes</SecondaryButton>}
      />

      <section className="mb-6 surface-card">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-900">Operator workload</h2><p className="mt-1 text-sm text-slate-500">Shared visibility only — CRM does not assign machine issues. An operator can hold up to 3 active machine issues and only 1 urgent issue at a time.</p></div><span className="text-xs text-slate-500">Active field work</span></div>
        <div className="mt-3 flex flex-wrap gap-2">{workload.map((row:any)=><span key={row.id} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm"><strong>{row.name}</strong> · {row.active} active{row.urgent? ` · ${row.urgent} urgent`:""}</span>)}</div>
      </section>

      <section className="mb-6 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Available machine issues</h2>
          <p className="text-sm text-slate-500">Shared queue. Review the location, distance and problem before claiming.</p>
        </div>
        {!availableTasks?.length ? <EmptyState title="No unclaimed machine issues" body="New field issues from CRM will appear here for all operators." /> :
          availableTasks.map((task:any)=><article key={task.id} className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap gap-2"><StatusBadge status={task.priority}/><span className="text-xs text-slate-500">Reported {formatDateTime(task.issue?.created_at??task.created_at)}</span></div>
                <h3 className="mt-2 font-semibold text-slate-900">{task.title}</h3>
                <p className="mt-1 text-sm text-slate-700">{task.issue?.location?.name??""}{task.issue?.machine?.name?` · ${task.issue.machine.name}`:""}</p>
                <p className="mt-1 text-xs text-slate-600">{task.issue?.location?.address??""}{task.issue?.location?.distance_from_storage_km!==null&&task.issue?.location?.distance_from_storage_km!==undefined?`${task.issue.location.address?" · ":""}${Number(task.issue.location.distance_from_storage_km).toFixed(1)} km one way from storage`:""}</p>
                <p className="mt-2 text-sm text-slate-700">{task.issue?.description??task.notes??"-"}</p>
                {mapsSearchHref(task.issue?.location?.address)?<a className="mt-2 inline-block text-sm text-sky-800 underline" target="_blank" rel="noopener noreferrer" href={mapsSearchHref(task.issue?.location?.address)??undefined}>Open location in Maps</a>:null}
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
              <div><h3 className="font-semibold text-slate-900">{task.title}</h3><p className="mt-1 text-sm text-slate-500">{task.issue?.location?.name??""}{task.issue?.machine?.name?` · ${task.issue.machine.name}`:""}</p><p className="mt-1 text-xs text-slate-500">{task.issue?.location?.distance_from_storage_km!==null&&task.issue?.location?.distance_from_storage_km!==undefined?`${Number(task.issue.location.distance_from_storage_km).toFixed(1)} km one way from storage`:"Distance not set"} · Reported {formatDateTime(task.issue?.created_at??task.created_at)}</p></div>
              <div className="flex flex-wrap items-start gap-2"><StatusBadge status={task.dispatch_state??task.status}/><Link className="link-secondary" href={`/follow-ups/${task.id}`}>Open</Link>{['assigned','accepted','en_route'].includes(String(task.dispatch_state))?<OperatorIssueReleaseButton taskId={task.id}/>:null}</div>
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
