import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { StatCard } from "@/components/StatCard";
import { DataTable, PageHeader, SectionCard } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function getDashboardData() {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const [machines, refill, issues, lowStorage, cash] = await Promise.all([
    supabase.from("machines").select("id", { count: "exact", head: true }),
    supabase.from("refill_recommendations").select("machine_name, product_name, suggested_qty, priority").order("suggested_qty", { ascending: false }).limit(8),
    supabase.from("issues").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    supabase.from("current_inventory_by_location").select("product_name, quantity_on_hand").eq("location_type", "storage").lte("quantity_on_hand", 20).order("quantity_on_hand").limit(8),
    supabase.from("cash_collections").select("machine_id, vms_expected_cash, actual_cash_collected, variance").order("collected_at", { ascending: false }).limit(8),
  ]);

  return { machines: machines.count ?? 0, openIssues: issues.count ?? 0, refillRows: refill.data ?? [], lowStorageRows: lowStorage.data ?? [], cashRows: cash.data ?? [] };
}

export default async function DashboardPage() {
  const data = await getDashboardData();
  return <AppShell><PageHeader title="Dashboard" subtitle="Operational control center for refills, stock, issues, and cash variances." />{!data ? <EmptyState title="Connect Supabase to activate dashboard" body="Add environment variables and restart the app." /> : <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Total machines" value={data.machines} /><StatCard label="Machines needing refill" value={data.refillRows.length} /><StatCard label="Open issues" value={data.openIssues} /><StatCard label="Low storage products" value={data.lowStorageRows.length} /></div><div className="mt-6 grid gap-4 xl:grid-cols-2"><SectionCard><h2 className="mb-3 text-base font-semibold">Machines needing refill</h2><DataTable headers={["Machine","Product","Take","Priority"]}>{data.refillRows.map((r:any,idx:number)=><tr key={`${r.machine_name}-${idx}`}><td>{r.machine_name}</td><td>{r.product_name}</td><td>{r.suggested_qty}</td><td>{r.priority}</td></tr>)}</DataTable></SectionCard><SectionCard><h2 className="mb-3 text-base font-semibold">Low storage products</h2><DataTable headers={["Product","Qty"]}>{data.lowStorageRows.map((r:any,idx:number)=><tr key={`${r.product_name}-${idx}`}><td>{r.product_name}</td><td>{r.quantity_on_hand}</td></tr>)}</DataTable></SectionCard></div></>}</AppShell>;
}
