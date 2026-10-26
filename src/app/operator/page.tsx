import Link from "next/link";
import { OwnerQaRouteCard } from "@/components/operator/OwnerQaRouteCard";
import { EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { NotificationCenter } from "@/components/NotificationCenter";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canExecuteRoutes, canManageOperations, hasRole } from "@/lib/authz";
import { loadAccessibleOperatorIds } from "@/lib/operator-route-access";
import { type OperatorRoutePreviewRow } from "@/lib/operator-route-types";
import { prioritizeAssignedOperatorRoutes, routeQueueItem } from "@/lib/operator-route-list-focus";
import { getServerI18n } from "@/lib/i18n/server";
import { isOperatorVisibleRouteStatus, isTerminalRouteStatus, routeDisplayStatus } from "@/lib/route-workflow";

export const dynamic = "force-dynamic";

export default async function OperatorPage() {
  const { locale } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const todayTripoli = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Operator routes unavailable" body="Supabase is not configured, so Snacky OS cannot load assigned routes." />
      </>
    );
  }

  if (!profile || !canExecuteRoutes(profile)) {
    return (
      <>
        <ErrorState title="Operator routes unavailable" body="Your account cannot execute routes." />
      </>
    );
  }

  const canManageAllRoutes = canManageOperations(profile);
  const accessibleOperatorIds = await loadAccessibleOperatorIds(supabase, profile);
  const routeSelect = "id, route_date, status, operator_id, route_stops(id, status, stop_order, machine_id)";
  const [assignedResult, availableResult] = await Promise.all([
    canManageAllRoutes
      ? supabase
        .from("routes")
        .select(routeSelect)
        .not("operator_id", "is", null)
        .order("route_date", { ascending: false })
      : accessibleOperatorIds.length
        ? supabase
          .from("routes")
          .select(routeSelect)
          .in("operator_id", accessibleOperatorIds)
          .order("route_date", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    supabase
      .from("routes")
      .select(routeSelect)
      .is("operator_id", null)
      .order("route_date", { ascending: true }),
  ]);
  const routesError = assignedResult.error ?? availableResult.error;
  const assignedRoutes = (assignedResult.data ?? []) as OperatorRoutePreviewRow[];
  const activeAssignedRoutes = prioritizeAssignedOperatorRoutes(
    assignedRoutes.filter(route => !isTerminalRouteStatus(route.status)), todayTripoli, true,
  ).map(item => item.route);
  const featuredRoute = activeAssignedRoutes[0] ?? null;
  const featuredSummary = featuredRoute ? routeQueueItem(featuredRoute,todayTripoli,true) : null;
  const completedAssignedRoutes = assignedRoutes
    .filter((route) => isTerminalRouteStatus(route.status))
    .sort((a, b) => String(b.route_date ?? "").localeCompare(String(a.route_date ?? "")))
    .slice(0, 6);
  const availableRoutes = ((availableResult.data ?? []) as OperatorRoutePreviewRow[]).filter((route) => isOperatorVisibleRouteStatus(route.status));
  const routes = [...activeAssignedRoutes, ...availableRoutes]
    .filter((route, index, rows) => rows.findIndex((candidate) => candidate.id === route.id) === index)
    .filter((route) => !isTerminalRouteStatus(route.status));

  if (routesError) {
    console.error("[operator] Failed to load assigned routes", routesError);
    return (
      <>
        <ErrorState title="Could not load assigned routes" body="Snacky OS could not load the operator route list." action={<SecondaryButton href="/operator">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {hasRole(profile, "owner") ? <OwnerQaRouteCard locale={locale} /> : null}
        <PageHeader
          title={tr("Operator", "المشغّل")}
          subtitle={tr("Assigned refill routes and daily execution workflow.", "جولات التعبئة المسندة وخطوات العمل اليومي.")}
          action={<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end"><div className="hidden md:block"><NotificationCenter label="Notifications" /></div><PrimaryButton href="/operator/routes">{tr("All my routes", "كل جولاتي")}</PrimaryButton></div>}
        />

        {featuredRoute && featuredSummary ? (
          <section aria-labelledby="operator-home-next-route-title"
            className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 bg-emerald-950 p-4 text-white sm:p-5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-300">{tr(canManageAllRoutes ? "TEAM · NEXT ROUTE" : "YOUR NEXT ROUTE", canManageAllRoutes ? "الفريق · الجولة التالية" : "جولتك التالية")}</p>
                <h2 id="operator-home-next-route-title" className="mt-1 text-xl font-bold">
                  {featuredSummary.urgency === "in_progress"
                    ? tr("Resume active work", "تابع الجولة الجارية")
                    : featuredSummary.urgency === "overdue"
                      ? tr("Review overdue work", "راجع الجولة المتأخرة")
                      : tr("Open next scheduled route", "افتح الجولة المجدولة التالية")}
                </h2>
                <p dir="ltr" className="mt-1 inline-block tabular-nums text-sm text-emerald-100">{featuredRoute.route_date || "—"}</p>
                <p className="mt-2 text-sm text-emerald-100">
                  {featuredSummary.unfinishedStops === null
                    ? tr("Stop count unverified", "عدد المواقع غير مؤكد")
                    : tr(String(featuredSummary.unfinishedStops) + " unfinished stops", "متبقي " + featuredSummary.unfinishedStops + " مواقع")}
                </p>
              </div>
              <Link href={`/operator/routes/${featuredRoute.id}`}
                className="flex min-h-12 w-full shrink-0 items-center justify-center rounded-xl bg-amber-400 px-5 py-3 text-center text-sm font-bold text-slate-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-100 sm:w-auto">
                {tr("Open route", "فتح الجولة")}
              </Link>
            </div>
            <p className="px-4 py-3 text-xs leading-5 text-slate-600">
              {tr("Existing assignments and pickup safeguards remain unchanged.", "التكليفات الحالية وضوابط استلام المخزون لم تتغير.")}
            </p>
          </section>
        ) : null}

        <SectionCard>
          <div className="p-4">
            <h2 className="text-base font-semibold text-slate-900">{tr("Route snapshot", "ملخص الجولات")}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold text-slate-500">{tr("Open assigned", "المسندة المفتوحة")}</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{activeAssignedRoutes.length}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold text-slate-500">{tr("Available", "المتاحة")}</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{availableRoutes.length}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold text-slate-500">{tr("Completed", "المكتملة")}</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{completedAssignedRoutes.length}</div>
              </div>
            </div>
          </div>
        </SectionCard>

        {!routes?.length ? (
          <EmptyState title="No assigned routes" body="Assigned routes for today and upcoming dates will appear here." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {routes.map((route) => {
              const item = routeQueueItem(route, todayTripoli, true);
              return (
                <Link key={route.id} href={`/operator/routes/${route.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:shadow-md">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">{route.route_date}</div>
                      <div className="mt-1 text-sm text-slate-500">{item.doneStops === null
                            ? tr("Stop progress unavailable", "تقدم المواقع غير متاح")
                            : item.totalStops === 0
                              ? tr("No stops configured", "لا توجد مواقع مسجلة")
                              : tr(String(item.doneStops) + "/" + item.totalStops + " completed or skipped",
                                item.doneStops + "/" + item.totalStops + " مكتمل أو متخطى")}</div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                    </div>
                  </div>
                  {item.progressPercent !== null ? (
                    <div role="progressbar" aria-valuenow={item.doneStops ?? 0}
                      aria-valuemin={0} aria-valuemax={item.totalStops ?? 1}
                      aria-label={tr("Completed or skipped stops", "المواقع المكتملة أو المتخطاة")}
                      className="h-2 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-2 rounded-full bg-emerald-500"
                        style={{ width: item.progressPercent + "%" }} />
                    </div>
                  ) : null}
                  {item.unfinishedStops !== null && item.totalStops !== null && item.totalStops > 0 ? (
                    <p className="mt-2 text-sm font-semibold text-emerald-800">
                      {tr(String(item.unfinishedStops) + " unfinished stops", "متبقي " + item.unfinishedStops + " مواقع")}
                    </p>
                  ) : null}
                </Link>
              );
            })}
          </div>
        )}

        {completedAssignedRoutes.length ? (
          <SectionCard>
            <div className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{tr("Recent completed routes", "الجولات المكتملة مؤخراً")}</h2>
                  <p className="mt-1 text-sm text-slate-500">Completed routes stay visible here for quick history and follow-up.</p>
                </div>
                <SecondaryButton href="/operator/routes">View all routes</SecondaryButton>
              </div>
              <div className="mt-4 space-y-3">
              {completedAssignedRoutes.map((route) => {
                const item = routeQueueItem(route, todayTripoli, true);
                return (
                  <Link
                    key={route.id}
                    href={`/operator/routes/${route.id}`}
                    className="block rounded-lg border border-slate-200 bg-white px-4 py-3 transition hover:shadow-sm"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="font-semibold text-slate-900">{route.route_date}</div>
                          <div className="mt-1 text-sm text-slate-500">{item.doneStops === null
                            ? tr("Stop progress unavailable", "تقدم المواقع غير متاح")
                            : item.totalStops === 0
                              ? tr("No stops configured", "لا توجد مواقع مسجلة")
                              : tr(String(item.doneStops) + "/" + item.totalStops + " completed or skipped",
                                item.doneStops + "/" + item.totalStops + " مكتمل أو متخطى")}</div>
                        </div>
                        <div className="shrink-0">
                          <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard>
          <div className="p-4">
            <h2 className="text-base font-semibold text-slate-900">{tr("Route workflow", "خطوات الجولة")}</h2>
            <div className="mt-3 grid gap-3 text-sm text-slate-600 md:grid-cols-5">
              {["Pick stock", "Visit stops", "Fill machines", "Record cash", "Return leftovers"].map((step) => (
                <div key={step} className="rounded-lg border border-slate-200 bg-white p-3 font-medium text-slate-800">
                  {step}
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>
    </>
  );
}

