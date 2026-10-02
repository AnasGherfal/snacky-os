/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ChartCard,
  HorizontalBarChart,
  TrendChart,
} from "@/components/DecisionCharts";
import {
  EmptyState,
  ErrorState,
  FormField,
  FormSection,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import {
  getAuthenticatedSupabaseServerClient,
  getCurrentProfile,
} from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import {
  computeFinanceBalancesFromCutoff,
  formatFinanceMoney,
} from "@/lib/finance-balance";
import {
  applyVisibleFinanceLedgerFilter,
  FINANCE_TRANSACTIONS_TABLE,
  loadFinanceLedgerRows,
} from "@/lib/finance-ledger";
import { buildGrowthDecision } from "@/lib/growth-decision";
import {
  calculateInvestorMonth,
  manualRouteSalesAsProfitRows,
} from "@/lib/investor-profit";
import { saveGrowthDecisionSettings } from "@/lib/investor-actions";
import { getServerI18n } from "@/lib/i18n/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type SettingsRow = {
  machine_cost_lyd: number | string;
  minimum_cash_reserve_lyd: number | string;
  restock_reserve_lyd: number | string;
  minimum_monthly_operating_profit_lyd: number | string;
  target_payback_months: number | string;
  minimum_history_months: number | string;
};

type SalesRow = {
  net_sales_amount?: number | string | null;
  cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null;
  cost_missing?: boolean | null;
  source?: "vms" | "manual_route_sale" | string | null;
};

type VmsProfitBreakdownRow = {
  bucket_key?: string | null;
  bucket_label?: string | null;
  sort_key?: string | null;
  revenue_amount?: number | string | null;
  cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null;
  missing_cost_sales_count?: number | string | null;
  missing_cost_revenue_amount?: number | string | null;
  cost_status?: string | null;
};

type VmsProfitSource = "monthly_product_profit" | "detailed_sales";

type VmsProfitLoadResult = {
  monthlyData: VmsProfitBreakdownRow[];
  machineData: VmsProfitBreakdownRow[];
  productData: VmsProfitBreakdownRow[];
  error: unknown | null;
  source: VmsProfitSource | null;
};

type MachineRow = {
  id: string;
  name?: string | null;
  rent_amount?: number | string | null;
  status?: string | null;
};

const DEFAULT_SETTINGS: SettingsRow = {
  machine_cost_lyd: 22000,
  minimum_cash_reserve_lyd: 15000,
  restock_reserve_lyd: 10000,
  minimum_monthly_operating_profit_lyd: 6000,
  target_payback_months: 18,
  minimum_history_months: 3,
};

const MIN_DECISION_COST_COVERAGE_PERCENT = 99;

function numeric(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthStart(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function completeMonthStarts(count: number, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count + index, 1),
    );
    return monthStart(date);
  });
}

function endOfMonth(start: string) {
  const [year, month] = start.split("-").map(Number);
  return dateOnly(new Date(Date.UTC(year, month, 0)));
}

