import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function formatRecommendationQty(value: number | null | undefined) {
  return value === null || value === undefined ? "Capacity missing" : value;
}

export default async function RefillsPage() {
  const supabase = getSupabaseServerClient();
  const { data: recommendations, error } = supabase
    ? await supabase
        .from("refill_recommendations")
        .select("machine_name, slot_code, product_name, current_qty, capacity, par_qty, suggested_qty, final_qty_to_take, available_storage_qty, priority, latest_vms_at, imported_at")
        .order("suggested_qty", { ascending: false })
    : { data: null, error: null };

  if (error) console.error("[refills] Failed to load refill recommendations", error);

  return (
    <AppShell>
      <PageHeader title="Refill Recommendations" subtitle="System-generated refill picks from imported VMS machine goods stock. Planograms are optional until VMS planogram sync is connected." />
      {!supabase ? (
        <EmptyState title="Connect Supabase to activate refills" body="Add environment variables and restart the app." />
      ) : !recommendations?.length ? (
        <EmptyState title="No refill recommendations yet" body="Import a VMS Machine Goods or Machine Inventory stock report with mapped products and capacity. Snacky planograms can be added later." />
      ) : (
        <DataTable headers={["Machine", "VMS slot", "Product", "Current", "Capacity", "Need", "Take", "Storage", "Priority", "Latest import"]}>
          {recommendations.map((row: any, index: number) => (
            <tr key={`${row.machine_name}-${row.slot_code}-${row.product_name}-${index}`}>
              <td className="font-medium">{row.machine_name}</td>
              <td>{row.slot_code ?? "VMS item"}</td>
              <td>{row.product_name}</td>
              <td>{row.current_qty}</td>
              <td>{formatRecommendationQty(row.capacity ?? row.par_qty)}</td>
              <td>{formatRecommendationQty(row.suggested_qty)}</td>
              <td className="font-semibold text-slate-900">{formatRecommendationQty(row.final_qty_to_take ?? row.suggested_qty)}</td>
              <td>{row.available_storage_qty}</td>
              <td><StatusBadge status={row.priority} /></td>
              <td>{row.imported_at ? new Date(row.imported_at).toLocaleString("en-US") : "-"}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
