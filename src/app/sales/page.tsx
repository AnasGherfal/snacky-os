import { BarList, KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { VmsDataSourceCard } from "@/components/VmsDataSourceCard";
import { DataTable, EmptyState, PageHeader } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatInteger, groupSum } from "@/lib/kpi";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import { type VmsDashboardBatch } from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

function chronologicalSales(rows: { label: string; value: number }[]) {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label));
}

type SalesRow = {
  id: string;
  machine_id: string | null;
  product_id: string | null;
  units_sold: number | string | null;
  transaction_count: number | string | null;
  net_sales_amount: number | string | null;
  gross_sales_amount: number | string | null;
  cash_sales_amount: number | string | null;
  card_sales_amount: number | string | null;
  sale_date: string | null;
  sales_month: string | null;
  period_start: string | null;
  machine_name: string | null;
  location_name: string | null;
  product_name: string | null;
};

type TransactionStatusRow = {
  failed_vend_count: number | string | null;
  failed_vend_amount: number | string | null;
  refund_count: number | string | null;
  refund_amount: number | string | null;
  failed_payment_count: number | string | null;
  needs_review_count: number | string | null;
};

async function SalesDashboardPageContent() {
  await requireCurrentProfileForPath("/sales");
  const supabase = await getAuthenticatedSupabaseServerClient();
  const [salesResult, statusResult, batchResult] = supabase
    ? await Promise.all([
      safeSupabaseQuery<SalesRow>({
        label: "sales.vms_sales_clean",
        promise: supabase
          .from("vms_sales_clean")
          .select("id, machine_id, product_id, units_sold, transaction_count, net_sales_amount, gross_sales_amount, cash_sales_amount, card_sales_amount, sale_date, sales_month, period_start, machine_name, location_name, product_name")
          .order("sale_date", { ascending: false }),
      }),
      safeSupabaseQuery<TransactionStatusRow>({
        label: "sales.vms_transaction_status_daily",
        promise: supabase
          .from("vms_transaction_status_daily")
          .select("failed_vend_count, failed_vend_amount, refund_count, refund_amount, failed_payment_count, needs_review_count"),
      }),
      safeSupabaseQuery<VmsDashboardBatch>({
        label: "sales.vms_import_batches",
        promise: supabase
          .from("vms_import_batches")
          .select("id, file_name, original_file_name, report_type, status, is_active, report_start_date, report_end_date, uploaded_at, imported_at, deleted_at, detected_min_datetime, detected_max_datetime, row_count, rows_found, rows_imported, error_count")
          .eq("report_type", "vms_order_details_weekly")
          .order("report_start_date", { ascending: true }),
      }),
    ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

  const sales = salesResult.data as SalesRow[];
  const statuses = statusResult.data as TransactionStatusRow[];
  const totalSales = sales.reduce((sum, row) => sum + Number(row.net_sales_amount ?? row.gross_sales_amount ?? 0), 0);
  const totalUnits = sales.reduce((sum, row) => sum + Number(row.units_sold ?? 0), 0);
  const totalTransactions = sales.reduce((sum, row) => sum + Number(row.transaction_count ?? 0), 0);
  const totalCash = sales.reduce((sum, row) => sum + Number(row.cash_sales_amount ?? 0), 0);
  const totalCard = sales.reduce((sum, row) => sum + Number(row.card_sales_amount ?? 0), 0);
  const statusTotals = statuses.reduce((totals, row) => ({
    failedVendCount: totals.failedVendCount + Number(row.failed_vend_count ?? 0),
    failedVendAmount: totals.failedVendAmount + Number(row.failed_vend_amount ?? 0),
    refundCount: totals.refundCount + Number(row.refund_count ?? 0),
    refundAmount: totals.refundAmount + Number(row.refund_amount ?? 0),
    failedPaymentCount: totals.failedPaymentCount + Number(row.failed_payment_count ?? 0),
    needsReviewCount: totals.needsReviewCount + Number(row.needs_review_count ?? 0),
  }), { failedVendCount: 0, failedVendAmount: 0, refundCount: 0, refundAmount: 0, failedPaymentCount: 0, needsReviewCount: 0 });
  const revenue = (row: SalesRow) => Number(row.net_sales_amount ?? row.gross_sales_amount ?? 0);
  const byDay = chronologicalSales(groupSum(sales, (row) => row.sale_date ?? "Unknown", revenue)).slice(-14);
  const byMonth = chronologicalSales(groupSum(sales, (row) => String(row.sales_month ?? "Unknown").slice(0, 7), revenue)).slice(-12);
  const byHour = chronologicalSales(groupSum(sales, (row) => {
    const date = row.period_start ? new Date(row.period_start) : null;
    if (!date || Number.isNaN(date.getTime())) return "Unknown";
    return `${String(date.getHours()).padStart(2, "0")}:00`;
  }, revenue));
  const byMachine = groupSum(sales, (row) => row.machine_name ?? "Unmapped machine", revenue).slice(0, 10);
  const byLocation = groupSum(sales, (row) => row.location_name ?? "No location", revenue).slice(0, 10);
  const byProduct = groupSum(sales, (row) => row.product_name ?? "Unmapped product", revenue).slice(0, 10);
  const hasTenderBreakdown = totalCash > 0 || totalCard > 0;

  return (
    <>
      <PageHeader title="Sales Dashboard" subtitle="VMS sales performance by day, machine, location, product, and payment type." />

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate sales analytics" body="Add environment variables and restart the app." />
      ) : (
        <div className="space-y-6">
          <VmsDataSourceCard
            batches={batchResult.data as VmsDashboardBatch[]}
            error={batchResult.error}
            title="Data Source"
            subtitle="Sales dashboard uses detailed VMS Order Details rows where transaction_status = successful_sale. Summary files remain reconciliation only."
            showSales
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiSection title="Total sales"><div className="text-3xl font-semibold text-slate-900">{lyd(totalSales)}</div></KpiSection>
            <KpiSection title="Units sold"><div className="text-3xl font-semibold text-slate-900">{formatInteger(totalUnits)}</div></KpiSection>
            <KpiSection title="Average transaction"><div className="text-3xl font-semibold text-slate-900">{totalTransactions ? lyd(totalSales / totalTransactions) : "-"}</div></KpiSection>
            <KpiSection title="Failed vend rate"><div className="text-3xl font-semibold text-slate-900">{totalTransactions + statusTotals.failedVendCount ? `${((statusTotals.failedVendCount / (totalTransactions + statusTotals.failedVendCount)) * 100).toFixed(1)}%` : "-"}</div></KpiSection>
            <KpiSection title="Cash sales"><div className="text-3xl font-semibold text-slate-900">{hasTenderBreakdown ? lyd(totalCash) : "-"}</div></KpiSection>
            <KpiSection title="Card sales"><div className="text-3xl font-semibold text-slate-900">{hasTenderBreakdown ? lyd(totalCard) : "-"}</div></KpiSection>
            <KpiSection title="Failed vend amount"><div className="text-3xl font-semibold text-slate-900">{lyd(statusTotals.failedVendAmount)}</div></KpiSection>
            <KpiSection title="Refund amount"><div className="text-3xl font-semibold text-slate-900">{lyd(statusTotals.refundAmount)}</div></KpiSection>
          </div>

          <KpiLoadWarning message={salesResult.error} />
          <KpiLoadWarning message={statusResult.error} />
          {!sales.length ? (
            <EmptyState title="No VMS sales snapshots yet" body="Upload VMS sales data to populate this dashboard. No sales are invented here." />
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Sales by day" subtitle="Latest observed VMS days.">
              <BarList rows={byDay} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Monthly sales trend" subtitle="Latest observed VMS months.">
              <BarList rows={byMonth} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Sales by hour">
              <BarList rows={byHour} valueFormatter={lyd} />
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
                const productRows = sales.filter((sale) => (sale.product_name ?? "Unmapped product") === row.label);
                const units = productRows.reduce((sum, sale) => sum + Number(sale.units_sold ?? 0), 0);

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

function isNextNavigationSignal(error: unknown) {
  const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE";
}

export default async function SalesDashboardPage() {
  try {
    return await SalesDashboardPageContent();
  } catch (error) {
    if (isNextNavigationSignal(error)) throw error;
    console.error("[sales] Page-level render guard caught an unexpected error", error);
    return (
      <>
        <PageHeader title="Sales Dashboard" subtitle="Sales analytics from active detailed VMS Order Details files." />
        <EmptyState title="Something did not load" body="Snacky OS recovered from a VMS data load error. Please retry after the latest import finishes; technical details are in the server logs." />
      </>
    );
  }
}
