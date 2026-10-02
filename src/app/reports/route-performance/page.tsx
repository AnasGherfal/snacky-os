import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import {
  buildMonthlyOperationsReport,
  type MonthlyFillLineRow,
  type MonthlyManualSaleRow,
  type MonthlyMovementRow,
  type MonthlyRefillRow,
  type MonthlyRouteRow,
  type MonthlyStopRow,
} from "@/lib/monthly-operations-report";
import { buildRouteMachineCatalog } from "@/lib/route-machine-catalog";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type Locale = "ar" | "en";
type QueryError = { message?: string } | null;
type QueryPage<T> = { data: T[] | null; error: QueryError };
type QueryResult<T> = { data: T[]; error: QueryError };
type TeamMemberRow = { id: string; full_name: string | null };
type MachineRow = {
  id: string;
  name: string | null;
  machine_code: string | null;
  vms_machine_id: string | null;
  vms_location_name: string | null;
  vms_raw_metadata: unknown;
};

const PAGE_SIZE = 1000;
const ID_CHUNK_SIZE = 75;
const tr = (locale: Locale, en: string, ar: string) => locale === "ar" ? ar : en;
const validMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

function currentBusinessMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
  const next = monthNumber === 12 ? `${year + 1}-01-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return { start, next };
}

function shiftMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fetchAllPages<T>(loadPage: (from: number, to: number) => PromiseLike<QueryPage<T>>): Promise<QueryResult<T>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await loadPage(from, from + PAGE_SIZE - 1);
    if (result.error) return { data: [], error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { data: rows, error: null };
  }
}

async function fetchRowsForIds<T>(
  ids: string[],
  loadPage: (ids: string[], from: number, to: number) => PromiseLike<QueryPage<T>>,
): Promise<QueryResult<T>> {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + ID_CHUNK_SIZE);
    const result = await fetchAllPages((from, to) => loadPage(chunk, from, to));
    if (result.error) return { data: [], error: result.error };
    rows.push(...result.data);
  }
  return { data: rows, error: null };
}

function integer(locale: Locale, value: number) {
  return new Intl.NumberFormat(locale === "ar" ? "ar-LY" : "en-US", { maximumFractionDigits: 0 }).format(value);
}

function decimal(locale: Locale, value: number, digits = 1) {
  return new Intl.NumberFormat(locale === "ar" ? "ar-LY" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function dateLabel(locale: Locale, value: string | null) {
  if (!value) return "-";
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(locale === "ar" ? "ar-LY" : "en-GB", { day: "numeric", month: "short" });
}

function durationLabel(locale: Locale, minutes: number | null) {
  if (minutes === null) return "-";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  if (!hours) return tr(locale, `${remaining} min`, `${integer(locale, remaining)} دقيقة`);
  if (!remaining) return tr(locale, `${hours} hr`, `${integer(locale, hours)} ساعة`);
  return tr(locale, `${hours} hr ${remaining} min`, `${integer(locale, hours)} ساعة و${integer(locale, remaining)} دقيقة`);
}

function statusLabel(locale: Locale, status: string) {
  const labels: Record<string, [string, string]> = {
    draft: ["Draft", "مسودة"],
    assigned: ["Assigned", "مُسندة"],
    in_progress: ["In progress", "قيد التنفيذ"],
    pickup_confirmed: ["Pickup confirmed", "تم استلام المخزون"],
    completed: ["Completed", "مكتملة"],
    verified: ["Verified", "تم التحقق"],
    payroll_pending: ["Payroll pending", "بانتظار الرواتب"],
    paid: ["Paid", "مدفوعة"],
    disputed: ["Disputed", "قيد الاعتراض"],
    reviewed: ["Reviewed", "تمت المراجعة"],
    cancelled: ["Cancelled", "ملغاة"],
    canceled: ["Cancelled", "ملغاة"],
  };
  const label = labels[status];
  return label ? tr(locale, label[0], label[1]) : status.replaceAll("_", " ");
}

function MetricCard({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint?: string; tone?: "neutral" | "ok" | "warn" | "danger" }) {
  const tones = {
    neutral: "border-slate-200 bg-white",
    ok: "border-emerald-200 bg-emerald-50/60",
    warn: "border-amber-200 bg-amber-50/60",
    danger: "border-rose-200 bg-rose-50/60",
  };
  return <div className={`rounded-2xl border p-4 shadow-sm ${tones[tone]}`}>
    <div className="text-sm font-medium text-slate-600">{label}</div>
    <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{value}</div>
    {hint ? <div className="mt-1 text-xs leading-5 text-slate-500">{hint}</div> : null}
  </div>;
}

export default async function RoutePerformancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/reports")) redirect("/unauthorized");

  const defaultMonth = currentBusinessMonth();
  const requestedMonth = (await searchParams).month ?? defaultMonth;
  const month = validMonth(requestedMonth) ? requestedMonth : defaultMonth;
  const { start, next } = monthBounds(month);
  const authClient = await getAuthenticatedSupabaseServerClient();
  if (!authClient) return <ErrorState title={tr(locale, "Monthly operations unavailable", "التقرير التشغيلي غير متاح")} body={tr(locale, "Supabase is not configured.", "لم يتم إعداد Supabase.")} />;
  const client = getSupabaseAdminClient() ?? authClient;

  const routesResult = await fetchAllPages<MonthlyRouteRow>((from, to) => client
    .from("routes")
    .select("id, route_date, operator_id, status, started_at, completed_at, cancellation_reason")
    .gte("route_date", start)
    .lt("route_date", next)
    .order("route_date", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to) as unknown as PromiseLike<QueryPage<MonthlyRouteRow>>);

  if (routesResult.error) return <ErrorState title={tr(locale, "Could not load monthly operations", "تعذر تحميل التقرير التشغيلي")} body={routesResult.error.message ?? tr(locale, "Route data could not load.", "تعذر تحميل بيانات الجولات.")} />;

  const routeRows = routesResult.data;
  const routeIds = routeRows.map((route) => route.id);
  const [stopsResult, movementsResult, refillsResult, manualSalesResult, fillLinesResult] = await Promise.all([
    fetchRowsForIds<MonthlyStopRow>(routeIds, (ids, from, to) => client.from("route_stops").select("id, route_id, machine_id, status, completed_at").in("route_id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<MonthlyStopRow>>),
    fetchRowsForIds<MonthlyMovementRow>(routeIds, (ids, from, to) => client.from("inventory_movements").select("related_route_id, related_route_stop_id, related_machine_id, quantity, reason, source_type, from_entity_type, to_entity_type").in("related_route_id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<MonthlyMovementRow>>),
    fetchRowsForIds<MonthlyRefillRow>(routeIds, (ids, from, to) => client.from("machine_refill_history").select("route_id, route_stop_id, machine_id, fill_status, issues_found").in("route_id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<MonthlyRefillRow>>),
    fetchRowsForIds<MonthlyManualSaleRow>(routeIds, (ids, from, to) => client.from("route_manual_sales").select("route_id, operator_id, quantity, total_amount_lyd, status").in("route_id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<MonthlyManualSaleRow>>),
    fetchRowsForIds<MonthlyFillLineRow>(routeIds, (ids, from, to) => client.from("route_stop_fill_lines").select("route_id, route_stop_id, machine_id, action_type, assigned_qty, actual_qty, difference_qty, needs_review").in("route_id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<MonthlyFillLineRow>>),
  ]);

  if (stopsResult.error) return <ErrorState title={tr(locale, "Could not load machine visits", "تعذر تحميل زيارات الأجهزة")} body={stopsResult.error.message ?? tr(locale, "Machine stop data could not load.", "تعذر تحميل بيانات مواقع الأجهزة.")} />;

  const operatorIds = Array.from(new Set(routeRows.map((route) => route.operator_id).filter((value): value is string => Boolean(value))));
  const machineIds = Array.from(new Set([
    ...stopsResult.data.map((stop) => stop.machine_id),
    ...movementsResult.data.map((movement) => movement.related_machine_id),
  ].filter((value): value is string => Boolean(value))));
  const [operatorsResult, machinesResult] = await Promise.all([
    fetchRowsForIds<TeamMemberRow>(operatorIds, (ids, from, to) => client.from("team_members").select("id, full_name").in("id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<TeamMemberRow>>),
    fetchRowsForIds<MachineRow>(machineIds, (ids, from, to) => client.from("machines").select("id, name, machine_code, vms_machine_id, vms_location_name, vms_raw_metadata").in("id", ids).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<QueryPage<MachineRow>>),
  ]);

  const report = buildMonthlyOperationsReport({
    routes: routeRows,
    stops: stopsResult.data,
    movements: movementsResult.error ? [] : movementsResult.data,
    refills: refillsResult.error ? [] : refillsResult.data,
    manualSales: manualSalesResult.error ? [] : manualSalesResult.data,
    fillLines: fillLinesResult.error ? [] : fillLinesResult.data,
  });
  const operatorById = new Map(operatorsResult.data.map((operator) => [operator.id, operator.full_name || tr(locale, "Unknown operator", "مشغل غير معروف")]));
  const machineById = new Map(buildRouteMachineCatalog(machinesResult.data).map((machine) => [machine.id, machine]));
  const optionalWarnings = [
    movementsResult.error ? tr(locale, "Actual inventory units could not load, so unit totals are hidden.", "تعذر تحميل حركة المخزون الفعلية، لذلك تم إخفاء إجماليات الوحدات.") : null,
    refillsResult.error ? tr(locale, "Full and partial refill status could not load.", "تعذر تحميل حالات التعبئة الكاملة والجزئية.") : null,
    fillLinesResult.error ? tr(locale, "Planned-versus-actual refill data could not load.", "تعذر تحميل مقارنة الكمية المخططة بالكمية الفعلية.") : null,
    manualSalesResult.error ? tr(locale, "Manual sales could not load.", "تعذر تحميل المبيعات اليدوية.") : null,
    operatorsResult.error ? tr(locale, "Some operator names could not load.", "تعذر تحميل بعض أسماء المشغلين.") : null,
    machinesResult.error ? tr(locale, "Some machine names could not load.", "تعذر تحميل بعض أسماء الأجهزة.") : null,
  ].filter((warning): warning is string => Boolean(warning));
  const unitsAvailable = !movementsResult.error;
  const refillStatusAvailable = !refillsResult.error;
  const fillAuditAvailable = !fillLinesResult.error;
  const manualSalesAvailable = !manualSalesResult.error;
  const attentionCoverageAvailable = refillStatusAvailable && fillAuditAvailable;
  const monthLabel = new Date(`${month}-01T12:00:00Z`).toLocaleDateString(locale === "ar" ? "ar-LY" : "en-US", { month: "long", year: "numeric" });
  const previousMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  const maxDailyFilled = Math.max(1, ...report.days.map((day) => day.filled));
  const completedTone = report.summary.routeCompletionRate >= 95 ? "ok" : report.summary.routeCompletionRate >= 80 ? "warn" : "danger";

  if (!routeRows.length) return <div dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader title={tr(locale, "Monthly Operations", "التقرير التشغيلي الشهري")} subtitle={tr(locale, `Routes, machine service, inventory, and operator work for ${monthLabel}.`, `الجولات وخدمة الأجهزة والمخزون وعمل المشغلين خلال ${monthLabel}.`)} breadcrumbs={[{ label: tr(locale, "Reports", "التقارير"), href: "/reports" }, { label: tr(locale, "Monthly Operations", "التقرير التشغيلي الشهري") }]} />
    <form className="surface-card mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-end"><label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{tr(locale, "Month", "الشهر")}</span><input className="field-input" type="month" name="month" defaultValue={month} /></label><button className="btn-primary" type="submit">{tr(locale, "Show report", "عرض التقرير")}</button></form>
    <EmptyState title={tr(locale, "No routes in this month", "لا توجد جولات في هذا الشهر")} body={tr(locale, "Choose another month or create a route to start the operational report.", "اختر شهراً آخر أو أنشئ جولة لبدء التقرير التشغيلي.")} />
  </div>;

  return <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader title={tr(locale, "Monthly Operations", "التقرير التشغيلي الشهري")} subtitle={tr(locale, `One operational view of routes, actual machine fills, inventory, and operator work for ${monthLabel}.`, `عرض تشغيلي موحد للجولات والتعبئة الفعلية للأجهزة والمخزون وعمل المشغلين خلال ${monthLabel}.`)} breadcrumbs={[{ label: tr(locale, "Reports", "التقارير"), href: "/reports" }, { label: tr(locale, "Monthly Operations", "التقرير التشغيلي الشهري") }]} action={<Link href="/reports" className="btn-secondary">{tr(locale, "All reports", "كل التقارير")}</Link>} />

    <div className="surface-card p-4">
      <form className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{tr(locale, "Report month", "شهر التقرير")}</span><input className="field-input" type="month" name="month" defaultValue={month} /></label><button className="btn-primary" type="submit">{tr(locale, "Show report", "عرض التقرير")}</button></div><div className="flex gap-2"><Link href={`/reports/route-performance?month=${previousMonth}`} className="btn-secondary">{tr(locale, "Previous month", "الشهر السابق")}</Link><Link href={`/reports/route-performance?month=${nextMonth}`} className="btn-secondary">{tr(locale, "Next month", "الشهر التالي")}</Link></div></form>
      <p className="mt-3 text-xs leading-5 text-slate-500">{tr(locale, "Operational activity is grouped by each route's business date. A service visit is a completed stop; a fill visit requires a positive net inventory movement into the machine.", "يتم تجميع النشاط حسب تاريخ تشغيل الجولة. زيارة الخدمة هي موقع مكتمل، أما زيارة التعبئة فتتطلب حركة مخزون فعلية موجبة إلى الجهاز.")}</p>
    </div>

    {optionalWarnings.length ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><div className="font-semibold">{tr(locale, "Some report sections are temporarily unavailable", "بعض أجزاء التقرير غير متاحة مؤقتاً")}</div><ul className="mt-2 list-disc space-y-1 ps-5">{optionalWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}

    <section>
      <div className="mb-3"><h2 className="text-lg font-semibold text-slate-950">{tr(locale, "Monthly summary", "ملخص الشهر")}</h2><p className="text-sm text-slate-500">{tr(locale, "The numbers needed to understand how much operational work was completed.", "الأرقام الأساسية لمعرفة حجم العمل التشغيلي المنجز.")}</p></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={tr(locale, "Routes completed", "الجولات المكتملة")} value={`${integer(locale, report.summary.routesCompleted)} / ${integer(locale, report.summary.routesScheduled)}`} hint={tr(locale, `${decimal(locale, report.summary.routeCompletionRate)}% of scheduled routes`, `${decimal(locale, report.summary.routeCompletionRate)}٪ من الجولات المجدولة`)} tone={completedTone} />
        <MetricCard label={tr(locale, "Actual fill visits", "زيارات التعبئة الفعلية")} value={integer(locale, report.summary.fillVisits)} hint={tr(locale, `${integer(locale, report.summary.completedVisits)} completed machine visits`, `${integer(locale, report.summary.completedVisits)} زيارة جهاز مكتملة`)} tone="ok" />
        <MetricCard label={tr(locale, "Machines filled", "الأجهزة التي تمت تعبئتها")} value={integer(locale, report.summary.uniqueMachinesFilled)} hint={tr(locale, `${integer(locale, report.summary.uniqueMachines)} machines serviced`, `تمت خدمة ${integer(locale, report.summary.uniqueMachines)} أجهزة`)} />
        <MetricCard label={tr(locale, "Active operators", "المشغلون النشطون")} value={integer(locale, report.summary.activeOperators)} hint={tr(locale, "Operators with completed machine visits", "المشغلون الذين لديهم زيارات أجهزة مكتملة")} />
        <MetricCard label={tr(locale, "Units loaded", "الوحدات المستلمة من المخزن")} value={unitsAvailable ? integer(locale, report.summary.loaded) : "—"} hint={tr(locale, "Storage to operator bags", "من المخزن إلى حقائب المشغلين")} />
        <MetricCard label={tr(locale, "Units filled", "الوحدات التي تمت تعبئتها")} value={unitsAvailable ? integer(locale, report.summary.filled) : "—"} hint={tr(locale, "Net units posted into machines", "صافي الوحدات المسجلة داخل الأجهزة")} tone="ok" />
        <MetricCard label={tr(locale, "Units returned", "الوحدات المعادة للمخزن")} value={unitsAvailable ? integer(locale, report.summary.returned) : "—"} hint={tr(locale, "All route-linked stock returned to storage", "كل مخزون الجولة المُعاد إلى المخزن")} />
        <MetricCard label={tr(locale, "Plan fulfilled", "تنفيذ خطة التعبئة")} value={fillAuditAvailable && report.summary.fillPlanRate !== null ? `${decimal(locale, report.summary.fillPlanRate)}%` : "—"} hint={fillAuditAvailable ? tr(locale, `${integer(locale, report.summary.recordedFillUnits)} actual of ${integer(locale, report.summary.assignedUnits)} assigned`, `${integer(locale, report.summary.recordedFillUnits)} فعلية من ${integer(locale, report.summary.assignedUnits)} مخططة`) : tr(locale, "Plan audit unavailable", "تدقيق الخطة غير متاح")} tone={fillAuditAvailable && report.summary.shortageUnits > 0 ? "warn" : "neutral"} />
      </div>
    </section>

    <section>
      <div className="mb-3"><h2 className="text-lg font-semibold text-slate-950">{tr(locale, "Operational health", "صحة العمليات")}</h2><p className="text-sm text-slate-500">{tr(locale, "Exceptions and workload signals that may need review.", "الاستثناءات ومؤشرات العمل التي قد تحتاج إلى مراجعة.")}</p></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={tr(locale, "Open routes", "الجولات المفتوحة")} value={integer(locale, report.summary.routesOpen)} hint={tr(locale, "Scheduled but not completed or cancelled", "مجدولة ولم تكتمل أو تُلغَ بعد")} tone={report.summary.routesOpen ? "warn" : "ok"} />
        <MetricCard label={tr(locale, "Cancelled routes", "الجولات الملغاة")} value={integer(locale, report.summary.routesCancelled)} hint={tr(locale, "Kept in history for accountability", "محفوظة في السجل للمراجعة")} tone={report.summary.routesCancelled ? "warn" : "neutral"} />
        <MetricCard label={tr(locale, "Partial fills", "التعبئات الجزئية")} value={refillStatusAvailable ? integer(locale, report.summary.partialFills) : "—"} hint={refillStatusAvailable ? tr(locale, `${integer(locale, report.summary.fullFills)} full fills`, `${integer(locale, report.summary.fullFills)} تعبئة كاملة`) : undefined} tone={refillStatusAvailable && report.summary.partialFills ? "warn" : "neutral"} />
        <MetricCard label={tr(locale, "Shortage units", "وحدات النقص")} value={fillAuditAvailable ? integer(locale, report.summary.shortageUnits) : "—"} hint={fillAuditAvailable ? tr(locale, `${integer(locale, report.summary.zeroFillLines)} assigned product lines filled with zero`, `${integer(locale, report.summary.zeroFillLines)} أصناف مخططة سُجلت بصفر`) : undefined} tone={fillAuditAvailable && report.summary.shortageUnits ? "warn" : "neutral"} />
        <MetricCard label={tr(locale, "Skipped or open stops", "المواقع المتخطاة أو المفتوحة")} value={integer(locale, report.summary.skippedStops + report.summary.openStops)} hint={tr(locale, `${integer(locale, report.summary.skippedStops)} skipped · ${integer(locale, report.summary.openStops)} still open`, `${integer(locale, report.summary.skippedStops)} متخطاة · ${integer(locale, report.summary.openStops)} ما زالت مفتوحة`)} tone={report.summary.skippedStops + report.summary.openStops ? "warn" : "ok"} />
        <MetricCard label={tr(locale, "Damaged units", "الوحدات التالفة")} value={unitsAvailable ? integer(locale, report.summary.damaged) : "—"} hint={tr(locale, "Route-related movements to waste", "حركات المخزون المرتبطة بالجولات إلى التالف")} tone={unitsAvailable && report.summary.damaged ? "warn" : "neutral"} />
        <MetricCard label={tr(locale, "Manual sales", "المبيعات اليدوية")} value={manualSalesAvailable ? integer(locale, report.summary.manualSaleUnits) : "—"} hint={manualSalesAvailable ? tr(locale, `${decimal(locale, report.summary.manualSalesLyd, 2)} LYD recorded`, `تم تسجيل ${decimal(locale, report.summary.manualSalesLyd, 2)} د.ل`) : undefined} />
        <MetricCard label={tr(locale, "Average route time", "متوسط مدة الجولة")} value={durationLabel(locale, report.summary.averageRouteMinutes)} hint={tr(locale, "From route start to completion when both times exist", "من بداية الجولة إلى إكمالها عند توفر الوقتين")} />
      </div>
    </section>

    {unitsAvailable ? <section className="surface-card p-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-semibold text-slate-950">{tr(locale, "Daily filling activity", "نشاط التعبئة اليومي")}</h2><p className="text-sm text-slate-500">{tr(locale, "Actual units filled on each route business day.", "الوحدات الفعلية التي تمت تعبئتها في كل يوم تشغيل.")}</p></div><div className="text-sm font-medium text-slate-600">{tr(locale, `${report.days.filter((day) => day.fillVisits > 0).length} active days`, `${integer(locale, report.days.filter((day) => day.fillVisits > 0).length)} أيام نشطة`)}</div></div>
      <div className="mt-6 flex h-40 items-end gap-1.5 rounded-xl border border-slate-100 bg-slate-50 px-3 pt-4">{report.days.map((day) => { const height = day.filled > 0 ? Math.max(5, Math.round((day.filled / maxDailyFilled) * 100)) : 2; return <div key={day.date} className="group flex h-full min-w-0 flex-1 items-end" title={tr(locale, `${dateLabel(locale, day.date)}: ${integer(locale, day.filled)} units, ${integer(locale, day.fillVisits)} fills`, `${dateLabel(locale, day.date)}: ${integer(locale, day.filled)} وحدة، ${integer(locale, day.fillVisits)} تعبئة`)}><div className="w-full rounded-t bg-[var(--snacky-primary)] opacity-80 transition group-hover:opacity-100" style={{ height: `${height}%` }} /></div>; })}</div>
      <div className="mt-2 flex justify-between text-xs text-slate-500"><span>{dateLabel(locale, report.days[0]?.date ?? null)}</span><span>{dateLabel(locale, report.days.at(-1)?.date ?? null)}</span></div>
    </section> : null}

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold text-slate-950">{tr(locale, "Operator performance", "أداء المشغلين")}</h2><p className="mt-1 text-sm text-slate-500">{tr(locale, "Completed routes, real machine fills, units, and exceptions by assigned operator.", "الجولات المكتملة والتعبئات الفعلية والوحدات والاستثناءات حسب المشغل المسند إليه العمل.")}</p>
      {!report.operators.length ? <EmptyState title={tr(locale, "No operator activity", "لا يوجد نشاط للمشغلين")} body={tr(locale, "Completed operator work will appear here.", "سيظهر عمل المشغلين المكتمل هنا.")} /> : <DataTable headers={[tr(locale, "Operator", "المشغل"), tr(locale, "Routes", "الجولات"), tr(locale, "Fills / visits", "التعبئة / الزيارات"), tr(locale, "Machines", "الأجهزة"), tr(locale, "Units filled", "الوحدات المعبأة"), tr(locale, "Returned / damaged", "المعاد / التالف"), tr(locale, "Partial / shortage", "الجزئي / النقص")] }>{report.operators.map((operator) => <tr key={operator.operatorId}><td><Link className="link-secondary font-semibold" href={`/team/${operator.operatorId}`}>{operatorById.get(operator.operatorId) ?? tr(locale, "Unknown operator", "مشغل غير معروف")}</Link></td><td><span className="font-semibold">{integer(locale, operator.completedRoutes)}</span><span className="text-slate-400"> / {integer(locale, operator.assignedRoutes)}</span></td><td><span className="font-semibold">{integer(locale, operator.fillVisits)}</span><span className="text-slate-400"> / {integer(locale, operator.completedVisits)}</span></td><td>{integer(locale, operator.uniqueMachines)}</td><td className="font-semibold">{unitsAvailable ? integer(locale, operator.filled) : "—"}</td><td>{unitsAvailable ? `${integer(locale, operator.returned)} / ${integer(locale, operator.damaged)}` : "—"}</td><td>{refillStatusAvailable || fillAuditAvailable ? `${refillStatusAvailable ? integer(locale, operator.partialFills) : "—"} / ${fillAuditAvailable ? integer(locale, operator.shortageUnits) : "—"}` : "—"}</td></tr>)}</DataTable>}
    </section>

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold text-slate-950">{tr(locale, "Machine refill frequency", "تكرار تعبئة الأجهزة")}</h2><p className="mt-1 text-sm text-slate-500">{tr(locale, "How often each machine was visited, actually filled, and how many units it received.", "عدد زيارات كل جهاز وتعبئته فعلياً وعدد الوحدات التي استلمها.")}</p>
      {!report.machines.length ? <EmptyState title={tr(locale, "No machine activity", "لا يوجد نشاط للأجهزة")} body={tr(locale, "Completed machine work will appear here.", "سيظهر عمل الأجهزة المكتمل هنا.")} /> : <DataTable headers={[tr(locale, "Machine", "الجهاز"), tr(locale, "Fills / visits", "التعبئة / الزيارات"), tr(locale, "Units filled", "الوحدات المعبأة"), tr(locale, "Full / partial", "كاملة / جزئية"), tr(locale, "Shortage", "النقص"), tr(locale, "Last service", "آخر خدمة"), tr(locale, "Operators", "المشغلون")] }>{report.machines.map((machine) => { const catalog = machineById.get(machine.machineId); return <tr key={machine.machineId}><td><Link className="link-secondary" href={`/machines/${machine.machineId}`}><span className="block font-semibold">{catalog?.name ?? tr(locale, "Unknown machine", "جهاز غير معروف")}</span>{catalog?.machine_code && catalog.machine_code !== catalog.name ? <span className="text-xs text-slate-500">{catalog.machine_code}</span> : null}</Link></td><td><span className="font-semibold">{integer(locale, machine.fillVisits)}</span><span className="text-slate-400"> / {integer(locale, machine.completedVisits)}</span></td><td className="font-semibold">{unitsAvailable ? integer(locale, machine.filledUnits) : "—"}</td><td>{refillStatusAvailable ? `${integer(locale, machine.fullFills)} / ${integer(locale, machine.partialFills)}` : "—"}</td><td>{fillAuditAvailable ? integer(locale, machine.shortageUnits) : "—"}</td><td>{dateLabel(locale, machine.lastServiceDate)}</td><td>{machine.operators.map((id) => operatorById.get(id)).filter(Boolean).join("، ") || "-"}</td></tr>; })}</DataTable>}
    </section>

    <section className="surface-card p-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-semibold text-slate-950">{tr(locale, "Routes needing attention", "الجولات التي تحتاج إلى متابعة")}</h2><p className="text-sm text-slate-500">{tr(locale, "Open, cancelled, skipped, partial, or issue-linked routes from this month.", "الجولات المفتوحة أو الملغاة أو المتخطاة أو الجزئية أو المرتبطة بمشكلة خلال هذا الشهر.")}</p></div><div className="text-sm font-medium text-slate-600">{integer(locale, report.attentionRoutes.length)}</div></div>
      {!report.attentionRoutes.length ? attentionCoverageAvailable
        ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">{tr(locale, "No route exceptions need attention for this month.", "لا توجد استثناءات في الجولات تحتاج إلى متابعة لهذا الشهر.")}</div>
        : <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">{tr(locale, "No workflow exceptions were found, but refill and shortage coverage is incomplete.", "لم يتم العثور على استثناءات في سير العمل، لكن بيانات التعبئة والنقص غير مكتملة.")}</div>
        : <DataTable headers={[tr(locale, "Date / route", "التاريخ / الجولة"), tr(locale, "Operator", "المشغل"), tr(locale, "Status", "الحالة"), tr(locale, "Stops", "المواقع"), tr(locale, "Units filled", "الوحدات المعبأة"), tr(locale, "Exceptions", "الاستثناءات")] }>{report.attentionRoutes.map((route) => { const exceptions = [route.partialFills ? tr(locale, `${route.partialFills} partial`, `${integer(locale, route.partialFills)} جزئية`) : null, route.skippedStops ? tr(locale, `${route.skippedStops} skipped`, `${integer(locale, route.skippedStops)} متخطاة`) : null, route.openStops ? tr(locale, `${route.openStops} open`, `${integer(locale, route.openStops)} مفتوحة`) : null, route.shortageUnits ? tr(locale, `${route.shortageUnits} shortage units`, `${integer(locale, route.shortageUnits)} وحدة نقص`) : null, route.zeroFillLines ? tr(locale, `${route.zeroFillLines} zero-fill lines`, `${integer(locale, route.zeroFillLines)} أصناف بصفر`) : null, route.reviewLines ? tr(locale, `${route.reviewLines} review lines`, `${integer(locale, route.reviewLines)} أصناف للمراجعة`) : null, route.issueVisits ? tr(locale, `${route.issueVisits} issue visits`, `${integer(locale, route.issueVisits)} زيارات بها مشكلة`) : null].filter(Boolean).join(" · "); return <tr key={route.routeId}><td><Link href={`/routes/${route.routeId}`} className="link-secondary"><span className="block font-semibold">{dateLabel(locale, route.routeDate)}</span><span className="text-xs text-slate-500">{route.routeId.slice(0, 8)}</span></Link></td><td>{route.operatorId ? operatorById.get(route.operatorId) ?? tr(locale, "Unknown operator", "مشغل غير معروف") : tr(locale, "Unassigned", "غير مسندة")}</td><td><StatusBadge status={route.status} label={statusLabel(locale, route.status)} /></td><td><span className="font-semibold">{integer(locale, route.completedStops)}</span><span className="text-slate-400"> / {integer(locale, route.totalStops)}</span></td><td>{unitsAvailable ? integer(locale, route.filled) : "—"}</td><td className="max-w-xs text-sm text-slate-600">{exceptions || route.cancellationReason || "-"}</td></tr>; })}</DataTable>}
    </section>
  </div>;
}
