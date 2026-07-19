from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return updated


# 1) Decision engine: distinguish missing costs from missing history and suppress unreliable payback.
path = "src/lib/growth-decision.ts"
text = read(path)
text = replace_once(
    text,
    """  historyMonthCount: number;\n  minimumHistoryMonths: number;\n};""",
    """  historyMonthCount: number;\n  minimumHistoryMonths: number;\n  monthsWithRevenue: number;\n  costCoverageComplete: boolean;\n  missingCostSalesCount: number;\n  missingCostRevenueLyd: number;\n};""",
    "growth input coverage fields",
)
text = replace_once(
    text,
    """  | \"improve_profit_first\"\n  | \"collect_more_history\"""",
    """  | \"improve_profit_first\"\n  | \"complete_product_costs\"\n  | \"collect_more_history\"""",
    "growth decision cost code",
)
text = regex_once(
    text,
    r"function scoreInput\(input: GrowthDecisionInput, projectedPaybackMonths: number \| null, cashAfterMachinePurchaseLyd: number\) \{.*?\n\}",
    """function scoreInput(input: GrowthDecisionInput, projectedPaybackMonths: number | null, cashAfterMachinePurchaseLyd: number) {\n  let score = 100;\n  if (!input.costCoverageComplete) score -= 30;\n  if (input.costCoverageComplete && input.historyMonthCount < input.minimumHistoryMonths) score -= 25;\n  if (input.acceptedLocationCount <= 0) score -= 25;\n  if (input.criticalRestockCount > 0) score -= Math.min(20, 5 + input.criticalRestockCount * 2);\n  if (input.openCriticalIssueCount > 0) score -= Math.min(20, 8 + input.openCriticalIssueCount * 4);\n  if (input.costCoverageComplete) {\n    if (input.weakMachineCount > 0) score -= Math.min(15, input.weakMachineCount * 4);\n    if (input.averageMonthlyOperatingProfitLyd < input.minimumMonthlyOperatingProfitLyd) score -= 20;\n    if (projectedPaybackMonths === null) score -= 20;\n    else if (projectedPaybackMonths > input.targetPaybackMonths) score -= 25;\n  }\n  if (cashAfterMachinePurchaseLyd < input.minimumCashReserveLyd) score -= 30;\n  return Math.max(0, Math.min(100, Math.round(score)));\n}""",
    "growth score coverage logic",
)
text = replace_once(
    text,
    """  const projectedPaybackMonths = payback(input.machineCostLyd, input.averageMachineProfitAfterRentLyd);""",
    """  const projectedPaybackMonths = input.costCoverageComplete\n    ? payback(input.machineCostLyd, input.averageMachineProfitAfterRentLyd)\n    : null;""",
    "growth payback reliability",
)
text = replace_once(
    text,
    """    {\n      key: \"cash_reserve\",""",
    """    {\n      key: \"product_costs\",\n      label: \"Revenue missing product cost\",\n      labelAr: \"إيراد بدون تكلفة منتج\",\n      amountLyd: nonNegative(input.missingCostRevenueLyd),\n      status: input.costCoverageComplete ? \"clear\" : \"required\",\n    },\n    {\n      key: \"cash_reserve\",""",
    "growth cost priority",
)
text = replace_once(
    text,
    """  if (projectedPaybackMonths !== null) {""",
    """  if (input.costCoverageComplete && projectedPaybackMonths !== null) {""",
    "growth common payback reason",
)
text = replace_once(
    text,
    """  if (input.historyMonthCount < input.minimumHistoryMonths) {""",
    """  if (!input.costCoverageComplete) {\n    return result(\n      \"complete_product_costs\",\n      \"Complete product costs first\",\n      \"أكمل تكاليف المنتجات أولاً\",\n      \"Sales history exists, but operating profit and payback are not reliable until every sold product has a valid cost.\",\n      \"سجل المبيعات موجود، لكن الربح التشغيلي ومدة الاسترداد غير موثوقين حتى تكون تكلفة كل منتج مباع مكتملة.\",\n      [\n        `${input.monthsWithRevenue} month(s) contain revenue; ${input.historyMonthCount} month(s) currently have complete product costs.`,\n        input.missingCostSalesCount > 0\n          ? `${input.missingCostSalesCount} sales record(s), representing ${money(input.missingCostRevenueLyd).toLocaleString(\"en-US\")} LYD of revenue, are missing cost coverage.`\n          : \"Machine-level product cost coverage is incomplete.\",\n      ],\n      [\n        `يوجد إيراد في ${input.monthsWithRevenue} شهر، بينما ${input.historyMonthCount} شهر فقط لديه تكاليف منتجات مكتملة.`,\n        input.missingCostSalesCount > 0\n          ? `يوجد ${input.missingCostSalesCount} سجل مبيعات بقيمة ${money(input.missingCostRevenueLyd).toLocaleString(\"en-US\")} د.ل بدون تغطية تكلفة مكتملة.`\n          : \"تغطية تكلفة المنتجات على مستوى الأجهزة غير مكتملة.\",\n      ],\n      \"high\",\n    );\n  }\n\n  if (input.historyMonthCount < input.minimumHistoryMonths) {""",
    "growth dedicated cost decision",
)
write(path, text)


