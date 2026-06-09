import Link from "next/link";
import { StatCard } from "@/components/StatCard";
import { DataTable, EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { restockCounts, type RestockPriorityItem } from "@/lib/restock-priority";
import { loadRestockPriorityData, type RestockPriorityLoadResult } from "@/lib/restock-priority-data";
import { detailedSalesSourceMessage, stockSourceMessage, vmsCoverageSummary, type VmsDashboardBatch } from "@/lib/vms-dashboard-source";

type SalesMonthlyRow = { machine_id: string | null; machine_name: string | null; sales_month: string | null; net_sales_amount: number | string | null; units_sold: number | string | null };
type ProductMonthlyRow = { product_id: string | null; product_name: string | null; sales_month: string | null; net_sales_amount: number | string | null; units_sold: number | string | null };
type TransactionStatusMonthlyRow = { failed_vend_count: number | string | null; failed_vend_amount: number | string | null; refund_count: number | string | null; refund_amount: number | string | null; needs_review_count: number | string | null };
type MissingCostRow = { product_id: string | null; product_name: string | null };
type RefillRow = { machine_name: string | null; product_name: string | null; suggested_qty: number | string | null; priority: string | null };
type LowStorageRow = { product_name: string | null; quantity_on_hand: number | string | null };
type CashRow = { machine_id: string | null; vms_expected_cash: number | string | null; actual_cash_collected: number | string | null; variance: number | string | null };

type DashboardSection =
  | "machines"
  | "refill"
  | "issues"
  | "lowStorage"
  | "cash"
  | "salesMonthly"
  | "productMonthly"
  | "transactionStatusMonthly"
  | "missingCostSales"
  | "vmsBatches"
  | "restockPriority";

type DashboardErrors = Partial<Record<DashboardSection, string>>;

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" ");
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? "Unknown Supabase error");
  }
  return "Unknown Supabase error";
}

function isMissingColumn(error: unknown, columns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

function SectionLoadError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
      This section could not load: {message}
    </div>
  );
}

async function safeDashboardQuery<T>({
  key,
  label,
  promise,
  fallback,
  errors,
}: {
  key: DashboardSection;
  label: string;
  promise: PromiseLike<any>;
  fallback: T;
  errors: DashboardErrors;
}) {
  try {
    const result = await promise;
    if (result.error) {
      const message = errorMessage(result.error);
      console.error("[dashboard] Supabase query failed", { section: key, query: label, error: result.error });
      errors[key] = message;
      return { data: fallback, count: 0 };
    }
    return { data: (result.data ?? fallback) as T, count: result.count ?? 0 };
  } catch (error) {
    const message = errorMessage(error);
    console.error("[dashboard] Supabase query threw", { section: key, query: label, error });
    errors[key] = message;
    return { data: fallback, count: 0 };
  }
}

async function loadVmsBatches(supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>) {
  const withDeletedAt = await supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, report_type, status, is_active, report_start_date, report_end_date, uploaded_at, imported_at, deleted_at, detected_min_datetime, detected_max_datetime")
    .in("report_type", ["vms_order_details_weekly", "sales", "stock", "machine_stock_snapshot", "planogram"])
    .order("report_start_date", { ascending: true });

  if (!withDeletedAt.error || !isMissingColumn(withDeletedAt.error, ["deleted_at", "detected_min_datetime", "detected_max_datetime"])) return withDeletedAt;

  return supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, report_type, status, is_active, report_start_date, report_end_date, uploaded_at, imported_at")
    .in("report_type", ["vms_order_details_weekly", "sales", "stock", "machine_stock_snapshot", "planogram"])
    .order("report_start_date", { ascending: true });
}

async function safeRestockPriorityForDashboard(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
  errors: DashboardErrors,
): Promise<RestockPriorityLoadResult> {
  try {
    return await loadRestockPriorityData(supabase);
  } catch (error) {
    const message = errorMessage(error);
    console.error("[dashboard] Restock priority failed", { section: "restockPriority", error });
    errors.restockPriority = message;
    return { items: [], errors: {}, productCount: 0, usedProductFallback: false };
  }
}

