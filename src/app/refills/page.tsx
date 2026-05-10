import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function RefillsPage() {
  const supabase = getSupabaseServerClient();
  const { data: recommendations } = supabase
    ? await supabase.from("refill_recommendations").select("machine_name, slot_code, product_name, current_qty, par_qty, suggested_qty, priority").order("machine_name")
    : { data: null };

  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">Refill Recommendations</h1>
      <p className="mt-2 text-slate-500">The first automation: what to take, where to take it, and how urgent it is.</p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        {!recommendations?.length ? (
          <EmptyState title="No refill recommendations yet" body="Add machine slots and import VMS stock snapshots. Empty/low products will appear here automatically." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="p-4">Machine</th><th>Slot</th><th>Product</th><th>Current</th><th>Par</th><th>Take</th><th>Priority</th></tr>
            </thead>
            <tbody>
              {recommendations.map((r: any, idx: number) => (
                <tr key={`${r.machine_name}-${r.slot_code}-${idx}`} className="border-b border-slate-100 last:border-0">
                  <td className="p-4 font-medium">{r.machine_name}</td>
                  <td>{r.slot_code}</td>
                  <td>{r.product_name}</td>
                  <td>{r.current_qty}</td>
                  <td>{r.par_qty}</td>
                  <td className="font-semibold">{r.suggested_qty}</td>
                  <td>{r.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