# 2) Growth page: add product diagnostics, reliable-only KPIs/payback, and accurate history classification.
path = "src/app/finance/growth-decisions/page.tsx"
text = read(path)
text = replace_once(
    text,
    """type VmsProfitLoadResult = {\n  monthlyData: VmsProfitBreakdownRow[];\n  machineData: VmsProfitBreakdownRow[];""",
    """type VmsProfitLoadResult = {\n  monthlyData: VmsProfitBreakdownRow[];\n  machineData: VmsProfitBreakdownRow[];\n  productData: VmsProfitBreakdownRow[];""",
    "growth VMS product data type",
)
text = replace_once(
    text,
    """  const [monthlyHistory, monthlyMachines] = await Promise.all([\n    client.rpc(\"sales_dashboard_monthly_profit_breakdown\", {\n      p_dimension: \"month\",\n      p_date_from: historyStart,\n      p_date_to: historyEnd,\n    }),\n    client.rpc(\"sales_dashboard_monthly_profit_breakdown\", {\n      p_dimension: \"machine\",\n      p_date_from: latestStart,\n      p_date_to: latestEnd,\n    }),\n  ]);""",
    """  const [monthlyHistory, monthlyMachines, monthlyProducts] = await Promise.all([\n    client.rpc(\"sales_dashboard_monthly_profit_breakdown\", {\n      p_dimension: \"month\",\n      p_date_from: historyStart,\n      p_date_to: historyEnd,\n    }),\n    client.rpc(\"sales_dashboard_monthly_profit_breakdown\", {\n      p_dimension: \"machine\",\n      p_date_from: latestStart,\n      p_date_to: latestEnd,\n    }),\n    client.rpc(\"sales_dashboard_monthly_profit_breakdown\", {\n      p_dimension: \"product\",\n      p_date_from: historyStart,\n      p_date_to: historyEnd,\n    }),\n  ]);""",
    "growth monthly product RPC",
)
text = replace_once(
    text,
    """    !monthlyMachines.error &&\n    (monthlyHistory.data ?? []).length > 0""",
    """    !monthlyMachines.error &&\n    !monthlyProducts.error &&\n    (monthlyHistory.data ?? []).length > 0""",
    "growth monthly product success",
)
text = replace_once(
    text,
    """      machineData: (monthlyMachines.data ?? []) as VmsProfitBreakdownRow[],\n      error: null,""",
    """      machineData: (monthlyMachines.data ?? []) as VmsProfitBreakdownRow[],\n      productData: (monthlyProducts.data ?? []) as VmsProfitBreakdownRow[],\n      error: null,""",
    "growth monthly product return first",
)
text = replace_once(
    text,
    """  const [detailedHistory, detailedMachines] = await Promise.all([\n    client.rpc(\"sales_dashboard_profit_breakdown\", {\n      p_dimension: \"month\",\n      p_date_from: historyStart,\n      p_date_to: historyEnd,\n    }),\n    client.rpc(\"sales_dashboard_profit_breakdown\", {\n      p_dimension: \"machine\",\n      p_date_from: latestStart,\n      p_date_to: latestEnd,\n    }),\n  ]);""",
    """  const [detailedHistory, detailedMachines, detailedProducts] = await Promise.all([\n    client.rpc(\"sales_dashboard_profit_breakdown\", {\n      p_dimension: \"month\",\n      p_date_from: historyStart,\n      p_date_to: historyEnd,\n    }),\n    client.rpc(\"sales_dashboard_profit_breakdown\", {\n      p_dimension: \"machine\",\n      p_date_from: latestStart,\n      p_date_to: latestEnd,\n    }),\n    client.rpc(\"sales_dashboard_profit_breakdown\", {\n      p_dimension: \"product\",\n      p_date_from: historyStart,\n      p_date_to: historyEnd,\n    }),\n  ]);""",
    "growth detailed product RPC",
)
text = replace_once(
    text,
    """  if (!detailedHistory.error && !detailedMachines.error) {""",
    """  if (!detailedHistory.error && !detailedMachines.error && !detailedProducts.error) {""",
    "growth detailed product success",
)
text = replace_once(
    text,
    """      machineData: (detailedMachines.data ?? []) as VmsProfitBreakdownRow[],\n      error: null,""",
    """      machineData: (detailedMachines.data ?? []) as VmsProfitBreakdownRow[],\n      productData: (detailedProducts.data ?? []) as VmsProfitBreakdownRow[],\n      error: null,""",
    "growth detailed product return",
)
text = replace_once(
    text,
    """  if (!monthlyHistory.error && !monthlyMachines.error) {""",
    """  if (!monthlyHistory.error && !monthlyMachines.error && !monthlyProducts.error) {""",
    "growth monthly fallback product success",
)
# Second monthly return has the same two-line shape; replace its first remaining occurrence.
text = replace_once(
    text,
    """      machineData: (monthlyMachines.data ?? []) as VmsProfitBreakdownRow[],\n      error: null,""",
    """      machineData: (monthlyMachines.data ?? []) as VmsProfitBreakdownRow[],\n      productData: (monthlyProducts.data ?? []) as VmsProfitBreakdownRow[],\n      error: null,""",
    "growth monthly product return fallback",
)
text = replace_once(
    text,
    """    machineData: [],\n    error: new Error(""",
    """    machineData: [],\n    productData: [],\n    error: new Error(""",
    "growth empty product data",
)
text = replace_once(
    text,
    """  const completeMonthly = monthly.filter(\n    (row) => row.vmsDataPresent && row.complete && row.revenueLyd > 0,\n  );""",
    """  const monthsWithRevenue = monthly.filter(\n    (row) => row.vmsDataPresent && row.revenueLyd > 0,\n  );\n  const completeMonthly = monthsWithRevenue.filter((row) => row.complete);\n  const vmsHistoryCostsComplete =\n    monthsWithRevenue.length > 0 && monthsWithRevenue.every((row) => row.complete);\n  const missingCostSalesCount = vmsProfitResult.monthlyData.reduce(\n    (sum, row) => sum + numeric(row.missing_cost_sales_count),\n    0,\n  );\n  const missingCostRevenueLyd = money(\n    vmsProfitResult.monthlyData.reduce(\n      (sum, row) => sum + numeric(row.missing_cost_revenue_amount),\n      0,\n    ),\n  );\n  const totalVmsRevenueLyd = money(\n    vmsProfitResult.monthlyData.reduce(\n      (sum, row) => sum + numeric(row.revenue_amount),\n      0,\n    ),\n  );\n  const costCoveragePercent =\n    totalVmsRevenueLyd > 0\n      ? Math.max(0, Math.min(100, ((totalVmsRevenueLyd - missingCostRevenueLyd) / totalVmsRevenueLyd) * 100))\n      : 0;\n  const missingCostProducts = vmsProfitResult.productData\n    .filter((row) => numeric(row.missing_cost_sales_count) > 0)\n    .sort(\n      (left, right) =>\n        numeric(right.missing_cost_revenue_amount) - numeric(left.missing_cost_revenue_amount),\n    )\n    .slice(0, 8);""",
    "growth monthly cost diagnostics",
)
text = replace_once(
    text,
    """  const activeMachines = machines.filter(""",
    """  const vmsCoverageComplete =\n    vmsHistoryCostsComplete &&\n    vmsMachineCostsComplete &&\n    vmsProfitResult.source !== null;\n  const activeMachines = machines.filter(""",
    "growth move coverage before averages",
)
text = replace_once(
    text,
    """  const vmsCoverageComplete =\n    vmsMachineCostsComplete &&\n    completeMonthly.length > 0 &&\n    vmsProfitResult.source !== null;\n""",
    """  const reliableProfitCoverage = vmsCoverageComplete && manualCoverageComplete;\n  const reliableAverageMonthlyOperatingProfit = reliableProfitCoverage\n    ? averageMonthlyOperatingProfit\n    : null;\n  const reliableAverageMachineProfitAfterRent = reliableProfitCoverage\n    ? averageMachineProfitAfterRent\n    : null;\n""",
    "growth reliable averages",
)
text = replace_once(
    text,
    """    averageMonthlyOperatingProfitLyd: averageMonthlyOperatingProfit,\n    averageMachineProfitAfterRentLyd: averageMachineProfitAfterRent,""",
    """    averageMonthlyOperatingProfitLyd: reliableAverageMonthlyOperatingProfit ?? 0,\n    averageMachineProfitAfterRentLyd: reliableAverageMachineProfitAfterRent ?? 0,""",
    "growth reliable decision values",
)
text = replace_once(
    text,
    """    historyMonthCount:\n      manualCoverageComplete && vmsCoverageComplete\n        ? completeMonthly.length\n        : 0,\n    minimumHistoryMonths: configuredHistoryMonths,""",
    """    historyMonthCount: manualCoverageComplete ? completeMonthly.length : 0,\n    minimumHistoryMonths: configuredHistoryMonths,\n    monthsWithRevenue: monthsWithRevenue.length,\n    costCoverageComplete: vmsCoverageComplete,\n    missingCostSalesCount,\n    missingCostRevenueLyd,""",
    "growth decision coverage inputs",
)
text = regex_once(
    text,
    r"        \{!vmsCoverageComplete && vmsProfitResult\.monthlyData\.length \? \(.*?        \) : null\}\n\n        \{!manualCoverageComplete",
    """        {!vmsCoverageComplete && vmsProfitResult.monthlyData.length ? (\n          <div className=\"rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950\">\n            <div className=\"font-semibold\">\n              {ar ? \"أكمل تكاليف المنتجات أولاً\" : \"Complete product costs first\"}\n            </div>\n            <p className=\"mt-1 leading-6\">\n              {ar\n                ? \"يوجد سجل مبيعات فعلي، لكن الربح ومدة الاسترداد لن يعتمدا حتى تكتمل تكلفة المنتجات المباعة.\"\n                : \"Real sales history is available, but profit and payback will remain unavailable until sold-product costs are complete.\"}\n            </p>\n            <div className=\"mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4\">\n              <div className=\"rounded-lg bg-white/80 p-3\"><div className=\"text-xs text-slate-500\">{ar ? \"أشهر بها مبيعات\" : \"Months with sales\"}</div><div className=\"mt-1 text-lg font-semibold\">{monthsWithRevenue.length}</div></div>\n              <div className=\"rounded-lg bg-white/80 p-3\"><div className=\"text-xs text-slate-500\">{ar ? \"أشهر مكتملة التكلفة\" : \"Fully costed months\"}</div><div className=\"mt-1 text-lg font-semibold\">{completeMonthly.length}</div></div>\n              <div className=\"rounded-lg bg-white/80 p-3\"><div className=\"text-xs text-slate-500\">{ar ? \"إيراد متأثر\" : \"Revenue affected\"}</div><div className=\"mt-1 text-lg font-semibold\">{formatFinanceMoney(missingCostRevenueLyd)}</div></div>\n              <div className=\"rounded-lg bg-white/80 p-3\"><div className=\"text-xs text-slate-500\">{ar ? \"تغطية التكلفة\" : \"Cost coverage\"}</div><div className=\"mt-1 text-lg font-semibold\">{costCoveragePercent.toFixed(1)}%</div></div>\n            </div>\n            {missingCostProducts.length ? (\n              <div className=\"mt-4\">\n                <div className=\"text-xs font-semibold uppercase tracking-wide text-amber-800\">{ar ? \"أعلى المنتجات الناقصة تكلفة\" : \"Top products missing cost\"}</div>\n                <div className=\"mt-2 grid gap-2 sm:grid-cols-2\">\n                  {missingCostProducts.map((row) => (\n                    <div key={String(row.bucket_key ?? row.bucket_label)} className=\"flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white/80 px-3 py-2\">\n                      <span className=\"min-w-0 truncate font-medium\">{row.bucket_label ?? row.bucket_key ?? (ar ? \"منتج غير معروف\" : \"Unknown product\")}</span>\n                      <span className=\"shrink-0 text-xs\">{formatFinanceMoney(numeric(row.missing_cost_revenue_amount))}</span>\n                    </div>\n                  ))}\n                </div>\n              </div>\n            ) : null}\n            <Link href=\"/products\" className=\"mt-4 inline-flex font-semibold text-amber-900 underline underline-offset-4\">{ar ? \"مراجعة تكاليف المنتجات\" : \"Review product costs\"}</Link>\n          </div>\n        ) : null}\n\n        {!manualCoverageComplete""",
    "growth detailed cost warning",
)
text = replace_once(
    text,
    """                  {decision.projectedPaybackMonths === null\n                    ? \"-\"\n                    : `${decision.projectedPaybackMonths} ${ar ? \"شهر\" : \"months\"}`}""",
    """                  {decision.projectedPaybackMonths === null\n                    ? reliableProfitCoverage\n                      ? \"-\"\n                      : ar\n                        ? \"غير متاح حتى اكتمال التكلفة\"\n                        : \"Unavailable until costs are complete\"\n                    : `${decision.projectedPaybackMonths} ${ar ? \"شهر\" : \"months\"}`}""",
    "growth payback unavailable label",
)
text = replace_once(
    text,
    """               averageMonthlyOperatingProfit,""",
    """               reliableAverageMonthlyOperatingProfit,""",
    "growth reliable monthly KPI",
)
text = replace_once(
    text,
    """               averageMachineProfitAfterRent,""",
    """               reliableAverageMachineProfitAfterRent,""",
    "growth reliable machine KPI",
)
text = replace_once(
    text,
    """                {formatFinanceMoney(Number(value))}""",
    """                {value === null\n                  ? ar\n                    ? \"غير متاح\"\n                    : \"Unavailable\"\n                  : formatFinanceMoney(Number(value))}""",
    "growth nullable KPI rendering",
)
text = replace_once(
    text,
    """                : \"Revenue, gross profit, and operating profit for completed months.\"""",
    """                : reliableProfitCoverage\n                  ? \"Revenue, gross profit, and operating profit for completed months.\"\n                  : \"Revenue remains visible. Profit lines appear after product costs are complete.\"""",
    "growth chart subtitle coverage",
)
text = replace_once(
    text,
    """              series={[\n                {\n                  key: \"revenue\",\n                  label: ar ? \"الإيراد\" : \"Revenue\",\n                  values: monthly.map((row) => row.revenueLyd),\n                },\n                {\n                  key: \"gross\",\n                  label: ar ? \"إجمالي الربح\" : \"Gross profit\",\n                  values: monthly.map((row) => row.grossProfitLyd),\n                },\n                {\n                  key: \"operating\",\n                  label: ar ? \"الربح التشغيلي\" : \"Operating profit\",\n                  values: monthly.map((row) => row.operatingProfitLyd),\n                },\n              ]}""",
    """              series={[\n                {\n                  key: \"revenue\",\n                  label: ar ? \"الإيراد\" : \"Revenue\",\n                  values: monthly.map((row) => row.revenueLyd),\n                },\n                ...(reliableProfitCoverage\n                  ? [\n                      {\n                        key: \"gross\",\n                        label: ar ? \"إجمالي الربح\" : \"Gross profit\",\n                        values: monthly.map((row) => row.grossProfitLyd),\n                      },\n                      {\n                        key: \"operating\",\n                        label: ar ? \"الربح التشغيلي\" : \"Operating profit\",\n                        values: monthly.map((row) => row.operatingProfitLyd),\n                      },\n                    ]\n                  : []),\n              ]}""",
    "growth reliable chart series",
)
write(path, text)


