import { BarList, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { dateKey, formatInteger, groupSum, locationName, machineName, monthKey, productName, salesAmount, soldQty } from "@/lib/kpi";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function chronologicalSales(rows: { label: string; value: number }[]) {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label));
}

export default async function SalesDashboardPage() {
  await requireCurrentProfileForPath("/sales");
  const supabase = getSupabaseServerClient();
  const { data } = supabase
    ? await supabase
        .from("vms_sales_snapshots")
        .select(
          "id, machine_id, product_id, sold_qty, sales_amount, cash_sales_amount, card_sales_amount, period_start, period_end, machine:machines(id, name, machine_code, location:locations(id, name)), product:products(id, name, sku)"
        )
        .eq("import_row_status", "imported")
        .order("period_end", { ascending: false })
    : { data: null };

  const sales = (data ?? []) as any[];
  const totalSales = sales.reduce((sum, row) => sum + salesAmount(row), 0);
  const totalUnits = sales.reduce((sum, row) => sum + soldQty(row), 0);
  const totalCash = sales.reduce((sum, row) => sum + Number(row.cash_sales_amount ?? 0), 0);
  const totalCard = sales.reduce((sum, row) => sum + Number(row.card_sales_amount ?? 0), 0);
  const byDay = chronologicalSales(groupSum(sales, (row) => dateKey(row.period_end), salesAmount)).slice(-14);
  const byMonth = chronologicalSales(groupSum(sales, (row) => monthKey(row.period_end), salesAmount)).slice(-12);
  const byMachine = groupSum(sales, machineName, salesAmount).slice(0, 10);
  const byLocation = groupSum(sales, locationName, salesAmount).slice(0, 10);
  const byProduct = groupSum(sales, productName, salesAmount).slice(0, 10);
  const hasTenderBreakdown = totalCash > 0 || totalCard > 0;

  return (
    <>
      <PageHeader title="Sales Dashboard" subtitle="VMS sales performance by day, machine, location, product, and payment type." />

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate sales analytics" body="Add environment variables and restart the app." />
      ) : !sales.length ? (
        <EmptyState title="No VMS sales snapshots yet" body="Upload VMS sales data to populate this dashboard. No sales are invented here." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiSection title="Total sales"><div className="text-3xl font-semibold text-slate-900">{lyd(totalSales)}</div></KpiSection>
            <KpiSection title="Units sold"><div className="text-3xl font-semibold text-slate-900">{formatInteger(totalUnits)}</div></KpiSection>
            <KpiSection title="Cash sales"><div className="text-3xl font-semibold text-slate-900">{hasTenderBreakdown ? lyd(totalCash) : "-"}</div></KpiSection>
            <KpiSection title="Card sales"><div className="text-3xl font-semibold text-slate-900">{hasTenderBreakdown ? lyd(totalCard) : "-"}</div></KpiSection>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Sales by day" subtitle="Latest observed VMS days.">
              <BarList rows={byDay} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Monthly sales trend" subtitle="Latest observed VMS months.">
              <BarList rows={byMonth} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Sales by machine">
              <BarList rows={byMachine} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Sales by location">
              <BarList rows={byLocation} valueFormatter={lyd} />
            </KpiSection>
          </div>

          {hasTenderBreakdown ? (
            <KpiSection title="Cash vs card">
              <BarList rows={[{ label: "Cash", value: totalCash }, { label: "Card", value: totalCard }]} valueFormatter={lyd} />
            </KpiSection>
          ) : (
            <EmptyState title="No cash vs card split available" body="VMS snapshots currently have no cash or card amounts. Total sales are still shown from sales_amount." />
          )}

          <KpiSection title="Sales by product">
            <DataTable headers={["Product", "Units", "Revenue"]}>
              {byProduct.map((row) => {
                const productRows = sales.filter((sale) => productName(sale) === row.label);
                const units = productRows.reduce((sum, sale) => sum + soldQty(sale), 0);

                return (
                  <tr key={row.label}>
                    <td className="font-medium">{row.label}</td>
                    <td>{formatInteger(units)}</td>
                    <td>{lyd(row.value)}</td>
                  </tr>
                );
              })}
            </DataTable>
          </KpiSection>
        </div>
      )}
    </>
  );
}
