/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { buildProductPlanningRecommendation, shiftPlanningMonth, type ProductPlanningSalesMonth } from "@/lib/product-planning";
import { formatProductQuantity, normalizeCaseQuantity } from "@/lib/product-quantity";

export const dynamic = "force-dynamic";

const PLAN_TABLE = "product_monthly_purchase_plans";

type PlanningSearchParams = {
  month?: string;
  saved?: string;
  error?: string;
};

type ProductRow = {
  id: string;
  sku: string | null;
  name: string;
  category: string | null;
  created_at: string | null;
  case_quantity: number | string | null;
  current_cost_price_lyd: number | string | null;
  last_purchase_cost_lyd: number | string | null;
  average_cost_lyd: number | string | null;
  active: boolean | null;
};

type SavedPlanRow = {
  id: string;
  product_id: string;
  planning_month: string;
  planned_units: number | string | null;
  planned_budget_lyd: number | string | null;
  plan_status: string | null;
  notes: string | null;
};

function monthStart(value: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? ""));
  if (match) return `${match[1]}-${match[2]}-01`;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthEnd(month: string) {
  const date = new Date(`${month}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function monthInputValue(month: string) {
  return month.slice(0, 7);
}

function numeric(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function wholeNumber(value: unknown) {
  return Math.max(0, Math.floor(numeric(value)));
}

function isMissingPlanTable(error: any) {
  const text = [error?.code, error?.message, error?.details, error?.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return error?.code === "PGRST205" || error?.code === "42P01" || text.includes(PLAN_TABLE);
}

function actionTone(action: string) {
  if (action === "increase" || action === "keep") return "counted_confirmed";
  if (action === "testing") return "pending";
  if (action === "reduce" || action === "review") return "variance_review";
  if (action === "remove") return "critical";
  return action;
}

async function saveMonthlyProductPlans(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/product-planning");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/product-planning?error=Supabase%20is%20not%20configured");

  const planningMonth = monthStart(String(formData.get("planning_month") ?? ""));
  const productIds = Array.from(new Set(formData.getAll("product_id").map((value) => String(value ?? "").trim()).filter(Boolean)));
  const now = new Date().toISOString();
  const payloads = productIds.map((productId) => ({
    planning_month: planningMonth,
    product_id: productId,
    planned_units: wholeNumber(formData.get(`planned_units__${productId}`)),
    planned_budget_lyd: Math.max(0, numeric(formData.get(`planned_budget__${productId}`))),
    plan_status: ["draft", "approved", "ordered", "closed"].includes(String(formData.get(`plan_status__${productId}`)))
      ? String(formData.get(`plan_status__${productId}`))
      : "draft",
    notes: String(formData.get(`notes__${productId}`) ?? "").trim() || null,
    created_by: profile.id,
    updated_at: now,
  }));

  if (!payloads.length) redirect(`/product-planning?month=${monthInputValue(planningMonth)}&error=${encodeURIComponent("No product plan rows were submitted.")}`);

  const { error } = await supabase.from(PLAN_TABLE).upsert(payloads, { onConflict: "planning_month,product_id" });
  if (error) {
    console.error("[product-planning] Failed to save monthly plans", error);
    const message = isMissingPlanTable(error)
      ? "Apply the product monthly planning migration before saving plans."
      : "Could not save the monthly product plan.";
    redirect(`/product-planning?month=${monthInputValue(planningMonth)}&error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/product-planning");
  redirect(`/product-planning?month=${monthInputValue(planningMonth)}&saved=1`);
}

export default async function ProductPlanningPage({ searchParams }: { searchParams: Promise<PlanningSearchParams> }) {
  await requireCurrentProfileForPath("/product-planning");
  const params = await searchParams;
  const planningMonth = monthStart(params.month);
  const previousMonth = shiftPlanningMonth(planningMonth, -1);
  const priorMonth = shiftPlanningMonth(planningMonth, -2);
  const historyStart = shiftPlanningMonth(planningMonth, -12);
  const currentMonthEnd = monthEnd(planningMonth);
  const supabase = await getAuthenticatedSupabaseServerClient();

  if (!supabase) {
    return <ErrorState title="Product Planning unavailable" body="Supabase is not configured, so monthly purchasing plans cannot load." />;
  }

  const [productsResult, storageResult, slotsResult, plansResult, purchasesResult, batchesResult] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, name, category, created_at, case_quantity, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd, active")
      .eq("active", true)
      .order("name"),
    supabase
      .from("current_inventory_by_location")
      .select("product_id, quantity_on_hand")
      .eq("location_type", "storage")
      .limit(10000),
    supabase
      .from("machine_slots")
      .select("product_id, machine_id, active")
      .eq("active", true)
      .limit(10000),
    supabase
      .from(PLAN_TABLE)
      .select("id, product_id, planning_month, planned_units, planned_budget_lyd, plan_status, notes")
      .eq("planning_month", planningMonth),
    supabase
      .from("purchase_orders")
      .select("id, order_date, status, purchase_order_lines(product_id, total_units, line_total_lyd, unit_cost_lyd)")
      .gte("order_date", planningMonth)
      .lte("order_date", currentMonthEnd)
      .limit(2000),
    supabase
      .from("vms_import_batches")
      .select("id, report_type, status, is_active, deleted_at, report_start_date, report_end_date")
      .eq("report_type", "monthly_product_profit")
      .in("status", ["imported", "imported_with_warnings", "partially_imported"])
      .eq("is_active", true)
      .is("deleted_at", null)
      .gte("report_end_date", historyStart)
      .lte("report_start_date", monthEnd(previousMonth))
      .limit(1000),
  ]);

  if (productsResult.error) {
    console.error("[product-planning] Product query failed", productsResult.error);
    return <ErrorState title="Product Planning could not load" body="Snacky OS could not load the product catalog." />;
  }

  const monthlyBatchIds = (batchesResult.data ?? []).map((row: any) => String(row.id ?? "")).filter(Boolean);
  const monthlySalesResult = monthlyBatchIds.length
    ? await supabase
        .from("vms_monthly_product_profit")
        .select("business_month, internal_product_id, transaction_count, transaction_amount, cost_amount, profit_amount, import_batch_id")
        .in("import_batch_id", monthlyBatchIds)
        .gte("business_month", historyStart)
        .lte("business_month", previousMonth)
        .limit(20000)
    : { data: [], error: null };

  const detailedSalesResult = monthlySalesResult.error || !(monthlySalesResult.data ?? []).length
    ? await supabase
        .from("kpi_product_monthly")
        .select("product_id, sales_month, units_sold, gross_sales_amount, gross_profit_amount")
        .gte("sales_month", historyStart)
        .lte("sales_month", previousMonth)
        .limit(10000)
    : { data: [], error: null };

  const products = (productsResult.data ?? []) as ProductRow[];
  const storageByProduct = new Map<string, number>();
  (storageResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + wholeNumber(row.quantity_on_hand));
  });

  const machineIdsByProduct = new Map<string, Set<string>>();
  (slotsResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    const machineId = String(row.machine_id ?? "");
    if (!productId || !machineId || row.active === false) return;
    if (!machineIdsByProduct.has(productId)) machineIdsByProduct.set(productId, new Set());
    machineIdsByProduct.get(productId)!.add(machineId);
  });

  const salesByProduct = new Map<string, ProductPlanningSalesMonth[]>();
  if ((monthlySalesResult.data ?? []).length) {
    const grouped = new Map<string, ProductPlanningSalesMonth>();
    (monthlySalesResult.data ?? []).forEach((row: any) => {
      const productId = String(row.internal_product_id ?? "");
      const month = String(row.business_month ?? "").slice(0, 10);
      if (!productId || !month) return;
      const key = `${productId}:${month}`;
      const current = grouped.get(key) ?? { month, units: 0, revenue: 0, grossProfit: 0 };
      current.units += wholeNumber(row.transaction_count);
      current.revenue += Math.max(0, numeric(row.transaction_amount));
      current.grossProfit = numeric(current.grossProfit) + numeric(row.profit_amount, numeric(row.transaction_amount) - numeric(row.cost_amount));
      grouped.set(key, current);
    });
    grouped.forEach((row, key) => {
      const productId = key.split(":")[0];
      salesByProduct.set(productId, [...(salesByProduct.get(productId) ?? []), row]);
    });
  } else {
    (detailedSalesResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id ?? "");
      const month = String(row.sales_month ?? "").slice(0, 10);
      if (!productId || !month) return;
      salesByProduct.set(productId, [
        ...(salesByProduct.get(productId) ?? []),
        {
          month,
          units: wholeNumber(row.units_sold),
          revenue: Math.max(0, numeric(row.gross_sales_amount)),
          grossProfit: row.gross_profit_amount === null || row.gross_profit_amount === undefined ? null : numeric(row.gross_profit_amount),
        },
      ]);
    });
  }

  const purchasedByProduct = new Map<string, { units: number; spend: number }>();
  (purchasesResult.data ?? [])
    .filter((purchase: any) => !["cancelled", "canceled", "voided"].includes(String(purchase.status ?? "").toLowerCase()))
    .forEach((purchase: any) => {
      (purchase.purchase_order_lines ?? []).forEach((line: any) => {
        const productId = String(line.product_id ?? "");
        if (!productId) return;
        const current = purchasedByProduct.get(productId) ?? { units: 0, spend: 0 };
        const units = wholeNumber(line.total_units);
        current.units += units;
        current.spend += Math.max(0, numeric(line.line_total_lyd, units * numeric(line.unit_cost_lyd)));
        purchasedByProduct.set(productId, current);
      });
    });

  const savedPlans = new Map<string, SavedPlanRow>();
  if (!plansResult.error) {
    (plansResult.data ?? []).forEach((row: any) => savedPlans.set(String(row.product_id), row as SavedPlanRow));
  }
  const planTableMissing = Boolean(plansResult.error && isMissingPlanTable(plansResult.error));
  if (plansResult.error && !planTableMissing) console.error("[product-planning] Plan query failed", plansResult.error);

  const rows = products.map((product) => {
    const purchased = purchasedByProduct.get(product.id) ?? { units: 0, spend: 0 };
    const unitCost = numeric(product.last_purchase_cost_lyd ?? product.average_cost_lyd ?? product.current_cost_price_lyd, NaN);
    const recommendation = buildProductPlanningRecommendation({
      productId: product.id,
      productName: product.name,
      category: product.category,
      createdAt: product.created_at,
      caseQuantity: product.case_quantity,
      currentStorageUnits: storageByProduct.get(product.id) ?? 0,
      activeMachineCount: machineIdsByProduct.get(product.id)?.size ?? 0,
      unitCost,
      salesMonths: salesByProduct.get(product.id) ?? [],
      purchasedUnitsThisMonth: purchased.units,
      purchasedSpendThisMonth: purchased.spend,
    }, planningMonth);
    const saved = savedPlans.get(product.id) ?? null;
    return {
      product,
      recommendation,
      saved,
      storageUnits: storageByProduct.get(product.id) ?? 0,
      activeMachineCount: machineIdsByProduct.get(product.id)?.size ?? 0,
      unitCost,
      plannedUnits: saved ? wholeNumber(saved.planned_units) : recommendation.suggestedBuyUnits,
      plannedBudget: saved ? Math.max(0, numeric(saved.planned_budget_lyd)) : recommendation.recommendedBudgetLyd ?? 0,
      planStatus: saved?.plan_status ?? "draft",
      notes: saved?.notes ?? "",
    };
  }).sort((left, right) => {
    const priority = { remove: 0, review: 1, reduce: 2, increase: 3, testing: 4, keep: 5 } as Record<string, number>;
    return (priority[left.recommendation.action] ?? 99) - (priority[right.recommendation.action] ?? 99)
      || right.recommendation.previousMonthUnits - left.recommendation.previousMonthUnits
      || left.product.name.localeCompare(right.product.name);
  });

  const totalRecommendedBudget = rows.reduce((sum, row) => sum + (row.recommendation.recommendedBudgetLyd ?? 0), 0);
  const totalPlannedBudget = rows.reduce((sum, row) => sum + row.plannedBudget, 0);
  const totalPurchasedSpend = rows.reduce((sum, row) => sum + row.recommendation.purchasedSpendThisMonth, 0);
  const remainingBudget = Math.max(0, totalPlannedBudget - totalPurchasedSpend);
  const newCount = rows.filter((row) => row.recommendation.action === "testing").length;
  const removeCount = rows.filter((row) => row.recommendation.action === "remove").length;
  const increaseCount = rows.filter((row) => row.recommendation.action === "increase").length;
  const dataWarning = monthlySalesResult.error && detailedSalesResult.error
    ? "Monthly VMS product sales could not load. Recommendations are based on product age, storage, and purchase records only."
    : null;

  return (
    <>
      <PageHeader
        title="Product Planning"
        subtitle="Decide what to keep, increase, reduce, or remove; set a dedicated monthly quantity and budget for every product."
        breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Product Planning" }]}
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/products-dashboard">Product Dashboard</SecondaryButton><SecondaryButton href="/purchases?module=finance">Purchases</SecondaryButton><PrimaryButton href="/purchases/new">New purchase</PrimaryButton></div>}
      />

      {params.saved ? <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Monthly product plan saved.</div> : null}
      {params.error ? <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-900">{params.error}</div> : null}
      {planTableMissing ? <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><div className="font-semibold">Recommendations are available, but plan saving is not installed yet.</div><p className="mt-1">Apply migration 202607160001_product_monthly_purchase_plans.sql to save monthly quantities and budgets.</p></div> : null}
      {dataWarning ? <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{dataWarning}</div> : null}

      <section className="surface-card mb-6">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-800">Planning month</span><input type="month" name="month" defaultValue={monthInputValue(planningMonth)} className="field-input" /></label>
          <button className="btn-primary">Open month</button>
          <Link href="/product-planning" className="btn-secondary">Current month</Link>
        </form>
        <p className="mt-3 text-sm text-slate-500">Sales baseline: {previousMonth.slice(0, 7)}. Trend comparison: {priorMonth.slice(0, 7)}.</p>
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recommended budget</div><div className="mt-2 text-2xl font-semibold">{lyd(totalRecommendedBudget)}</div><p className="mt-1 text-sm text-slate-500">Calculated from target buy units and latest product costs</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Saved / editable budget</div><div className="mt-2 text-2xl font-semibold">{lyd(totalPlannedBudget)}</div><p className="mt-1 text-sm text-slate-500">Your dedicated amount for each item this month</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Purchased this month</div><div className="mt-2 text-2xl font-semibold">{lyd(totalPurchasedSpend)}</div><p className="mt-1 text-sm text-slate-500">Remaining against plan: {lyd(remainingBudget)}</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</div><div className="mt-2 text-lg font-semibold">{increaseCount} increase · {removeCount} remove</div><p className="mt-1 text-sm text-slate-500">{newCount} new products remain protected for testing</p></div>
      </section>

      {!rows.length ? <EmptyState title="No products to plan" body="Create active products before building a monthly purchase plan." /> : (
        <form action={saveMonthlyProductPlans}>
          <input type="hidden" name="planning_month" value={planningMonth} />
          <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="font-semibold text-slate-950">Monthly item budget</div><p className="mt-1 text-sm text-slate-500">Edit planned units or budget, then save all products together.</p></div>
            <button className="btn-primary" disabled={planTableMissing}>Save monthly plan</button>
          </div>
          <DataTable sortable showSummary headers={["Product", "Recommendation", "Last month sold", "Month before", "Storage now", "Minimum stock", "Suggested buy", "Purchased this month", "Planned units", "Planned budget", "Status", "Notes"]}>
            {rows.map((row) => {
              const packaging = { caseQuantity: row.product.case_quantity, productName: row.product.name, category: row.product.category };
              return (
                <tr key={row.product.id}>
                  <td>
                    <input type="hidden" name="product_id" value={row.product.id} />
                    <div className="font-semibold text-slate-950">{row.product.name}</div>
                    <div className="mt-1 text-xs text-slate-500">{row.product.sku ?? "No SKU"} · {normalizeCaseQuantity(row.product.case_quantity)} per box · {row.activeMachineCount} machine(s)</div>
                    <div className="mt-1 text-xs text-slate-500">Unit cost: {Number.isFinite(row.unitCost) && row.unitCost > 0 ? lyd(row.unitCost) : "Missing"}</div>
                  </td>
                  <td className="min-w-56">
                    <StatusBadge status={actionTone(row.recommendation.action)} label={row.recommendation.actionLabel} />
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">{row.recommendation.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  </td>
                  <td>{formatProductQuantity(row.recommendation.previousMonthUnits, packaging)}</td>
                  <td>{formatProductQuantity(row.recommendation.priorMonthUnits, packaging)}</td>
                  <td>{formatProductQuantity(row.storageUnits, packaging)}</td>
                  <td>{formatProductQuantity(row.recommendation.minimumStockUnits, packaging)}</td>
                  <td>{formatProductQuantity(row.recommendation.suggestedBuyUnits, packaging)}</td>
                  <td><div>{formatProductQuantity(row.recommendation.purchasedUnitsThisMonth, packaging)}</div><div className="mt-1 text-xs text-slate-500">{lyd(row.recommendation.purchasedSpendThisMonth)}</div></td>
                  <td className="min-w-36"><input type="number" min="0" step="1" name={`planned_units__${row.product.id}`} defaultValue={row.plannedUnits} className="field-input" /><div className="mt-1 text-xs text-slate-500">{formatProductQuantity(row.plannedUnits, packaging)}</div></td>
                  <td className="min-w-36"><input type="number" min="0" step="0.01" name={`planned_budget__${row.product.id}`} defaultValue={row.plannedBudget.toFixed(2)} className="field-input" /></td>
                  <td><select name={`plan_status__${row.product.id}`} defaultValue={row.planStatus} className="field-input min-w-28"><option value="draft">Draft</option><option value="approved">Approved</option><option value="ordered">Ordered</option><option value="closed">Closed</option></select></td>
                  <td className="min-w-48"><input name={`notes__${row.product.id}`} defaultValue={row.notes} className="field-input" placeholder="Supplier, promo, test note..." /></td>
                </tr>
              );
            })}
          </DataTable>
          <div className="sticky bottom-3 z-10 mt-4 flex justify-end rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur"><button className="btn-primary" disabled={planTableMissing}>Save monthly plan</button></div>
        </form>
      )}
    </>
  );
}
