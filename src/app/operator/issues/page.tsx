import { redirect } from "next/navigation";
import { EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { isOperatorRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}

export default async function OperatorIssuesPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = getSupabaseServerClient();
  let query = supabase
    ?.from("issues")
    .select("id, issue_type, priority, status, description, created_at, sla_due_at, machine:machines(id, name, machine_code, location:locations(id, name))")
    .order("created_at", { ascending: false });

  if (query && isOperatorRole(profile)) {
    query = query.eq("reported_by", profile.team_member_id ?? "");
  }

  const { data: issues } = query ? await query : { data: [] };

  return (
    <>
      <PageHeader
        title="Issues"
        subtitle="Machine issues you reported from route execution screens."
        action={<SecondaryButton href="/operator/routes">Back to my routes</SecondaryButton>}
      />

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
