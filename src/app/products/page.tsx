import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function ProductsPage() {
  const supabase = getSupabaseServerClient();
  const { data: products } = supabase
    ? await supabase.from("products").select("id, sku, name, category, cost_price, selling_price, active").order("name")
    : { data: null };

  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">Products</h1>
      <p className="mt-2 text-slate-500">Master list of sellable items, costs, selling prices, categories, and active status.</p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        {!products?.length ? (
          <EmptyState title="No products yet" body="Add products before importing VMS data, so mapping works correctly." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="p-4">SKU</th><th>Name</th><th>Category</th><th>Cost</th><th>Price</th><th>Active</th></tr>
            </thead>
            <tbody>
              {products.map((p: any) => (
                <tr key={p.id} className="border-b border-slate-100 last:border-0">
                  <td className="p-4 font-medium">{p.sku}</td>
                  <td>{p.name}</td>
                  <td>{p.category}</td>
                  <td>{lyd(p.cost_price)}</td>
                  <td>{lyd(p.selling_price)}</td>
                  <td>{p.active ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
