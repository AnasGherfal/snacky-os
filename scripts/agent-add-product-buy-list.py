from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


page_path = "src/app/product-planning/page.tsx"
text = read(page_path)

text = replace_once(
    text,
    'import { formatProductQuantity, normalizeCaseQuantity } from "@/lib/product-quantity";',
    'import { formatProductQuantity, normalizeCaseQuantity } from "@/lib/product-quantity";\nimport { BuyListLiveSummary } from "@/app/product-planning/BuyListLiveSummary";',
    "buy list summary import",
)

text = replace_once(
    text,
    '''type PlanningSearchParams = {\n  month?: string;\n  saved?: string;\n  error?: string;\n};''',
    '''type PlanningSearchParams = {\n  month?: string;\n  saved?: string;\n  error?: string;\n  view?: string;\n};''',
    "planning view search param",
)

text = replace_once(
    text,
    '''  average_cost_lyd: number | string | null;\n  active: boolean | null;''',
    '''  average_cost_lyd: number | string | null;\n  last_purchase_date: string | null;\n  active: boolean | null;''',
    "last purchase date type",
)

text = replace_once(
    text,
    '''function numeric(value: unknown, fallback = 0) {\n  const parsed = Number(value ?? fallback);\n  return Number.isFinite(parsed) ? parsed : fallback;\n}\n''',
    '''function numeric(value: unknown, fallback = 0) {\n  const parsed = Number(value ?? fallback);\n  return Number.isFinite(parsed) ? parsed : fallback;\n}\n\nfunction roundMoney(value: number) {\n  return Math.round(value * 100) / 100;\n}\n''',
    "money rounding helper",
)

save_start = text.index('  const planningMonth = monthStart(String(formData.get("planning_month") ?? ""));', text.index('async function saveMonthlyProductPlans'))
save_end = text.index('\n}\n\nexport default async function ProductPlanningPage', save_start)
new_save_body = '''  const planningMonth = monthStart(String(formData.get("planning_month") ?? ""));
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
  redirect(`/product-planning?${targetSuffix}&saved=1`);'''
text = text[:save_start] + new_save_body + text[save_end:]

text = replace_once(
    text,
    '.select("id, sku, name, category, created_at, case_quantity, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd, active")',
    '.select("id, sku, name, category, created_at, case_quantity, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd, last_purchase_date, active")',
    "product latest purchase fields",
)

rows_start = text.index('  const rows = products.map((product) => {')
rows_end = text.index('\n\n  const totalRecommendedBudget', rows_start)
new_rows = '''  const rows = products.map((product) => {
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
  });'''
text = text[:rows_start] + new_rows + text[rows_end:]

text = replace_once(
    text,
    '  const totalProjectedMonthUnits = rows.reduce((sum, row) => sum + row.recommendation.projectedCurrentMonthUnits, 0);\n  const remainingBudget = Math.max(0, totalPlannedBudget - totalPurchasedSpend);',
    '''  const totalProjectedMonthUnits = rows.reduce((sum, row) => sum + row.recommendation.projectedCurrentMonthUnits, 0);
  const buyListRows = rows.filter((row) => row.inBuyList && row.buyQuantity > 0);
  const buyListOnly = params.view === "buy-list";
  const visibleRows = buyListOnly ? buyListRows : rows;
  const estimatedBuyListTotal = buyListRows.reduce((sum, row) => sum + (row.estimatedBuyCost ?? 0), 0);
  const missingBuyListCostCount = buyListRows.filter((row) => row.estimatedBuyCost === null).length;
  const remainingBudget = Math.max(0, totalPlannedBudget - totalPurchasedSpend);''',
    "buy list totals",
)

text = replace_once(
    text,
    '''        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/products-dashboard">Product Dashboard</SecondaryButton><SecondaryButton href="/purchases?module=finance">Purchases</SecondaryButton><PrimaryButton href="/purchases/new">New purchase</PrimaryButton></div>}''',
    '''        action={<div className="flex flex-wrap gap-2"><SecondaryButton href={`/product-planning?month=${monthInputValue(planningMonth)}&view=buy-list`}>Buy list ({buyListRows.length})</SecondaryButton><SecondaryButton href="/purchases?module=finance">Purchases</SecondaryButton><PrimaryButton href="/purchases/new">New purchase</PrimaryButton></div>}''',
    "page buy list action",
)

text = replace_once(
    text,
    'Monthly product plan saved.',
    'Buy list and monthly product plan saved.',
    "saved message",
)

render_start = text.index('      {!rows.length ? <EmptyState title="No products to plan"')
render_end = text.index('\n    </>\n  );\n}', render_start)
new_render = '''      <section className="surface-card mb-5">
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
      )}'''
text = text[:render_start] + new_render + text[render_end:]
write(page_path, text)

