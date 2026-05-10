import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function InventoryPage() {
  const supabase = getSupabaseServerClient();
  const { data: inventory } = supabase
    ? await supabase.from("current_inventory_by_location").select("product_name, location_type, location_name, quantity_on_hand").order("product_name")
    : { data: null };

  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
      <p className="mt-2 text-slate-500">Live inventory view calculated from movements, not manual edits.</p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        {!inventory?.length ? (
          <EmptyState title="No inventory movement yet" body="Receive purchases, move products to operator bags, and refill machines to see inventory balances." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="p-4">Product</th><th>Location Type</th><th>Location</th><th>Qty</th></tr>
            </thead>
            <tbody>
              {inventory.map((row: any, idx: number) => (
                <tr key={`${row.product_name}-${row.location_name}-${idx}`} className="border-b border-slate-100 last:border-0">
                  <td className="p-4 font-medium">{row.product_name}</td>
                  <td>{row.location_type}</td>
                  <td>{row.location_name}</td>
                  <td>{row.quantity_on_hand}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