async function getDashboardData() {
  await requireCurrentProfileForPath("/dashboard");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return { data: null };

  const errors: DashboardErrors = {};
  const [
    machines,
    refill,
    issues,
    lowStorage,
    cash,
    salesMonthly,
    productMonthly,
    transactionStatusMonthly,
    missingCostSales,
    vmsBatches,
    restockPriority,
  ] = await Promise.all([
    safeDashboardQuery<[]>({ key: "machines", label: "machines count", promise: supabase.from("machines").select("id", { count: "exact", head: true }), fallback: [], errors }),
    safeDashboardQuery<RefillRow[]>({ key: "refill", label: "refill_recommendations top suggested_qty", promise: supabase.from("refill_recommendations").select("machine_name, product_name, suggested_qty, priority").order("suggested_qty", { ascending: false }).limit(8), fallback: [], errors }),
    safeDashboardQuery<[]>({ key: "issues", label: "issues open count", promise: supabase.from("issues").select("id", { count: "exact", head: true }).neq("status", "resolved"), fallback: [], errors }),
    safeDashboardQuery<LowStorageRow[]>({ key: "lowStorage", label: "current_inventory_by_location low storage", promise: supabase.from("current_inventory_by_location").select("product_name, quantity_on_hand").eq("location_type", "storage").lte("quantity_on_hand", 20).order("quantity_on_hand").limit(8), fallback: [], errors }),
    safeDashboardQuery<CashRow[]>({ key: "cash", label: "cash_collections latest variance", promise: supabase.from("cash_collections").select("machine_id, vms_expected_cash, actual_cash_collected, variance").order("collected_at", { ascending: false }).limit(8), fallback: [], errors }),
    safeDashboardQuery<SalesMonthlyRow[]>({ key: "salesMonthly", label: "kpi_machine_monthly sales totals", promise: supabase.from("kpi_machine_monthly").select("machine_id, machine_name, sales_month, net_sales_amount, units_sold").order("sales_month", { ascending: false }).limit(100), fallback: [], errors }),
    safeDashboardQuery<ProductMonthlyRow[]>({ key: "productMonthly", label: "kpi_product_monthly top products", promise: supabase.from("kpi_product_monthly").select("product_id, product_name, sales_month, net_sales_amount, units_sold").order("net_sales_amount", { ascending: false }).limit(8), fallback: [], errors }),
    safeDashboardQuery<TransactionStatusMonthlyRow[]>({ key: "transactionStatusMonthly", label: "vms_transaction_status_monthly exception totals", promise: supabase.from("vms_transaction_status_monthly").select("sales_month, failed_vend_count, failed_vend_amount, refund_count, refund_amount, needs_review_count").order("sales_month", { ascending: false }).limit(12), fallback: [], errors }),
    safeDashboardQuery<MissingCostRow[]>({ key: "missingCostSales", label: "vms_sales_clean missing cost rows", promise: supabase.from("vms_sales_clean").select("product_id, product_name").eq("cost_missing", true).limit(1000), fallback: [], errors }),
    safeDashboardQuery<VmsDashboardBatch[]>({ key: "vmsBatches", label: "vms_import_batches active detailed files", promise: loadVmsBatches(supabase), fallback: [], errors }),
    safeRestockPriorityForDashboard(supabase, errors),
  ]);

  return {
    data: {
      machines: machines.count ?? 0,
      openIssues: issues.count ?? 0,
      refillRows: refill.data,
      lowStorageRows: lowStorage.data,
      cashRows: cash.data,
      salesMonthlyRows: salesMonthly.data,
      productMonthlyRows: productMonthly.data,
      transactionStatusRows: transactionStatusMonthly.data,
      missingCostRows: missingCostSales.data,
      vmsBatchRows: vmsBatches.data,
      restockItems: restockPriority.items,
      restockWarnings: restockPriority.errors,
      errors,
    },
  };
}

