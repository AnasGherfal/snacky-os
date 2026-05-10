import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function MachinesPage() {
  const supabase = getSupabaseServerClient();
  const { data: machines } = supabase
    ? await supabase.from("machines").select("id, machine_code, name, status, machine_type, locations(name)").order("name")
    : { data: null };

  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">Machines</h1>
      <p className="mt-2 text-slate-500">Your physical vending machines, VMS IDs, locations, types, and status.</p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        {!machines?.length ? (
          <EmptyState title="No machines yet" body="Insert seed data or add your first machine in Supabase Studio." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="p-4">Code</th><th>Name</th><th>Location</th><th>Type</th><th>Status</th></tr>
            </thead>
            <tbody>
              {machines.map((m: any) => (
                <tr key={m.id} className="border-b border-slate-100 last:border-0">
                  <td className="p-4 font-medium">{m.machine_code}</td>
                  <td>{m.name}</td>
                  <td>{m.locations?.name ?? "—"}</td>
                  <td>{m.machine_type}</td>
                  <td>{m.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
