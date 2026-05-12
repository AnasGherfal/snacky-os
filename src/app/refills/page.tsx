import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function RefillsPage() {
  const supabase = getSupabaseServerClient();
  const { data: recommendations } = supabase
    ? await supabase.from("refill_recommendations").select("machine_name, slot_code, product_name, current_qty, par_qty, suggested_qty, priority").order("machine_name")
    : { data: null };

  return <AppShell><PageHeader title="Refill Recommendations" subtitle="System-generated refill picks based on machine stock and slot par levels." />{!recommendations?.length ? <EmptyState title="No refill recommendations yet" body="Add machine slots and import VMS stock snapshots to activate this queue." /> : <DataTable headers={["Machine","Slot","Product","Current","Par","Take","Priority"]}>{recommendations.map((r:any,idx:number)=><tr key={`${r.machine_name}-${idx}`}><td className="font-medium">{r.machine_name}</td><td>{r.slot_code}</td><td>{r.product_name}</td><td>{r.current_qty}</td><td>{r.par_qty}</td><td className="font-semibold text-slate-900">{r.suggested_qty}</td><td><StatusBadge status={r.priority} /></td></tr>)}</DataTable>}</AppShell>;
}
