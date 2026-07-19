from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return updated


page_path = "src/app/finance/growth-decisions/page.tsx"
page = read(page_path)

page = replace_once(
    page,
    """const DEFAULT_SETTINGS: SettingsRow = {
  machine_cost_lyd: 22000,
  minimum_cash_reserve_lyd: 15000,
  restock_reserve_lyd: 10000,
  minimum_monthly_operating_profit_lyd: 6000,
  target_payback_months: 18,
  minimum_history_months: 3,
};
""",
    """const DEFAULT_SETTINGS: SettingsRow = {
  machine_cost_lyd: 22000,
  minimum_cash_reserve_lyd: 15000,
  restock_reserve_lyd: 10000,
  minimum_monthly_operating_profit_lyd: 6000,
  target_payback_months: 18,
  minimum_history_months: 3,
};

const MIN_DECISION_COST_COVERAGE_PERCENT = 99;
""",
    "coverage tolerance constant",
)

page = replace_once(
    page,
    """function normalizeMachineName(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}
""",
    """function normalizeMachineName(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

function conservativeVmsProfit(row: VmsProfitBreakdownRow | null | undefined) {
  const revenue = numeric(row?.revenue_amount);
  const reportedGrossProfit = numeric(row?.gross_profit_amount);
  const missingCostRevenue = numeric(row?.missing_cost_revenue_amount);
  const grossProfit = money(Math.max(0, reportedGrossProfit - missingCostRevenue));
  return {
    revenue,
    cogs: money(Math.max(0, revenue - grossProfit)),
    grossProfit,
  };
}

function displayProductLabel(row: VmsProfitBreakdownRow, ar: boolean) {
  const value = String(row.bucket_label ?? row.bucket_key ?? "").trim();
  if (!value || value === "未设置") return ar ? "منتج غير مربوط" : "Unmapped product";
  return value;
}
""",
    "conservative profit helpers",
)

page = regex_once(
    page,
    r"function vmsAggregateAsSalesRow\(\n  row: VmsProfitBreakdownRow \| null \| undefined,\n\): SalesRow\[\] \{.*?\n\}",
    """function vmsAggregateAsSalesRow(
  row: VmsProfitBreakdownRow | null | undefined,
): SalesRow[] {
  if (!row) return [];
  const conservative = conservativeVmsProfit(row);
  return [
    {
      net_sales_amount: conservative.revenue,
      cogs_amount: conservative.cogs,
      gross_profit_amount: conservative.grossProfit,
      cost_missing: false,
      source: "vms",
    },
  ];
}""",
    "conservative monthly sales row",
)

page = replace_once(
    page,
    """  const completeMonthly = monthsWithRevenue.filter((row) => row.complete);
  const vmsHistoryCostsComplete =
    monthsWithRevenue.length > 0 && monthsWithRevenue.every((row) => row.complete);
""",
    """  const completeMonthly = monthsWithRevenue.filter((row) => row.complete);
""",
    "remove strict history cost gate",
)

page = replace_once(
    page,
    """  const costCoveragePercent =
    totalVmsRevenueLyd > 0
      ? Math.max(0, Math.min(100, ((totalVmsRevenueLyd - missingCostRevenueLyd) / totalVmsRevenueLyd) * 100))
      : 0;
""",
    """  const costCoveragePercent =
    totalVmsRevenueLyd > 0
      ? Math.max(0, Math.min(100, ((totalVmsRevenueLyd - missingCostRevenueLyd) / totalVmsRevenueLyd) * 100))
      : 0;
  const minorCostGapAccepted =
    missingCostSalesCount > 0 &&
    costCoveragePercent >= MIN_DECISION_COST_COVERAGE_PERCENT;
  const decisionCostCoverageAccepted =
    missingCostSalesCount === 0 || minorCostGapAccepted;
""",
    "cost gap tolerance calculation",
)

page = replace_once(
    page,
    """  const vmsMachineCostsComplete = vmsProfitResult.machineData.every(
    (row) => numeric(row.missing_cost_sales_count) === 0,
  );
  const vmsCoverageComplete =
    vmsHistoryCostsComplete &&
    vmsMachineCostsComplete &&
    vmsProfitResult.source !== null;
""",
    """  const vmsCoverageComplete =
    monthsWithRevenue.length > 0 &&
    decisionCostCoverageAccepted &&
    vmsProfitResult.source !== null;
""",
    "tolerant VMS coverage gate",
)

page = replace_once(
    page,
    """    const vmsGrossProfit =
      vmsRow && numeric(vmsRow.missing_cost_sales_count) === 0
        ? numeric(vmsRow.gross_profit_amount)
        : 0;
""",
    """    const vmsGrossProfit = vmsRow
      ? conservativeVmsProfit(vmsRow).grossProfit
      : 0;
""",
    "conservative machine profit",
)