# 3) Investor statement generation: use the same supported monthly/detailed summary RPC chain.
path = "src/lib/investor-actions.ts"
text = read(path)
text = replace_once(
    text,
    """import { calculateInvestorMonth, manualRouteSalesAsProfitRows, monthBounds } from \"@/lib/investor-profit\";""",
    """import { calculateInvestorMonth, manualRouteSalesAsProfitRows, monthBounds } from \"@/lib/investor-profit\";\nimport { getSupabaseAdminClient } from \"@/lib/supabase-server\";""",
    "investor admin import",
)
text = replace_once(
    text,
    """function investorsUrl(""",
    """type InvestorVmsSummaryRow = {\n  revenue_amount?: number | string | null;\n  cogs_amount?: number | string | null;\n  gross_profit_amount?: number | string | null;\n  missing_cost_sales_count?: number | string | null;\n};\n\nfunction summaryRevenue(row: InvestorVmsSummaryRow | null | undefined) {\n  const value = Number(row?.revenue_amount ?? 0);\n  return Number.isFinite(value) ? value : 0;\n}\n\nasync function loadInvestorVmsProfit(client: any, dateFrom: string, dateTo: string) {\n  const monthly = await client.rpc(\"sales_dashboard_monthly_summary\", {\n    p_date_from: dateFrom,\n    p_date_to: dateTo,\n  });\n  const monthlyRow = (monthly.data ?? [])[0] as InvestorVmsSummaryRow | undefined;\n  if (!monthly.error && summaryRevenue(monthlyRow) > 0) {\n    return { data: monthlyRow ? [{\n      net_sales_amount: monthlyRow.revenue_amount,\n      cogs_amount: monthlyRow.cogs_amount,\n      gross_profit_amount: monthlyRow.gross_profit_amount,\n      cost_missing: Number(monthlyRow.missing_cost_sales_count ?? 0) > 0,\n      source: \"vms\",\n    }] : [], error: null, source: \"monthly_product_profit\" };\n  }\n\n  const detailed = await client.rpc(\"sales_dashboard_summary\", {\n    p_date_from: dateFrom,\n    p_date_to: dateTo,\n  });\n  const detailedRow = (detailed.data ?? [])[0] as InvestorVmsSummaryRow | undefined;\n  if (!detailed.error && summaryRevenue(detailedRow) > 0) {\n    return { data: detailedRow ? [{\n      net_sales_amount: detailedRow.revenue_amount,\n      cogs_amount: detailedRow.cogs_amount,\n      gross_profit_amount: detailedRow.gross_profit_amount,\n      cost_missing: Number(detailedRow.missing_cost_sales_count ?? 0) > 0,\n      source: \"vms\",\n    }] : [], error: null, source: \"detailed_sales\" };\n  }\n  if (!monthly.error) {\n    return { data: monthlyRow ? [{\n      net_sales_amount: monthlyRow.revenue_amount,\n      cogs_amount: monthlyRow.cogs_amount,\n      gross_profit_amount: monthlyRow.gross_profit_amount,\n      cost_missing: Number(monthlyRow.missing_cost_sales_count ?? 0) > 0,\n      source: \"vms\",\n    }] : [], error: null, source: \"monthly_product_profit\" };\n  }\n  if (!detailed.error) {\n    return { data: detailedRow ? [{\n      net_sales_amount: detailedRow.revenue_amount,\n      cogs_amount: detailedRow.cogs_amount,\n      gross_profit_amount: detailedRow.gross_profit_amount,\n      cost_missing: Number(detailedRow.missing_cost_sales_count ?? 0) > 0,\n      source: \"vms\",\n    }] : [], error: null, source: \"detailed_sales\" };\n  }\n  return { data: [], error: new Error(`Monthly VMS RPC: ${monthly.error?.message ?? \"unknown error\"}; detailed VMS RPC: ${detailed.error?.message ?? \"unknown error\"}`), source: null };\n}\n\nfunction investorsUrl(""",
    "investor VMS RPC helper",
)
text = replace_once(
    text,
    """  const [salesResult, manualSalesResult, ledgerResult, priorStatementsResult] = await Promise.all([\n    supabase\n      .from(\"vms_sales_clean\")\n      .select(\"net_sales_amount, cogs_amount, gross_profit_amount, cost_missing\")\n      .gte(\"sale_date\", bounds.start)\n      .lte(\"sale_date\", bounds.end),\n    supabase\n      .from(\"route_manual_sales\")""",
    """  const operationalReadClient = getSupabaseAdminClient() ?? supabase;\n  const [salesResult, manualSalesResult, ledgerResult, priorStatementsResult] = await Promise.all([\n    loadInvestorVmsProfit(supabase, bounds.start, bounds.end),\n    operationalReadClient\n      .from(\"route_manual_sales\")""",
    "investor supported VMS source",
)
text = replace_once(
    text,
    """  if (salesResult.error) redirect(investorsUrl(agreementId, { type: \"error\", text: `VMS sales could not load: ${salesResult.error.message}` }));""",
    """  if (salesResult.error) redirect(investorsUrl(agreementId, { type: \"error\", text: `VMS sales could not load: ${salesResult.error instanceof Error ? salesResult.error.message : \"Unknown VMS RPC error\"}` }));""",
    "investor VMS error",
)
text = replace_once(
    text,
    """    ? await supabase.from(\"inventory_movements\")""",
    """    ? await operationalReadClient.from(\"inventory_movements\")""",
    "investor manual cost admin read",
)
text = replace_once(
    text,
    """     `VMS rows: ${salesResult.data?.length ?? 0}`,""",
    """     `VMS source: ${salesResult.source ?? \"unavailable\"}`,\n     `VMS rows: ${salesResult.data?.length ?? 0}`,""",
    "investor source note",
)
write(path, text)


