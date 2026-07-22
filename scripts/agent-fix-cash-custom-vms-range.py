from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


page_path = "src/app/reports/cash-reconciliation/page.tsx"
page = read(page_path)

helper_anchor = '''function firstRpcRow(data: unknown): SalesSummaryRow {
  if (Array.isArray(data)) return (data[0] ?? {}) as SalesSummaryRow;
  return (data ?? {}) as SalesSummaryRow;
}
'''
helper_insert = '''function firstRpcRow(data: unknown): SalesSummaryRow {
  if (Array.isArray(data)) return (data[0] ?? {}) as SalesSummaryRow;
  return (data ?? {}) as SalesSummaryRow;
}

function salesSummaryHasActivity(row: SalesSummaryRow) {
  return numeric(row.revenue_amount) > 0
    || numeric(row.successful_sales_count) > 0
    || numeric(row.units_sold) > 0;
}

function calendarMonthRanges(range: SalesDateRange) {
  const [startYear, startMonth] = range.start.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = range.end.slice(0, 7).split("-").map(Number);
  const cursor = new Date(startYear, startMonth - 1, 1);
  const last = new Date(endYear, endMonth - 1, 1);
  const ranges: { start: string; end: string }[] = [];

  while (cursor.getTime() <= last.getTime()) {
    ranges.push({
      start: formatLocalDate(startOfMonth(cursor)),
      end: formatLocalDate(endOfMonth(cursor)),
    });
    cursor.setMonth(cursor.getMonth() + 1, 1);
  }

  return ranges;
}

function mergeSalesSummaryRows(rows: SalesSummaryRow[]): SalesSummaryRow {
  return rows.reduce<SalesSummaryRow>((total, row) => ({
    revenue_amount: roundMoney(numeric(total.revenue_amount) + numeric(row.revenue_amount)),
    successful_sales_count: Math.max(0, Math.floor(numeric(total.successful_sales_count) + numeric(row.successful_sales_count))),
    units_sold: Math.max(0, Math.floor(numeric(total.units_sold) + numeric(row.units_sold))),
    cash_sales_amount: roundMoney(numeric(total.cash_sales_amount) + numeric(row.cash_sales_amount)),
    card_sales_amount: roundMoney(numeric(total.card_sales_amount) + numeric(row.card_sales_amount)),
    unknown_payment_sales_amount: roundMoney(numeric(total.unknown_payment_sales_amount) + numeric(row.unknown_payment_sales_amount)),
    payment_method_available: Boolean(total.payment_method_available || row.payment_method_available),
  }), {});
}

function mergeVmsBreakdownRows(rows: VmsMachineSalesRow[]) {
  const merged = new Map<string, any>();
  for (const row of rows) {
    const key = String(row.bucket_key ?? row.bucket_label ?? "unknown");
    const current = merged.get(key) ?? { ...row };
    current.successful_sales_amount = roundMoney(numeric(current.successful_sales_amount) + (merged.has(key) ? numeric(row.successful_sales_amount) : 0));
    current.successful_sales_count = Math.max(0, Math.floor(numeric(current.successful_sales_count) + (merged.has(key) ? numeric(row.successful_sales_count) : 0)));
    current.units_sold = Math.max(0, Math.floor(numeric(current.units_sold) + (merged.has(key) ? numeric(row.units_sold) : 0)));
    current.rows_used = Math.max(0, Math.floor(numeric(current.rows_used) + (merged.has(key) ? numeric(row.rows_used) : 0)));
    merged.set(key, current);
  }
  return Array.from(merged.values());
}

async function loadMonthlyVmsRangeByMonth(supabase: any, range: SalesDateRange) {
  const monthRanges = calendarMonthRanges(range);
  const results = await Promise.all(monthRanges.map(async (monthRange) => {
    const [summary, month, machine] = await Promise.all([
      supabase.rpc("sales_dashboard_monthly_summary", { p_date_from: monthRange.start, p_date_to: monthRange.end }),
      supabase.rpc("sales_dashboard_monthly_breakdown", { p_dimension: "month", p_date_from: monthRange.start, p_date_to: monthRange.end }),
      supabase.rpc("sales_dashboard_monthly_breakdown", { p_dimension: "machine", p_date_from: monthRange.start, p_date_to: monthRange.end }),
    ]);
    return { summary, month, machine };
  }));
  const error = results.flatMap((result) => [result.summary.error, result.month.error, result.machine.error]).find(Boolean) ?? null;
  if (error) {
    return {
      summaryResult: { data: [], error },
      monthResult: { data: [], error },
      machineResult: { data: [], error },
    };
  }
  return {
    summaryResult: { data: [mergeSalesSummaryRows(results.map((result) => firstRpcRow(result.summary.data)))], error: null },
    monthResult: { data: mergeVmsBreakdownRows(results.flatMap((result) => result.month.data ?? [])), error: null },
    machineResult: { data: mergeVmsBreakdownRows(results.flatMap((result) => result.machine.data ?? [])), error: null },
  };
}
'''
page = replace_once(page, helper_anchor, helper_insert, "insert monthly custom-range helpers")