page = regex_once(
    page,
    r"        \{!vmsCoverageComplete && vmsProfitResult\.monthlyData\.length \? \(.*?        \) : null\}\n\n        \{!manualCoverageComplete \? \(",
    """        {missingCostSalesCount > 0 && vmsProfitResult.monthlyData.length ? (
          <div className={`rounded-xl border p-4 text-sm ${minorCostGapAccepted ? "border-sky-200 bg-sky-50 text-sky-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
            <div className="font-semibold">
              {minorCostGapAccepted
                ? ar
                  ? "تم تجاهل فجوة تكلفة بسيطة في قرار النمو"
                  : "Minor cost gap ignored for growth decision"
                : ar
                  ? "أكمل تكاليف المنتجات أولاً"
                  : "Complete product costs first"}
            </div>
            <p className="mt-1 leading-6">
              {minorCostGapAccepted
                ? ar
                  ? `تغطية التكلفة ${costCoveragePercent.toFixed(1)}%. سيستمر القرار، وتم احتساب المبيعات المتأثرة كربح صفري حتى لا يتم تضخيم الربح أو مدة الاسترداد.`
                  : `Cost coverage is ${costCoveragePercent.toFixed(1)}%. The decision continues, and affected sales are conservatively treated as zero profit so profit and payback are not overstated.`
                : ar
                  ? "فجوة التكلفة كبيرة بما يكفي للتأثير على الربح ومدة الاسترداد، لذلك يبقى قرار الشراء موقوفاً."
                  : "The cost gap is large enough to affect profit and payback, so the purchase recommendation remains on hold."}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg bg-white/80 p-3"><div className="text-xs text-slate-500">{ar ? "أشهر بها مبيعات" : "Months with sales"}</div><div className="mt-1 text-lg font-semibold">{monthsWithRevenue.length}</div></div>
              <div className="rounded-lg bg-white/80 p-3"><div className="text-xs text-slate-500">{ar ? "سجلات ناقصة التكلفة" : "Missing-cost records"}</div><div className="mt-1 text-lg font-semibold">{missingCostSalesCount}</div></div>
              <div className="rounded-lg bg-white/80 p-3"><div className="text-xs text-slate-500">{ar ? "إيراد محسوب بربح صفري" : "Revenue treated as zero profit"}</div><div className="mt-1 text-lg font-semibold">{formatFinanceMoney(missingCostRevenueLyd)}</div></div>
              <div className="rounded-lg bg-white/80 p-3"><div className="text-xs text-slate-500">{ar ? "تغطية التكلفة" : "Cost coverage"}</div><div className="mt-1 text-lg font-semibold">{costCoveragePercent.toFixed(1)}%</div></div>
            </div>
            {missingCostProducts.length ? (
              <div className="mt-4">
                <div className={`text-xs font-semibold uppercase tracking-wide ${minorCostGapAccepted ? "text-sky-800" : "text-amber-800"}`}>{ar ? "أعلى المنتجات الناقصة تكلفة" : "Top products missing cost"}</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {missingCostProducts.map((row) => (
                    <div key={String(row.bucket_key ?? row.bucket_label)} className={`flex items-center justify-between gap-3 rounded-lg border bg-white/80 px-3 py-2 ${minorCostGapAccepted ? "border-sky-200" : "border-amber-200"}`}>
                      <span className="min-w-0 truncate font-medium">{displayProductLabel(row, ar)}</span>
                      <span className="shrink-0 text-xs">{formatFinanceMoney(numeric(row.missing_cost_revenue_amount))}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <Link href="/products" className={`mt-4 inline-flex font-semibold underline underline-offset-4 ${minorCostGapAccepted ? "text-sky-900" : "text-amber-900"}`}>{ar ? "مراجعة تكاليف المنتجات" : "Review product costs"}</Link>
          </div>
        ) : null}

        {!manualCoverageComplete ? (""",
    "cost coverage banner",
)

write(page_path, page)


test_path = "scripts/test-growth-investor-portal.mjs"
test = read(test_path)
test = replace_once(
    test,
    """  assert.match(growth, /Unavailable until costs are complete/);
""",
    """  assert.match(growth, /Unavailable until costs are complete/);
  assert.match(growth, /MIN_DECISION_COST_COVERAGE_PERCENT = 99/);
  assert.match(growth, /costCoveragePercent >= MIN_DECISION_COST_COVERAGE_PERCENT/);
  assert.match(growth, /Minor cost gap ignored for growth decision/);
  assert.match(growth, /reportedGrossProfit - missingCostRevenue/);
  assert.match(growth, /Revenue treated as zero profit/);
""",
    "growth tolerance regression assertions",
)
write(test_path, test)
