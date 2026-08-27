import { BarList, KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { VmsDataSourceCard } from "@/components/VmsDataSourceCard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatDays, formatInteger, formatLydOrDash, formatPctOrDash, groupCount, observedDayCount, salesAmount, soldQty } from "@/lib/kpi";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import { type VmsDashboardBatch } from "@/lib/vms-dashboard-source";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export default async function ProductsDashboardPage() {
  await requireCurrentProfileForPath("/products-dashboard");
  const supabase = getSupabaseAdminClient() ?? await getAuthenticatedSupabaseServerClient();
  const [salesResult, productsResult, inventoryResult, stockResult, batchResult] = supabase
    ? await Promise.all([
        safeSupabaseQuery<any>({
          label: "products-dashboard.vms_sales_clean",
          promise: supabase.from("vms_sales_clean").select("id, product_id, units_sold, net_sales_amount, gross_profit_amount, sale_date, cost_missing"),
        }),
        safeSupabaseQuery<any>({
          label: "products-dashboard.products",
          promise: supabase.from("products").select("id, sku, name, cost_price, current_cost_price_lyd, selling_price, current_selling_price_lyd, active").order("name"),
        }),
        safeSupabaseQuery<any>({
          label: "products-dashboard.current_inventory_by_location",
          promise: supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, quantity_on_hand"),
        }),
        safeSupabaseQuery<any>({
          label: "products-dashboard.latest_vms_stock_by_slot",
          promise: supabase.from("latest_vms_stock_by_slot").select("product_id, current_qty"),
        }),
        safeSupabaseQuery<VmsDashboardBatch>({
          label: "products-dashboard.vms_import_batches",
          promise: supabase.from("vms_import_batches").select("id, file_name, original_file_name, report_type, status, is_active, report_start_date, report_end_date, uploaded_at, imported_at, deleted_at, detected_min_datetime, detected_max_datetime, row_count, rows_found, rows_imported, error_count").in("report_type", ["vms_order_details_weekly", "sales", "stock", "machine_stock_snapshot", "planogram"]).order("report_start_date", { ascending: true }),
        }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

  const sales = ((salesResult.data ?? []) as any[]).map((row) => ({
    ...row,
    sold_qty: row.units_sold,
    sales_amount: row.net_sales_amount,
    period_end: row.sale_date,
  }));
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
    const hasCost = productSales.some((row) => !row.cost_missing);
    const grossProfit = hasCost ? productSales.reduce((sum, row) => sum + Number(row.gross_profit_amount ?? 0), 0) : null;
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
  const missingCostProducts = metrics.filter((row) => row.revenue > 0 && row.grossProfit === null).length;

  return (
    <>
      <PageHeader title="Product Dashboard" subtitle="Product velocity, revenue, margin, stockouts, and storage coverage." />

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate product KPIs" body="Add environment variables and restart the app." />
      ) : (
        <div className="space-y-6">
          <VmsDataSourceCard
            batches={batchResult.data as VmsDashboardBatch[]}
            error={batchResult.error}
            title="Data Source"
            subtitle="Product sales use detailed VMS transaction rows. Stockout and refill pressure signals come from the latest active stock snapshots."
            showSales
            showStock
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiSection title="Units sold"><div className="text-3xl font-semibold">{formatInteger(totalUnits)}</div></KpiSection>
            <KpiSection title="Revenue"><div className="text-3xl font-semibold">{lyd(totalRevenue)}</div></KpiSection>
            <KpiSection title="Gross profit"><div className="text-3xl font-semibold">{hasAnyCost ? lyd(totalGrossProfit) : "-"}</div></KpiSection>
            <KpiSection title="Products with stockouts"><div className="text-3xl font-semibold">{metrics.filter((row) => row.stockoutCount > 0).length}</div></KpiSection>
          </div>

          <KpiLoadWarning message={productsResult.error} />
          <KpiLoadWarning message={salesResult.error} />
          <KpiLoadWarning message={inventoryResult.error} />
          <KpiLoadWarning message={stockResult.error} />

          {!products.length ? <EmptyState title="No products yet" body="Create products and upload VMS sales snapshots to populate product KPIs." /> : null}

          {missingCostProducts ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              Cost missing for {missingCostProducts} products. Profit may be incomplete.
            </div>
          ) : null}

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
    </>
  );
}
