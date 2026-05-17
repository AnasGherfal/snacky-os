import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function IssuesPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type = "" } = await searchParams;
  const supabase = getSupabaseServerClient();
  let query = supabase?.from("issues").select("id, issue_type, priority, status, description, machines(name)").order("created_at", { ascending: false });
  if (query && type) query = query.ilike("issue_type", `%${type}%`);

  const { data: issues } = query
    ? await query
    : { data: null };

  return <AppShell><PageHeader title="Issues" subtitle="Track machine incidents, priorities, and SLA execution." />
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap gap-2">
        <SecondaryButton href="/machines">Machines</SecondaryButton>
        <SecondaryButton href="/machine-slots">Planograms</SecondaryButton>
        <SecondaryButton href="/issues">Issues</SecondaryButton>
        <SecondaryButton href="/issues?type=maintenance">Maintenance</SecondaryButton>
      </div>
    </div>
    {!issues?.length ? <EmptyState title={type ? "No matching issues" : "No issues yet"} body="Operator-reported machine problems will appear here." /> : <DataTable headers={["Machine","Type","Priority","Status","Description"]}>{issues.map((i:any)=><tr key={i.id}><td className="font-medium">{i.machines?.name ?? "—"}</td><td>{i.issue_type}</td><td><StatusBadge status={i.priority} /></td><td><StatusBadge status={i.status} /></td><td>{i.description}</td></tr>)}</DataTable>}</AppShell>;
}