old_block = '''  const selectedSalesRange = salesRangeForCash(selectedRange);
  const selectedSourceReportType = monthlyProfitTableAvailable
    ? resolveSalesDashboardSourceReportType(batches, selectedSalesRange)
    : resolveDetailedSalesDashboardSourceReportType(batches, selectedSalesRange);
  const selectedSourceMode: SalesDashboardSourceMode = selectedSourceReportType === "monthly_product_profit" ? "monthly" : "detailed";
  const selectedSummaryRpc = selectedSourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";
  const selectedBreakdownRpc = selectedSourceMode === "monthly" ? "sales_dashboard_monthly_breakdown" : "sales_dashboard_breakdown";

  const comparisonSalesRange = comparisonRange ? salesRangeForCash(comparisonRange) : null;
  const comparisonSourceReportType = comparisonSalesRange
    ? monthlyProfitTableAvailable
      ? resolveSalesDashboardSourceReportType(batches, comparisonSalesRange)
      : resolveDetailedSalesDashboardSourceReportType(batches, comparisonSalesRange)
    : null;
  const comparisonSourceMode: SalesDashboardSourceMode | null = comparisonSourceReportType === "monthly_product_profit" ? "monthly" : comparisonSourceReportType ? "detailed" : null;
  const comparisonSummaryRpc = comparisonSourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";

  const [selectedVmsSummaryResult, selectedVmsDayResult, selectedVmsMonthResult, selectedVmsMachineResult, comparisonVmsSummaryResult] = await Promise.all([
    supabase.rpc(selectedSummaryRpc, { p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    selectedSourceMode === "monthly"
      ? Promise.resolve({ data: [], error: null })
      : supabase.rpc(selectedBreakdownRpc, { p_dimension: "day", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    supabase.rpc(selectedBreakdownRpc, { p_dimension: "month", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    supabase.rpc(selectedBreakdownRpc, { p_dimension: "machine", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    comparisonSalesRange
      ? supabase.rpc(comparisonSummaryRpc, { p_date_from: comparisonSalesRange.start, p_date_to: comparisonSalesRange.end })
      : Promise.resolve({ data: [], error: null }),
  ]);
'''
new_block = '''  const selectedSalesRange = salesRangeForCash(selectedRange);
  let selectedSourceReportType = monthlyProfitTableAvailable
    ? resolveSalesDashboardSourceReportType(batches, selectedSalesRange)
    : resolveDetailedSalesDashboardSourceReportType(batches, selectedSalesRange);
  let selectedSourceMode: SalesDashboardSourceMode = selectedSourceReportType === "monthly_product_profit" ? "monthly" : "detailed";
  const selectedSummaryRpc = selectedSourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";
  const selectedBreakdownRpc = selectedSourceMode === "monthly" ? "sales_dashboard_monthly_breakdown" : "sales_dashboard_breakdown";

  const comparisonSalesRange = comparisonRange ? salesRangeForCash(comparisonRange) : null;
  const comparisonSourceReportType = comparisonSalesRange
    ? monthlyProfitTableAvailable
      ? resolveSalesDashboardSourceReportType(batches, comparisonSalesRange)
      : resolveDetailedSalesDashboardSourceReportType(batches, comparisonSalesRange)
    : null;
  const comparisonSourceMode: SalesDashboardSourceMode | null = comparisonSourceReportType === "monthly_product_profit" ? "monthly" : comparisonSourceReportType ? "detailed" : null;
  const comparisonSummaryRpc = comparisonSourceMode === "monthly" ? "sales_dashboard_monthly_summary" : "sales_dashboard_summary";

  let [selectedVmsSummaryResult, selectedVmsDayResult, selectedVmsMonthResult, selectedVmsMachineResult, comparisonVmsSummaryResult] = await Promise.all([
    supabase.rpc(selectedSummaryRpc, { p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    selectedSourceMode === "monthly"
      ? Promise.resolve({ data: [], error: null })
      : supabase.rpc(selectedBreakdownRpc, { p_dimension: "day", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    supabase.rpc(selectedBreakdownRpc, { p_dimension: "month", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    supabase.rpc(selectedBreakdownRpc, { p_dimension: "machine", p_date_from: selectedSalesRange.start, p_date_to: selectedSalesRange.end }),
    comparisonSalesRange
      ? supabase.rpc(comparisonSummaryRpc, { p_date_from: comparisonSalesRange.start, p_date_to: comparisonSalesRange.end })
      : Promise.resolve({ data: [], error: null }),
  ]);

  let selectedMonthlyCalendarFallbackUsed = false;
  let selectedMonthlyFallbackError: unknown = null;
  if (
    selectedRange.key === "custom"
    && monthlyProfitTableAvailable
    && (selectedVmsSummaryResult.error || !salesSummaryHasActivity(firstRpcRow(selectedVmsSummaryResult.data)))
  ) {
    const monthlyFallback = await loadMonthlyVmsRangeByMonth(supabase, selectedSalesRange);
    selectedMonthlyFallbackError = monthlyFallback.summaryResult.error;
    if (!monthlyFallback.summaryResult.error && salesSummaryHasActivity(firstRpcRow(monthlyFallback.summaryResult.data))) {
      selectedVmsSummaryResult = monthlyFallback.summaryResult;
      selectedVmsDayResult = { data: [], error: null };
      selectedVmsMonthResult = monthlyFallback.monthResult;
      selectedVmsMachineResult = monthlyFallback.machineResult;
      selectedSourceReportType = "monthly_product_profit";
      selectedSourceMode = "monthly";
      selectedMonthlyCalendarFallbackUsed = true;
    }
  }

  let comparisonMonthlyFallbackError: unknown = null;
  if (
    comparisonSalesRange
    && comparisonRange?.key === "custom"
    && monthlyProfitTableAvailable
    && (comparisonVmsSummaryResult.error || !salesSummaryHasActivity(firstRpcRow(comparisonVmsSummaryResult.data)))
  ) {
    const comparisonMonthlyFallback = await loadMonthlyVmsRangeByMonth(supabase, comparisonSalesRange);
    comparisonMonthlyFallbackError = comparisonMonthlyFallback.summaryResult.error;
    if (!comparisonMonthlyFallback.summaryResult.error && salesSummaryHasActivity(firstRpcRow(comparisonMonthlyFallback.summaryResult.data))) {
      comparisonVmsSummaryResult = comparisonMonthlyFallback.summaryResult;
    }
  }
'''
page = replace_once(page, old_block, new_block, "replace VMS source loading")

