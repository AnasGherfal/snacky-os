import { redirect } from "next/navigation";
import Link from "next/link";
import { EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { isOperatorRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getServerI18n } from "@/lib/i18n/server";
import { MachineIssueClaimButton } from "@/components/operator/MachineIssueClaimButton";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Tripoli",
  }).format(new Date(value));
}

export default async function OperatorIssuesPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;

  const supabase = getSupabaseAdminClient();
  let query = supabase
    ?.from("issues")
    .select("id, issue_type, priority, status, description, created_at, sla_due_at, machine:machines(id, name, machine_code, location:locations(id, name))")
    .order("created_at", { ascending: false });

  if (query && isOperatorRole(profile)) {
    query = query.eq("reported_by", profile.team_member_id ?? "");
  }

  const { data: issues } = query ? await query : { data: [] };
  const memberId = profile.team_member_id ?? "";
  const { data: myTasks } = supabase && memberId
    ? await supabase
        .from("crm_tasks")
        .select("id,title,priority,status,dispatch_state,due_date,created_at,issue:issues(id,issue_type,description,created_at,location:locations(name,distance_from_storage_km),machine:machines(id,name,machine_code))")
        .eq("task_type", "field_action")
        .eq("assigned_to", memberId)
        .is("archived_at", null)
        .neq("status", "completed")
        .order("created_at", { ascending: true })
    : { data: [] };

  // The read-only RPC validates active operator access and returns only
  // machine-only issues with a machine.report receipt. No customer PII or
  // unrelated CRM tasks can leak into the shared operator queue.
  const { data: availableMachineTasks, error: availableError } = supabase && isOperatorRole(profile)
    ? await supabase.rpc("snacky_available_machine_issues_v1")
    : { data: [], error: null };
  if (availableError) console.error("[operator-issues] Could not load shared machine issue queue", { code: availableError.code });
  const availableRows = (availableMachineTasks ?? []) as Array<{
    task_id: string; issue_id: string; title: string; description: string;
    priority: string; created_at: string; machine_name: string | null;
    machine_code: string | null; location_name: string | null;
    distance_from_storage_km: number | string | null;
  }>;

  return (
    <>
      <PageHeader
        title="Machine issues"
        subtitle={tr("Claim available machine incidents or finish work already assigned to you.", "استلم بلاغات أعطال الماكينات المتاحة أو أكمل العمل المسند إليك.")}
        action={<SecondaryButton href="/operator/routes">Back to my routes</SecondaryButton>}
      />

      {isOperatorRole(profile) ? (
        <section className="mb-6 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4" dir={ar ? "rtl" : "ltr"}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-amber-950">{tr("Available machine issues", "أعطال الماكينات المتاحة")}</h2>
            <span className="rounded-full bg-amber-200 px-3 py-1 text-sm font-bold text-amber-950">{availableRows.length}</span>
          </div>
          <p className="text-sm text-amber-900">{tr(
            "All active operators can see these issues. The first operator to claim takes responsibility for the visit. If you fix it, record your diagnosis and a field photo to close the machine-only report. Customer complaints remain with Customer Relations.",
            "البلاغات ظاهرة لكل المشغّلين النشطين. أول مشغّل يستلم البلاغ يصبح مسؤولاً عن الزيارة. إذا أصلحت العطل، سجّل التشخيص وأرفق صورة ميدانية لإغلاق بلاغ الماكينة. مشاكل العملاء تبقى لدى علاقات العملاء.",
          )}</p>
          {availableError ? (
            <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-900">{tr("Could not load available machine issues. Refresh this page.", "تعذر تحميل بلاغات الماكينات. حدّث الصفحة.")}</p>
          ) : !availableRows.length ? (
            <p className="rounded-lg bg-white p-3 text-sm text-slate-600">{tr("No unclaimed machine issues at the moment.", "لا توجد بلاغات ماكينة بانتظار الاستلام حالياً.")}</p>
          ) : (
            <div className="space-y-3">
              {availableRows.map((task) => (
                <article key={task.task_id} className="rounded-xl border border-amber-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2"><StatusBadge status={task.priority} />
                    <span className="text-xs text-slate-500">{formatDateTime(task.created_at)}</span>
                  </div>
                  <h3 className="mt-2 font-semibold text-slate-950">
                    {task.machine_name ?? tr("Machine incident", "بلاغ ماكينة")}
                    {task.machine_code ? ` · ${task.machine_code}` : ""}
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">{task.location_name ?? ""}
                    {task.distance_from_storage_km != null
                      ? ` · ${Number(task.distance_from_storage_km).toFixed(1)} km ${tr("from storage (one way)", "من المخزن (اتجاه واحد)")}` : ""}
                  </p>
                  <p className="my-3 whitespace-pre-wrap text-sm text-slate-800">{task.description ?? task.title}</p>
                  <MachineIssueClaimButton taskId={task.task_id} userId={profile.id} />
                </article>
              ))}
            </div>
          )}
          <p className="text-xs text-amber-900">{tr("Phone push alerts require notifications enabled on the operator's device in Account. In-app issues appear regardless.", "إشعارات الهاتف تحتاج تفعيلها من حساب المشغّل. البلاغات داخل سناكي تظهر حتى بدون إشعارات الهاتف.")}</p>
        </section>
      ) : null}

      <section className="mb-6 space-y-3" dir={ar ? "rtl" : "ltr"}>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{tr("My field work", "مهامي الميدانية")}</h2>
          <p className="text-sm text-slate-500">
            {tr("Open a claimed issue, record the diagnosis and field photos, then select Fixed or a maintenance outcome. Customer complaints are followed up by Customer Relations.", "افتح البلاغ الذي استلمته، وسجّل التشخيص والصور، ثم حدّد تم الإصلاح أو احتياج الصيانة. علاقات العملاء تتابع مشاكل العملاء.")}
          </p>
        </div>
        {!myTasks?.length ? (
          <EmptyState
            title="No assigned machine issues"
            body="If Customer Relations needs a field visit, the assigned issue will appear here."
          />
        ) : (
          myTasks.map((task: any) => (
            <article key={task.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge status={task.priority} />
                    <StatusBadge status={task.dispatch_state ?? task.status} />
                  </div>
                  <h3 className="mt-2 font-semibold text-slate-900">{task.title}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {task.issue?.location?.name ?? ""}
                    {task.issue?.machine?.name ? ` · ${task.issue.machine.name}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {task.issue?.location?.distance_from_storage_km !== null && task.issue?.location?.distance_from_storage_km !== undefined
                      ? `${Number(task.issue.location.distance_from_storage_km).toFixed(1)} km one way from storage · `
                      : ""}
                    Reported {formatDateTime(task.issue?.created_at ?? task.created_at)}
                  </p>
                  {task.issue?.description ? <p className="mt-2 text-sm text-slate-700">{task.issue.description}</p> : null}
                </div>
                <Link className="btn-primary min-h-11" href={`/follow-ups/${task.id}`}>
                  Open field action
                </Link>
              </div>
            </article>
          ))
        )}
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
