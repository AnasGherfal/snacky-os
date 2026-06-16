import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge, SectionCard } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canExecuteRoutes } from "@/lib/authz";
import { buildOperatorRouteAccessContext, loadAccessibleOperatorIds, preferredOperatorViewerId } from "@/lib/operator-route-access";
import { loadOperatorRoutePayPreviewMap, type OperatorRoutePreviewRow, type OperatorRoutePreviewStopRow } from "@/lib/payroll-server";
import { moneyLabel } from "@/lib/payroll";
import { sortPickupProductRows } from "@/lib/route-pickup-checklist";
import { isActiveRouteStatus, isAvailableRouteStatus, isCompletedRouteStatus, isRouteStopActiveStatus, isRouteStopDoneStatus, isRouteStopPendingStatus, isTerminalRouteStatus, nextOperatorRouteHref, routeDisplayStatus, ROUTE_STOP_COMPLETED_STATUS } from "@/lib/route-workflow";
import { skipStop } from "@/lib/operator-actions";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

type OperatorRouteDetailRow = OperatorRoutePreviewRow & {
  started_at?: string | null;
  completed_at?: string | null;
};

type OperatorRouteMachineRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
};

type OperatorRouteStockLineRow = {
  id: string;
  product_id?: string | null;
  planned_qty?: number | string | null;
  picked_qty?: number | string | null;
  returned_qty?: number | string | null;
  product?: { name?: string | null; category?: string | null } | null;
};

type OperatorPayrollPeriodSummary = {
  id: string;
  net_total_lyd?: number | string | null;
  status?: string | null;
};

const OPERATOR_ROUTE_BASE_SELECT = "id, route_date, status, operator_id, started_at, completed_at, created_at, notes";

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

async function readOperatorRouteBaseById(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  routeId: string,
) {
  return client
    .from("routes")
    .select(OPERATOR_ROUTE_BASE_SELECT)
    .eq("id", routeId)
    .maybeSingle();
}