page = replace_once(
    page,
    '''    selectedVmsMachineResult.error,
  ].filter(Boolean);''',
    '''    selectedVmsMachineResult.error,
    selectedMonthlyFallbackError,
    comparisonMonthlyFallbackError,
  ].filter(Boolean);''',
    "include monthly fallback warnings",
)

page = replace_once(
    page,
    '''<section className="surface-card sm:col-span-2"><div className="text-sm text-slate-500">VMS source</div><div className="mt-2 text-xl font-semibold text-slate-950">{selectedSourceReportType.replaceAll("_", " ")}</div><div className="mt-1 text-xs text-slate-500">Selected dates are passed to the same finalized VMS sales source used by the Sales Dashboard.</div></section>''',
    '''<section className="surface-card sm:col-span-2"><div className="text-sm text-slate-500">VMS source</div><div className="mt-2 text-xl font-semibold text-slate-950">{selectedSourceReportType.replaceAll("_", " ")}{selectedMonthlyCalendarFallbackUsed ? " · combined by calendar month" : ""}</div><div className="mt-1 text-xs text-slate-500">{selectedMonthlyCalendarFallbackUsed ? "The exact custom-range source returned no VMS activity, so Snacky OS combined the same finalized monthly VMS records that appear when each month is selected separately." : "Selected dates are passed to the same finalized VMS sales source used by the Sales Dashboard."}</div></section>''',
    "explain custom monthly fallback",
)

write(page_path, page)


test_path = "scripts/test-cash-reconciliation-selected-range.mjs"
test_text = read(test_path)
addition = '''

test("custom ranges recover VMS totals by combining working month selections", () => {
  assert.match(page, /loadMonthlyVmsRangeByMonth/);
  assert.match(page, /selectedRange\.key === "custom"/);
  assert.match(page, /calendarMonthRanges/);
  assert.match(page, /sales_dashboard_monthly_summary/);
  assert.match(page, /combined by calendar month/);
  assert.match(page, /same finalized monthly VMS records that appear when each month is selected separately/);
});
'''
if 'test("custom ranges recover VMS totals by combining working month selections"' not in test_text:
    test_text += addition
write(test_path, test_text)
