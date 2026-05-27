import { StatCard } from "@/components/StatCard";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { lyd } from "@/lib/format";
import { vmsCoverageSummary, type VmsDashboardBatch } from "@/lib/vms-dashboard-source";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type SalesMonthlyRow = { machine_id: string | null; machine_name: string | null; sales_month: string | null; net_sales_amount: number | string | null; units_sold: number | string | null; gross_profit_amount?: number | string | null };
type ProductMonthlyRow = { product_id: string | null; product_name: string | null; sales_month: string | null; net_sales_amount: number | string | null; units_sold: number | string | null };
type TransactionStatusMonthlyRow = { failed_vend_count: number | string | null; failed_vend_amount: number | string | null; refund_count: number | string | null; refund_amount: number | string | null; needs_review_count: number | string | null };
type MissingCostRow = { product_id: string | null; product_name: string | null };
type RefillRow = { machine_name: string | null; product_name: string | null; suggested_qty: number | string | null; priority: string | null };
type LowStorageRow = { product_name: string | null; quantity_on_hand: number | string | null };

async function getDashboardData() {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { data: null, error: null };

  const [machines, refill, issues, lowStorage, cash, salesMonthly, productMonthly, transactionStatusMonthly, missingCostSales, vmsBatches] = await Promise.all([
    supabase.from("machines").select("id", { count: "exact", head: true }),
    supabase.from("refill_recommendations").select("machine_name, product_name, suggested_qty, priority").order("suggested_qty", { ascending: false }).limit(8),
    supabase.from("issues").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    supabase.from("current_inventory_by_location").select("product_name, quantity_on_hand").eq("location_type", "storage").lte("quantity_on_hand", 20).order("quantity_on_hand").limit(8),
    supabase.from("cash_collections").select("machine_id, vms_expected_cash, actual_cash_collected, variance").order("collected_at", { ascending: false }).limit(8),
    supabase.from("kpi_machine_monthly").select("machine_id, machine_name, sales_month, net_sales_amount, units_sold, gross_profit_amount").order("sales_month", { ascending: false }).limit(100),
    supabase.from("kpi_product_monthly").select("product_id, product_name, sales_month, net_sales_amount, units_sold").order("net_sales_amount", { ascending: false }).limit(8),
    supabase.from("vms_transaction_status_monthly").select("sales_month, failed_vend_count, failed_vend_amount, refund_count, refund_amount, failed_payment_count, needs_review_count").order("sales_month", { ascending: false }).limit(12),
    supabase.from("vms_sales_clean").select("product_id, product_name").eq("cost_missing", true).limit(1000),
    supabase.from("vms_import_batches").select("id, file_name, report_type, status, is_active, report_start_date, report_end_date, uploaded_at, imported_at, deleted_at").eq("report_type", "vms_order_details_weekly").order("report_start_date", { ascending: true }),
  ]);

  const loadError = machines.error ?? refill.error ?? issues.error ?? lowStorage.error ?? cash.error ?? salesMonthly.error ?? productMonthly.error ?? transactionStatusMonthly.error ?? missingCostSales.error ?? vmsBatches.error;
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
      transactionStatusRows: transactionStatusMonthly.data ?? [],
      missingCostRows: missingCostSales.data ?? [],
      vmsBatchRows: vmsBatches.data ?? [],
    },
    error: null,
  };
}

