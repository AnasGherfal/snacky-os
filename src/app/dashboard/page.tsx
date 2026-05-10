import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { StatCard } from "@/components/StatCard";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function getCounts() {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const [machines, products, issues, recommendations] = await Promise.all([
    supabase.from("machines").select("id", { count: "exact", head: true }),
    supabase.from("products").select("id", { count: "exact", head: true }),
    supabase.from("issues").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    supabase.from("refill_recommendations").select("machine_id", { count: "exact", head: true }),
  ]);

  return {
    machines: machines.count ?? 0,
    products: products.count ?? 0,
    openIssues: issues.count ?? 0,
    refillRecommendations: recommendations.count ?? 0,
  };
}

export default async function DashboardPage() {
  const counts = await getCounts();

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Owner Dashboard</h1>
        <p className="mt-2 text-slate-500">Today’s control panel: machines, refills, inventory, cash, and issues.</p>
      </div>

      {!counts ? (
        <EmptyState
          title="Connect Supabase to activate the dashboard"
          body="Create .env.local using .env.example, paste the Supabase URL and anon key from npx supabase status, then restart npm run dev."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-4">
          <StatCard label="Machines" value={counts.machines} note="Active + inactive records" />
          <StatCard label="Products" value={counts.products} note="Sellable items" />
          <StatCard label="Need refill" value={counts.refillRecommendations} note="Based on latest VMS stock" />
          <StatCard label="Open issues" value={counts.openIssues} note="Not resolved yet" />
        </div>
      )}

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Next system feature</h2>
          <p className="mt-2 text-sm text-slate-500">
            Build the VMS import screen, product mapping, and refill recommendation workflow. This removes the daily “what should I take?” thinking.
          </p>
        </section>
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Operating rule</h2>
          <p className="mt-2 text-sm text-slate-500">
            Every refill must create inventory movement, cash collection, cleaning checklist, and photo proof. No action should live only in someone’s head.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