component_path = "src/app/product-planning/BuyListLiveSummary.tsx"
write(component_path, '''"use client";

import { useEffect, useState } from "react";

function money(value: number) {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} LYD`;
}

export function BuyListLiveSummary({
  formId,
  initialCount,
  initialTotal,
  initialMissingCostCount,
}: {
  formId: string;
  initialCount: number;
  initialTotal: number;
  initialMissingCostCount: number;
}) {
  const [summary, setSummary] = useState({ count: initialCount, total: initialTotal, missing: initialMissingCostCount });

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;

    const update = () => {
      const quantityInputs = new Map(
        Array.from(form.querySelectorAll<HTMLInputElement>("[data-buy-quantity]")).map((input) => [String(input.dataset.buyQuantity ?? ""), input]),
      );
      const lineTotals = new Map(
        Array.from(form.querySelectorAll<HTMLElement>("[data-buy-line-total]")).map((node) => [String(node.dataset.buyLineTotal ?? ""), node]),
      );
      let count = 0;
      let total = 0;
      let missing = 0;

      for (const checkbox of Array.from(form.querySelectorAll<HTMLInputElement>('[data-buy-list-checkbox="true"]'))) {
        const productId = String(checkbox.dataset.productId ?? "");
        const input = quantityInputs.get(productId);
        const output = lineTotals.get(productId);
        const quantity = Math.max(0, Math.floor(Number(input?.value ?? 0) || 0));
        const unitCost = Number(input?.dataset.unitCost ?? Number.NaN);

        if (!checkbox.checked || quantity <= 0) {
          if (output) output.textContent = checkbox.checked ? "0.00 LYD" : "Not in list";
          continue;
        }

        count += 1;
        if (Number.isFinite(unitCost) && unitCost > 0) {
          const lineTotal = Math.round(quantity * unitCost * 100) / 100;
          total += lineTotal;
          if (output) output.textContent = money(lineTotal);
        } else {
          missing += 1;
          if (output) output.textContent = "Cost missing";
        }
      }

      setSummary({ count, total: Math.round(total * 100) / 100, missing });
    };

    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, [formId]);

  return (
    <div className="mb-4 grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:grid-cols-3" aria-live="polite">
      <div><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Selected products</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{summary.count}</div></div>
      <div><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Live estimated total</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{money(summary.total)}</div></div>
      <div><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Missing last costs</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{summary.missing}</div></div>
    </div>
  );
}
''')

test_path = "scripts/test-product-planning-packaging.mjs"
test_text = read(test_path)
test_text = replace_once(
    test_text,
    'const planningPage = read("src/app/product-planning/page.tsx");',
    'const planningPage = read("src/app/product-planning/page.tsx");\nconst buyListSummary = read("src/app/product-planning/BuyListLiveSummary.tsx");',
    "buy list test source",
)
old_test_start = test_text.index('test("Product Planning page loads and explains current-month VMS demand"')
old_test_end = test_text.index('\n\ntest("inventory and route pickup use case_quantity packaging displays"', old_test_start)
new_test = '''test("Product Planning page exposes a persistent buy list ordered by monthly sales", () => {
  for (const label of [
    "Product Planning",
    "Current-month demand signal",
    "Sold this month",
    "Storage left",
    "Recommended buy",
    "Buy list quantity",
    "Last purchase cost",
    "Estimated cost",
    "Add to buy list",
    "Save & open buy list",
    "Estimated list cost",
  ]) {
    assert.match(planningPage, new RegExp(label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));
  }
  assert.match(planningPage, /right\.recommendation\.currentMonthUnits - left\.recommendation\.currentMonthUnits/);
  assert.match(planningPage, /params\.view === "buy-list"/);
  assert.match(planningPage, /plan_status: selectedForBuyList \?/);
  assert.match(planningPage, /planned_units: purchasedUnits \+ \(selectedForBuyList \? buyQuantity : 0\)/);
  assert.match(planningPage, /last_purchase_cost_lyd, average_cost_lyd, last_purchase_date/);
  assert.match(planningPage, /\[&_\.data-table_th\]:sticky/);
  assert.match(planningPage, /BuyListLiveSummary/);
  assert.match(buyListSummary, /Live estimated total/);
  assert.match(buyListSummary, /data-buy-list-checkbox/);
  assert.match(buyListSummary, /quantity \* unitCost/);
  assert.match(planningPage, /\.lte\("business_month", planningMonth\)/);
  assert.match(planningPage, /\.lte\("sales_month", planningMonth\)/);
  assert.match(planningHelper, /New product — keep testing/);
  assert.match(moduleTabs, /label:\s*"Product Planning",\s*href:\s*"\\/product-planning"/);
  assert.match(authz, /matchesPrefix\(pathname, \["\\/product-planning"\]\)/);
});'''
test_text = test_text[:old_test_start] + new_test + test_text[old_test_end:]
write(test_path, test_text)
