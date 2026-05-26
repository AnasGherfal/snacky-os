import { StatCard } from "@/components/StatCard";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function getDashboardData() {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { data: null, error: null };

  const [machines, refill, issues, lowStorage, cash, salesMonthly, productMonthly] = await Promise.all([
    supabase.from("machines").select("id", { count: "exact", head: true }),
    supabase.from("refill_recommendations").select("machine_name, product_name, suggested_qty, priority").order("suggested_qty", { ascending: false }).limit(8),
    supabase.from("issues").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    supabase.from("current_inventory_by_location").select("product_name, quantity_on_hand").eq("location_type", "storage").lte("quantity_on_hand", 20).order("quantity_on_hand").limit(8),
    supabase.from("cash_collections").select("machine_id, vms_expected_cash, actual_cash_collected, variance").order("collected_at", { ascending: false }).limit(8),
    supabase.from("kpi_machine_monthly").select("machine_id, machine_name, sales_month, net_sales_amount, units_sold, gross_profit_amount").order("sales_month", { ascending: false }).limit(100),
    supabase.from("kpi_product_monthly").select("product_id, product_name, sales_month, net_sales_amount, units_sold").order("net_sales_amount", { ascending: false }).limit(8),
  ]);

  const loadError = machines.error ?? refill.error ?? issues.error ?? lowStorage.error ?? cash.error ?? salesMonthly.error ?? productMonthly.error;
  if (loadError) {
    console.error("[dashboard] Failed to load dashboard data", loadError);
    return { data: null, error: loadError };
  }

  return {
    data: {
      machines: machines.count ?? 0,
      openIssues: issues.count ?? 0,
      refillRows: refill.data ?? [],
      lowStorageRows: lowStorage.data ?? [],
      cashRows: cash.data ?? [],
      salesMonthlyRows: salesMonthly.data ?? [],
      productMonthlyRows: productMonthly.data ?? [],
    },
    error: null,
  };
}

export default async function DashboardPage() {
  const { data, error } = await getDashboardData();
  const totalNetSales = (data?.salesMonthlyRows ?? []).reduce((sum: number, row: any) => sum + Number(row.net_sales_amount ?? 0), 0);
  const totalUnitsSold = (data?.salesMonthlyRows ?? []).reduce((sum: number, row: any) => sum + Number(row.units_sold ?? 0), 0);
  const latestSalesMonth = [...(data?.salesMonthlyRows ?? [])].map((row: any) => String(row.sales_month ?? "").slice(0, 7)).filter(Boolean).sort().at(-1);
  const latestMonthSales = latestSalesMonth
    ? (data?.salesMonthlyRows ?? []).filter((row: any) => String(row.sales_month ?? "").startsWith(latestSalesMonth)).reduce((sum: number, row: any) => sum + Number(row.net_sales_amount ?? 0), 0)
    : 0;
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Operational control center for refills, stock, issues, and cash variances." />
      {error ? (
        <ErrorState title="Could not load dashboard" body="Snacky OS could not load the operational dashboard from Supabase." action={<SecondaryButton href="/dashboard">Retry</SecondaryButton>} />
      ) : !data ? (
        <EmptyState title="Connect Supabase to activate dashboard" body="Add environment variables and restart the app." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total machines" value={data.machines} />
            <StatCard label="Net sales" value={lyd(totalNetSales)} />
            <StatCard label="Units sold" value={totalUnitsSold.toLocaleString("en-US")} />
            <StatCard label={latestSalesMonth ? `NSM ${latestSalesMonth}` : "Monthly net sales"} value={lyd(latestMonthSales)} />
            <StatCard label="Machines needing refill" value={data.refillRows.length} />
            <StatCard label="Open issues" value={data.openIssues} />
            <StatCard label="Low storage products" value={data.lowStorageRows.length} />
          </div>
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            <SectionCard>
              <h2 className="mb-3 text-base font-semibold">Top products from VMS sales</h2>
              {!data.productMonthlyRows.length ? (
                <EmptyState title="No VMS sales yet" body="Upload VMS sales reports to populate sales KPIs." />
              ) : (
                <DataTable headers={["Product", "Net sales", "Units"]}>
                  {data.productMonthlyRows.map((row: any, index: number) => (
                    <tr key={`${row.product_id}-${index}`}>
                      <td>{row.product_name}</td>
                      <td>{lyd(Number(row.net_sales_amount ?? 0))}</td>
                      <td>{Number(row.units_sold ?? 0).toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </SectionCard>
            <SectionCard>
              <h2 className="mb-3 text-base font-semibold">Machines needing refill</h2>
              {!data.refillRows.length ? (
                <EmptyState title="No refill recommendations" body="Upload mapped VMS stock data to generate machine refill recommendations." />
              ) : (
                <DataTable headers={["Machine", "Product", "Take", "Priority"]}>
                  {data.refillRows.map((row: any, index: number) => (
                    <tr key={`${row.machine_name}-${index}`}>
                      <td>{row.machine_name}</td>
                      <td>{row.product_name}</td>
                      <td>{row.suggested_qty}</td>
                      <td>{row.priority}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </SectionCard>
            <SectionCard>
              <h2 className="mb-3 text-base font-semibold">Low storage products</h2>
              {!data.lowStorageRows.length ? (
                <EmptyState title="No low storage products" body="Storage inventory is either healthy or ledger movements have not been recorded yet." />
              ) : (
                <DataTable headers={["Product", "Qty"]}>
                  {data.lowStorageRows.map((row: any, index: number) => (
                    <tr key={`${row.product_name}-${index}`}>
                      <td>{row.product_name}</td>
                      <td>{row.quantity_on_hand}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </>
  );
}