export default async function OperatorRouteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { id: routeId } = await params;
  const { success, error } = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!profile || !canExecuteRoutes(profile)) redirect("/unauthorized");
  if (!supabase) {
    return (
      <>
        <ErrorState
          title="Route unavailable"
          body="Snacky OS could not connect to the database to load this route."
          action={<SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>}
        />
      </>
    );
  }

  const routeDiagnosticClient = getSupabaseAdminClient() ?? supabase;
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const accessibleOperatorIds = await loadAccessibleOperatorIds(supabase, profile);
  const currentViewerOperatorId = preferredOperatorViewerId(profile, accessibleOperatorIds);

  const [baseRouteResult, visibleRouteResult] = await Promise.all([
    readOperatorRouteBaseById(routeDiagnosticClient, routeId),
    readOperatorRouteBaseById(supabase, routeId),
  ]);
  const baseRoute = baseRouteResult.data;
  const visibleRoute = visibleRouteResult.data;
  const baseRouteError = baseRouteResult.error;
  const visibleRouteError = visibleRouteResult.error;

  if (baseRouteError) {
    console.error("[operator:route] Base route read failed", {
      route_id: routeId,
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      operator_profile_id: profile.team_member_id ?? null,
      linked_operator_ids: accessibleOperatorIds,
      exact_reason_page_would_not_found: "base_route_query_failed",
      base_route_found: Boolean(baseRoute),
      permission_filtered_route_found: Boolean(visibleRoute),
      base_route_error: errorSummary(baseRouteError),
    });
  }

  if (visibleRouteError) {
    console.error("[operator:route] Permission-filtered route read failed", {
      route_id: routeId,
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      operator_profile_id: profile.team_member_id ?? null,
      linked_operator_ids: accessibleOperatorIds,
      exact_reason_page_would_not_found: "permission_filtered_query_failed",
      base_route_found: Boolean(baseRoute),
      permission_filtered_route_found: Boolean(visibleRoute),
      permission_filtered_route_error: errorSummary(visibleRouteError),
    });
  }

  const route = (visibleRoute ?? baseRoute) as OperatorRouteDetailRow | null;
  if (!route) {
    console.error("[operator:route] Route detail returned no base row", {
      route_id: routeId,
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      operator_profile_id: profile.team_member_id ?? null,
      linked_operator_ids: accessibleOperatorIds,
      base_route_found: false,
      permission_filtered_route_found: false,
      exact_reason_page_would_not_found: baseRouteError ? "base_route_query_failed" : "route_missing",
      base_route_error: errorSummary(baseRouteError),
      permission_filtered_route_error: errorSummary(visibleRouteError),
    });
    notFound();
  }

  const routeRow = route as OperatorRouteDetailRow;
  const canAccess = canAccessOperatorRoute(routeAccessProfile, routeRow.operator_id);
  const routeReadClient = visibleRoute ? supabase : routeDiagnosticClient;

  if (!visibleRoute && baseRoute) {
    console.warn("[operator:route] Using base route read after permission-filtered query returned no row", {
      route_id: routeId,
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      operator_profile_id: profile.team_member_id ?? null,
      linked_operator_ids: accessibleOperatorIds,
      route_status: routeRow.status ?? null,
      assigned_operator_id: routeRow.operator_id ?? null,
      base_route_found: true,
      permission_filtered_route_found: false,
      exact_reason_page_would_not_found: visibleRouteError ? "permission_filtered_query_failed" : "permission_filtered_query_returned_no_row",
      permission_filtered_route_error: errorSummary(visibleRouteError),
    });
  }

  const [{ data: operator }, { data: stops, error: stopsError }, { data: routeStock }] = await Promise.all([
    routeRow.operator_id
      ? routeReadClient.from("team_members").select("id, full_name").eq("id", routeRow.operator_id).maybeSingle()
      : Promise.resolve({ data: null }),
    routeReadClient
      .from("route_stops")
      .select("id, stop_order, status, machine_id")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true }),
    routeReadClient
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name, category)")
      .eq("route_id", routeId),
  ]);
  if (stopsError) console.error("[operator:route] Failed to load stops", { routeId, error: stopsError });

  if (!canAccess) {
    console.error("[operator:route] Route access denied by app permission check", {
      route_id: routeId,
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      operator_profile_id: profile.team_member_id ?? null,
      linked_operator_ids: accessibleOperatorIds,
      route_status: routeRow.status ?? null,
      assigned_operator_id: routeRow.operator_id ?? null,
      base_route_found: Boolean(baseRoute),
      permission_filtered_route_found: Boolean(visibleRoute),
      exact_reason_page_would_not_found: "app_permission_check_denied",
    });
    return (
      <>
        <ErrorState
          title="Route unavailable"
          body={process.env.NODE_ENV === "development"
            ? `This route is assigned to ${routeRow.operator_id}. Linked operator ids for auth user ${profile?.id ?? "none"} are ${accessibleOperatorIds.join(", ") || "none"}.`
            : "This route is not assigned to you."}
          action={<SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>}
        />
      </>
    );
  }

  const currentMonthStart = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();
  const routeStops = (stops ?? []) as OperatorRoutePreviewStopRow[];
  const machineIds = routeStops.map((stop) => stop.machine_id).filter(Boolean);
  const { data: machines } = machineIds.length
    ? await routeReadClient.from("machines").select("id, name, machine_code").in("id", machineIds)
    : { data: [] };
  const machineById = new Map(((machines ?? []) as OperatorRouteMachineRow[]).map((machine) => [machine.id, machine]));
  const doneStops = routeStops.filter((s) => isRouteStopDoneStatus(s.status)).length;
  const totalStops = routeStops.length;
  const pickItems = (routeStock ?? []) as OperatorRouteStockLineRow[];
  const currentPayrollPeriodResult = currentViewerOperatorId
    ? await routeReadClient.from("payroll_periods").select("id, net_total_lyd, status").eq("operator_id", currentViewerOperatorId).eq("period_start", currentMonthStart).maybeSingle()
    : { data: null };
  const { previewByRouteId } = await loadOperatorRoutePayPreviewMap({
    supabase: routeReadClient,
    routes: [{ ...routeRow, route_stops: routeStops }],
    viewerTeamMemberId: currentViewerOperatorId,
  });
  const payPreview = previewByRouteId.get(routeId);
  const hasPickup = pickItems.some((item) => Number(item.picked_qty ?? 0) > 0);
  const sortedPickItems = sortPickupProductRows(
    pickItems.map((item) => ({
      ...item,
      productName: item.product?.name ?? "Unknown product",
      productCategory: item.product?.category ?? null,
    })),
  );
  const continueHref = nextOperatorRouteHref({ routeId, status: routeRow.status, hasPickup, stops: routeStops, start: true });
  const primaryAction = continueHref
    ? {
        href: continueHref,
        label: isAvailableRouteStatus(routeRow.status)
          ? (routeRow.operator_id ? "Start Route" : "Claim & Start")
          : "Continue Route",
      }
    : null;

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title={`Route for ${routeRow.route_date}`}
          subtitle={`${operator?.full_name ?? "Available to claim"} - ${totalStops} machine stops`}
          action={<SecondaryButton href="/operator/routes">Back to routes</SecondaryButton>}
        />
        {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}

        {/* Route Status Cards */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">Status</div>
              <StatusBadge status={routeDisplayStatus(routeRow.status, routeRow.operator_id)} />
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">Progress</div>
              <div className="font-semibold text-lg">
                {doneStops}/{totalStops}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="mb-1 text-sm text-slate-500">{isTerminalRouteStatus(routeRow.status) ? "Completed route pay" : "Estimated route pay"}</div>
              <div className="font-semibold text-lg text-slate-900">
                {payPreview?.totalPay !== null && payPreview?.totalPay !== undefined ? moneyLabel(payPreview.totalPay) : "Unavailable"}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {payPreview?.source === "saved"
                  ? "This amount comes from the stored route pay breakdown."
                  : "This amount updates from your current pay profile until admin verifies payroll."}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="mb-1 text-sm text-slate-500">Monthly earned total</div>
              <div className="font-semibold text-lg text-slate-900">
                {moneyLabel((currentPayrollPeriodResult.data as OperatorPayrollPeriodSummary | null)?.net_total_lyd ?? 0)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {currentPayrollPeriodResult.data ? `Current period status: ${(currentPayrollPeriodResult.data as OperatorPayrollPeriodSummary).status}` : "Current month payroll period has not been created yet."}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">Action</div>
              {primaryAction ? (
                <Link href={primaryAction.href} className="btn-primary w-full text-base">
                  {primaryAction.label}
                </Link>
              ) : (
                <div className="text-sm text-slate-600">Route completed</div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Pick List Section */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Pick list</h2>
          {isAvailableRouteStatus(routeRow.status) ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <strong>Ready to start?</strong> Click {routeRow.operator_id ? "Start Route" : "Claim & Start"} above to view your pick list and begin picking stock from storage.
            </div>
          ) : null}
          {!pickItems.length ? (
            <EmptyState title="No pick list yet" body="This route has no products assigned to pick from storage." />
          ) : (
            <div className="mb-4 space-y-2">
              {sortedPickItems.map((item) => (
                <div key={item.id} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words font-medium text-slate-900">{item.product?.name ?? "Unknown product"}</span>
                  <span className="shrink-0 text-slate-600">{item.picked_qty || item.planned_qty} / {item.planned_qty} picked</span>
                </div>
              ))}
            </div>
          )}
          <Link
            href={`/operator/routes/${routeId}/pick-list`}
            className="btn-secondary w-full sm:w-auto"
          >
            View Pick List
          </Link>
        </section>

        {/* Machine Stops */}
        <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="p-4 md:p-6 border-b border-slate-200">
            <h2 className="text-lg font-semibold">Machine Stops ({totalStops})</h2>
          </div>
          {!routeStops.length ? (
            <EmptyState
              title="No stops"
              body="This route currently has no machine stops."
            />
          ) : (
            <div className="divide-y divide-slate-200">
              {routeStops.map((stop) => {
                const machine = stop.machine_id ? machineById.get(stop.machine_id) ?? null : null;

                return (
                <div key={stop.id} className="p-4 md:p-6 hover:bg-slate-50 transition">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700">
                        {stop.stop_order}
                      </div>
                      <div className="min-w-0">
                        <h3 className="break-words font-semibold text-slate-900">{machine?.name ?? "Unknown machine"}</h3>
                        <p className="text-sm text-slate-500">
                          Code: {machine?.machine_code ?? "-"}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={stop.status} />
                    </div>
                  </div>

                  {isActiveRouteStatus(routeRow.status) || isCompletedRouteStatus(routeRow.status) ? (
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      {isRouteStopPendingStatus(stop.status) ? (
                        <Link href={`/operator/routes/${routeId}/pick-list`} className="btn-primary w-full text-base sm:w-auto">
                          Pick this stop
                        </Link>
                      ) : isRouteStopActiveStatus(stop.status) || stop.status === ROUTE_STOP_COMPLETED_STATUS ? (
                        <Link
                          href={`/operator/routes/${routeId}/stops/${stop.id}`}
                          className="btn-primary w-full text-base sm:w-auto"
                        >
                          {stop.status === ROUTE_STOP_COMPLETED_STATUS ? "Edit stop" : "Continue filling"}
                        </Link>
                      ) : null}
                      {!isRouteStopDoneStatus(stop.status) ? (
                        <ConfirmDialog
                          action={skipStop}
                          triggerLabel="Skip stop"
                          title="Skip this machine?"
                          description="Skipped stops count as finished for route closure, but any picked stock must still be returned on the leftovers screen."
                          confirmLabel="Skip stop"
                          buttonClassName="btn-secondary w-full sm:w-auto"
                          confirmButtonClassName="btn-danger"
                          hiddenFields={[{ name: "route_id", value: routeId }, { name: "stop_id", value: stop.id }]}
                          reasonLabel="Skip reason"
                          reasonPlaceholder="Machine inaccessible, closed location, or another reason."
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
              })}
            </div>
          )}
        </section>

        {primaryAction ? (
          <div className="sticky bottom-3 z-10 -mx-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:hidden">
            <Link href={primaryAction.href} className="btn-primary w-full text-base">
              {primaryAction.label}
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