# 4) Regression tests.
path = "scripts/test-growth-investor-portal.mjs"
text = read(path)
text = replace_once(
    text,
    """  historyMonthCount: 4,\n  minimumHistoryMonths: 3,""",
    """  historyMonthCount: 4,\n  minimumHistoryMonths: 3,\n  monthsWithRevenue: 4,\n  costCoverageComplete: true,\n  missingCostSalesCount: 0,\n  missingCostRevenueLyd: 0,""",
    "test ready coverage input",
)
insert_after = """test(\"investor due and reserves can block a machine purchase\", () => {\n  const result = buildGrowthDecision({\n    ...readyInput,\n    cashAvailableLyd: 42000,\n    investorDueLyd: 8000,\n  });\n  assert.equal(result.code, \"build_cash_reserve\");\n  assert.ok(result.reserveGapLyd > 0);\n});\n"""
new_test = insert_after + """\ntest(\"missing product costs produce a dedicated hold without a fake payback\", () => {\n  const result = buildGrowthDecision({\n    ...readyInput,\n    costCoverageComplete: false,\n    historyMonthCount: 0,\n    monthsWithRevenue: 4,\n    missingCostSalesCount: 6,\n    missingCostRevenueLyd: 850,\n  });\n  assert.equal(result.code, \"complete_product_costs\");\n  assert.equal(result.projectedPaybackMonths, null);\n  assert.match(result.title, /Complete product costs/);\n  assert.match(result.reasons.join(\" \"), /4 month/);\n  assert.doesNotMatch(result.reasons.join(\" \"), /Estimated payback/);\n});\n"""
text = replace_once(text, insert_after, new_test, "test cost decision")
text = replace_once(
    text,
    """  assert.match(growth, /Decision sales source:/);""",
    """  assert.match(growth, /Decision sales source:/);\n  assert.match(growth, /p_dimension: \"product\"/);\n  assert.match(growth, /missingCostProducts/);\n  assert.match(growth, /Complete product costs first/);\n  assert.match(growth, /Unavailable until costs are complete/);""",
    "test growth diagnostics",
)
text = replace_once(
    text,
    """  assert.match(actions, /manual sales revenue/);\n  assert.match(growth, /operationalReadClient/);""",
    """  assert.match(actions, /manual sales revenue/);\n  assert.match(actions, /sales_dashboard_monthly_summary/);\n  assert.match(actions, /sales_dashboard_summary/);\n  assert.doesNotMatch(actions, /from\\(\"vms_sales_clean\"\\)/);\n  assert.match(growth, /operationalReadClient/);""",
    "test investor supported RPCs",
)
write(path, text)

print("Prepared cost coverage and investor RPC fixes.")
