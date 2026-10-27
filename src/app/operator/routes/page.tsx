import Link from "next/link";
import { OwnerQaRouteCard } from "@/components/operator/OwnerQaRouteCard";
import { prioritizeAssignedOperatorRoutes, routeQueueItem, type RouteQueueUrgency } from "@/lib/operator-route-list-focus";
import { redirect } from "next/navigation";
import { NotificationCenter } from "@/components/NotificationCenter";
import OperatorInstructionsPanel from "@/components/operator/OperatorInstructionsPanel";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SecondaryButton,
  SectionCard,
  StatusBadge,
} from "@/components/ui";
import {
  getAuthenticatedSupabaseServerClient,
  getCurrentProfile,
} from "@/lib/auth";
import {
  canExecuteRoutes,
  canManageOperations,
  hasRole,
  isOwnerAdminRole,
} from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { loadAccessibleOperatorIds } from "@/lib/operator-route-access";
import {
  type OperatorRoutePreviewRow,
  type OperatorRoutePreviewStopRow,
} from "@/lib/operator-route-types";
import {
  isOperatorVisibleRouteStatus,
  isTerminalRouteStatus,
  routeDisplayStatus,
} from "@/lib/route-workflow";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

function errorSummary(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const row = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return {
    code: row.code ?? null,
    message: row.message ?? null,
    details: row.details ?? null,
    hint: row.hint ?? null,
  };
}

function missingDbObjectName(error: unknown) {
  const summary = errorSummary(error);
  const text = [summary?.code, summary?.message, summary?.details, summary?.hint]
    .map((value) => String(value ?? ""))
    .join(" ");
  return (
    text.match(/relation "([^"]+)"/i)?.[1] ??
    text.match(/column "([^"]+)"/i)?.[1] ??
    null
  );
}

function logRouteLoaderIssue({
  step,
  query,
  error,
  context,
  optional = false,
}: {
  step: string;
  query: string;
  error: unknown;
  context: Record<string, unknown>;
  optional?: boolean;
}) {
  const summary = errorSummary(error);
  const payload = {
    ...context,
    loader_step: step,
    loader_query: query,
    optional_data_failed: optional,
    db_error_code: summary?.code ?? null,
    db_error_message: summary?.message ?? null,
    db_error_details: summary?.details ?? null,
    db_error_hint: summary?.hint ?? null,
    missing_relation_or_column: missingDbObjectName(error),
  };
  (optional ? console.warn : console.error)(
    `[operator:routes] ${step} failed`,
    payload,
  );
}

const urgencyText: Record<RouteQueueUrgency, { en: string; ar: string }> = {
  in_progress: { en: "In progress", ar: "قيد التنفيذ" },
  overdue: { en: "Scheduled date passed", ar: "تجاوز تاريخها" },
  today: { en: "Scheduled today", ar: "مجدولة اليوم" },
  upcoming: { en: "Upcoming", ar: "قادمة" },
  date_unverified: { en: "Date unverified", ar: "التاريخ غير مؤكد" },
};

