import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
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
    .select("id, issue_type, priority, status, description, created_at, sla_due_at, machine:machines(name, machine_code)")
    .order("created_at", { ascending: false });

  if (query && isOperatorRole(profile.role)) {
    query = query.eq("reported_by", profile.team_member_id ?? "");
  }

  const { data: issues } = query ? await query : { data: [] };

  return (
    <AppShell>
      <PageHeader
        title="Issues"
        subtitle="Machine issues you reported from route execution screens."
        action={<SecondaryButton href="/operator/routes">Back to my routes</SecondaryButton>}
      />

      {!issues?.length ? (
        <EmptyState title="No issues reported" body="Report machine problems from a route stop while completing your refill workflow." />
      ) : (
        <DataTable headers={["Created", "Machine", "Type", "Priority", "Status", "SLA", "Description"]}>
          {issues.map((issue: any) => (
            <tr key={issue.id}>
              <td>{formatDate(issue.created_at)}</td>
              <td>
                <div className="font-medium text-slate-900">{issue.machine?.name ?? "Unknown machine"}</div>
                <div className="text-xs text-slate-500">{issue.machine?.machine_code ?? "-"}</div>
              </td>
              <td>{issue.issue_type}</td>
              <td><StatusBadge status={issue.priority} /></td>
              <td><StatusBadge status={issue.status} /></td>
              <td>{formatDate(issue.sla_due_at)}</td>
              <td>{issue.description ?? "-"}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