function monthLabel(start: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${start}T00:00:00Z`));
}

function setupError(error: unknown) {
  const row = error as { code?: string; message?: string } | null;
  const text = `${row?.code ?? ""} ${row?.message ?? ""}`.toLowerCase();
  return (
    text.includes("growth_decision_settings") ||
    text.includes("does not exist") ||
    text.includes("schema cache")
  );
}

function databaseErrorMessage(error: unknown) {
  if (!error || typeof error !== "object")
    return String(error ?? "Unknown database error");
  const row = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return (
    [row.code, row.message, row.details, row.hint]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" · ") || "Unknown database error"
  );
}


function normalizeMachineName(value: unknown) {
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

function vmsAggregateAsSalesRow(
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
}

async function loadVmsGrowthProfit({
  client,
  historyStart,
  historyEnd,
  latestStart,
  latestEnd,
}: {
  client: NonNullable<
    Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>
  >;
  historyStart: string;
  historyEnd: string;
  latestStart: string;
  latestEnd: string;
}): Promise<VmsProfitLoadResult> {
  const [monthlyHistory, monthlyMachines, monthlyProducts] = await Promise.all([
    client.rpc("sales_dashboard_monthly_profit_breakdown", {
      p_dimension: "month",
      p_date_from: historyStart,
      p_date_to: historyEnd,
    }),
    client.rpc("sales_dashboard_monthly_profit_breakdown", {
      p_dimension: "machine",
      p_date_from: latestStart,
      p_date_to: latestEnd,
    }),
    client.rpc("sales_dashboard_monthly_profit_breakdown", {
      p_dimension: "product",
      p_date_from: historyStart,
      p_date_to: historyEnd,
    }),
  ]);

  if (
    !monthlyHistory.error &&
    !monthlyMachines.error &&
    !monthlyProducts.error &&
    (monthlyHistory.data ?? []).length > 0
  ) {
    return {
      monthlyData: (monthlyHistory.data ?? []) as VmsProfitBreakdownRow[],
      machineData: (monthlyMachines.data ?? []) as VmsProfitBreakdownRow[],
      productData: (monthlyProducts.data ?? []) as VmsProfitBreakdownRow[],
      error: null,
      source: "monthly_product_profit",
    };
  }

  const [detailedHistory, detailedMachines, detailedProducts] = await Promise.all([
    client.rpc("sales_dashboard_profit_breakdown", {
      p_dimension: "month",
      p_date_from: historyStart,
      p_date_to: historyEnd,
    }),
    client.rpc("sales_dashboard_profit_breakdown", {
      p_dimension: "machine",
      p_date_from: latestStart,
      p_date_to: latestEnd,
    }),
    client.rpc("sales_dashboard_profit_breakdown", {
      p_dimension: "product",
      p_date_from: historyStart,
      p_date_to: historyEnd,
    }),
  ]);

  if (!detailedHistory.error && !detailedMachines.error && !detailedProducts.error) {
    return {
      monthlyData: (detailedHistory.data ?? []) as VmsProfitBreakdownRow[],
      machineData: (detailedMachines.data ?? []) as VmsProfitBreakdownRow[],
      productData: (detailedProducts.data ?? []) as VmsProfitBreakdownRow[],
      error: null,
      source: "detailed_sales",
    };
  }

  if (!monthlyHistory.error && !monthlyMachines.error && !monthlyProducts.error) {
    return {
      monthlyData: (monthlyHistory.data ?? []) as VmsProfitBreakdownRow[],
      machineData: (monthlyMachines.data ?? []) as VmsProfitBreakdownRow[],
      productData: (monthlyProducts.data ?? []) as VmsProfitBreakdownRow[],
      error: null,
      source: "monthly_product_profit",
    };
  }

  return {
    monthlyData: [],
    machineData: [],
    productData: [],
    error: new Error(
      `Monthly sales RPCs: ${databaseErrorMessage(monthlyHistory.error ?? monthlyMachines.error)} | Detailed sales RPCs: ${databaseErrorMessage(detailedHistory.error ?? detailedMachines.error)}`,
    ),
    source: null,
  };
}

export default async function GrowthDecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const params = await searchParams;

  if (!supabase)
    return (
      <ErrorState
        title={ar ? "قرارات النمو غير متاحة" : "Growth decisions unavailable"}
        body={ar ? "Supabase غير مهيأ." : "Supabase is not configured."}
      />
    );

  const settingsResult = await supabase
    .from("growth_decision_settings")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();
  if (settingsResult.error && setupError(settingsResult.error)) {
    return (
      <ErrorState
        title={
          ar
            ? "يلزم تثبيت وحدة قرارات النمو"
            : "Growth Decisions setup required"
        }
        body={
          ar
            ? "شغّل ملف الترحيل 202607180003_growth_decisions_investor_portal.sql ثم أعد تحميل الصفحة."
            : "Run migration 202607180003_growth_decisions_investor_portal.sql, then reload this page."
        }
      />
    );
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(settingsResult.data ?? {}),
  } as SettingsRow;
  const monthStarts = completeMonthStarts(6);
  const historyStart = monthStarts[0];
  const historyEnd = endOfMonth(monthStarts[monthStarts.length - 1]);
  const operationalReadClient = getSupabaseAdminClient() ?? supabase;

  const latestStart = monthStarts[monthStarts.length - 1];
  const latestEnd = endOfMonth(latestStart);

  const [
    ledgerResult,
    vmsProfitResult,
    manualSalesResult,
    machinesResult,
    acceptedLocationsResult,
    issuesResult,
    refillResult,
    statementsResult,
    paymentsResult,
  ] = await Promise.all([
    loadFinanceLedgerRows({
      label: "growth-decisions.finance-ledger",
      buildQuery: (columns, level) =>
        applyVisibleFinanceLedgerFilter(
          supabase.from(FINANCE_TRANSACTIONS_TABLE).select(columns.join(",")),
          level,
        ),
    }),
    loadVmsGrowthProfit({
      client: supabase,
      historyStart,
      historyEnd,
      latestStart,
      latestEnd,
    }),
    operationalReadClient
      .from("route_manual_sales")
      .select(
        "id, machine_id, total_amount_lyd, inventory_movement_id, sale_time, status",
      )
      .eq("status", "confirmed")
      .gte("sale_time", `${historyStart}T00:00:00.000Z`)
      .lte("sale_time", `${historyEnd}T23:59:59.999Z`),
    supabase.from("machines").select("id, name, rent_amount, status"),
    supabase
      .from("location_pipeline_leads")
      .select("id", { count: "exact", head: true })
      .eq("status", "accepted")
      .is("archived_at", null),
    supabase
      .from("issues")
      .select("id", { count: "exact", head: true })
      .eq("priority", "critical")
      .not("status", "in", "(resolved,closed)"),
    supabase
      .from("refill_recommendations")
      .select("priority, final_qty_to_take, suggested_qty"),
    supabase
      .from("investor_monthly_statements")
      .select("id, investor_share_due_lyd, calculation_status")
      .eq("calculation_status", "finalized"),
    supabase
      .from("investor_payments")
      .select("amount_lyd, finance_posting_status"),
  ]);

  if (ledgerResult.error) {
    return (
      <ErrorState
        title={
          ar ? "تعذر تحميل الرصيد المالي" : "Finance balance could not load"
        }
        body={
          ar
            ? "راجع صحة دفتر المالية قبل اتخاذ قرار توسع."
            : "Repair the Finance ledger before relying on an expansion decision."
        }
      />
    );
  }
  if (vmsProfitResult.error) {
    const vmsError = vmsProfitResult.error;
    return (
      <ErrorState
        title={ar ? "تعذر تحميل مبيعات VMS" : "VMS sales could not load"}
        body={`${ar ? "تعذر تحميل بيانات الربح من نفس مصادر لوحة المبيعات. راجع ترحيلات ووظائف Sales Dashboard قبل الاعتماد على قرار التوسع." : "Profit data could not load from the same RPC sources used by the Sales Dashboard. Repair the Sales Dashboard migrations or RPCs before relying on an expansion decision."} ${databaseErrorMessage(vmsError)}`}
      />
    );
  }

  const vmsMonthlyByKey = new Map(
    vmsProfitResult.monthlyData.map((row) => [
      String(row.bucket_key ?? row.sort_key ?? "").slice(0, 7),
      row,
    ]),
  );
  const manualSalesAvailable = !manualSalesResult.error;
  const manualSales = manualSalesAvailable
    ? ((manualSalesResult.data ?? []) as any[])
    : [];
  const manualMovementIds = Array.from(
    new Set(
      manualSales
        .map((sale) => String(sale.inventory_movement_id ?? "").trim())
        .filter(Boolean),
    ),
  );
  const manualMovementResult = manualMovementIds.length
    ? await operationalReadClient
        .from("inventory_movements")
        .select("id, line_total_lyd, unit_cost_lyd")
        .in("id", manualMovementIds)
    : { data: [], error: null };
  const manualCostsAvailable = !manualMovementResult.error;
  const manualCoverageComplete = manualSalesAvailable && manualCostsAvailable;
  const manualProfitRows = manualCostsAvailable
    ? manualRouteSalesAsProfitRows(manualSales, manualMovementResult.data ?? [])
    : [];
  const manualProfitBySaleId = new Map(
    manualSales.map((sale, index) => [
      String(sale.id),
      manualProfitRows[index],
    ]),
  );
  const machines = (machinesResult.data ?? []) as MachineRow[];
  const ledgerRows = ledgerResult.data;
  const monthly = monthStarts.map((start) => {
    const end = endOfMonth(start);
    const vmsRow = vmsMonthlyByKey.get(start.slice(0, 7));
    const monthManualSales = manualSales.filter((sale) => {
      const date = String(sale.sale_time ?? "").slice(0, 10);
      return date >= start && date <= end;
    });
    const monthManualProfitRows = monthManualSales.flatMap((sale) => {
      const row = manualProfitBySaleId.get(String(sale.id));
      return row ? [row] : [];
    });
    const monthLedger = ledgerRows.filter(
      (row) =>
        row.transaction_date &&
        row.transaction_date >= start &&
        row.transaction_date <= end,
    );
    return {
      start,
      end,
      vmsDataPresent: Boolean(vmsRow),
      ...calculateInvestorMonth({
        salesRows: [
          ...vmsAggregateAsSalesRow(vmsRow),
          ...monthManualProfitRows,
        ],
        ledgerRows: monthLedger,
        sharePercent: 0,
      }),
    };
  });
  const monthsWithRevenue = monthly.filter(
    (row) => row.vmsDataPresent && row.revenueLyd > 0,
  );
  const completeMonthly = monthsWithRevenue.filter((row) => row.complete);
  const missingCostSalesCount = vmsProfitResult.monthlyData.reduce(
    (sum, row) => sum + numeric(row.missing_cost_sales_count),
    0,
  );
  const missingCostRevenueLyd = money(
    vmsProfitResult.monthlyData.reduce(
      (sum, row) => sum + numeric(row.missing_cost_revenue_amount),
      0,
    ),
  );
  const totalVmsRevenueLyd = money(
    vmsProfitResult.monthlyData.reduce(
      (sum, row) => sum + numeric(row.revenue_amount),
      0,
    ),
  );
  const costCoveragePercent =
    totalVmsRevenueLyd > 0
      ? Math.max(0, Math.min(100, ((totalVmsRevenueLyd - missingCostRevenueLyd) / totalVmsRevenueLyd) * 100))
      : 0;
  const minorCostGapAccepted =
    missingCostSalesCount > 0 &&
    costCoveragePercent >= MIN_DECISION_COST_COVERAGE_PERCENT;
  const decisionCostCoverageAccepted =
    missingCostSalesCount === 0 || minorCostGapAccepted;
  const missingCostProducts = vmsProfitResult.productData
    .filter((row) => numeric(row.missing_cost_sales_count) > 0)
    .sort(
      (left, right) =>
        numeric(right.missing_cost_revenue_amount) - numeric(left.missing_cost_revenue_amount),
    )
    .slice(0, 8);
  const configuredHistoryMonths = Math.round(
    numeric(settings.minimum_history_months),
  );
  const decisionMonths = completeMonthly.slice(-configuredHistoryMonths);
  const averageMonthlyOperatingProfit = decisionMonths.length
    ? money(
        decisionMonths.reduce((sum, row) => sum + row.operatingProfitLyd, 0) /
          decisionMonths.length,
      )
    : 0;

  const latestManualSales = manualSales.filter((sale) => {
    const date = String(sale.sale_time ?? "").slice(0, 10);
    return date >= latestStart && date <= latestEnd;
  });
  const vmsMachineByName = new Map(
    vmsProfitResult.machineData.map((row) => [
      normalizeMachineName(row.bucket_key ?? row.bucket_label),
      row,
    ]),
  );
  const vmsCoverageComplete =
    monthsWithRevenue.length > 0 &&
    decisionCostCoverageAccepted &&
    vmsProfitResult.source !== null;
  const activeMachines = machines.filter(
    (machine) => String(machine.status ?? "active") === "active",
  );
  const machineProfitRows = activeMachines.map((machine) => {
    const vmsRow = vmsMachineByName.get(normalizeMachineName(machine.name));
    const vmsGrossProfit = vmsRow
      ? conservativeVmsProfit(vmsRow).grossProfit
      : 0;
    const manualGrossProfit = latestManualSales
      .filter((sale) => sale.machine_id === machine.id)
      .reduce((sum, sale) => {
        const profitRow = manualProfitBySaleId.get(String(sale.id));
        return (
          sum +
          (profitRow && !profitRow.cost_missing
            ? numeric(profitRow.gross_profit_amount)
            : 0)
        );
      }, 0);
    return {
      id: machine.id,
      name: machine.name ?? machine.id,
      profitAfterRent: money(
        vmsGrossProfit + manualGrossProfit - numeric(machine.rent_amount),
      ),
    };
  });
  const averageMachineProfitAfterRent = machineProfitRows.length
    ? money(
        machineProfitRows.reduce((sum, row) => sum + row.profitAfterRent, 0) /
          machineProfitRows.length,
      )
    : 0;
  const weakMachineCount = machineProfitRows.filter(
    (row) => row.profitAfterRent <= 0,
  ).length;
  const reliableProfitCoverage = vmsCoverageComplete && manualCoverageComplete;
  const reliableAverageMonthlyOperatingProfit = reliableProfitCoverage
    ? averageMonthlyOperatingProfit
    : null;
  const reliableAverageMachineProfitAfterRent = reliableProfitCoverage
    ? averageMachineProfitAfterRent
    : null;
  const financeBalances = computeFinanceBalancesFromCutoff({
    rows: ledgerRows,
  });
  const unpostedInvestorPayments = (paymentsResult.data ?? [])
    .filter((row) => row.finance_posting_status !== "posted")
    .reduce((sum, row) => sum + numeric(row.amount_lyd), 0);
  const cashAvailable = money(
    financeBalances.snacky_lyd - unpostedInvestorPayments,
  );
  const finalizedDue = (statementsResult.data ?? []).reduce(
    (sum, row) => sum + numeric(row.investor_share_due_lyd),
    0,
  );
  const totalInvestorPaid = (paymentsResult.data ?? []).reduce(
    (sum, row) => sum + numeric(row.amount_lyd),
    0,
  );
  const investorDue = Math.max(0, money(finalizedDue - totalInvestorPaid));
  const criticalRestockCount = (refillResult.data ?? []).filter(
    (row) =>
      String(row.priority ?? "").toLowerCase() === "critical" &&
      Math.max(numeric(row.final_qty_to_take), numeric(row.suggested_qty)) > 0,
  ).length;

  const decision = buildGrowthDecision({
    cashAvailableLyd: cashAvailable,
    machineCostLyd: numeric(settings.machine_cost_lyd),
    minimumCashReserveLyd: numeric(settings.minimum_cash_reserve_lyd),
    restockReserveLyd: numeric(settings.restock_reserve_lyd),
    investorDueLyd: investorDue,
    minimumMonthlyOperatingProfitLyd: numeric(
      settings.minimum_monthly_operating_profit_lyd,
    ),
    averageMonthlyOperatingProfitLyd: reliableAverageMonthlyOperatingProfit ?? 0,
    averageMachineProfitAfterRentLyd: reliableAverageMachineProfitAfterRent ?? 0,
    targetPaybackMonths: numeric(settings.target_payback_months),
    acceptedLocationCount: acceptedLocationsResult.count ?? 0,
    criticalRestockCount,
    openCriticalIssueCount: issuesResult.count ?? 0,
    weakMachineCount,
    historyMonthCount: manualCoverageComplete ? completeMonthly.length : 0,
    minimumHistoryMonths: configuredHistoryMonths,
    monthsWithRevenue: monthsWithRevenue.length,
    costCoverageComplete: vmsCoverageComplete,
    missingCostSalesCount,
    missingCostRevenueLyd,
  });

  const decisionTitle = ar ? decision.titleAr : decision.title;
  const decisionSummary = ar ? decision.summaryAr : decision.summary;
  const reasons = ar ? decision.reasonsAr : decision.reasons;
  const notice = params.error
    ? { tone: "error", text: params.error }
    : params.success
      ? { tone: "success", text: params.success }
      : null;
  const manualCoverageError =
    manualSalesResult.error ?? manualMovementResult.error ?? null;
  const vmsSourceLabel =
    vmsProfitResult.source === "monthly_product_profit"
      ? ar
        ? "تقرير الربح الشهري للمنتجات"
        : "Monthly Product Profit"
      : ar
        ? "تفاصيل مبيعات VMS"
        : "Detailed VMS sales";

  return (
    <>
      <PageHeader
        title={ar ? "قرارات النمو" : "Growth Decisions"}
        subtitle={
          ar
            ? "قرار مبني على النقد والربح والمخزون والأعطال والمواقع قبل شراء جهاز جديد."
            : "A data-driven recommendation using cash, profit, stock, issues, and location readiness before buying another machine."
        }
      />

      <div className="space-y-6">
        {notice ? (
          <div
            className={`rounded-xl border p-4 text-sm font-medium ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}
          >
            {notice.text}
          </div>
        ) : null}

        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          <span className="font-semibold text-slate-900">
            {ar ? "مصدر مبيعات القرار:" : "Decision sales source:"}
          </span>{" "}
          {vmsSourceLabel}
        </div>

        {missingCostSalesCount > 0 && vmsProfitResult.monthlyData.length ? (
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

        {!manualCoverageComplete ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <div className="font-semibold">
              {ar
                ? "تغطية المبيعات اليدوية غير مكتملة — قرار الشراء موقوف احتياطياً"
                : "Manual route sales coverage is incomplete — purchase recommendation is held"}
            </div>
            <p className="mt-1 leading-6">
              {ar
                ? "تم تحميل مبيعات VMS والمالية، لذلك ستظهر الرسوم والأرقام. لكن النظام لن يوصي بشراء جهاز حتى يتمكن من قراءة المبيعات اليدوية المؤكدة وتكلفتها."
                : "VMS and Finance data loaded, so the charts and figures remain available. Snacky OS will not recommend buying a machine until confirmed manual route sales and their product costs can be read."}
            </p>
            {manualCoverageError ? (
              <p className="mt-2 break-words font-mono text-xs text-amber-800">
                {databaseErrorMessage(manualCoverageError)}
              </p>
            ) : null}
          </div>
        ) : null}

        <section
          className={`rounded-3xl border p-6 ${decision.code === "buy_now" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}
        >
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  status={decision.code === "buy_now" ? "ready" : "hold"}
                />
                <span className="text-sm font-semibold text-slate-600">
                  {ar
                    ? `درجة الجاهزية ${decision.score}/100`
                    : `Readiness score ${decision.score}/100`}
                </span>
              </div>
              <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                {decisionTitle}
              </h2>
              <p className="mt-2 text-base leading-7 text-slate-700">
                {decisionSummary}
              </p>
              <ul className="mt-4 space-y-2 text-sm leading-6 text-slate-700">
                {reasons.map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            </div>
            <div className="grid min-w-[260px] gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
                <div className="text-xs text-slate-500">
                  {ar ? "مدة الاسترداد المتوقعة" : "Estimated payback"}
                </div>
                <div className="mt-1 text-xl font-semibold">
                  {decision.projectedPaybackMonths === null
                    ? reliableProfitCoverage
                      ? "-"
                      : ar
                        ? "غير متاح حتى اكتمال التكلفة"
                        : "Unavailable until costs are complete"
                    : `${decision.projectedPaybackMonths} ${ar ? "شهر" : "months"}`}
                </div>
              </div>
              <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
                <div className="text-xs text-slate-500">
                  {ar ? "النقد بعد شراء الجهاز" : "Cash after machine purchase"}
                </div>
                <div className="mt-1 text-xl font-semibold">
                  {formatFinanceMoney(decision.cashAfterMachinePurchaseLyd)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [ar ? "النقد المتاح" : "Available Snacky cash", cashAvailable],
            [
              ar ? "متوسط الربح التشغيلي" : "Average monthly operating profit",
              reliableAverageMonthlyOperatingProfit,
            ],
            [
              ar
                ? "متوسط ربح الجهاز بعد الإيجار"
                : "Average machine profit after rent",
              reliableAverageMachineProfitAfterRent,
            ],
            [
              ar ? "مستحق المستثمر غير المدفوع" : "Unpaid investor amount",
              investorDue,
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="surface-card">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {String(label)}
              </div>
              <div className="mt-2 text-2xl font-semibold text-slate-950">
                {value === null
                  ? ar
                    ? "غير متاح"
                    : "Unavailable"
                  : formatFinanceMoney(Number(value))}
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <ChartCard
            title={ar ? "اتجاه الأداء الشهري" : "Monthly performance trend"}
            subtitle={
              ar
                ? "الإيراد والربح الإجمالي والربح التشغيلي للأشهر المكتملة."
                : reliableProfitCoverage
                  ? "Revenue, gross profit, and operating profit for completed months."
                  : "Revenue remains visible. Profit lines appear after product costs are complete."
            }
          >
            <TrendChart
              labels={monthly.map((row) => monthLabel(row.start, locale))}
              series={[
                {
                  key: "revenue",
                  label: ar ? "الإيراد" : "Revenue",
                  values: monthly.map((row) => row.revenueLyd),
                },
                ...(reliableProfitCoverage
                  ? [
                      {
                        key: "gross",
                        label: ar ? "إجمالي الربح" : "Gross profit",
                        values: monthly.map((row) => row.grossProfitLyd),
                      },
                      {
                        key: "operating",
                        label: ar ? "الربح التشغيلي" : "Operating profit",
                        values: monthly.map((row) => row.operatingProfitLyd),
                      },
                    ]
                  : []),
              ]}
              valueFormatter={(value) =>
                new Intl.NumberFormat("en-US", {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(value)
              }
            />
          </ChartCard>
          <ChartCard
            title={ar ? "أولوية استخدام النقد" : "Cash allocation priorities"}
            subtitle={
              ar
                ? "ترتيب المبالغ التي يجب حمايتها قبل شراء جهاز."
                : "Amounts that should be protected before committing to another machine."
            }
          >
            <HorizontalBarChart
              rows={decision.priorities.map((row) => ({
                label: ar ? row.labelAr : row.label,
                value: row.amountLyd ?? 0,
                note: row.status,
              }))}
              valueFormatter={(value) => formatFinanceMoney(value)}
            />
          </ChartCard>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <section className="surface-card">
            <h2 className="text-base font-semibold text-slate-950">
              {ar ? "ما يجب فعله الآن" : "What to do with the money now"}
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Link
                href="/finance/investors"
                className="rounded-xl border border-slate-200 p-4 hover:bg-slate-50"
              >
                <div className="font-semibold">
                  {ar ? "تسوية مستحق المستثمر" : "Settle investor amount"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {formatFinanceMoney(investorDue)}
                </div>
              </Link>
              <Link
                href="/restock-priority"
                className="rounded-xl border border-slate-200 p-4 hover:bg-slate-50"
              >
                <div className="font-semibold">
                  {ar ? "تمويل المنتجات الحرجة" : "Fund critical products"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {criticalRestockCount} {ar ? "عنصر" : "items"}
                </div>
              </Link>
              <Link
                href="/issues"
                className="rounded-xl border border-slate-200 p-4 hover:bg-slate-50"
              >
                <div className="font-semibold">
                  {ar ? "إصلاح الأعطال الحرجة" : "Repair critical issues"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {issuesResult.count ?? 0} {ar ? "عطل" : "issues"}
                </div>
              </Link>
              <Link
                href="/locations-pipeline"
                className="rounded-xl border border-slate-200 p-4 hover:bg-slate-50"
              >
                <div className="font-semibold">
                  {ar ? "تجهيز موقع جديد" : "Secure the next location"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {acceptedLocationsResult.count ?? 0}{" "}
                  {ar ? "موقع مقبول" : "accepted locations"}
                </div>
              </Link>
            </div>
          </section>

          <FormSection
            title={ar ? "قواعد قرار الشراء" : "Machine purchase decision rules"}
            description={
              ar
                ? "يمكن تعديلها حسب تكلفة الجهاز ومستوى الأمان المطلوب."
                : "Adjust these rules as machine cost and your desired safety buffer change."
            }
          >
            <form action={saveGrowthDecisionSettings} className="space-y-4">
              <FormField
                label={ar ? "تكلفة الجهاز بالدينار" : "Machine cost (LYD)"}
              >
                <input
                  name="machine_cost_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={numeric(settings.machine_cost_lyd)}
                  className="field-input"
                />
              </FormField>
              <FormField
                label={ar ? "الاحتياطي النقدي الأدنى" : "Minimum cash reserve"}
              >
                <input
                  name="minimum_cash_reserve_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={numeric(settings.minimum_cash_reserve_lyd)}
                  className="field-input"
                />
              </FormField>
              <FormField
                label={
                  ar ? "احتياطي شراء المنتجات" : "Protected restocking reserve"
                }
              >
                <input
                  name="restock_reserve_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={numeric(settings.restock_reserve_lyd)}
                  className="field-input"
                />
              </FormField>
              <FormField
                label={
                  ar
                    ? "الحد الأدنى للربح التشغيلي الشهري"
                    : "Minimum monthly operating profit"
                }
              >
                <input
                  name="minimum_monthly_operating_profit_lyd"
                  type="number"
                  step="0.01"
                  defaultValue={numeric(
                    settings.minimum_monthly_operating_profit_lyd,
                  )}
                  className="field-input"
                />
              </FormField>
              <FormField
                label={
                  ar ? "هدف استرداد التكلفة بالأشهر" : "Target payback months"
                }
              >
                <input
                  name="target_payback_months"
                  type="number"
                  min="1"
                  step="0.1"
                  defaultValue={numeric(settings.target_payback_months)}
                  className="field-input"
                />
              </FormField>
              <FormField
                label={
                  ar
                    ? "عدد الأشهر المطلوبة للقرار"
                    : "Required complete history months"
                }
              >
                <input
                  name="minimum_history_months"
                  type="number"
                  min="1"
                  max="24"
                  step="1"
                  defaultValue={numeric(settings.minimum_history_months)}
                  className="field-input"
                />
              </FormField>
              <button className="btn-primary w-full">
                {ar ? "حفظ القواعد" : "Save decision rules"}
              </button>
            </form>
          </FormSection>
        </div>

        {!vmsProfitResult.monthlyData.length ? (
          <EmptyState
            title={
              ar
                ? "لا توجد مبيعات شهرية كافية"
                : "No complete monthly sales data"
            }
            body={
              ar
                ? "ارفع ملفات VMS الشهرية لتفعيل قرار موثوق."
                : "Upload monthly VMS sales to activate a reliable decision."
            }
          />
        ) : null}
      </div>
    </>
  );
}
