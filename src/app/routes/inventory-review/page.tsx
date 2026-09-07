import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  DataTable,
  EmptyState,
  ErrorState,
  MobileCardList,
  MobileField,
  MobileRecordCard,
  PageHeader,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isAdminRole } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { reviewRouteInventoryDiscrepancy } from "@/lib/route-inventory-discrepancy-actions";
import {
  ROUTE_INVENTORY_CLOSED_STATUSES,
  ROUTE_INVENTORY_OPEN_STATUSES,
  isMissingRouteInventoryReviewSchema,
  routeInventoryDiscrepancyHasCorrection,
  routeInventoryDiscrepancyStatusLabel,
  routeInventoryDiscrepancyTypeLabel,
  routeInventoryErrorText,
  type RouteInventoryDiscrepancyRow,
  type RouteInventoryReconciliationLineEvidence,
} from "@/lib/route-inventory-discrepancies";

export const dynamic = "force-dynamic";

const REVIEW_PATH = "/routes/inventory-review";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewSearchParams = {
  view?: string;
  route?: string;
  success?: string;
  error?: string;
};

type RouteRow = { id: string; route_date: string | null; status: string | null };
type StopRow = { id: string; stop_order: number | null };
type MachineRow = { id: string; name: string | null; machine_code: string | null };
type OperatorRow = { id: string; full_name: string | null };
type ProductRow = { id: string; name: string | null; sku: string | null };

