import Link from "next/link";
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
  isRouteStopDoneStatus,
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

function routeProgress(route: OperatorRoutePreviewRow) {
  const completedStops =
    route.route_stops?.filter((stop: OperatorRoutePreviewStopRow) =>
      isRouteStopDoneStatus(stop.status),
    ).length ?? 0;
  const totalStops = route.route_stops?.length ?? 0;
  const progress =
    totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;
  return { completedStops, totalStops, progress };
}

function RouteCard({
  route,
  subtitle,
  t,
}: {
  route: OperatorRoutePreviewRow;
  subtitle: string;
  t: (key: string, fallback?: string) => string;
}) {
  const { completedStops, totalStops, progress } = routeProgress(route);
  const routeStatus = routeDisplayStatus(route.status, route.operator_id);

  return (
    <Link
      href={`/operator/routes/${route.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
    >
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{route.route_date}</h3>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="shrink-0">
          <StatusBadge
            status={routeStatus}
            label={t(routeStatus, routeStatus)}
          />
        </div>
      </div>
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-slate-600">{t("Progress")}</span>
          <span className="text-xs font-semibold text-slate-700">
            {progress}%
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-slate-200">
          <div
            className="h-2 rounded-full bg-green-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="text-sm text-slate-600">
        {completedStops}/{totalStops} {t("completed or skipped")}
      </div>
    </Link>
  );
}

export default async function OperatorRoutesPage() {
  const { t } = await getServerI18n();
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
        .select(routeSelect)
        .not("operator_id", "is", null)
        .order("route_date", { ascending: false })
    : accessibleOperatorIds.length
      ? routeReadClient
          .from("routes")
          .select(routeSelect)
          .in("operator_id", accessibleOperatorIds)
          .order("route_date", { ascending: false })
      : Promise.resolve({ data: [], error: null });
  const availableQuery = routeReadClient
    .from("routes")
    .select(routeSelect)
    .is("operator_id", null)
    .order("route_date", { ascending: true });
  const [assignedResult, availableResult] = await Promise.all([
    assignedQuery,
    availableQuery,
  ]);

  const assignedRoutesError = assignedResult.error ?? null;
  const availableRoutesError = availableResult.error ?? null;
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
  const { data: stopRows, error: stopsError } = routeIds.length
    ? await routeReadClient
        .from("route_stops")
        .select("id, route_id, status, stop_order, machine_id")
        .in("route_id", routeIds)
        .order("stop_order", { ascending: true })
    : { data: [], error: null };

  if (stopsError) {
    logRouteLoaderIssue({
      step: "load_route_stop_summaries",
      query: "route_stops",
      error: stopsError,
      context: { ...loaderContext, route_ids: routeIds },
      optional: true,
    });
  }

  const stopsByRouteId = new Map<string, OperatorRoutePreviewStopRow[]>();
  if (!stopsError) {
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
  const assignedOpenRoutes = assignedRoutes.filter(
    (route) => !isTerminalRouteStatus(route.status),
  );
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
        title={canManageAllRoutes ? t("Operator Routes") : t("My routes")}
        subtitle={
          canManageAllRoutes
            ? t("Assigned, unassigned, and completed routes across the team.")
            : t(
                "See your assigned work, open routes you can claim, and completed history in one place.",
              )
        }
        action={headerAction}
      />

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
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <div>
            <div className="text-sm text-slate-500">{t("Open assigned")}</div>
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {assignedOpenRoutes.length}
            </div>
            <div className="mt-1 text-sm text-slate-500">
              {t("Routes already assigned and still waiting on completion.")}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-500">{t("Available")}</div>
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {availableRoutes.length}
            </div>
            <div className="mt-1 text-sm text-slate-500">
              {t("Open routes you can claim when the team leaves them unassigned.")}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-500">{t("Completed")}</div>
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {completedRoutes.length}
            </div>
            <div className="mt-1 text-sm text-slate-500">
              {t("Finished routes stay visible for history and follow-up.")}
            </div>
          </div>
        </div>
      </SectionCard>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {canManageAllRoutes ? t("Assigned routes") : t("Assigned to me")}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
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
                subtitle={`${route.route_stops?.length ?? 0} ${t("machine stops")}`}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {t("Unassigned")}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
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
                subtitle={`${route.route_stops?.length ?? 0} ${t("machine stops")} - ${t("ready to claim")}`}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {t("Completed routes")}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {t("Finished routes stay visible here for history and follow-up.")}
          </p>
        </div>
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
                subtitle={`${route.route_stops?.length ?? 0} ${t("machine stops")}`}
                t={t}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
