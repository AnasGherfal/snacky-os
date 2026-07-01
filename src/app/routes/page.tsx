import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { isActiveRouteStatus, isCompletedRouteStatus, isTerminalRouteStatus, routeDisplayStatus } from "@/lib/route-workflow";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function errorSummary(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
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
  return text.match(/relation "([^"]+)"/i)?.[1] ?? text.match(/column "([^"]+)"/i)?.[1] ?? null;
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
  (optional ? console.warn : console.error)("[routes] " + step + " failed", payload);
}


export default async function RoutesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes")) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Routes unavailable" body="Supabase is not configured, so Snacky OS cannot load routes." />
      </>
    );
  }
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const loaderContext = {
    page_module: "src/app/routes/page.tsx",
    current_user_id: profile.id,
    current_user_role: profile.role,
    operator_profile_id: profile.team_member_id ?? null,
    route_status_filter: "all",
    assignment_filter: "all",
    page,
    page_size: pageSize,
  };
  const { data: routes, count, error: routesError } = await supabase
    .from("routes")
    .select("id, route_date, status, operator_id", { count: "exact" })
    .order("route_date", { ascending: false })
    .range(from, to);
  if (routesError) {
    logRouteLoaderIssue({ step: "load_routes", query: "routes", error: routesError, context: loaderContext });
    return (
      <>
        <ErrorState title="Could not load routes" body="Snacky OS could not load route records from Supabase." action={<SecondaryButton href="/routes">Retry</SecondaryButton>} />
      </>
    );
  }
  const routeRows = routes ?? [];
  const operatorIds = Array.from(new Set(routeRows.map((route: any) => route.operator_id).filter(Boolean)));
  const routeIds = routeRows.map((route: any) => route.id);
  const supportClient = getSupabaseAdminClient() ?? supabase;
  const [{ data: operators, error: operatorsError }, { data: stops, error: stopsError }] = await Promise.all([
    operatorIds.length
      ? supportClient.from("team_members").select("id, full_name").in("id", operatorIds)
      : Promise.resolve({ data: [], error: null }),
    routeIds.length
      ? supportClient.from("route_stops").select("route_id").in("route_id", routeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (operatorsError) {
    logRouteLoaderIssue({ step: "load_route_operators", query: "team_members", error: operatorsError, context: loaderContext, optional: true });
  }
  if (stopsError) {
    logRouteLoaderIssue({ step: "load_route_stop_counts", query: "route_stops", error: stopsError, context: loaderContext, optional: true });
  }
  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator]));
  const stopsByRouteId = new Map<string, number>();
  if (!stopsError) {
    (stops ?? []).forEach((stop: any) => {
      stopsByRouteId.set(stop.route_id, (stopsByRouteId.get(stop.route_id) ?? 0) + 1);
    });
  }
  const groups = [
    { title: "Unassigned / Available", rows: routeRows.filter((route: any) => !route.operator_id && !isTerminalRouteStatus(route.status)) },
    { title: "In progress", rows: routeRows.filter((route: any) => isActiveRouteStatus(route.status)) },
    { title: "Assigned routes", rows: routeRows.filter((route: any) => route.operator_id && !isActiveRouteStatus(route.status) && !isTerminalRouteStatus(route.status)) },
    { title: "Completed", rows: routeRows.filter((route: any) => isCompletedRouteStatus(route.status)) },
  ].filter((group) => group.rows.length);

  const renderRouteCards = (rows: any[]) => (
    <MobileCardList>
      {rows.map((route: any) => (
        <MobileRecordCard key={route.id}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words text-base font-semibold text-slate-900">{route.route_date}</h2>
              <p className="mt-1 text-sm text-slate-500">{operatorById.get(route.operator_id)?.full_name ?? "Available"}</p>
            </div>
            <StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MobileField label="Stops">{stopsByRouteId.get(route.id) ?? 0}</MobileField>
            <MobileField label="Performer">{operatorById.get(route.operator_id)?.full_name ?? "Unassigned"}</MobileField>
          </div>
          <Link className="btn-secondary mt-4 w-full" href={`/routes/${route.id}`}>
            View route
          </Link>
        </MobileRecordCard>
      ))}
    </MobileCardList>
  );

  const renderRouteTable = (rows: any[]) => (
    <DataTable className="hidden md:block" headers={["Date", "Performer", "Status", "Stops", "Details"]}>
      {rows.map((route: any) => (
        <tr key={route.id}>
          <td>{route.route_date}</td>
          <td>{operatorById.get(route.operator_id)?.full_name ?? "Unassigned"}</td>
          <td><StatusBadge status={routeDisplayStatus(route.status, route.operator_id)} /></td>
          <td>{stopsByRouteId.get(route.id) ?? 0}</td>
          <td>
            <Link className="link-secondary" href={`/routes/${route.id}`}>
              View route
            </Link>
          </td>
        </tr>
      ))}
    </DataTable>
  );

  return (
    <>
      <PageHeader
        title="Routes"
        subtitle="Plan refill routes, assign operators, and track machine stops."
        action={<PrimaryButton href="/routes/new">Create route</PrimaryButton>}
      />
      {operatorsError || stopsError ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Some route summary details are unavailable right now. Routes are still loaded.
        </div>
      ) : null}
      {!routeRows.length ? (
        <EmptyState
          title="No routes yet"
          body="Create your first refill route from recommendations or add machine stops manually."
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.title} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-900">{group.title}</h2>
                <span className="text-sm text-slate-500">{group.rows.length}</span>
              </div>
              {renderRouteCards(group.rows)}
              {renderRouteTable(group.rows)}
            </section>
          ))}
          <PaginationControls basePath="/routes" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="routes" />
        </div>
      )}
    </>
  );
}