export default async function DashboardPage() {
  const { data } = await getDashboardData();
  const salesMonthlyRows = (data?.salesMonthlyRows ?? []) as SalesMonthlyRow[];
  const productMonthlyRows = (data?.productMonthlyRows ?? []) as ProductMonthlyRow[];
  const transactionStatusRows = (data?.transactionStatusRows ?? []) as TransactionStatusMonthlyRow[];
  const missingCostRows = (data?.missingCostRows ?? []) as MissingCostRow[];
  const refillRows = (data?.refillRows ?? []) as RefillRow[];
  const lowStorageRows = (data?.lowStorageRows ?? []) as LowStorageRow[];
  const cashRows = (data?.cashRows ?? []) as CashRow[];
  const restockItems = (data?.restockItems ?? []) as RestockPriorityItem[];
  const restockSummary = restockCounts(restockItems);
  const topRestockItems = restockItems.filter((item) => item.section !== "normal").slice(0, 5);
  const restockWarnings = Object.values(data?.restockWarnings ?? {}).filter(Boolean);
  const errors = data?.errors ?? {};
  const vmsBatchRows = (data?.vmsBatchRows ?? []) as VmsDashboardBatch[];
  const coverage = vmsCoverageSummary(vmsBatchRows);
  const salesSourceMessage = detailedSalesSourceMessage(vmsBatchRows, vmsBatchRows.filter((batch) => batch.report_type === "sales"));
  const refillSourceMessage = stockSourceMessage(vmsBatchRows);
  const hasVmsData = Boolean((data?.vmsBatchRows ?? []).length || salesMonthlyRows.length || productMonthlyRows.length || transactionStatusRows.length || refillRows.length);
  const totalNetSales = salesMonthlyRows.reduce((sum, row) => sum + Number(row.net_sales_amount ?? 0), 0);
  const totalUnitsSold = salesMonthlyRows.reduce((sum, row) => sum + Number(row.units_sold ?? 0), 0);
  const totalCashVariance = cashRows.reduce((sum, row) => sum + Number(row.variance ?? 0), 0);
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
  const missingCostProducts = errors.missingCostSales ? 0 : new Set(missingCostRows.map((row) => String(row.product_id ?? row.product_name ?? ""))).size;
  const topKpiErrors = [errors.machines, errors.issues, errors.salesMonthly, errors.transactionStatusMonthly, errors.cash].filter(Boolean);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Operational control center for refills, stock, issues, and cash variances." />
      {!data ? (
        <EmptyState title="Connect Supabase to activate dashboard" body="Add environment variables and restart the app." />
      ) : (
        <>
          <div className="mb-5 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">Data Source</div>
            <SectionLoadError message={errors.vmsBatches} />
            {!hasVmsData ? (
              <p className="mt-1 font-medium text-slate-700">No VMS data imported yet</p>
            ) : (
              <div className="mt-1 space-y-1"><p>{salesSourceMessage}</p><p>{refillSourceMessage}</p></div>
            )}
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
            <StatCard label="Cash variance" value={lyd(totalCashVariance)} />
            <StatCard label="Machines needing refill" value={refillRows.length} />
            <StatCard label="Open issues" value={data.openIssues} />
            <StatCard label="Low storage products" value={lowStorageRows.length} />
            <StatCard label="Products needing restock" value={(restockSummary.critical + restockSummary.low).toLocaleString("en-US")} />
          </div>
          {topKpiErrors.length ? (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              Some KPI totals could not load: {topKpiErrors.join(" | ")}
            </div>
          ) : null}
          {missingCostProducts ? (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              Cost missing for {missingCostProducts} products. Profit may be incomplete.
            </div>
          ) : null}
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            <SectionCard>
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Products needing restock</h2>
                  <p className="mt-1 text-sm text-slate-500">Critical and low products from storage thresholds, routes, VMS stock, and sales velocity.</p>
                </div>
                <Link href="/restock-priority" className="btn-secondary shrink-0">View Restock Priority</Link>
              </div>
              <SectionLoadError message={errors.restockPriority} />
              {!errors.restockPriority && restockWarnings.length ? (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Some restock signals are unavailable. Showing the working signals.
                </div>
              ) : null}
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-rose-100 bg-rose-50 p-3">
                  <div className="text-xs font-semibold uppercase text-rose-700">Critical</div>
                  <div className="mt-1 text-2xl font-semibold text-rose-800">{restockSummary.critical}</div>
                </div>
                <div className="rounded-lg border border-amber-100 bg-amber-50 p-3">
                  <div className="text-xs font-semibold uppercase text-amber-700">Low</div>
                  <div className="mt-1 text-2xl font-semibold text-amber-800">{restockSummary.low}</div>
                </div>
              </div>
              {errors.restockPriority ? null : !topRestockItems.length ? (
                <EmptyState title="No restock priorities yet" body="Set product storage thresholds or import VMS data to rank products." />
              ) : (
                <div className="space-y-2">
                  {topRestockItems.map((item) => (
                    <div key={item.productId} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">{item.name}</div>
                        <div className="text-xs text-slate-500">Storage {item.storageQty} · Buy {item.suggestedBuyQty} · Score {item.priorityScore}</div>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{item.status.toUpperCase()}</span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            <SectionCard>
              <h2 className="mb-3 text-base font-semibold">Top products from VMS sales</h2>
              <SectionLoadError message={errors.productMonthly} />
              {errors.productMonthly ? null : !hasVmsData ? (
                <EmptyState title="No VMS data imported yet" body="Upload VMS sales reports to populate sales KPIs." />
              ) : !productMonthlyRows.length ? (
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
              <SectionLoadError message={errors.refill} />
              {errors.refill ? null : !hasVmsData ? (
                <EmptyState title="No VMS data imported yet" body="Upload mapped VMS stock data to generate machine refill recommendations." />
              ) : !refillRows.length ? (
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
              <SectionLoadError message={errors.lowStorage} />
              {errors.lowStorage ? null : !lowStorageRows.length ? (
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
            <SectionCard>
              <h2 className="mb-3 text-base font-semibold">Recent cash variance</h2>
              <SectionLoadError message={errors.cash} />
              {errors.cash ? null : !cashRows.length ? (
                <EmptyState title="No cash collections yet" body="Cash variance appears after operators complete machine stops and finance counts cash." />
              ) : (
                <DataTable headers={["Machine", "Expected", "Counted", "Variance"]}>
                  {cashRows.map((row, index) => (
                    <tr key={`${row.machine_id}-${index}`}>
                      <td>{row.machine_id ? row.machine_id.slice(0, 8) : "-"}</td>
                      <td>{row.vms_expected_cash === null ? "-" : lyd(Number(row.vms_expected_cash ?? 0))}</td>
                      <td>{row.actual_cash_collected === null ? "-" : lyd(Number(row.actual_cash_collected ?? 0))}</td>
                      <td>{row.variance === null ? "-" : lyd(Number(row.variance ?? 0))}</td>
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
