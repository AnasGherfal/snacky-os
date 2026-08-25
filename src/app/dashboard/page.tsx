import Link from "next/link";
import { KpiSection } from "@/components/KpiDashboard";
import { StatCard } from "@/components/StatCard";
import { VmsDataSourceCard } from "@/components/VmsDataSourceCard";
import { EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import {
  loadFinanceHealthDiagnostics,
  type FinanceHealthDiagnostics,
} from "@/lib/finance-health";
import { lyd } from "@/lib/format";
import { restockCounts, type RestockPriorityItem } from "@/lib/restock-priority";
import {
  loadRestockPriorityData,
  type RestockPriorityLoadResult,
} from "@/lib/restock-priority-data";
import { getServerI18n } from "@/lib/i18n/server";
import { ROUTE_RESERVATION_STATUSES } from "@/lib/route-workflow";
import {
  activeDetailedBatches,
  activeStockBatches,
  batchDateRangeLabel,
  batchImportedRows,
  formatVmsDateTime,
  queryVmsDashboardBatches,
  sourceFileName,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

type RevenueDailyRow = {
  sale_date: string | null;
  net_sales_amount: number | string | null;
};

type RefillRow = {
  machine_id: string | null;
  machine_name: string | null;
  product_name: string | null;
  current_qty: number | string | null;
  capacity: number | string | null;
  available_storage_qty: number | string | null;
  suggested_qty: number | string | null;
  final_qty_to_take: number | string | null;
  priority: string | null;
};

type IssueRow = {
  id: string;
  issue_type: string | null;
  priority: string | null;
  status: string | null;
  description: string | null;
  created_at: string | null;
  sla_due_at?: string | null;
  machines?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

type RouteRow = {
  id: string;
  route_date: string | null;
  status: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  last_completion_error?: string | null;
  operator?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
};

type MissingCostRow = {
  product_id: string | null;
  product_name: string | null;
};

type DashboardSection =
  | "revenue"
  | "cashWaiting"
  | "cashVariance"
  | "purchaseDrafts"
  | "purchaseUnpaid"
  | "routes"
  | "recentIssues"
  | "criticalIssues"
  | "refill"
  | "missingCost"
  | "vmsBatches"
  | "restockPriority"
  | "financeHealth";

type DashboardErrors = Partial<Record<DashboardSection, string>>;

type DashboardData = {
  today: string;
  weekStart: string;
  monthStart: string;
  revenueRows: RevenueDailyRow[];
  cashWaitingCount: number;
  varianceReviewCount: number;
  draftPurchaseCount: number;
  unpaidPurchaseCount: number;
  routeRows: RouteRow[];
  recentIssues: IssueRow[];
  criticalIssueCount: number;
  refillRows: RefillRow[];
  missingCostRows: MissingCostRow[];
  vmsBatchRows: VmsDashboardBatch[];
  restockItems: RestockPriorityItem[];
  restockWarnings: string[];
  financeDiagnostics: FinanceHealthDiagnostics;
  errors: DashboardErrors;
};

type ActionItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
};

type DashboardI18n = {
  t: (key: string, fallback?: string) => string;
  locale: "en" | "ar";
};

const HEALTHY_IMPORT_STATUSES = ["imported", "imported_with_warnings", "partially_imported"];
const ROUTE_PENDING_STATUSES = new Set<string>(ROUTE_RESERVATION_STATUSES);
const dashboardSectionLabels: Record<DashboardSection, string> = {
  revenue: "Revenue",
  cashWaiting: "Cash waiting",
  cashVariance: "Cash variance",
  purchaseDrafts: "Purchase drafts",
  purchaseUnpaid: "Unpaid purchases",
  routes: "Routes",
  recentIssues: "Recent issues",
  criticalIssues: "Critical issues",
  refill: "Refill recommendations",
  missingCost: "Missing product cost",
  vmsBatches: "VMS imports",
  restockPriority: "Restock priority",
  financeHealth: "Finance health",
};

function relationRecord<T extends Record<string, unknown>>(value: T | T[] | null | undefined) {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

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

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US");
}

function dateOnlyUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthStartUtc(value: string) {
  return `${value.slice(0, 7)}-01`;
}

function weekStartUtc(date: Date) {
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + offset);
  return dateOnlyUtc(copy);
}

function sumRevenue(rows: RevenueDailyRow[], start: string, end: string) {
  return rows
    .filter((row) => row.sale_date && row.sale_date >= start && row.sale_date <= end)
    .reduce((sum, row) => sum + numberValue(row.net_sales_amount), 0);
}

function machineNeedsRefill(row: RefillRow) {
  return Math.max(numberValue(row.final_qty_to_take), numberValue(row.suggested_qty)) > 0;
}

function refillPriorityRank(priority: string | null | undefined) {
  const value = String(priority ?? "").toLowerCase();
  if (value === "critical") return 0;
  if (value === "high") return 1;
  if (value === "normal") return 2;
  return 3;
}

function sortRefillRows(rows: RefillRow[]) {
  return [...rows].sort((left, right) => {
    const priorityDifference = refillPriorityRank(left.priority) - refillPriorityRank(right.priority);
    if (priorityDifference) return priorityDifference;
    const takeDifference = Math.max(numberValue(right.final_qty_to_take), numberValue(right.suggested_qty))
      - Math.max(numberValue(left.final_qty_to_take), numberValue(left.suggested_qty));
    if (takeDifference) return takeDifference;
    return String(left.machine_name ?? "").localeCompare(String(right.machine_name ?? ""));
  });
}

function issueMachineName(issue: IssueRow, fallback: string) {
  return textValue(relationRecord<{ name?: string | null }>(issue.machines)?.name) ?? fallback;
}

function trimText(value: string | null | undefined, max = 140) {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function routeOperatorName(route: RouteRow) {
  return textValue(relationRecord<{ full_name?: string | null }>(route.operator)?.full_name) ?? "غير مسندة";
}

function routeIsPending(route: RouteRow) {
  return ROUTE_PENDING_STATUSES.has(String(route.status ?? ""));
}

function dashboardStatusLabel(status: string | null | undefined, t: DashboardI18n["t"]) {
  const value = String(status ?? "").toLowerCase();
  switch (value) {
    case "critical":
      return t("Critical");
    case "high":
      return t("High");
    case "normal":
      return t("Normal");
    case "open":
      return t("Open");
    case "resolved":
      return t("Resolved");
    case "closed":
    case "cancelled":
    case "canceled":
      return t("cancelled");
    case "pending":
      return t("pending");
    case "assigned":
      return t("assigned");
    case "in_progress":
      return t("in_progress");
    case "completed":
      return t("completed");
    case "available":
      return t("available");
    case "imported":
      return t("Imported");
    case "imported_with_warnings":
      return t("Imported with warnings");
    case "partially_imported":
      return t("Partially imported");
    default:
      return t("Unknown");
  }
}

function routeIsBroken(route: RouteRow, today: string) {
  if (!routeIsPending(route)) return false;
  if (textValue(route.last_completion_error)) return true;
  return Boolean(route.route_date && route.route_date < today);
}

function importNeedsAttention(batch: VmsDashboardBatch) {
  const status = String(batch.status ?? "");
  if (!HEALTHY_IMPORT_STATUSES.includes(status)) return true;
  return false;
}

function importHasWarnings(batch: VmsDashboardBatch) {
  return statusValue(batch.status) === "imported_with_warnings"
    || numberValue(batch.error_count) > 0
    || numberValue(batch.rows_needing_review) > 0;
}

function statusValue(value: string | null | undefined) {
  return String(value ?? "").trim();
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

async function safeDashboardCount({
  key,
  label,
  promise,
  errors,
}: {
  key: DashboardSection;
  label: string;
  promise: PromiseLike<any>;
  errors: DashboardErrors;
}) {
  try {
    const result = await promise;
    if (result.error) {
      const message = errorMessage(result.error);
      console.error("[dashboard] Supabase count failed", { section: key, query: label, error: result.error });
      errors[key] = message;
      return 0;
    }
    return Number(result.count ?? 0);
  } catch (error) {
    const message = errorMessage(error);
    console.error("[dashboard] Supabase count threw", { section: key, query: label, error });
    errors[key] = message;
    return 0;
  }
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

async function safeFinanceHealthForDashboard(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
  errors: DashboardErrors,
): Promise<FinanceHealthDiagnostics> {
  try {
    const diagnostics = await loadFinanceHealthDiagnostics(supabase);
    if (diagnostics.errors.length) {
      errors.financeHealth = diagnostics.errors.join(" | ");
    }
    return diagnostics;
  } catch (error) {
    const message = errorMessage(error);
    console.error("[dashboard] Finance health failed", { section: "financeHealth", error });
    errors.financeHealth = message;
    return {
      purchasesMissingFinance: [],
      cashCollectionsMissingFinance: [],
      brokenLinks: [],
      balanceInconsistencies: [],
      missingCategories: [],
      ignoredSourceRows: [],
      errors: [message],
    };
  }
}

async function loadRouteRows(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
) {
  const withError = await supabase
    .from("routes")
    .select("id, route_date, status, started_at, updated_at, completed_at, last_completion_error, operator:team_members(full_name)")
    .order("route_date", { ascending: true })
    .limit(80);

  if (!withError.error || !isMissingColumn(withError.error, ["last_completion_error"])) return withError;

  return supabase
    .from("routes")
    .select("id, route_date, status, started_at, updated_at, completed_at, operator:team_members(full_name)")
    .order("route_date", { ascending: true })
    .limit(80);
}

async function loadIssueRows(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
) {
  const withSla = await supabase
    .from("issues")
    .select("id, issue_type, priority, status, description, created_at, sla_due_at, machines(name)")
    .neq("status", "resolved")
    .neq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(6);

  if (!withSla.error || !isMissingColumn(withSla.error, ["sla_due_at"])) return withSla;

  return supabase
    .from("issues")
    .select("id, issue_type, priority, status, description, created_at, machines(name)")
    .neq("status", "resolved")
    .neq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(6);
}

async function getDashboardData() {
  await requireCurrentProfileForPath("/dashboard");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return { data: null };

  const today = dateOnlyUtc(new Date());
  const weekStart = weekStartUtc(new Date());
  const monthStart = monthStartUtc(today);
  const revenueStart = weekStart < monthStart ? weekStart : monthStart;
  const errors: DashboardErrors = {};

  const [
    revenueRows,
    cashWaitingCount,
    varianceReviewCount,
    draftPurchaseCount,
    unpaidPurchaseCount,
    routeRows,
    recentIssues,
    criticalIssueCount,
    refillRows,
    missingCostRows,
    vmsBatchRows,
    restockPriority,
    financeDiagnostics,
  ] = await Promise.all([
    safeDashboardQuery<RevenueDailyRow[]>({
      key: "revenue",
      label: "kpi_machine_daily recent revenue",
      promise: supabase
        .from("kpi_machine_daily")
        .select("sale_date, net_sales_amount")
        .gte("sale_date", revenueStart)
        .order("sale_date", { ascending: false }),
      fallback: [],
      errors,
    }),
    safeDashboardCount({
      key: "cashWaiting",
      label: "cash_collections collected_pending_count",
      promise: supabase
        .from("cash_collections")
        .select("id", { count: "exact", head: true })
        .eq("review_status", "collected_pending_count"),
      errors,
    }),
    safeDashboardCount({
      key: "cashVariance",
      label: "cash_collections variance_review",
      promise: supabase
        .from("cash_collections")
        .select("id", { count: "exact", head: true })
        .eq("review_status", "variance_review"),
      errors,
    }),
    safeDashboardCount({
      key: "purchaseDrafts",
      label: "purchase_orders drafts",
      promise: supabase
        .from("purchase_orders")
        .select("id", { count: "exact", head: true })
        .eq("status", "draft"),
      errors,
    }),
    safeDashboardCount({
      key: "purchaseUnpaid",
      label: "purchase_orders received unpaid",
      promise: supabase
        .from("purchase_orders")
        .select("id", { count: "exact", head: true })
        .eq("status", "received")
        .neq("payment_status", "paid")
        .neq("payment_status", "voided"),
      errors,
    }),
    safeDashboardQuery<RouteRow[]>({
      key: "routes",
      label: "routes open and recent",
      promise: loadRouteRows(supabase),
      fallback: [],
      errors,
    }),
    safeDashboardQuery<IssueRow[]>({
      key: "recentIssues",
      label: "issues recent unresolved",
      promise: loadIssueRows(supabase),
      fallback: [],
      errors,
    }),
    safeDashboardCount({
      key: "criticalIssues",
      label: "issues critical unresolved",
      promise: supabase
        .from("issues")
        .select("id", { count: "exact", head: true })
        .eq("priority", "critical")
        .neq("status", "resolved")
        .neq("status", "closed"),
      errors,
    }),
    safeDashboardQuery<RefillRow[]>({
      key: "refill",
      label: "refill_recommendations current",
      promise: supabase
        .from("refill_recommendations")
        .select("machine_id, machine_name, product_name, current_qty, capacity, available_storage_qty, suggested_qty, final_qty_to_take, priority")
        .limit(4000),
      fallback: [],
      errors,
    }),
    safeDashboardQuery<MissingCostRow[]>({
      key: "missingCost",
      label: "vms_sales_clean missing cost products",
      promise: supabase
        .from("vms_sales_clean")
        .select("product_id, product_name")
        .eq("cost_missing", true)
        .limit(1000),
      fallback: [],
      errors,
    }),
    safeDashboardQuery<VmsDashboardBatch[]>({
      key: "vmsBatches",
      label: "vms_import_batches dashboard sources",
      promise: queryVmsDashboardBatches(supabase, {
        reportTypes: ["vms_order_details_weekly", "sales", "stock", "machine_stock_snapshot", "planogram"],
      }),
      fallback: [],
      errors,
    }),
    safeRestockPriorityForDashboard(supabase, errors),
    safeFinanceHealthForDashboard(supabase, errors),
  ]);

  return {
    data: {
      today,
      weekStart,
      monthStart,
      revenueRows: revenueRows.data,
      cashWaitingCount,
      varianceReviewCount,
      draftPurchaseCount,
      unpaidPurchaseCount,
      routeRows: routeRows.data,
      recentIssues: recentIssues.data,
      criticalIssueCount,
      refillRows: refillRows.data,
      missingCostRows: missingCostRows.data,
      vmsBatchRows: vmsBatchRows.data,
      restockItems: restockPriority.items,
      restockWarnings: Object.values(restockPriority.errors ?? {}).filter(Boolean),
      financeDiagnostics,
      errors,
    } satisfies DashboardData,
  };
}

function SectionLoadError({ message, prefix }: { message?: string | null; prefix: string }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
      {prefix} {message}
    </div>
  );
}

function SectionEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-center">
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
    </div>
  );
}

function DashboardPageContent({ data, t, locale }: { data: DashboardData; t: DashboardI18n["t"]; locale: DashboardI18n["locale"] }) {
  const isArabic = locale === "ar";
  const localize = (en: string, ar: string) => (isArabic ? ar : en);
  const errors = data.errors;
  const revenueRows = data.revenueRows;
  const restockItems = data.restockItems;
  const restockSummary = restockCounts(restockItems);
  const restockWarnings = data.restockWarnings;
  const recentIssues = data.recentIssues;
  const routeRows = data.routeRows;
  const pendingRoutes = routeRows.filter(routeIsPending);
  const brokenRouteCount = routeRows.filter((route) => routeIsBroken(route, data.today)).length;
  const overdueRouteCount = pendingRoutes.filter((route) => route.route_date && route.route_date < data.today).length;
  const recentRefillRows = sortRefillRows(data.refillRows.filter(machineNeedsRefill)).slice(0, 8);
  const machinesNeedingRefillCount = new Set(
    data.refillRows
      .filter(machineNeedsRefill)
      .map((row) => textValue(row.machine_id) ?? textValue(row.machine_name) ?? ""),
  ).size;
  const purchasesWaitingCount = data.draftPurchaseCount + data.unpaidPurchaseCount;
  const todayRevenue = sumRevenue(revenueRows, data.today, data.today);
  const weekRevenue = sumRevenue(revenueRows, data.weekStart, data.today);
  const monthRevenue = sumRevenue(revenueRows, data.monthStart, data.today);
  const latestSaleDate = [...revenueRows]
    .map((row) => row.sale_date ?? "")
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const missingCostProducts = errors.missingCost
    ? 0
    : new Set(data.missingCostRows.map((row) => textValue(row.product_id) ?? textValue(row.product_name) ?? "")).size;
  const financeGapCount =
    data.financeDiagnostics.purchasesMissingFinance.length
    + data.financeDiagnostics.cashCollectionsMissingFinance.length
    + data.financeDiagnostics.brokenLinks.length;
  const financeWarningCount =
    data.financeDiagnostics.balanceInconsistencies.length
    + data.financeDiagnostics.missingCategories.length
    + data.financeDiagnostics.ignoredSourceRows.length;
  const failedImportCount = data.vmsBatchRows.filter(importNeedsAttention).length;
  const warningImportCount = data.vmsBatchRows.filter(importHasWarnings).length;
  const activeDetailedCount = activeDetailedBatches(data.vmsBatchRows).length;
  const activeStockCount = activeStockBatches(data.vmsBatchRows).length;
  const partialSections = Object.entries(errors).filter(([, message]) => Boolean(message));

  const actionItems: ActionItem[] = [];
  if (!activeDetailedCount) {
    actionItems.push({
      key: "missing-detailed-sales",
      title: t("Import a detailed VMS sales file"),
      detail: t("Revenue cards stay flat until at least one active Order Details file is feeding the dashboard."),
      href: "/vms-import",
      cta: t("Open VMS import"),
    });
  }
  if (!activeStockCount) {
    actionItems.push({
      key: "missing-stock-snapshot",
      title: t("Import a stock snapshot"),
      detail: t("Route refill signals work best when the latest machine stock snapshot is active."),
      href: "/vms-import",
      cta: t("Upload stock file"),
    });
  }
  if (failedImportCount > 0) {
    actionItems.push({
      key: "failed-imports",
      title: t("Review failed imports"),
      detail: localize(
        `${failedImportCount} VMS import batch${failedImportCount === 1 ? "" : "es"} still need attention.`,
        `${failedImportCount} دفعة استيراد من VMS لا تزال بحاجة إلى مراجعة.`,
      ),
      href: "/vms-import/sources",
      cta: t("Review imports"),
    });
  }
  if (financeGapCount > 0) {
    actionItems.push({
      key: "finance-gaps",
      title: t("Repair finance links"),
      detail: localize(
        `${financeGapCount} purchase or cash row${financeGapCount === 1 ? "" : "s"} are missing finance coverage.`,
        `${financeGapCount} صف شراء أو كاش لا يملك تغطية مالية.`,
      ),
      href: "/admin/system-health",
      cta: t("Open system health"),
    });
  }
  if (data.cashWaitingCount > 0) {
    actionItems.push({
      key: "cash-waiting",
      title: t("Count waiting cash collections"),
      detail: localize(
        `${data.cashWaitingCount} cash pickup${data.cashWaitingCount === 1 ? "" : "s"} still need finance counting.`,
        `${data.cashWaitingCount} عملية تحصيل نقد لا تزال بحاجة إلى العد.`,
      ),
      href: "/cash-collections?status=collected_pending_count",
      cta: t("Open cash queue"),
    });
  }
  if (restockSummary.critical > 0) {
    actionItems.push({
      key: "critical-restock",
      title: t("Buy critical products"),
      detail: localize(
        `${restockSummary.critical} product${restockSummary.critical === 1 ? "" : "s"} are already at critical restock level.`,
        `${restockSummary.critical} منتج${restockSummary.critical === 1 ? "" : "ات"} وصلت إلى مستوى تعبئة حرج.`,
      ),
      href: "/restock-priority?filter=critical",
      cta: t("Open restock priority"),
    });
  }
  if (machinesNeedingRefillCount > 0) {
    actionItems.push({
      key: "refill-routes",
      title: t("Build the next refill route"),
      detail: localize(
        `${machinesNeedingRefillCount} machine${machinesNeedingRefillCount === 1 ? "" : "s"} have active refill recommendations.`,
        `${machinesNeedingRefillCount} جهاز${machinesNeedingRefillCount === 1 ? "" : "ات"} لديه توصيات تعبئة نشطة.`,
      ),
      href: "/routes/new",
      cta: t("Create route"),
    });
  }
  if (pendingRoutes.length > 0) {
    actionItems.push({
      key: "pending-routes",
      title: t("Close open routes"),
      detail: localize(
        `${pendingRoutes.length} route${pendingRoutes.length === 1 ? "" : "s"} are still open${overdueRouteCount ? `, including ${overdueRouteCount} overdue` : ""}.`,
        `${pendingRoutes.length} جولة${pendingRoutes.length === 1 ? "" : "ات"} ما زالت مفتوحة${overdueRouteCount ? `، منها ${overdueRouteCount} متأخرة` : ""}.`,
      ),
      href: "/routes",
      cta: t("Open routes"),
    });
  }
  if (data.criticalIssueCount > 0) {
    actionItems.push({
      key: "critical-issues",
      title: t("Resolve critical issues"),
      detail: localize(
        `${data.criticalIssueCount} critical machine issue${data.criticalIssueCount === 1 ? "" : "s"} are still unresolved.`,
        `${data.criticalIssueCount} عطل جهاز حرِج ما زال غير محلول.`,
      ),
      href: "/issues",
      cta: t("Open issues"),
    });
  }

  const revenueUnavailable = Boolean(errors.revenue);
  const criticalProductsUnavailable = Boolean(errors.restockPriority);
  const routesUnavailable = Boolean(errors.routes);
  const refillUnavailable = Boolean(errors.refill);
  const heroRevenueSummary = revenueUnavailable
    ? t("Revenue is waiting for the next healthy detailed VMS sales load.")
    : localize(
      `Snacky made ${lyd(todayRevenue)} today, ${lyd(weekRevenue)} this week, and ${lyd(monthRevenue)} this month.`,
      `حققت Snacky ${lyd(todayRevenue)} اليوم، و${lyd(weekRevenue)} هذا الأسبوع، و${lyd(monthRevenue)} هذا الشهر.`,
    );
  const heroAttentionSummary = [
    data.cashWaitingCount ? localize(`${data.cashWaitingCount} cash pickup${data.cashWaitingCount === 1 ? "" : "s"} waiting`, `${data.cashWaitingCount} عملية تحصيل نقد في الانتظار`) : null,
    restockSummary.critical ? localize(`${restockSummary.critical} critical product${restockSummary.critical === 1 ? "" : "s"}`, `${restockSummary.critical} منتج حرِج`) : null,
    pendingRoutes.length ? localize(`${pendingRoutes.length} route${pendingRoutes.length === 1 ? "" : "s"} still open`, `${pendingRoutes.length} جولة ما زالت مفتوحة`) : null,
    brokenRouteCount ? localize(`${brokenRouteCount} broken route${brokenRouteCount === 1 ? "" : "s"}`, `${brokenRouteCount} جولة معطوبة`) : null,
  ].filter(Boolean).join(" / ") || t("No urgent operational queue is blocking the day right now.");

  return (
    <>
      <PageHeader
        title={t("Dashboard")}
        subtitle={t("How much money Snacky made, what needs attention, and what should happen next.")}
        action={(
          <div className="flex flex-wrap gap-2">
            <PrimaryButton href="/routes/new">{t("Create Route")}</PrimaryButton>
            <SecondaryButton href="/restock-priority">{t("Open Restock Priority")}</SecondaryButton>
          </div>
        )}
      />

      <section className="mb-6 overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-emerald-50 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700">{t("Snacky Today")}</div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{heroRevenueSummary}</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">{heroAttentionSummary}</p>
            <div className="mt-3 text-xs text-slate-500">
              {t("Latest detailed sales date")}: {latestSaleDate ?? t("Not available")} / {t("Active stock snapshot files")}: {activeStockCount}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/cash-collections?status=collected_pending_count">{t("Count cash")}</SecondaryButton>
            <SecondaryButton href="/admin/system-health">{t("System health")}</SecondaryButton>
          </div>
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-slate-900">{t("Top Cards")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("The eight numbers that should explain today's trading and backlog in one glance.")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t("Revenue today")}
            value={revenueUnavailable ? "-" : lyd(todayRevenue)}
            note={latestSaleDate ? localize(`Detailed sales through ${latestSaleDate}`, `المبيعات التفصيلية حتى ${latestSaleDate}`) : t("Waiting for detailed VMS sales")}
          />
          <StatCard
            label={t("Revenue week")}
            value={revenueUnavailable ? "-" : lyd(weekRevenue)}
            note={localize(`From ${data.weekStart} to ${data.today}`, `من ${data.weekStart} إلى ${data.today}`)}
          />
          <StatCard
            label={t("Revenue month")}
            value={revenueUnavailable ? "-" : lyd(monthRevenue)}
            note={localize(`From ${data.monthStart} to ${data.today}`, `من ${data.monthStart} إلى ${data.today}`)}
          />
          <StatCard
            label={t("Cash collected waiting")}
            value={errors.cashWaiting ? "-" : data.cashWaitingCount.toLocaleString("en-US")}
            note={errors.cashVariance ? t("Variance review unavailable") : localize(`${data.varianceReviewCount} in variance review`, `${data.varianceReviewCount} قيد مراجعة الفروقات`)}
          />
          <StatCard
            label={t("Purchases waiting")}
            value={errors.purchaseDrafts || errors.purchaseUnpaid ? "-" : purchasesWaitingCount.toLocaleString("en-US")}
            note={localize(`Draft ${data.draftPurchaseCount} / unpaid received ${data.unpaidPurchaseCount}`, `مسودات ${data.draftPurchaseCount} / غير مسددة ${data.unpaidPurchaseCount}`)}
          />
          <StatCard
            label={t("Critical products")}
            value={criticalProductsUnavailable ? "-" : restockSummary.critical.toLocaleString("en-US")}
            note={criticalProductsUnavailable ? t("Restock engine unavailable") : localize(`${restockSummary.low} more low products`, `${restockSummary.low} منتجات منخفضة إضافية`)}
          />
          <StatCard
            label={t("Routes pending")}
            value={routesUnavailable ? "-" : pendingRoutes.length.toLocaleString("en-US")}
            note={routesUnavailable ? t("Route queue unavailable") : overdueRouteCount ? localize(`${overdueRouteCount} overdue`, `${overdueRouteCount} متأخرة`) : t("No overdue routes")}
          />
          <StatCard
            label={t("Machines needing refill")}
            value={refillUnavailable ? "-" : machinesNeedingRefillCount.toLocaleString("en-US")}
            note={refillUnavailable ? t("Refill recommendations unavailable") : localize(`${recentRefillRows.length} recommendation rows on deck`, `${recentRefillRows.length} صف توصية جاهز`)}
          />
        </div>
      </section>

      {partialSections.length ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t("Dashboard stayed online in partial mode. Some sections could not load:")}
          {" "}
          {partialSections.map(([key]) => dashboardSectionLabels[key as DashboardSection]).join(" / ")}.
        </div>
      ) : null}

      {!errors.restockPriority && restockWarnings.length ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t("Some restock inputs are still partial, so critical product counts are based on the signals that are currently healthy.")}
        </div>
      ) : null}

      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-900">{t("What Needs Attention")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("Operations pressure from issues, refill demand, finance gaps, and import health.")}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          <KpiSection title={t("Recent issues")} subtitle={t("Unresolved issues should stay visible until someone owns the fix.")}>
            <SectionLoadError message={errors.recentIssues} prefix={t("This section could not load:")} />
            {errors.recentIssues ? null : !recentIssues.length ? (
              <SectionEmpty title={t("No open issues")} body={t("Operators have not reported unresolved machine problems yet.")} />
            ) : (
              <div className="space-y-3">
                {recentIssues.map((issue) => (
                  <div key={issue.id} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">{issueMachineName(issue, t("Unknown machine"))}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {textValue(issue.issue_type) ?? t("Issue")} / {t("logged")} {formatDateTime(issue.created_at)}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusBadge status={issue.priority ?? "unknown"} label={dashboardStatusLabel(issue.priority, t)} />
                        <StatusBadge status={issue.status ?? "unknown"} label={dashboardStatusLabel(issue.status, t)} />
                      </div>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-700">{trimText(issue.description)}</p>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <div>{t("SLA due")}: {issue.sla_due_at ? formatDateTime(issue.sla_due_at) : t("not set")}</div>
                      <Link href="/issues" className="font-semibold text-amber-700 hover:text-amber-800">{t("Open issues")}</Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </KpiSection>

          <KpiSection title={t("Machines needing refill now")} subtitle={t("The route builder should pull from the same live recommendation queue shown here.")}>
            <SectionLoadError message={errors.refill} prefix={t("This section could not load:")} />
            {errors.refill ? null : !recentRefillRows.length ? (
              <SectionEmpty title={t("No refill pressure")} body={t("No active machine refill recommendations are asking for stock right now.")} />
            ) : (
              <div className="space-y-3">
                {recentRefillRows.map((row, index) => {
                  const refillQty = Math.max(numberValue(row.final_qty_to_take), numberValue(row.suggested_qty));
                  return (
                    <div key={`${textValue(row.machine_id) ?? textValue(row.machine_name) ?? "machine"}-${index}`} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">{textValue(row.machine_name) ?? t("Unknown machine")}</div>
                          <div className="mt-1 text-xs text-slate-500">{textValue(row.product_name) ?? t("Unknown product")}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusBadge status={row.priority ?? "normal"} label={dashboardStatusLabel(row.priority, t)} />
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{t("Take")} {refillQty}</span>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Machine stock")}</div>
                          <div className="mt-1">{numberValue(row.current_qty)}</div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Capacity")}</div>
                          <div className="mt-1">{numberValue(row.capacity)}</div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Storage available")}</div>
                          <div className="mt-1">{numberValue(row.available_storage_qty)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="flex justify-end">
                  <SecondaryButton href="/routes/new">{t("Create route from recommendations")}</SecondaryButton>
                </div>
              </div>
            )}
          </KpiSection>
        </div>

        <div className="space-y-4">
          <KpiSection title={t("What should I do next?")} subtitle={t("A short operating queue based on the current dashboard signals.")}>
            {!actionItems.length ? (
              <SectionEmpty title={t("No urgent queue")} body={t("The highest-priority queues are clear. Review routes or restock priority when you want the next task.")} />
            ) : (
              <div className="space-y-3">
                {actionItems.map((item) => (
                  <div key={item.key} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900">{item.title}</div>
                        <p className="mt-1 text-sm leading-6 text-slate-600">{item.detail}</p>
                      </div>
                      <Link href={item.href} className="btn-secondary shrink-0">{item.cta}</Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </KpiSection>

          <KpiSection title={t("System health summary")} subtitle={t("Counts that usually send teams into repair mode.")}>
            {errors.financeHealth || errors.routes || errors.missingCost || errors.vmsBatches ? (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {t("Some health counters are partial right now, but the dashboard kept running.")}
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Failed imports")}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-950">{errors.vmsBatches ? "-" : failedImportCount}</div>
                <div className="mt-1 text-xs text-slate-500">{t("Warnings")}: {errors.vmsBatches ? "-" : warningImportCount}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Missing finance links")}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-950">{errors.financeHealth ? "-" : financeGapCount}</div>
                <div className="mt-1 text-xs text-slate-500">{t("Warnings")}: {errors.financeHealth ? "-" : financeWarningCount}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Broken routes")}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-950">{errors.routes ? "-" : brokenRouteCount}</div>
                <div className="mt-1 text-xs text-slate-500">{t("Overdue open routes")}: {errors.routes ? "-" : overdueRouteCount}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Products without cost")}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-950">{errors.missingCost ? "-" : missingCostProducts}</div>
                <div className="mt-1 text-xs text-slate-500">{t("Critical issues")}: {errors.criticalIssues ? "-" : data.criticalIssueCount}</div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <SecondaryButton href="/admin/system-health">{t("Open System Health")}</SecondaryButton>
              <SecondaryButton href="/admin/finance-health">{t("Open Finance Health")}</SecondaryButton>
            </div>
          </KpiSection>
        </div>
      </div>

      <div className="mt-6">
        <VmsDataSourceCard
          batches={data.vmsBatchRows}
          error={errors.vmsBatches}
          title={t("VMS Import Status")}
          subtitle={t("Dashboard totals only use the active detailed sales and stock snapshot files listed below.")}
          showSales
          showStock
        />
      </div>

      {!errors.vmsBatches && data.vmsBatchRows.length ? (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{t("Latest import status")}</h2>
              <p className="mt-1 text-sm text-slate-500">{t("The newest files feeding sales, refill, and inventory logic right now.")}</p>
            </div>
            <SecondaryButton href="/vms-import/sources">{t("Open VMS Data Sources")}</SecondaryButton>
          </div>
          <div className="space-y-3">
            {data.vmsBatchRows.slice(0, 4).map((batch) => (
              <div key={batch.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">
                      <Link href={`/vms-import/${batch.id}`} className="link-secondary">{sourceFileName(batch)}</Link>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {batch.report_type ?? t("Unknown")} / {batchDateRangeLabel(batch)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge status={batch.status ?? "unknown"} label={dashboardStatusLabel(batch.status, t)} />
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                      {batchImportedRows(batch).toLocaleString("en-US")} {t("rows")}
                    </span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  {t("Updated")} {formatVmsDateTime(batch.imported_at ?? batch.uploaded_at)} / {t("Active")}: {batch.is_active === false || batch.deleted_at ? t("No") : t("Yes")}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function isNextNavigationSignal(error: unknown) {
  const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE";
}

async function DashboardPageContentLoader({ t, locale }: DashboardI18n) {
  const result = await getDashboardData();

  if (!result.data) {
    return (
      <>
        <PageHeader title={t("Dashboard")} subtitle={t("How much money Snacky made, what needs attention, and what should happen next.")} />
        <EmptyState title={t("Connect Supabase to activate the dashboard")} body={t("Add the Snacky OS environment variables and restart the app.")} />
      </>
    );
  }

  return <DashboardPageContent data={result.data} t={t} locale={locale} />;
}

export default async function DashboardPage() {
  const { t, locale } = await getServerI18n();
  try {
    return await DashboardPageContentLoader({ t, locale });
  } catch (error) {
    if (isNextNavigationSignal(error)) throw error;
    console.error("[dashboard] Page-level render guard caught an unexpected error", error);
    return (
      <>
        <PageHeader title={t("Dashboard")} subtitle={t("How much money Snacky made, what needs attention, and what should happen next.")}
        />
        <EmptyState title={t("Dashboard recovered from an error")} body={t("One of the dashboard render paths failed unexpectedly. Please contact admin if the issue keeps happening.")} />
      </>
    );
  }
}
