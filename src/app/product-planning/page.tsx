/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { buildProductPlanningRecommendation, shiftPlanningMonth, type ProductPlanningSalesMonth } from "@/lib/product-planning";
import { formatProductQuantity, normalizeCaseQuantity } from "@/lib/product-quantity";
import { BuyListLiveSummary } from "@/app/product-planning/BuyListLiveSummary";

export const dynamic = "force-dynamic";

const PLAN_TABLE = "product_monthly_purchase_plans";

type PlanningSearchParams = {
  month?: string;
  saved?: string;
  error?: string;
  view?: string;
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
  last_purchase_date: string | null;
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

type MonthlyBatchRow = {
  id?: unknown;
  report_start_date?: unknown;
  report_end_date?: unknown;
  imported_at?: unknown;
  uploaded_at?: unknown;
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

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
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

function safeDate(value: unknown) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function dateTimeValue(value: unknown) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function batchMonthKey(row: MonthlyBatchRow) {
  return safeDate(row.report_start_date)?.slice(0, 7) ?? safeDate(row.report_end_date)?.slice(0, 7) ?? "";
}

function selectBestMonthlyBatches(rows: MonthlyBatchRow[]) {
  const sorted = [...rows].sort((left, right) => {
    const endDiff = String(safeDate(right.report_end_date) ?? "").localeCompare(String(safeDate(left.report_end_date) ?? ""));
    if (endDiff) return endDiff;
    return Math.max(dateTimeValue(right.imported_at), dateTimeValue(right.uploaded_at))
      - Math.max(dateTimeValue(left.imported_at), dateTimeValue(left.uploaded_at));
  });
  const byMonth = new Map<string, MonthlyBatchRow>();
  sorted.forEach((row) => {
    const month = batchMonthKey(row);
    if (month && !byMonth.has(month)) byMonth.set(month, row);
  });
  return Array.from(byMonth.values());
}

function inclusiveCoverageDays(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) return 0;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

async function saveMonthlyProductPlans(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/product-planning");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/product-planning?error=Supabase%20is%20not%20configured");

  const planningMonth = monthStart(String(formData.get("planning_month") ?? ""));
  const redirectView = String(formData.get("redirect_view") ?? "") === "buy-list" ? "buy-list" : "";
  const targetSuffix = `month=${monthInputValue(planningMonth)}${redirectView ? "&view=buy-list" : ""}`;
  const productIds = Array.from(new Set(formData.getAll("product_id").map((value) => String(value ?? "").trim()).filter(Boolean)));
  const now = new Date().toISOString();
  const payloads = productIds.map((productId) => {
    const selectedForBuyList = String(formData.get(`buy_list__${productId}`) ?? "") === "on";
    const buyQuantity = wholeNumber(formData.get(`buy_quantity__${productId}`));
    const purchasedUnits = wholeNumber(formData.get(`purchased_units__${productId}`));
    const purchasedSpend = Math.max(0, numeric(formData.get(`purchased_spend__${productId}`)));
    const lastPurchaseCost = numeric(formData.get(`buy_unit_cost__${productId}`), Number.NaN);
    const existingStatus = String(formData.get(`existing_status__${productId}`) ?? "draft");
    const estimatedRemainingCost = selectedForBuyList && Number.isFinite(lastPurchaseCost) && lastPurchaseCost > 0
      ? buyQuantity * lastPurchaseCost
      : 0;

    return {
      planning_month: planningMonth,
      product_id: productId,
      planned_units: purchasedUnits + (selectedForBuyList ? buyQuantity : 0),
      planned_budget_lyd: roundMoney(purchasedSpend + estimatedRemainingCost),
      plan_status: selectedForBuyList ? (existingStatus === "ordered" ? "ordered" : "approved") : "draft",
      notes: String(formData.get(`notes__${productId}`) ?? "").trim() || null,
      created_by: profile.id,
      updated_at: now,
    };
  });

  if (!payloads.length) redirect(`/product-planning?${targetSuffix}&error=${encodeURIComponent("No product plan rows were submitted.")}`);

  const { error } = await supabase.from(PLAN_TABLE).upsert(payloads, { onConflict: "planning_month,product_id" });
  if (error) {
    console.error("[product-planning] Failed to save monthly plans", error);
    const message = isMissingPlanTable(error)
      ? "Apply the product monthly planning migration before saving plans."
      : "Could not save the monthly product plan.";
    redirect(`/product-planning?${targetSuffix}&error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/product-planning");
  redirect(`/product-planning?${targetSuffix}&saved=1`);
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
      .select("id, sku, name, category, created_at, case_quantity, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd, last_purchase_date, active")
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
      .select("id, report_type, status, is_active, deleted_at, report_start_date, report_end_date, imported_at, uploaded_at")
      .eq("report_type", "monthly_product_profit")
      .in("status", ["imported", "imported_with_warnings", "partially_imported"])
      .eq("is_active", true)
      .is("deleted_at", null)
      .gte("report_end_date", historyStart)
      .lte("report_start_date", currentMonthEnd)
      .limit(1000),
  ]);

  if (productsResult.error) {
    console.error("[product-planning] Product query failed", productsResult.error);
    return <ErrorState title="Product Planning could not load" body="Snacky OS could not load the product catalog." />;
  }

  const selectedMonthlyBatches = selectBestMonthlyBatches((batchesResult.data ?? []) as MonthlyBatchRow[]);
  const monthlyBatchIds = selectedMonthlyBatches.map((row) => String(row.id ?? "")).filter(Boolean);
  const planningMonthBatch = selectedMonthlyBatches.find((row) => batchMonthKey(row) === planningMonth.slice(0, 7)) ?? null;
  const coverageStartRaw = safeDate(planningMonthBatch?.report_start_date) ?? (planningMonthBatch ? planningMonth : null);
  const coverageEndRaw = safeDate(planningMonthBatch?.report_end_date);
  const currentMonthCoverageStart = coverageStartRaw && coverageStartRaw < planningMonth ? planningMonth : coverageStartRaw;
  const currentMonthSalesThrough = coverageEndRaw && coverageEndRaw > currentMonthEnd ? currentMonthEnd : coverageEndRaw;
  const currentMonthObservedDays = inclusiveCoverageDays(currentMonthCoverageStart, currentMonthSalesThrough);

  const monthlySalesResult = monthlyBatchIds.length
    ? await supabase
        .from("vms_monthly_product_profit")
        .select("business_month, internal_product_id, transaction_count, transaction_amount, cost_amount, profit_amount, import_batch_id")
        .in("import_batch_id", monthlyBatchIds)
        .gte("business_month", historyStart)
        .lte("business_month", planningMonth)
        .limit(20000)
    : { data: [], error: null };

  const detailedSalesResult = monthlySalesResult.error || !(monthlySalesResult.data ?? []).length
    ? await supabase
        .from("kpi_product_monthly")
        .select("product_id, sales_month, units_sold, gross_sales_amount, gross_profit_amount")
        .gte("sales_month", historyStart)
        .lte("sales_month", planningMonth)
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
    const recommendationCost = numeric(product.last_purchase_cost_lyd ?? product.average_cost_lyd ?? product.current_cost_price_lyd, Number.NaN);
    const lastPurchaseCost = numeric(product.last_purchase_cost_lyd, Number.NaN);
    const recommendation = buildProductPlanningRecommendation({
      productId: product.id,
      productName: product.name,
      category: product.category,
      createdAt: product.created_at,
      caseQuantity: product.case_quantity,
      currentStorageUnits: storageByProduct.get(product.id) ?? 0,
      activeMachineCount: machineIdsByProduct.get(product.id)?.size ?? 0,
      unitCost: recommendationCost,
      salesMonths: salesByProduct.get(product.id) ?? [],
      currentMonthObservedDays,
      currentMonthSalesThrough,
      purchasedUnitsThisMonth: purchased.units,
      purchasedSpendThisMonth: purchased.spend,
    }, planningMonth);
    const saved = savedPlans.get(product.id) ?? null;
    const planStatus = saved?.plan_status ?? "draft";
    const inBuyList = ["approved", "ordered"].includes(planStatus);
    const savedRemainingUnits = saved ? Math.max(0, wholeNumber(saved.planned_units) - purchased.units) : recommendation.suggestedBuyUnits;
    const buyQuantity = inBuyList ? savedRemainingUnits : recommendation.suggestedBuyUnits;
    const estimatedBuyCost = Number.isFinite(lastPurchaseCost) && lastPurchaseCost > 0
      ? roundMoney(buyQuantity * lastPurchaseCost)
      : null;

    return {
      product,
      recommendation,
      saved,
      storageUnits: storageByProduct.get(product.id) ?? 0,
      activeMachineCount: machineIdsByProduct.get(product.id)?.size ?? 0,
      recommendationCost,
      lastPurchaseCost,
      inBuyList,
      buyQuantity,
      estimatedBuyCost,
      plannedUnits: saved ? wholeNumber(saved.planned_units) : recommendation.recommendedPlanUnits,
      plannedBudget: saved ? Math.max(0, numeric(saved.planned_budget_lyd)) : recommendation.recommendedBudgetLyd ?? 0,
      planStatus,
      notes: saved?.notes ?? "",
    };
  }).sort((left, right) => {
    return right.recommendation.currentMonthUnits - left.recommendation.currentMonthUnits
      || right.recommendation.projectedCurrentMonthUnits - left.recommendation.projectedCurrentMonthUnits
      || right.recommendation.previousMonthUnits - left.recommendation.previousMonthUnits
      || left.product.name.localeCompare(right.product.name);
  });

  const totalRecommendedBudget = rows.reduce((sum, row) => sum + (row.recommendation.recommendedBudgetLyd ?? 0), 0);
  const totalPlannedBudget = rows.reduce((sum, row) => sum + row.plannedBudget, 0);
  const totalPurchasedSpend = rows.reduce((sum, row) => sum + row.recommendation.purchasedSpendThisMonth, 0);
  const totalCurrentMonthUnits = rows.reduce((sum, row) => sum + row.recommendation.currentMonthUnits, 0);
  const totalProjectedMonthUnits = rows.reduce((sum, row) => sum + row.recommendation.projectedCurrentMonthUnits, 0);
  const buyListRows = rows.filter((row) => row.inBuyList && row.buyQuantity > 0);
  const buyListOnly = params.view === "buy-list";
  const visibleRows = buyListOnly ? buyListRows : rows;
  const estimatedBuyListTotal = buyListRows.reduce((sum, row) => sum + (row.estimatedBuyCost ?? 0), 0);
  const missingBuyListCostCount = buyListRows.filter((row) => row.estimatedBuyCost === null).length;
  const remainingBudget = Math.max(0, totalPlannedBudget - totalPurchasedSpend);
  const newCount = rows.filter((row) => row.recommendation.action === "testing").length;
  const removeCount = rows.filter((row) => row.recommendation.action === "remove").length;
  const increaseCount = rows.filter((row) => row.recommendation.action === "increase").length;
  const dataWarning = monthlySalesResult.error && detailedSalesResult.error
    ? "Monthly VMS product sales could not load. Recommendations are based on product age, storage, and purchase records only."
    : null;
  const currentMonthDataNotice = currentMonthObservedDays > 0
    ? `Current-month VMS sales are included through ${currentMonthSalesThrough} (${currentMonthObservedDays} day${currentMonthObservedDays === 1 ? "" : "s"} covered).`
    : "No active current-month product-sales upload was found. Recommendations still use last month until you upload this month's VMS sales.";

  return (
    <>
      <PageHeader
        title="Product Planning"
        subtitle="Plan what to buy using last month, current-month VMS sales, projected remaining demand, current storage, and purchases already made."
        breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Product Planning" }]}
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href={`/product-planning?month=${monthInputValue(planningMonth)}&view=buy-list`}>Buy list ({buyListRows.length})</SecondaryButton><SecondaryButton href="/purchases?module=finance">Purchases</SecondaryButton><PrimaryButton href="/purchases/new">New purchase</PrimaryButton></div>}
      />

      {params.saved ? <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Buy list and monthly product plan saved.</div> : null}
      {params.error ? <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-900">{params.error}</div> : null}
      {planTableMissing ? <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><div className="font-semibold">Recommendations are available, but plan saving is not installed yet.</div><p className="mt-1">Apply migration 202607160001_product_monthly_purchase_plans.sql to save monthly quantities and budgets.</p></div> : null}
      {dataWarning ? <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{dataWarning}</div> : null}
      <div className={`mb-5 rounded-xl border p-4 text-sm ${currentMonthObservedDays > 0 ? "border-sky-200 bg-sky-50 text-sky-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
        <div className="font-semibold">Current-month demand signal</div>
        <p className="mt-1">{currentMonthDataNotice}</p>
      </div>

      <section className="surface-card mb-6">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-800">Planning month</span><input type="month" name="month" defaultValue={monthInputValue(planningMonth)} className="field-input" /></label>
          <button className="btn-primary">Open month</button>
          <Link href="/product-planning" className="btn-secondary">Current month</Link>
        </form>
        <p className="mt-3 text-sm text-slate-500">Baseline: {previousMonth.slice(0, 7)}. Current uploaded sales: {planningMonth.slice(0, 7)}{currentMonthSalesThrough ? ` through ${currentMonthSalesThrough}` : " not uploaded yet"}. Earlier comparison: {priorMonth.slice(0, 7)}.</p>
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current month sold</div><div className="mt-2 text-2xl font-semibold">{totalCurrentMonthUnits.toLocaleString("en-US")}</div><p className="mt-1 text-sm text-slate-500">Projected full month: {totalProjectedMonthUnits.toLocaleString("en-US")} units</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recommended budget</div><div className="mt-2 text-2xl font-semibold">{lyd(totalRecommendedBudget)}</div><p className="mt-1 text-sm text-slate-500">Spent so far plus the quantity still suggested</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Saved / editable budget</div><div className="mt-2 text-2xl font-semibold">{lyd(totalPlannedBudget)}</div><p className="mt-1 text-sm text-slate-500">Your dedicated amount for each item this month</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Purchased this month</div><div className="mt-2 text-2xl font-semibold">{lyd(totalPurchasedSpend)}</div><p className="mt-1 text-sm text-slate-500">Remaining against saved plan: {lyd(remainingBudget)}</p></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</div><div className="mt-2 text-lg font-semibold">{increaseCount} increase · {removeCount} remove</div><p className="mt-1 text-sm text-slate-500">{newCount} new products remain protected for testing</p></div>
      </section>

      <section className="surface-card mb-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-950">Purchasing view</div>
            <p className="mt-1 text-sm text-slate-500">Products are ordered from most sold to least sold this month. Add only the products you intend to buy.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/product-planning?month=${monthInputValue(planningMonth)}`} className={buyListOnly ? "btn-secondary" : "btn-primary"}>All products</Link>
            <Link href={`/product-planning?month=${monthInputValue(planningMonth)}&view=buy-list`} className={buyListOnly ? "btn-primary" : "btn-secondary"}>Buy list ({buyListRows.length})</Link>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Items in buy list</div><div className="mt-1 text-xl font-semibold">{buyListRows.length}</div></div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated list cost</div><div className="mt-1 text-xl font-semibold">{lyd(estimatedBuyListTotal)}</div></div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Missing last costs</div><div className="mt-1 text-xl font-semibold">{missingBuyListCostCount}</div></div>
        </div>
      </section>

      {!rows.length ? <EmptyState title="No products to plan" body="Create active products before building a monthly purchase plan." /> : buyListOnly && !visibleRows.length ? (
        <EmptyState title="Your buy list is empty" body="Open All products, choose quantities, tick Add to buy list, then save." action={<SecondaryButton href={`/product-planning?month=${monthInputValue(planningMonth)}`}>Open all products</SecondaryButton>} />
      ) : (
        <form id="product-planning-buy-list" action={saveMonthlyProductPlans}>
          <input type="hidden" name="planning_month" value={planningMonth} />
          <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="font-semibold text-slate-950">Restock products and buy list</div><p className="mt-1 text-sm text-slate-500">Storage, monthly sales, recommended quantity, and latest purchase cost are shown together. Save to keep the list for purchasing.</p></div>
            <div className="flex flex-wrap gap-2"><button className="btn-secondary" name="redirect_view" value={buyListOnly ? "buy-list" : ""} disabled={planTableMissing}>Save list</button><button className="btn-primary" name="redirect_view" value="buy-list" disabled={planTableMissing}>Save & open buy list</button></div>
          </div>

          <BuyListLiveSummary formId="product-planning-buy-list" initialCount={buyListRows.length} initialTotal={estimatedBuyListTotal} initialMissingCostCount={missingBuyListCostCount} />

          <DataTable
            className="product-planning-table [&_.table-wrap]:max-h-[68vh] [&_.table-wrap]:overflow-auto [&_.data-table_th]:sticky [&_.data-table_th]:top-0 [&_.data-table_th]:z-20 [&_.data-table_th]:bg-slate-50"
            headers={["Product", "Sold this month", "Storage left", "Recommended buy", "Buy list quantity", "Last purchase cost", "Estimated cost", "Add to buy list", "Recommendation"]}
          >
            {visibleRows.map((row) => {
              const packaging = { caseQuantity: row.product.case_quantity, productName: row.product.name, category: row.product.category };
              return (
                <tr key={row.product.id}>
                  <td className="min-w-56">
                    <input type="hidden" name="product_id" value={row.product.id} />
                    <input type="hidden" name={`purchased_units__${row.product.id}`} value={row.recommendation.purchasedUnitsThisMonth} />
                    <input type="hidden" name={`purchased_spend__${row.product.id}`} value={row.recommendation.purchasedSpendThisMonth} />
                    <input type="hidden" name={`buy_unit_cost__${row.product.id}`} value={Number.isFinite(row.lastPurchaseCost) && row.lastPurchaseCost > 0 ? row.lastPurchaseCost : ""} />
                    <input type="hidden" name={`existing_status__${row.product.id}`} value={row.planStatus} />
                    <input type="hidden" name={`notes__${row.product.id}`} value={row.notes} />
                    <div className="font-semibold text-slate-950">{row.product.name}</div>
                    <div className="mt-1 text-xs text-slate-500">{row.product.sku ?? "No SKU"} · {normalizeCaseQuantity(row.product.case_quantity)} per box</div>
                    <div className="mt-1 text-xs text-slate-500">Used in {row.activeMachineCount} machine(s)</div>
                  </td>
                  <td className="min-w-44">
                    <div className="text-lg font-semibold text-slate-950">{formatProductQuantity(row.recommendation.currentMonthUnits, packaging)}</div>
                    <div className="mt-1 text-xs text-slate-500">Projected: {formatProductQuantity(row.recommendation.projectedCurrentMonthUnits, packaging, { compact: true })}</div>
                    <div className="mt-1 text-xs text-slate-500">Last month: {formatProductQuantity(row.recommendation.previousMonthUnits, packaging, { compact: true })}</div>
                  </td>
                  <td className="min-w-40"><div className="text-lg font-semibold">{formatProductQuantity(row.storageUnits, packaging)}</div><div className="mt-1 text-xs text-slate-500">Target now: {formatProductQuantity(row.recommendation.targetStockUnits, packaging, { compact: true })}</div></td>
                  <td className="min-w-44"><div className="text-lg font-semibold text-slate-950">{formatProductQuantity(row.recommendation.suggestedBuyUnits, packaging)}</div><div className="mt-1 text-xs text-slate-500">Already purchased: {formatProductQuantity(row.recommendation.purchasedUnitsThisMonth, packaging, { compact: true })}</div></td>
                  <td className="min-w-40"><input type="number" min="0" step="1" name={`buy_quantity__${row.product.id}`} defaultValue={row.buyQuantity} data-buy-quantity={row.product.id} data-unit-cost={Number.isFinite(row.lastPurchaseCost) && row.lastPurchaseCost > 0 ? row.lastPurchaseCost : ""} className="field-input" /><div className="mt-1 text-xs text-slate-500">Suggested: {formatProductQuantity(row.recommendation.suggestedBuyUnits, packaging, { compact: true })}</div></td>
                  <td className="min-w-40"><div className="font-semibold">{Number.isFinite(row.lastPurchaseCost) && row.lastPurchaseCost > 0 ? lyd(row.lastPurchaseCost) : "Missing"}</div><div className="mt-1 text-xs text-slate-500">{row.product.last_purchase_date ? `Purchased ${row.product.last_purchase_date}` : "No previous purchase cost"}</div></td>
                  <td className="min-w-36"><div className="text-lg font-semibold" data-buy-line-total={row.product.id}>{row.inBuyList ? (row.estimatedBuyCost === null ? "Cost missing" : lyd(row.estimatedBuyCost)) : "Not in list"}</div><div className="mt-1 text-xs text-slate-500">Quantity × last purchase cost</div></td>
                  <td className="min-w-32"><label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium"><input type="checkbox" name={`buy_list__${row.product.id}`} defaultChecked={row.inBuyList} data-buy-list-checkbox="true" data-product-id={row.product.id} className="h-5 w-5" /><span>Add</span></label></td>
                  <td className="min-w-64"><StatusBadge status={actionTone(row.recommendation.action)} label={row.recommendation.actionLabel} /><ul className="mt-2 space-y-1 text-xs text-slate-600">{row.recommendation.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}</ul></td>
                </tr>
              );
            })}
          </DataTable>

          <div className="sticky bottom-3 z-30 mt-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-slate-600">The list is saved inside this month’s product plan and remains available when you record purchases.</div>
            <div className="flex flex-wrap gap-2"><button className="btn-secondary" name="redirect_view" value={buyListOnly ? "buy-list" : ""} disabled={planTableMissing}>Save list</button><button className="btn-primary" name="redirect_view" value="buy-list" disabled={planTableMissing}>Save & open buy list</button></div>
          </div>
        </form>
      )}
    </>
  );
}