function uniqueIds(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function formatQuantity(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.trunc(number).toLocaleString("en-US") : "0";
}

function formatDifference(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  const whole = Math.trunc(number);
  return `${whole > 0 ? "+" : ""}${whole.toLocaleString("en-US")}`;
}

function formatDateTime(value: unknown, locale: "en" | "ar") {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function reviewHref(view: "open" | "history", routeId?: string | null) {
  const params = new URLSearchParams();
  if (view === "history") params.set("view", view);
  if (routeId) params.set("route", routeId);
  const query = params.toString();
  return query ? `${REVIEW_PATH}?${query}` : REVIEW_PATH;
}

function sourceLabel(value: unknown, locale: "en" | "ar") {
  const source = String(value ?? "");
  if (source === "route_stop_inventory_commit") return locale === "ar" ? "إكمال موقع الجولة" : "Route stop completion";
  if (source === "route_terminal_reconciliation_line") return locale === "ar" ? "تسوية نهاية الجولة" : "End-of-route reconciliation";
  return source.replaceAll("_", " ") || "-";
}

function localizedMessage(message: string, locale: "en" | "ar") {
  if (locale !== "ar" || !message) return message;
  const exact: Record<string, string> = {
    "Inventory discrepancy moved into investigation.": "تم نقل فرق المخزون إلى حالة التحقيق.",
    "Reconciled inventory variance accepted and closed.": "تم اعتماد فرق المخزون الذي تمت تسويته وإغلاقه.",
    "Inventory discrepancy reopened for review.": "تمت إعادة فتح فرق المخزون للمراجعة.",
    "This discrepancy changed. Refresh the page and review its latest status.": "تم تعديل هذا الفرق. حدّث الصفحة وراجع أحدث حالة.",
    "This variance cannot be accepted until its correcting inventory movement is linked.": "لا يمكن اعتماد هذا الفرق حتى يتم ربط حركة تصحيح المخزون.",
    "This discrepancy is no longer in the required review state. Refresh and try again.": "لم يعد هذا الفرق في حالة المراجعة المطلوبة. حدّث الصفحة وحاول مرة أخرى.",
    "You do not have permission to review this inventory discrepancy.": "ليس لديك صلاحية مراجعة فرق المخزون هذا.",
    "The inventory discrepancy review could not be saved. Refresh and try again.": "تعذر حفظ مراجعة فرق المخزون. حدّث الصفحة وحاول مرة أخرى.",
    "A valid route inventory discrepancy is required.": "يلزم تحديد فرق صالح في مخزون الجولة.",
    "Select a valid inventory review action.": "اختر إجراءً صالحًا لمراجعة المخزون.",
    "The review submission is missing its safety key. Refresh and try again.": "يفتقد طلب المراجعة إلى مفتاح الأمان. حدّث الصفحة وحاول مرة أخرى.",
    "Review notes are required for this action.": "ملاحظات المراجعة مطلوبة لهذا الإجراء.",
    "Supabase is not configured.": "لم يتم إعداد Supabase.",
    "Inventory discrepancy review is not installed in the database yet.": "مراجعة فروق المخزون غير مثبتة في قاعدة البيانات بعد.",
  };
  const reusedSuffix = " The earlier saved result was reused safely.";
  if (message.endsWith(reusedSuffix)) {
    const base = message.slice(0, -reusedSuffix.length);
    return `${exact[base] ?? base} تم استخدام النتيجة المحفوظة سابقًا بأمان.`;
  }
  return exact[message] ?? message;
}

function ReviewActions({
  row,
  evidence,
  returnTo,
  locale,
}: {
  row: RouteInventoryDiscrepancyRow;
  evidence?: RouteInventoryReconciliationLineEvidence | null;
  returnTo: string;
  locale: "en" | "ar";
}) {
  const tr = (en: string, ar: string) => (locale === "ar" ? ar : en);
  const commonFields = [
    { name: "discrepancy_id", value: row.id },
    { name: "route_id", value: row.route_id },
    { name: "expected_updated_at", value: row.updated_at },
    { name: "return_to", value: returnTo },
  ];
  const submissionId = (action: string) => `route-inventory-review:${action}:${row.id}:${row.updated_at}`;
  const hiddenFields = (action: string) => [
    ...commonFields,
    { name: "review_action", value: action },
    { name: "client_submission_id", value: submissionId(action) },
  ];

  if (row.status === "open") {
    return (
      <div className="space-y-2">
        <ConfirmDialog
          action={reviewRouteInventoryDiscrepancy}
          triggerLabel={tr("Start investigation", "بدء التحقيق")}
          title={tr("Start investigating this difference?", "بدء التحقيق في هذا الفرق؟")}
          description={tr("The case will stay open and no inventory quantity will change.", "ستبقى الحالة مفتوحة ولن تتغير أي كمية في المخزون.")}
          confirmLabel={tr("Start investigation", "بدء التحقيق")}
          pendingConfirmLabel={tr("Saving...", "جارٍ الحفظ...")}
          cancelLabel={tr("Cancel", "إلغاء")}
          reasonLabel={tr("Initial note", "ملاحظة أولية")}
          reasonPlaceholder={tr("Optional context for the reviewer.", "معلومات اختيارية للمراجع.")}
          requireReason={false}
          buttonClassName="btn-secondary w-full"
          confirmButtonClassName="btn-primary"
          hiddenFields={hiddenFields("start_investigation")}
        />
        {routeInventoryDiscrepancyHasCorrection(row, evidence) ? (
          <AcceptAction row={row} locale={locale} hiddenFields={hiddenFields("accept_reconciled_variance")} />
        ) : (
          <p className="text-xs text-amber-800">{tr("Link the correcting ledger movement before closing this case.", "اربط حركة تصحيح السجل قبل إغلاق هذه الحالة.")}</p>
        )}
      </div>
    );
  }

  if (row.status === "investigating") {
    return routeInventoryDiscrepancyHasCorrection(row, evidence) ? (
      <AcceptAction row={row} locale={locale} hiddenFields={hiddenFields("accept_reconciled_variance")} />
    ) : (
      <p className="text-xs text-amber-800">{tr("Still waiting for a linked correcting movement.", "لا تزال الحالة بانتظار حركة تصحيح مرتبطة.")}</p>
    );
  }

  return (
    <ConfirmDialog
      action={reviewRouteInventoryDiscrepancy}
      triggerLabel={tr("Reopen review", "إعادة فتح المراجعة")}
      title={tr("Reopen this inventory review?", "إعادة فتح مراجعة المخزون؟")}
      description={tr("This reopens review status only. Existing inventory movements will not be changed or reversed.", "سيؤدي هذا إلى إعادة فتح حالة المراجعة فقط. لن تتغير حركات المخزون الحالية ولن يتم عكسها.")}
      confirmLabel={tr("Reopen", "إعادة الفتح")}
      pendingConfirmLabel={tr("Reopening...", "جارٍ إعادة الفتح...")}
      cancelLabel={tr("Cancel", "إلغاء")}
      reasonLabel={tr("Reason for reopening", "سبب إعادة الفتح")}
      reasonPlaceholder={tr("Explain what needs another review.", "اشرح ما يحتاج إلى مراجعة أخرى.")}
      buttonClassName="btn-secondary w-full"
      confirmButtonClassName="btn-primary"
      hiddenFields={hiddenFields("reopen")}
    />
  );
}

function AcceptAction({
  row,
  locale,
  hiddenFields,
}: {
  row: RouteInventoryDiscrepancyRow;
  locale: "en" | "ar";
  hiddenFields: Array<{ name: string; value: string }>;
}) {
  const tr = (en: string, ar: string) => (locale === "ar" ? ar : en);
  return (
    <ConfirmDialog
      action={reviewRouteInventoryDiscrepancy}
      triggerLabel={tr("Accept reconciled variance", "اعتماد الفرق الذي تمت تسويته")}
      title={tr("Accept and close this reconciled variance?", "اعتماد وإغلاق هذا الفرق الذي تمت تسويته؟")}
      description={tr(
        `A correcting movement is already linked for ${formatQuantity(row.absolute_quantity)} unit(s). This action records review approval only and will not move inventory.`,
        `توجد حركة تصحيح مرتبطة بالفعل لعدد ${formatQuantity(row.absolute_quantity)} وحدة. يسجل هذا الإجراء موافقة المراجعة فقط ولن ينقل المخزون.`,
      )}
      confirmLabel={tr("Accept and close", "اعتماد وإغلاق")}
      pendingConfirmLabel={tr("Closing review...", "جارٍ إغلاق المراجعة...")}
      cancelLabel={tr("Cancel", "إلغاء")}
      reasonLabel={tr("Review notes", "ملاحظات المراجعة")}
      reasonPlaceholder={tr("Explain why the existing correction is accepted.", "اشرح سبب اعتماد التصحيح الحالي.")}
      buttonClassName="btn-primary w-full"
      confirmButtonClassName="btn-primary"
      hiddenFields={hiddenFields}
    />
  );
}

export default async function RouteInventoryReviewPage({
  searchParams,
}: {
  searchParams: Promise<ReviewSearchParams>;
}) {
  const { locale } = await getServerI18n();
  const tr = (en: string, ar: string) => (locale === "ar" ? ar : en);
  const profile = await getCurrentProfile();
  if (!profile || !isAdminRole(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const view: "open" | "history" = params.view === "history" ? "history" : "open";
  const routeFilter = UUID_PATTERN.test(String(params.route ?? "")) ? String(params.route) : null;
  const returnTo = reviewHref(view, routeFilter);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return <ErrorState title={tr("Inventory review unavailable", "مراجعة المخزون غير متاحة")} body={tr("Supabase is not configured.", "لم يتم إعداد Supabase.")} />;
  }

  const statuses = view === "history" ? ROUTE_INVENTORY_CLOSED_STATUSES : ROUTE_INVENTORY_OPEN_STATUSES;
  let discrepancyQuery = supabase
    .from("route_inventory_discrepancies")
    .select("id, route_id, route_stop_id, machine_id, operator_id, product_id, discrepancy_type, recorded_quantity, actual_quantity, difference_quantity, absolute_quantity, status, source_type, source_id, details, detected_at, resolution_type, resolution_notes, resolved_at, correcting_movement_id, updated_at", { count: "exact" })
    .in("status", [...statuses])
    .order("detected_at", { ascending: false })
    .limit(100);
  if (routeFilter) discrepancyQuery = discrepancyQuery.eq("route_id", routeFilter);
  const discrepancyResult = await discrepancyQuery;

  if (discrepancyResult.error) {
    if (isMissingRouteInventoryReviewSchema(discrepancyResult.error)) {
      return (
        <>
          <PageHeader
            title={tr("Route inventory review", "مراجعة مخزون الجولات")}
            subtitle={tr("Review and close route inventory differences without changing stock outside its protected workflows.", "راجع فروق مخزون الجولات وأغلقها دون تغيير المخزون خارج مساراته المحمية.")}
            action={<SecondaryButton href="/routes">{tr("Back to routes", "العودة إلى الجولات")}</SecondaryButton>}
          />
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
            <div className="font-semibold">{tr("Inventory review is not installed yet", "مراجعة المخزون غير مثبتة بعد")}</div>
            <p className="mt-2">{tr("Apply the current route inventory migrations, then reload this page. Route creation and existing route records are unchanged.", "طبّق ترحيلات مخزون الجولات الحالية، ثم أعد تحميل هذه الصفحة. لن تتغير عملية إنشاء الجولات أو سجلات الجولات الحالية.")}</p>
          </div>
        </>
      );
    }
    console.error("[route-inventory-review] Discrepancy queue failed", discrepancyResult.error);
    return (
      <ErrorState
        title={tr("Could not load route inventory review", "تعذر تحميل مراجعة مخزون الجولات")}
        body={tr("The review query failed. Refresh the page; if it repeats, check discrepancy table access.", "فشل استعلام المراجعة. حدّث الصفحة؛ وإذا تكرر الخطأ فتحقق من صلاحيات جدول الفروقات.")}
        action={<SecondaryButton href={returnTo}>{tr("Retry", "إعادة المحاولة")}</SecondaryButton>}
      />
    );
  }

  const rows = (discrepancyResult.data ?? []) as RouteInventoryDiscrepancyRow[];
  const routeIds = uniqueIds(rows.map((row) => row.route_id));
  const stopIds = uniqueIds(rows.map((row) => row.route_stop_id));
  const machineIds = uniqueIds(rows.map((row) => row.machine_id));
  const operatorIds = uniqueIds(rows.map((row) => row.operator_id));
  const productIds = uniqueIds(rows.map((row) => row.product_id));
  const discrepancyIds = rows.map((row) => row.id);

  const [routesResult, stopsResult, machinesResult, operatorsResult, productsResult, evidenceResult] = await Promise.all([
    routeIds.length ? supabase.from("routes").select("id, route_date, status").in("id", routeIds) : Promise.resolve({ data: [], error: null }),
    stopIds.length ? supabase.from("route_stops").select("id, stop_order").in("id", stopIds) : Promise.resolve({ data: [], error: null }),
    machineIds.length ? supabase.from("machines").select("id, name, machine_code").in("id", machineIds) : Promise.resolve({ data: [], error: null }),
    operatorIds.length ? supabase.from("team_members").select("id, full_name").in("id", operatorIds) : Promise.resolve({ data: [], error: null }),
    productIds.length ? supabase.from("products").select("id, name, sku").in("id", productIds) : Promise.resolve({ data: [], error: null }),
    discrepancyIds.length
      ? supabase.from("route_inventory_reconciliation_lines").select("discrepancy_id, adjustment_movement_id, return_movement_id, review_status").in("discrepancy_id", discrepancyIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const relatedErrors = [routesResult.error, stopsResult.error, machinesResult.error, operatorsResult.error, productsResult.error, evidenceResult.error].filter(Boolean);
  if (relatedErrors.length) {
    console.error("[route-inventory-review] Related context partially failed", relatedErrors.map(routeInventoryErrorText));
  }

  const routeById = new Map(((routesResult.data ?? []) as RouteRow[]).map((row) => [row.id, row]));
  const stopById = new Map(((stopsResult.data ?? []) as StopRow[]).map((row) => [row.id, row]));
  const machineById = new Map(((machinesResult.data ?? []) as MachineRow[]).map((row) => [row.id, row]));
  const operatorById = new Map(((operatorsResult.data ?? []) as OperatorRow[]).map((row) => [row.id, row]));
  const productById = new Map(((productsResult.data ?? []) as ProductRow[]).map((row) => [row.id, row]));
  const evidenceByDiscrepancyId = new Map(
    ((evidenceResult.data ?? []) as RouteInventoryReconciliationLineEvidence[])
      .filter((row) => row.discrepancy_id)
      .map((row) => [String(row.discrepancy_id), row]),
  );
  const totalUnits = rows.reduce((sum, row) => sum + Math.max(0, Number(row.absolute_quantity ?? 0)), 0);
  const investigatingCount = rows.filter((row) => row.status === "investigating").length;

  const contextFor = (row: RouteInventoryDiscrepancyRow) => {
    const route = routeById.get(row.route_id);
    const stop = row.route_stop_id ? stopById.get(row.route_stop_id) : null;
    const machine = row.machine_id ? machineById.get(row.machine_id) : null;
    const operator = row.operator_id ? operatorById.get(row.operator_id) : null;
    const product = productById.get(row.product_id);
    return { route, stop, machine, operator, product };
  };

  const actionsFor = (row: RouteInventoryDiscrepancyRow) => (
    <ReviewActions row={row} evidence={evidenceByDiscrepancyId.get(row.id)} returnTo={returnTo} locale={locale} />
  );

  return (
    <>
      <PageHeader
        title={tr("Route inventory review", "مراجعة مخزون الجولات")}
        subtitle={tr("Review recorded-versus-actual route stock differences. Review actions never move stock.", "راجع فروق مخزون الجولات بين الكمية المسجلة والكمية الفعلية. إجراءات المراجعة لا تنقل المخزون.")}
        breadcrumbs={[{ label: tr("Operations", "العمليات"), href: "/routes" }, { label: tr("Inventory review", "مراجعة المخزون") }]}
        action={<SecondaryButton href={routeFilter ? `/routes/${routeFilter}` : "/routes"}>{routeFilter ? tr("Back to route", "العودة إلى الجولة") : tr("Back to routes", "العودة إلى الجولات")}</SecondaryButton>}
      />

      {params.success ? <div role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{localizedMessage(params.success, locale)}</div> : null}
      {params.error ? <div role="alert" className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-900">{localizedMessage(params.error, locale)}</div> : null}
      {relatedErrors.length ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          {tr("Some names or reconciliation evidence could not load. Cases remain visible, but closing is disabled unless correction evidence is verified.", "تعذر تحميل بعض الأسماء أو أدلة التسوية. تظل الحالات ظاهرة، لكن الإغلاق معطل ما لم يتم التحقق من دليل التصحيح.")}
        </div>
      ) : null}

      <div className="mb-5 flex flex-wrap gap-2">
        <Link href={reviewHref("open", routeFilter)} aria-current={view === "open" ? "page" : undefined} className={view === "open" ? "btn-primary" : "btn-secondary"}>{tr("Open review", "المراجعات المفتوحة")}</Link>
        <Link href={reviewHref("history", routeFilter)} aria-current={view === "history" ? "page" : undefined} className={view === "history" ? "btn-primary" : "btn-secondary"}>{tr("History", "السجل")}</Link>
      </div>

      <section className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="surface-card p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{view === "open" ? tr("Cases needing review", "حالات تحتاج إلى مراجعة") : tr("Closed cases", "الحالات المغلقة")}</div><div className="mt-2 text-3xl font-semibold text-slate-950">{discrepancyResult.count ?? rows.length}</div></div>
        <div className="surface-card p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Units in cases shown", "الوحدات في الحالات المعروضة")}</div><div className="mt-2 text-3xl font-semibold text-slate-950">{formatQuantity(totalUnits)}</div></div>
        <div className="surface-card p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Shown cases investigating", "الحالات المعروضة قيد التحقيق")}</div><div className="mt-2 text-3xl font-semibold text-slate-950">{view === "open" ? investigatingCount : "-"}</div></div>
      </section>

      {!rows.length ? (
        <EmptyState
          title={view === "open" ? tr("No route inventory differences need review", "لا توجد فروق في مخزون الجولات تحتاج إلى مراجعة") : tr("No closed inventory reviews", "لا توجد مراجعات مخزون مغلقة")}
          body={view === "open" ? tr("New discrepancies will appear here automatically when a protected route workflow records one.", "ستظهر الفروقات الجديدة هنا تلقائيًا عندما يسجلها مسار جولة محمي.") : tr("Closed and reopened review history will appear here.", "سيظهر هنا سجل المراجعات المغلقة والمعاد فتحها.")}
        />
      ) : (
        <>
          <MobileCardList>
            {rows.map((row) => {
              const context = contextFor(row);
              return (
                <MobileRecordCard key={row.id}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <Link href={`/routes/${row.route_id}`} className="font-semibold text-slate-950 hover:underline">{context.route?.route_date ?? tr("Route", "جولة")}</Link>
                      <div className="mt-1 text-xs text-slate-500">{formatDateTime(row.detected_at, locale)}</div>
                    </div>
                    <StatusBadge status={row.status} label={routeInventoryDiscrepancyStatusLabel(row.status, locale)} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label={tr("Difference", "الفرق")}><span className="font-semibold text-rose-700">{formatDifference(row.difference_quantity)}</span></MobileField>
                    <MobileField label={tr("Product", "المنتج")}>{context.product?.name ?? row.product_id.slice(0, 8)}</MobileField>
                    <MobileField label={tr("Recorded / actual", "المسجل / الفعلي")}>{formatQuantity(row.recorded_quantity)} / {formatQuantity(row.actual_quantity)}</MobileField>
                    <MobileField label={tr("Machine / stop", "الجهاز / الموقع")}>{context.machine?.name ?? context.machine?.machine_code ?? "-"}{context.stop?.stop_order ? ` · ${tr("Stop", "الموقع")} ${context.stop.stop_order}` : ""}</MobileField>
                    <MobileField label={tr("Operator", "المشغل")}>{context.operator?.full_name ?? "-"}</MobileField>
                    <MobileField label={tr("Type", "النوع")}>{routeInventoryDiscrepancyTypeLabel(row.discrepancy_type, locale)}</MobileField>
                    <MobileField label={tr("Source", "المصدر")}>{sourceLabel(row.source_type, locale)}</MobileField>
                    <MobileField label={tr("Correction evidence", "دليل التصحيح")}>{routeInventoryDiscrepancyHasCorrection(row, evidenceByDiscrepancyId.get(row.id)) ? tr("Linked", "مرتبط") : tr("Not linked", "غير مرتبط")}</MobileField>
                  </div>
                  {row.resolution_notes ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{row.resolution_notes}</p> : null}
                  <div className="mt-4">{actionsFor(row)}</div>
                </MobileRecordCard>
              );
            })}
          </MobileCardList>

          <DataTable className="hidden md:block" headers={[
            tr("Status", "الحالة"),
            tr("Route", "الجولة"),
            tr("Operator", "المشغل"),
            tr("Machine / stop", "الجهاز / الموقع"),
            tr("Product", "المنتج"),
            tr("Recorded", "المسجل"),
            tr("Actual", "الفعلي"),
            tr("Difference", "الفرق"),
            tr("Detected", "وقت الاكتشاف"),
            tr("Review", "المراجعة"),
          ]}>
            {rows.map((row) => {
              const context = contextFor(row);
              return (
                <tr key={row.id}>
                  <td><StatusBadge status={row.status} label={routeInventoryDiscrepancyStatusLabel(row.status, locale)} /><div className="mt-1 max-w-44 text-xs text-slate-500">{routeInventoryDiscrepancyTypeLabel(row.discrepancy_type, locale)}</div></td>
                  <td><Link href={`/routes/${row.route_id}`} className="link-secondary">{context.route?.route_date ?? row.route_id.slice(0, 8)}</Link><div className="text-xs text-slate-500">{context.route?.status?.replaceAll("_", " ") ?? "-"}</div></td>
                  <td>{context.operator?.full_name ?? "-"}</td>
                  <td>{context.machine?.name ?? context.machine?.machine_code ?? "-"}<div className="text-xs text-slate-500">{context.stop?.stop_order ? `${tr("Stop", "الموقع")} ${context.stop.stop_order}` : "-"}</div></td>
                  <td>{context.product?.name ?? row.product_id.slice(0, 8)}<div className="text-xs text-slate-500">{context.product?.sku ?? sourceLabel(row.source_type, locale)}</div></td>
                  <td>{formatQuantity(row.recorded_quantity)}</td>
                  <td>{formatQuantity(row.actual_quantity)}</td>
                  <td className="font-semibold text-rose-700">{formatDifference(row.difference_quantity)}</td>
                  <td>{formatDateTime(row.detected_at, locale)}</td>
                  <td><div className="min-w-48">{actionsFor(row)}</div></td>
                </tr>
              );
            })}
          </DataTable>

          {Number(discrepancyResult.count ?? 0) > rows.length ? (
            <p className="mt-4 text-sm text-slate-500">{tr("Showing the first 100 cases. Close older reviews or filter to one route to narrow the queue.", "يتم عرض أول 100 حالة. أغلق المراجعات الأقدم أو اختر جولة واحدة لتضييق القائمة.")}</p>
          ) : null}
        </>
      )}
    </>
  );
}
