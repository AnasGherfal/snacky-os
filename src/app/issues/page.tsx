import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function IssuesPage() {
  const supabase = getSupabaseServerClient();
  const { data: issues } = supabase
    ? await supabase.from("issues").select("id, issue_type, priority, status, description, machines(name)").order("created_at", { ascending: false })
    : { data: null };

  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">Issues</h1>
      <p className="mt-2 text-slate-500">Maintenance tickets, SLA tracking, photos, and resolution history.</p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        {!issues?.length ? (
          <EmptyState title="No issues yet" body="Operator-reported machine problems will appear here." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="p-4">Machine</th><th>Type</th><th>Priority</th><th>Status</th><th>Description</th></tr>
            </thead>
            <tbody>
              {issues.map((i: any) => (
                <tr key={i.id} className="border-b border-slate-100 last:border-0">
                  <td className="p-4 font-medium">{i.machines?.name ?? "—"}</td>
                  <td>{i.issue_type}</td>
                  <td>{i.priority}</td>
                  <td>{i.status}</td>
                  <td>{i.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