function RouteCard({
  route,
  t,
  locale,
  todayTripoli,
  stopsVerified,
}: {
  route: OperatorRoutePreviewRow;
  t: (key: string, fallback?: string) => string;
  locale: "ar" | "en";
  todayTripoli: string;
  stopsVerified: boolean;
}) {
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const item = routeQueueItem(route, todayTripoli, stopsVerified);
  const { doneStops, totalStops, unfinishedStops, progressPercent, urgency } = item;
  const routeStatus = routeDisplayStatus(route.status, route.operator_id);
  const isTerminal = isTerminalRouteStatus(route.status);
  const isHighPriority = !isTerminal && (urgency === "in_progress" || urgency === "overdue");
  const progressUnavailable = progressPercent === null;
  const urgencyLabel = locale === "ar" ? urgencyText[urgency].ar : urgencyText[urgency].en;

  return (
    <Link href={`/operator/routes/${route.id}`}
      className={isHighPriority
        ? "group block rounded-xl border border-emerald-200 border-s-4 border-s-emerald-700 bg-white p-4 shadow-sm transition hover:border-emerald-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
        : "group block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-emerald-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-slate-950"><span dir="ltr" className="inline-block tabular-nums">{route.route_date || tr("Unscheduled", "بدون تاريخ")}</span></h3>
          {!isTerminal ? (
            <p className={isHighPriority ? "mt-1 text-xs font-semibold text-emerald-800" : "mt-1 text-xs font-medium text-slate-600"}>{urgencyLabel}</p>
          ) : null}
        </div>
        <StatusBadge status={routeStatus} label={t(routeStatus, routeStatus)} />
      </div>

      {progressUnavailable ? (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {totalStops === 0
            ? tr("No machine stops configured", "لا توجد مواقع أجهزة مسجلة")
            : tr("Stop progress unverified — open route to inspect", "تقدم المواقع غير مؤكد — افتح الجولة للمراجعة")}
        </p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">{tr("Completed or skipped", "المكتملة أو المتخطاة")}</span>
            <strong dir="ltr" className="tabular-nums text-slate-950">{doneStops} / {totalStops}</strong>
          </div>
          <div role="progressbar"
            aria-label={tr("Stops completed or skipped", "المواقع المكتملة أو المتخطاة")}
            aria-valuemin={0} aria-valuemax={Math.max(1,totalStops ?? 0)} aria-valuenow={doneStops ?? 0}
            className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-emerald-600" style={{width: `${progressPercent}%`}} />
          </div>
          {!isTerminal ? <p className="mt-2 text-sm font-semibold text-slate-800">
            {tr(`${unfinishedStops} unfinished machine stops`, `${unfinishedStops} مواقع لم تنتهِ بعد`)}
          </p> : null}
        </>
      )}
      <span className="mt-3 block border-t border-slate-100 pt-3 text-sm font-semibold text-emerald-800 group-hover:underline">
        {tr("Open route", "فتح الجولة")}
      </span>
    </Link>
  );
}

export default async function OperatorRoutesPage({ searchParams }: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const filters = await searchParams;
  const rawView = Array.isArray(filters?.view) ? filters?.view[0] : filters?.view;
  const availableView = rawView === "available";
  const { t, locale } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const tripoliToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();

  if (!profile || !canExecuteRoutes(profile)) redirect("/unauthorized");
  if (!supabase) {
    return (
      <ErrorState
        title={t("Routes unavailable")}
        body={t(
          "Supabase is not configured, so Snacky OS cannot load operator routes.",
        )}
      />
    );
  }

  const canManageAllRoutes = canManageOperations(profile);
  const canAssignInstructions = isOwnerAdminRole(profile);
  const accessibleOperatorIds = await loadAccessibleOperatorIds(
    supabase,
    profile,
  );
  const routeReadClient = getSupabaseAdminClient() ?? supabase;
  const loaderContext = {
    page_module: "src/app/operator/routes/page.tsx",
    current_user_id: profile.id,
    current_user_role: profile.role,
    operator_profile_id: profile.team_member_id ?? null,
    route_status_filter: "assigned|available|completed",
    assignment_filter: canManageAllRoutes
      ? "all_routes"
      : "accessible_operator_ids",
  };
  const routeSelect = "id, route_date, status, operator_id";

  const assignedQuery = canManageAllRoutes
    ? routeReadClient
        .from("routes")
        .select(routeSelect, { count: "exact" })
        .not("operator_id", "is", null)
        .order("route_date", { ascending: false })
    : accessibleOperatorIds.length
      ? routeReadClient
          .from("routes")
          .select(routeSelect, { count: "exact" })
          .in("operator_id", accessibleOperatorIds)
          .order("route_date", { ascending: false })
      : Promise.resolve({ data: [], count: 0, error: null });
  const availableQuery = routeReadClient
    .from("routes")
    .select(routeSelect, { count: "exact" })
    .is("operator_id", null)
    .order("route_date", { ascending: true });
  const [assignedResult, availableResult] = await Promise.all([
    assignedQuery,
    availableQuery,
  ]);

  const assignedRoutesError = assignedResult.error ?? null;
  const availableRoutesError = availableResult.error ?? null;
  // A server-side PostgREST row cap can return fewer routes than exist
  // without an error. Never hide open work behind an apparently complete list.
  const assignedCount = "count" in assignedResult ? assignedResult.count : null;
  const assignedQueryExpected = canManageAllRoutes || accessibleOperatorIds.length > 0;
  const assignedRoutesIncomplete = !assignedRoutesError && assignedQueryExpected
    && (typeof assignedCount !== "number" || assignedCount !== (assignedResult.data?.length ?? 0));
  const availableRoutesIncomplete = !availableRoutesError
    && (typeof availableResult.count !== "number"
      || availableResult.count !== (availableResult.data?.length ?? 0));
  if (assignedRoutesIncomplete || availableRoutesIncomplete) {
    console.error("[operator:routes] Route query incomplete; refusing partial assignment list", {
      assigned_expected: assignedCount,
      assigned_received: assignedResult.data?.length ?? 0,
      available_expected: availableResult.count,
      available_received: availableResult.data?.length ?? 0,
    });
    return <ErrorState title={tr("Route list incomplete", "قائمة الجولات غير مكتملة")}
      body={tr("The database returned only part of the route list. Refresh or ask a manager to check the source before relying on it.",
        "أعاد النظام جزءاً فقط من قائمة الجولات. حدّث الصفحة أو اطلب مراجعة مصدر البيانات قبل الاعتماد عليها.")} />;
  }

  if (assignedRoutesError) {
    logRouteLoaderIssue({
      step: "load_assigned_routes",
      query: "routes",
      error: assignedRoutesError,
      context: { ...loaderContext, route_bucket: "assigned" },
      optional: !availableRoutesError,
    });
  }
  if (availableRoutesError) {
    logRouteLoaderIssue({
      step: "load_available_routes",
      query: "routes",
      error: availableRoutesError,
      context: { ...loaderContext, route_bucket: "available" },
      optional: !assignedRoutesError,
    });
  }
  if (assignedRoutesError && availableRoutesError) {
    return (
      <ErrorState
        title={t("Could not load routes")}
        body={t("Snacky OS could not load the operator route list.")}
      />
    );
  }

  const baseAssignedRoutes = assignedRoutesError
    ? []
    : ((assignedResult.data ?? []) as OperatorRoutePreviewRow[]);
  const baseAvailableRoutes = availableRoutesError
    ? []
    : ((availableResult.data ?? []) as OperatorRoutePreviewRow[]).filter(
        (route) => isOperatorVisibleRouteStatus(route.status),
      );
  const routeIds = Array.from(
    new Set(
      [...baseAssignedRoutes, ...baseAvailableRoutes]
        .map((route) => route.id)
        .filter(Boolean),
    ),
  );
  const { data: stopRows, error: stopsError, count: stopCount } = routeIds.length
    ? await routeReadClient
        .from("route_stops")
        .select("id, route_id, status, stop_order, machine_id", { count: "exact" })
        .in("route_id", routeIds)
        .order("stop_order", { ascending: true })
    : { data: [], error: null, count: 0 };

  const stopsVerified = !stopsError && typeof stopCount === "number" && Array.isArray(stopRows)
    && stopRows.length === stopCount
    && new Set(stopRows.map(stop => stop.id)).size === stopRows.length;
  if (!stopsError && !stopsVerified) {
    console.warn("[operator:routes] Incomplete stop history — progress will be unverified", {
      expected_count: stopCount,
      received_count: stopRows?.length ?? 0,
    });
  }
  if (stopsError || !stopsVerified) {
    logRouteLoaderIssue({
      step: "load_route_stop_summaries",
      query: "route_stops",
      error: stopsError,
      context: { ...loaderContext, route_ids: routeIds },
      optional: true,
    });
  }

  const stopsByRouteId = new Map<string, OperatorRoutePreviewStopRow[]>();
  if (stopsVerified) {
    (
      (stopRows ?? []) as (OperatorRoutePreviewStopRow & {
        route_id?: string | null;
      })[]
    ).forEach((stop) => {
      const routeId = String(stop.route_id ?? "");
      if (routeId) {
        stopsByRouteId.set(routeId, [
          ...(stopsByRouteId.get(routeId) ?? []),
          stop,
        ]);
      }
    });
  }

  const attachStops = (
    route: OperatorRoutePreviewRow,
  ): OperatorRoutePreviewRow => ({
    ...route,
    route_stops: stopsByRouteId.get(String(route.id)) ?? [],
  });
  const assignedRoutes = baseAssignedRoutes.map(attachStops);
  const availableRoutes = baseAvailableRoutes.map(attachStops);
  const assignedOpenRoutes = prioritizeAssignedOperatorRoutes(
    assignedRoutes.filter(route => !isTerminalRouteStatus(route.status)), tripoliToday, stopsVerified,
  ).map(item => item.route);
  const priorityRoute = assignedOpenRoutes[0] ?? null;
  const priorityRouteSummary = priorityRoute ? routeQueueItem(priorityRoute, tripoliToday, stopsVerified) : null;
  const completedRoutes = assignedRoutes
    .filter((route) => isTerminalRouteStatus(route.status))
    .sort((a, b) =>
      String(b.route_date ?? "").localeCompare(String(a.route_date ?? "")),
    );

  const headerAction = (
    <div className="flex items-center gap-2">
      {!canManageAllRoutes && profile.team_member_id ? (
        <SecondaryButton href={`/team/${profile.team_member_id}#my-money`}>
          {t("My Money")}
        </SecondaryButton>
      ) : null}
      <div className="hidden md:block">
        <NotificationCenter label={t("Notifications", "Notifications")} />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={availableView ? tr("Available Routes", "الجولات المتاحة") : canManageAllRoutes ? t("Operator Routes") : tr("My Routes", "جولاتي")}
        subtitle={availableView
          ? tr("Unassigned routes you can claim.", "الجولات غير المسندة التي تقدر تستلمها.")
          : canManageAllRoutes
            ? t("Assigned, unassigned, and completed routes across the team.")
            : tr("Your assigned routes, progress and completed history.", "جولاتك المسندة وتقدم العمل والسجل السابق.")
        }
        action={headerAction}
      />

      <nav className="flex flex-wrap gap-2" aria-label={tr("Route views", "عرض الجولات")}>
        <Link href="/operator/routes" aria-current={!availableView ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm font-semibold ${!availableView ? "border-emerald-600 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-white text-slate-700"}`}>
          {tr("Assigned", "المسندة")} ({assignedOpenRoutes.length})
        </Link>
        <Link href="/operator/routes?view=available" aria-current={availableView ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm font-semibold ${availableView ? "border-emerald-600 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-white text-slate-700"}`}>
          {tr("Available", "المتاحة")} ({availableRoutes.length})
        </Link>
      </nav>

      {!availableView && !assignedRoutesError && priorityRoute && priorityRouteSummary ? (
        <section aria-labelledby="operator-route-focus-title" className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 bg-emerald-950 p-4 text-white sm:p-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-amber-300">
                {tr(canManageAllRoutes ? "TEAM · ROUTE TO REVIEW" : "YOUR NEXT ROUTE", canManageAllRoutes ? "الفريق · جولة للمراجعة" : "جولتك التالية")}
              </p>
              <h2 id="operator-route-focus-title" className="mt-2 text-xl font-bold">
                {priorityRouteSummary.urgency === "in_progress"
                  ? tr("Resume an active route", "تابع جولة قيد التنفيذ")
                  : priorityRouteSummary.urgency === "overdue"
                    ? tr("Review an overdue route", "راجع جولة متأخرة")
                    : priorityRouteSummary.urgency === "today"
                      ? tr("Route scheduled today", "جولة مجدولة اليوم")
                      : tr("Next scheduled route", "الجولة المجدولة التالية")}
              </h2>
              <p dir="ltr" className="mt-1 inline-block font-semibold tabular-nums text-emerald-100">{priorityRoute.route_date ?? "—"}</p>
              <p className="mt-2 text-sm leading-6 text-emerald-100">
                {priorityRouteSummary.unfinishedStops === null
                  ? tr("Stop progress could not be verified.", "تعذر التحقق من تقدم المواقع.")
                  : priorityRouteSummary.totalStops === 0
                    ? tr("No machine stops are configured for this route.", "لا توجد مواقع أجهزة مسجلة لهذه الجولة.")
                    : tr(
                        String(priorityRouteSummary.unfinishedStops) + " stops unfinished; " + String(priorityRouteSummary.doneStops) + " completed or skipped.",
                        "متبقي " + priorityRouteSummary.unfinishedStops + " مواقع؛ المكتملة أو المتخطاة " + priorityRouteSummary.doneStops + ".",
                      )}
              </p>
            </div>
            <Link href={`/operator/routes/${priorityRoute.id}`}
              className="flex min-h-12 w-full shrink-0 items-center justify-center rounded-xl bg-amber-400 px-5 py-3 text-center text-sm font-bold text-slate-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-emerald-950 sm:w-auto">
              {tr("Open route", "فتح الجولة")}
            </Link>
          </div>
          <p className="px-4 py-3 text-xs leading-5 text-slate-600 sm:px-5">
            {tr("Active routes are shown first, followed by overdue and scheduled work. This does not assign routes or change stop order.", "تظهر الجولات الجارية أولاً ثم المتأخرة والمجدولة. هذا لا يغيّر التكليفات ولا ترتيب المواقع داخل الجولة.")}
          </p>
        </section>
      ) : null}

      {hasRole(profile, "owner") ? <OwnerQaRouteCard locale={locale} /> : null}

      {!stopsVerified ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          {tr("Stop counts could not be completely verified. No route progress or unfinished-stop count has been assumed to be zero.",
            "تعذر التحقق الكامل من أعداد المواقع. لم تُعتبر أعداد المواقع غير المنتهية أو تقدم الجولات صفراً.")}
        </div>
      ) : null}

      {assignedRoutesError || availableRoutesError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t(
            "Some route buckets are unavailable right now. Routes that loaded are still shown.",
          )}
        </div>
      ) : null}

      {!canManageAllRoutes || canAssignInstructions ? (
        <OperatorInstructionsPanel hideSetupWarning />
      ) : null}

      <SectionCard>
        <div className="grid grid-cols-3 gap-2 p-3 sm:gap-4 sm:p-4">
          <div>
            <div className="text-sm text-slate-500">{t("Open assigned")}</div>
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {assignedOpenRoutes.length}
            </div>
            <div className="mt-1 hidden text-sm text-slate-500 sm:block">
              {t("Routes already assigned and still waiting on completion.")}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-500">{t("Available")}</div>
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {availableRoutes.length}
            </div>
            <div className="mt-1 hidden text-sm text-slate-500 sm:block">
              {t("Open routes you can claim when the team leaves them unassigned.")}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-500">{t("Completed")}</div>
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {completedRoutes.length}
            </div>
            <div className="mt-1 hidden text-sm text-slate-500 sm:block">
              {t("Finished routes stay visible for history and follow-up.")}
            </div>
          </div>
        </div>
      </SectionCard>

      {!availableView ? <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {canManageAllRoutes ? t("Assigned routes") : t("Assigned to me")}
          </h2>
          <p className="mt-1 hidden text-sm text-slate-500 sm:block">
            {canManageAllRoutes
              ? t("Routes already assigned across the team.")
              : t("Routes already assigned to your linked operator identity.")}
          </p>
        </div>
        {!assignedOpenRoutes.length ? (
          <EmptyState
            title={t("No assigned open routes")}
            body={t(
              "Assigned routes will appear here when they are ready to start or continue.",
            )}
          />
        ) : (
          <div className="space-y-4">
            {assignedOpenRoutes.map((route) => (
              <RouteCard
                key={route.id}
                route={route}
                t={t}
                locale={locale}
                todayTripoli={tripoliToday}
                stopsVerified={stopsVerified}
              />
            ))}
          </div>
        )}
      </section> : null}

      {(availableView || canManageAllRoutes) ? <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {t("Unassigned")}
          </h2>
          <p className="mt-1 hidden text-sm text-slate-500 sm:block">
            {t("Open routes you can claim when the route is left available.")}
          </p>
        </div>
        {!availableRoutes.length ? (
          <EmptyState
            title={t("No unassigned routes")}
            body={t("Available routes will appear here when admin leaves them open.")}
          />
        ) : (
          <div className="space-y-4">
            {availableRoutes.map((route) => (
              <RouteCard
                key={route.id}
                route={route}
                t={t}
                locale={locale}
                todayTripoli={tripoliToday}
                stopsVerified={stopsVerified}
              />
            ))}
          </div>
        )}
      </section> : null}

      {!availableView ? <details className="rounded-xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-base font-semibold text-slate-900">
          {tr("Completed routes", "الجولات المكتملة")} ({completedRoutes.length})
          <span className="ms-2 text-xs font-normal text-slate-500">{tr("Show history", "عرض السجل")}</span>
        </summary>
        {!completedRoutes.length ? (
          <EmptyState
            title={t("No completed routes yet")}
            body={t("Completed routes will stay visible here after route closure.")}
          />
        ) : (
          <div className="space-y-4">
            {completedRoutes.map((route) => (
              <RouteCard
                key={route.id}
                route={route}
                t={t}
                locale={locale}
                todayTripoli={tripoliToday}
                stopsVerified={stopsVerified}
              />
            ))}
          </div>
        )}
      </details> : null}
    </div>
  );
}
