import { AppShell } from "@/components/AppShell";
import { BarList, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { lyd } from "@/lib/format";
import { formatDays, formatInteger, formatLydOrDash, formatPctOrDash, groupCount, observedDayCount, salesAmount, soldQty } from "@/lib/kpi";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function ProductsDashboardPage() {
  const supabase = getSupabaseServerClient();
  const [salesResult, productsResult, inventoryResult, stockResult] = supabase
    ? await Promise.all([
        supabase.from("vms_sales_snapshots").select("id, product_id, sold_qty, sales_amount, period_end, product:products(id, sku, name, cost_price, selling_price)"),
        supabase.from("products").select("id, sku, name, cost_price, selling_price, active").order("name"),
        supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, quantity_on_hand"),
        supabase.from("vms_stock_snapshots").select("product_id, current_qty"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const sales = (salesResult.data ?? []) as any[];
  const products = (productsResult.data ?? []) as any[];
  const inventory = (inventoryResult.data ?? []) as any[];
  const stockouts = groupCount(((stockResult.data ?? []) as any[]).filter((row) => Number(row.current_qty ?? 0) <= 0 && row.product_id), (row) => String(row.product_id));
  const observedDays = observedDayCount(sales);

  const storageByProduct = new Map<string, number>();
  inventory
    .filter((row) => row.location_type === "storage")
    .forEach((row) => storageByProduct.set(String(row.product_id), (storageByProduct.get(String(row.product_id)) ?? 0) + Number(row.quantity_on_hand ?? 0)));

  const metrics = products.map((product) => {
    const productSales = sales.filter((row) => row.product_id === product.id);
    const units = productSales.reduce((sum, row) => sum + soldQty(row), 0);
    const revenue = productSales.reduce((sum, row) => sum + salesAmount(row), 0);
    const cost = Number(product.cost_price ?? 0);
    const hasCost = cost > 0;
    const grossProfit = hasCost ? revenue - units * cost : null;
    const margin = hasCost && revenue > 0 ? (Number(grossProfit) / revenue) * 100 : null;
    const storageQty = storageByProduct.get(String(product.id)) ?? 0;
    const dailyVelocity = units / observedDays;
    const daysLeft = dailyVelocity > 0 ? storageQty / dailyVelocity : null;

    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      active: product.active,
      units,
      revenue,
      grossProfit,
      margin,
      storageQty,
      daysLeft,
      stockoutCount: stockouts.get(String(product.id)) ?? 0,
    };
  });

  const topProducts = [...metrics].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const slowMoving = [...metrics].filter((row) => row.storageQty > 0).sort((a, b) => a.units - b.units || a.revenue - b.revenue).slice(0, 10);
  const totalRevenue = metrics.reduce((sum, row) => sum + row.revenue, 0);
  const totalUnits = metrics.reduce((sum, row) => sum + row.units, 0);
  const totalGrossProfit = metrics.reduce((sum, row) => sum + Number(row.grossProfit ?? 0), 0);
  const hasAnyCost = metrics.some((row) => row.grossProfit !== null);

  return (
    <AppShell>
      <PageHeader title="Product Dashboard" subtitle="Product velocity, revenue, margin, stockouts, and storage coverage." />

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate product KPIs" body="Add environment variables and restart the app." />
      ) : !products.length ? (
        <EmptyState title="No products yet" body="Create products and upload VMS sales snapshots to populate product KPIs." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiSection title="Units sold"><div className="text-3xl font-semibold">{formatInteger(totalUnits)}</div></KpiSection>
            <KpiSection title="Revenue"><div className="text-3xl font-semibold">{lyd(totalRevenue)}</div></KpiSection>
            <KpiSection title="Gross profit"><div className="text-3xl font-semibold">{hasAnyCost ? lyd(totalGrossProfit) : "-"}</div></KpiSection>
            <KpiSection title="Products with stockouts"><div className="text-3xl font-semibold">{metrics.filter((row) => row.stockoutCount > 0).length}</div></KpiSection>
          </div>

          {!sales.length ? <EmptyState title="No product sales yet" body="VMS sales snapshots are required for velocity, revenue, and margin metrics." /> : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Top products" subtitle="Ranked by VMS revenue.">
              <BarList rows={topProducts.map((row) => ({ label: row.name, value: row.revenue, detail: `${formatInteger(row.units)} units` }))} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Slow moving products" subtitle="Storage products with the lowest observed sales velocity.">
              <DataTable headers={["Product", "Storage", "Units sold", "Days left"]}>
                {slowMoving.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium">{row.name}</td>
                    <td>{formatInteger(row.storageQty)}</td>
                    <td>{formatInteger(row.units)}</td>
                    <td>{formatDays(row.daysLeft)}</td>
                  </tr>
                ))}
              </DataTable>
            </KpiSection>
          </div>

          <KpiSection title="Product KPI table">
            <DataTable headers={["Product", "Status", "Units", "Revenue", "Gross profit", "Margin", "Stockouts", "Storage qty", "Days left"]}>
              {metrics.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="font-medium text-slate-900">{row.name}</div>
                    <div className="text-xs text-slate-500">{row.sku}</div>
                  </td>
                  <td><StatusBadge status={row.active ? "active" : "inactive"} /></td>
                  <td>{formatInteger(row.units)}</td>
                  <td>{lyd(row.revenue)}</td>
                  <td>{formatLydOrDash(row.grossProfit)}</td>
                  <td>{formatPctOrDash(row.margin)}</td>
                  <td>{row.stockoutCount}</td>
                  <td>{formatInteger(row.storageQty)}</td>
                  <td>{formatDays(row.daysLeft)}</td>
                </tr>
              ))}
            </DataTable>
          </KpiSection>
        </div>
      )}
    </AppShell>
  );
}
