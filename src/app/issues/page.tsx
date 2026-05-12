import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function IssuesPage() {
  const supabase = getSupabaseServerClient();
  const { data: issues } = supabase
    ? await supabase.from("issues").select("id, issue_type, priority, status, description, machines(name)").order("created_at", { ascending: false })
    : { data: null };

  return <AppShell><PageHeader title="Issues" subtitle="Track machine incidents, priorities, and SLA execution." />{!issues?.length ? <EmptyState title="No issues yet" body="Operator-reported machine problems will appear here." /> : <DataTable headers={["Machine","Type","Priority","Status","Description"]}>{issues.map((i:any)=><tr key={i.id}><td className="font-medium">{i.machines?.name ?? "—"}</td><td>{i.issue_type}</td><td><StatusBadge status={i.priority} /></td><td><StatusBadge status={i.status} /></td><td>{i.description}</td></tr>)}</DataTable>}</AppShell>;
}