export default async function DashboardPage() {
  const { data, error } = await getDashboardData();
  const salesMonthlyRows = (data?.salesMonthlyRows ?? []) as SalesMonthlyRow[];
  const productMonthlyRows = (data?.productMonthlyRows ?? []) as ProductMonthlyRow[];
  const transactionStatusRows = (data?.transactionStatusRows ?? []) as TransactionStatusMonthlyRow[];
  const missingCostRows = (data?.missingCostRows ?? []) as MissingCostRow[];
  const refillRows = (data?.refillRows ?? []) as RefillRow[];
  const lowStorageRows = (data?.lowStorageRows ?? []) as LowStorageRow[];
  const coverage = vmsCoverageSummary((data?.vmsBatchRows ?? []) as VmsDashboardBatch[]);
  const totalNetSales = salesMonthlyRows.reduce((sum, row) => sum + Number(row.net_sales_amount ?? 0), 0);
  const totalUnitsSold = salesMonthlyRows.reduce((sum, row) => sum + Number(row.units_sold ?? 0), 0);
  const latestSalesMonth = [...salesMonthlyRows].map((row) => String(row.sales_month ?? "").slice(0, 7)).filter(Boolean).sort().at(-1);
  const latestMonthSales = latestSalesMonth
    ? salesMonthlyRows.filter((row) => String(row.sales_month ?? "").startsWith(latestSalesMonth)).reduce((sum, row) => sum + Number(row.net_sales_amount ?? 0), 0)
    : 0;
  const transactionStatusTotals = transactionStatusRows.reduce((totals, row) => ({
    failedVendCount: totals.failedVendCount + Number(row.failed_vend_count ?? 0),
    failedVendAmount: totals.failedVendAmount + Number(row.failed_vend_amount ?? 0),
    refundCount: totals.refundCount + Number(row.refund_count ?? 0),
    refundAmount: totals.refundAmount + Number(row.refund_amount ?? 0),
    needsReviewCount: totals.needsReviewCount + Number(row.needs_review_count ?? 0),
  }), { failedVendCount: 0, failedVendAmount: 0, refundCount: 0, refundAmount: 0, needsReviewCount: 0 });
  const missingCostProducts = new Set(missingCostRows.map((row) => String(row.product_id ?? row.product_name ?? ""))).size;
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Operational control center for refills, stock, issues, and cash variances." />
      {error ? (
        <ErrorState title="Could not load dashboard" body="Snacky OS could not load the operational dashboard from Supabase." action={<SecondaryButton href="/dashboard">Retry</SecondaryButton>} />
      ) : !data ? (
        <EmptyState title="Connect Supabase to activate dashboard" body="Add environment variables and restart the app." />
      ) : (
        <>
          <div className="mb-5 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">Data Source</div>
            <p className="mt-1">
              Dashboard KPIs use {coverage.active.length} active detailed VMS order file(s)
              {coverage.start && coverage.end ? ` covering ${coverage.start} to ${coverage.end}` : ""}. General summary files are reconciliation only.
            </p>
            {coverage.gaps.length ? (
              <p className="mt-2 font-medium text-amber-800">
                Warning: selected period has missing VMS detailed data. Sales may be incomplete.
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total machines" value={data.machines} />
            <StatCard label="Net sales" value={lyd(totalNetSales)} />
            <StatCard label="Units sold" value={totalUnitsSold.toLocaleString("en-US")} />
            <StatCard label={latestSalesMonth ? `NSM ${latestSalesMonth}` : "Monthly net sales"} value={lyd(latestMonthSales)} />
            <StatCard label="Failed vend count" value={transactionStatusTotals.failedVendCount.toLocaleString("en-US")} />
            <StatCard label="Failed vend amount" value={lyd(transactionStatusTotals.failedVendAmount)} />
            <StatCard label="Refund count" value={transactionStatusTotals.refundCount.toLocaleString("en-US")} />
            <StatCard label="Refund amount" value={lyd(transactionStatusTotals.refundAmount)} />
            <StatCard label="Needs review count" value={transactionStatusTotals.needsReviewCount.toLocaleString("en-US")} />
            <StatCard label="Machines needing refill" value={refillRows.length} />
            <StatCard label="Open issues" value={data.openIssues} />
            <StatCard label="Low storage products" value={lowStorageRows.length} />
          </div>
          {missingCostProducts ? (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              Cost missing for {missingCostProducts} products. Profit may be incomplete.
            </div>
          ) : null}
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            <SectionCard>
              <h2 className="mb-3 text-base font-semibold">Top products from VMS sales</h2>
              {!productMonthlyRows.length ? (
                <EmptyState title="No VMS sales yet" body="Upload VMS sales reports to populate sales KPIs." />
              ) : (
                <DataTable headers={["Product", "Net sales", "Units"]}>
                  {productMonthlyRows.map((row, index) => (
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
              {!refillRows.length ? (
                <EmptyState title="No refill recommendations" body="Upload mapped VMS stock data to generate machine refill recommendations." />
              ) : (
                <DataTable headers={["Machine", "Product", "Take", "Priority"]}>
                  {refillRows.map((row, index) => (
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
              {!lowStorageRows.length ? (
                <EmptyState title="No low storage products" body="Storage inventory is either healthy or ledger movements have not been recorded yet." />
              ) : (
                <DataTable headers={["Product", "Qty"]}>
                  {lowStorageRows.map((row, index) => (
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
