import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge, SectionCard } from "@/components/ui";
import { lyd } from "@/lib/format";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canExecuteRoutes } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { buildOperatorRouteAccessContext, loadAccessibleOperatorIds } from "@/lib/operator-route-access";
import { type OperatorRoutePreviewRow, type OperatorRoutePreviewStopRow } from "@/lib/operator-route-types";
import { sortPickupProductRows } from "@/lib/route-pickup-checklist";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { isActiveRouteStatus, isAvailableRouteStatus, isPickupConfirmedStatus, isRouteStopActiveStatus, isRouteStopDoneStatus, isRouteStopPendingStatus, nextOperatorRouteHref, routeDisplayStatus } from "@/lib/route-workflow";
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
  machine_display_name?: string | null;
  location?: { id?: string | null; name?: string | null } | null;
};

type OperatorRouteStockLineRow = {
  id: string;
  product_id?: string | null;
  planned_qty?: number | string | null;
  picked_qty?: number | string | null;
  returned_qty?: number | string | null;
  product?: { name?: string | null; category?: string | null } | null;
};

type OperatorRouteManualSaleRow = {
  id: string;
  product_name?: string | null;
  quantity?: number | string | null;
  total_amount_lyd?: number | string | null;
  payment_method?: string | null;
  sale_time?: string | null;
  status?: string | null;
  machine_id?: string | null;
};

type OperatorRouteAdjustmentRow = {
  id: string;
  adjustment_type?: string | null;
  product_name?: string | null;
  quantity?: number | string | null;
  reason?: string | null;
  notes?: string | null;
  photo_url?: string | null;
  status?: string | null;
  created_at?: string | null;
  machine_id?: string | null;
  route_stop_id?: string | null;
};

type RouteBagSnapshotBalanceRow = {
  product_id?: string | null;
  signed_quantity?: number | string | null;
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

function missingDbObjectName(error: unknown) {
  const summary = errorSummary(error);
  const text = [summary?.code, summary?.message, summary?.details, summary?.hint]
    .map((value) => String(value ?? ""))
    .join(" ");
  const relation = text.match(/relation "([^"]+)"/i)?.[1] ?? null;
  const column = text.match(/column "([^"]+)"/i)?.[1] ?? null;
  return relation ?? column;
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" ");
}

function isMissingColumn(error: unknown, columns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
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
  (optional ? console.warn : console.error)('[operator:route] ' + step + ' failed', payload);
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
  const { t } = await getServerI18n();
  const supabase = await getAuthenticatedSupabaseServerClient();
  const profile = await getCurrentProfile();
  if (!profile || !canExecuteRoutes(profile)) redirect("/unauthorized");
  if (!supabase) {
    return (
      <>
        <ErrorState
          title={t("Route unavailable")}
          body={t("Snacky OS could not connect to the database to load this route.")}
          action={<SecondaryButton href="/operator/routes">{t("Back to routes")}</SecondaryButton>}
        />
      </>
    );
  }

  const routeDiagnosticClient = getSupabaseAdminClient() ?? supabase;
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const accessibleOperatorIds = await loadAccessibleOperatorIds(supabase, profile);

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
  const routeReadClient = routeDiagnosticClient;
  const loaderContext = {
    route_id: routeId,
    current_user_id: profile.id,
    current_user_role: profile.role,
    current_user_roles: profile.roles,
    operator_profile_id: profile.team_member_id ?? null,
    linked_operator_ids: accessibleOperatorIds,
    route_status: routeRow.status ?? null,
    assigned_operator_id: routeRow.operator_id ?? null,
    base_route_found: Boolean(baseRoute),
    visible_route_found: Boolean(visibleRoute),
    permission_check_passed: canAccess,
  };

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

  const [{ data: operator, error: operatorError }, { data: stops, error: stopsError }, { data: routeStock, error: routeStockError }, { data: routeAdjustments, error: adjustmentsError }, { data: routeManualSales, error: manualSalesError }, { data: routeBagSnapshot, error: routeBagSnapshotError }] = await Promise.all([
    routeRow.operator_id
      ? routeReadClient.from("team_members").select("id, full_name").eq("id", routeRow.operator_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    routeReadClient
      .from("route_stops")
      .select("id, stop_order, status, machine_id")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true }),
    routeReadClient
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name, category)")
      .eq("route_id", routeId),
    routeReadClient
      .from("inventory_adjustments")
      .select("id, adjustment_type, product_name, quantity, reason, notes, photo_url, status, created_at, machine_id, route_stop_id")
      .eq("route_id", routeId)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false }),
    routeReadClient
      .from("route_manual_sales")
      .select("id, product_name, quantity, total_amount_lyd, payment_method, sale_time, status, machine_id")
      .eq("route_id", routeId)
      .order("sale_time", { ascending: false }),
    supabase.rpc("snacky_route_bag_snapshot", { p_route_id: routeId }),
  ]);
  if (operatorError) logRouteLoaderIssue({ step: 'load_route_operator', query: 'team_members', error: operatorError, context: loaderContext, optional: true });
  if (stopsError) logRouteLoaderIssue({ step: 'load_route_stops', query: 'route_stops', error: stopsError, context: loaderContext });
  let routeStockRows = (routeStock ?? []) as OperatorRouteStockLineRow[];
  if (routeStockError && isMissingColumn(routeStockError, ["category"])) {
    const fallbackRouteStock = await routeReadClient
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name)")
      .eq("route_id", routeId);
    if (fallbackRouteStock.error) {
      logRouteLoaderIssue({ step: 'load_route_stock_lines_fallback', query: 'route_stock_lines', error: fallbackRouteStock.error, context: loaderContext, optional: true });
      routeStockRows = [];
    } else {
      routeStockRows = (fallbackRouteStock.data ?? []) as OperatorRouteStockLineRow[];
      logRouteLoaderIssue({ step: 'load_route_stock_lines_optional_column_missing', query: 'route_stock_lines', error: routeStockError, context: loaderContext, optional: true });
    }
  } else if (routeStockError) {
    logRouteLoaderIssue({ step: 'load_route_stock_lines', query: 'route_stock_lines', error: routeStockError, context: loaderContext, optional: true });
    routeStockRows = [];
  }
  if (adjustmentsError) logRouteLoaderIssue({ step: 'load_inventory_adjustments', query: 'inventory_adjustments', error: adjustmentsError, context: loaderContext, optional: true });
  if (manualSalesError && !errorText(manualSalesError).toLowerCase().includes("route_manual_sales")) logRouteLoaderIssue({ step: 'load_manual_route_sales', query: 'route_manual_sales', error: manualSalesError, context: loaderContext, optional: true });
  if (routeBagSnapshotError) logRouteLoaderIssue({ step: 'load_route_bag_snapshot', query: 'rpc.snacky_route_bag_snapshot', error: routeBagSnapshotError, context: loaderContext, optional: true });
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
          title={t("Route unavailable")}
          body={t("This route is not assigned to you.")}
          action={<SecondaryButton href="/operator/routes">{t("Back to routes")}</SecondaryButton>}
        />
      </>
    );
  }

  if (stopsError) {
    return (
      <>
        <ErrorState
          title={t("Route details unavailable")}
          body={t("The route stops could not load. Refresh this page and try again. If it keeps happening, ask a supervisor to check the route data.")}
          action={<SecondaryButton href="/operator/routes">{t("Back to routes")}</SecondaryButton>}
        />
      </>
    );
  }

  const routeStops = (stops ?? []) as OperatorRoutePreviewStopRow[];
  const machineIds = routeStops.map((stop) => stop.machine_id).filter(Boolean);
  const { data: machines, error: machinesError } = machineIds.length
    ? await routeReadClient.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", machineIds)
    : { data: [], error: null };
  if (machinesError) logRouteLoaderIssue({ step: 'load_route_machines', query: 'machines', error: machinesError, context: loaderContext, optional: true });
  const machineById = new Map(((machines ?? []) as OperatorRouteMachineRow[]).map((machine) => [machine.id, machine]));
  const adjustmentRows = adjustmentsError ? [] : (routeAdjustments ?? []) as OperatorRouteAdjustmentRow[];
  const manualSaleRows = manualSalesError ? [] : (routeManualSales ?? []) as OperatorRouteManualSaleRow[];
  const confirmedManualSales = manualSaleRows.filter((sale) => String(sale.status ?? "confirmed").toLowerCase() === "confirmed");
  const manualSalesTotal = confirmedManualSales.reduce((sum, sale) => sum + Number(sale.total_amount_lyd ?? 0), 0);
  const manualCashSalesTotal = confirmedManualSales.filter((sale) => String(sale.payment_method ?? "").toLowerCase() === "cash").reduce((sum, sale) => sum + Number(sale.total_amount_lyd ?? 0), 0);
  const manualCardSalesTotal = confirmedManualSales.filter((sale) => String(sale.payment_method ?? "").toLowerCase() === "card").reduce((sum, sale) => sum + Number(sale.total_amount_lyd ?? 0), 0);
  const damagedAdjustmentRows = adjustmentRows.filter((adjustment) => adjustment.adjustment_type === "damaged");
  const returnedAdjustmentRows = adjustmentRows.filter((adjustment) => adjustment.adjustment_type === "returned_from_machine");
  const damagedAdjustmentQty = damagedAdjustmentRows.reduce((sum, adjustment) => sum + Number(adjustment.quantity ?? 0), 0);
  const returnedAdjustmentQty = returnedAdjustmentRows.reduce((sum, adjustment) => sum + Number(adjustment.quantity ?? 0), 0);
  const doneStops = routeStops.filter((s) => isRouteStopDoneStatus(s.status)).length;
  const totalStops = routeStops.length;
  const pickItems = routeStockRows;
  const routeProductsPrepared = pickItems.some((item) => Number(item.planned_qty ?? 0) > 0);
  const hasPickup = pickItems.some((item) => Number(item.picked_qty ?? 0) > 0);
  const routeBagSnapshotValue = Array.isArray(routeBagSnapshot) ? routeBagSnapshot[0] : routeBagSnapshot;
  const routeBagBalances = routeBagSnapshotValue && typeof routeBagSnapshotValue === "object"
    && Array.isArray((routeBagSnapshotValue as { balances?: unknown }).balances)
    ? (routeBagSnapshotValue as { balances: RouteBagSnapshotBalanceRow[] }).balances
    : null;
  const canonicalRouteBagAvailable = !routeBagSnapshotError && routeBagBalances !== null;
  const routeBagRemainingByProduct = new Map<string, number>();
  for (const balance of routeBagBalances ?? []) {
    const productId = String(balance.product_id ?? "").trim();
    const signedQuantity = Number(balance.signed_quantity ?? 0);
    if (!productId || !Number.isFinite(signedQuantity)) continue;
    routeBagRemainingByProduct.set(productId, (routeBagRemainingByProduct.get(productId) ?? 0) + signedQuantity);
  }
  const sortedPickItems = sortPickupProductRows(
    pickItems.map((item) => ({
      ...item,
      productName: item.product?.name ?? "Unknown product",
      productCategory: item.product?.category ?? null,
    })),
  );
  const continueHref = routeProductsPrepared
    ? nextOperatorRouteHref({ routeId, status: routeRow.status, hasPickup, stops: routeStops, start: true })
    : null;
  const primaryAction = continueHref
    ? {
        href: continueHref,
        label: isAvailableRouteStatus(routeRow.status)
          ? (routeRow.operator_id ? t("Start Route") : t("Claim & Start"))
          : t("Continue Route"),
      }
    : null;
  const routeStatus = routeDisplayStatus(routeRow.status, routeRow.operator_id);
  const translatedSuccess = success ? t(success, success) : null;
  const translatedError = error ? t(error, error) : null;

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title={`${t("Route for")} ${routeRow.route_date}`}
          subtitle={`${operator?.full_name ?? t("Available to claim")} - ${totalStops} ${t("machine stops")}`}
          action={<SecondaryButton href="/operator/routes">{t("Back to routes")}</SecondaryButton>}
        />
        {translatedSuccess ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{translatedSuccess}</div> : null}
        {translatedError ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{translatedError}</div> : null}
        {!routeProductsPrepared && totalStops > 0 ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
            <div className="font-semibold">{t("Machine stops assigned — waiting for storage quantities")}</div>
            <p className="mt-1 leading-6">{t("You can review every machine on this route now. The exact products and quantities will be added at storage before the route can start.")}</p>
          </div>
        ) : null}
        {operatorError || machinesError || adjustmentsError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
{t("Some route details could not load. The route is still available, but a few non-critical details may be missing.")}
          </div>
        ) : null}

        {/* Route Status Cards */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">{t("Status")}</div>
              <StatusBadge status={routeStatus} label={t(routeStatus, routeStatus)} />
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">{t("Progress")}</div>
              <div className="font-semibold text-lg">
                {doneStops}/{totalStops}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="mb-1 text-sm text-slate-500">{t("Stops")}</div>
              <div className="font-semibold text-lg text-slate-900">
                {totalStops}
              </div>
              <div className="mt-1 text-xs text-slate-500">
{t("Machine stops on this route.")}
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <div className="text-sm text-slate-500 mb-1">{t("Action")}</div>
              {primaryAction ? (
                <Link href={primaryAction.href} className="btn-primary w-full text-base">
                  {primaryAction.label}
                </Link>
              ) : (
                <div className="text-sm text-slate-600">{routeProductsPrepared ? t("Route completed") : t("Waiting for product quantities")}</div>
              )}
            </div>
          </SectionCard>
        </div>

        {manualSalesError ? (
          <section className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
            {t("manualSales.loadError", "Manual sales could not load. The rest of the route is still available.")}
          </section>
        ) : null}
        {manualSaleRows.length ? (
          <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">{t("manualSales.title", "Manual Route Sales")}</h2>
                <p className="mt-1 text-sm text-slate-500">{t("Manual sales entered during filling are kept separate from VMS sales and cash collection.")}</p>
              </div>
              <StatusBadge status="confirmed" label={t("confirmed", "confirmed")} />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Manual sales")}</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{confirmedManualSales.length}</div>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{t("Manual cash sales")}</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-950">{lyd(manualCashSalesTotal)}</div>
              </div>
              <div className="rounded-lg border border-sky-200 bg-sky-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-sky-800">{t("Manual sales total")}</div>
                <div className="mt-1 text-2xl font-semibold text-sky-950">{lyd(manualSalesTotal)}</div>
                {manualCardSalesTotal > 0 ? <div className="mt-1 text-xs text-sky-800">{t("Card")}: {lyd(manualCardSalesTotal)}</div> : null}
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {manualSaleRows.map((sale) => (
                <article key={sale.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={sale.status} label={t(String(sale.status ?? "confirmed"), String(sale.status ?? "confirmed"))} />
                        <span className="font-semibold text-slate-900">{sale.product_name ?? t("Unknown product")}</span>
                        <span className="text-sm text-slate-500">x{sale.quantity ?? 0}</span>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{lyd(Number(sale.total_amount_lyd ?? 0))} - {t(String(sale.payment_method ?? "cash"), String(sale.payment_method ?? "cash"))}</p>
                    </div>
                    <div className="text-xs text-slate-500">
                      <div>{sale.sale_time ? new Date(sale.sale_time).toLocaleString("en-US") : "-"}</div>
                      <div className="mt-1 font-medium text-slate-700">{formatMachineDisplayName(machineById.get(sale.machine_id ?? "") ?? null, { includeArea: true })}</div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : manualSalesError ? null : (
          <section className="rounded-lg border border-dashed border-slate-300 bg-white p-4 md:p-6">
            <h2 className="text-lg font-semibold text-slate-900">{t("manualSales.title", "Manual Route Sales")}</h2>
            <p className="mt-1 text-sm text-slate-500">{t("manualSales.empty", "No manual sales have been recorded yet.")}</p>
          </section>
        )}

        {adjustmentRows.length ? (
          <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">{t("Inventory adjustments")}</h2>
                <p className="mt-1 text-sm text-slate-500">{t("Damaged products and products returned from the machine are recorded here.")}</p>
              </div>
              <StatusBadge status={damagedAdjustmentRows.length ? "damaged" : "returned_from_machine"} label={damagedAdjustmentRows.length ? t("damaged", "damaged") : t("returned_from_machine", "returned_from_machine")} />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">{t("Damaged units")}</div>
                <div className="mt-1 text-2xl font-semibold text-amber-950">{damagedAdjustmentQty}</div>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{t("Returned units")}</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-950">{returnedAdjustmentQty}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Adjustment rows")}</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{adjustmentRows.length}</div>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {adjustmentRows.map((adjustment) => (
                <article key={adjustment.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={adjustment.adjustment_type} label={t(String(adjustment.adjustment_type ?? "unknown"), String(adjustment.adjustment_type ?? "unknown"))} />
                        <span className="font-semibold text-slate-900">{adjustment.product_name ?? t("Unknown product")}</span>
                        <span className="text-sm text-slate-500">x{adjustment.quantity ?? 0}</span>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{adjustment.reason ?? t("No reason added")}</p>
                      {adjustment.notes ? <p className="mt-1 text-sm text-slate-500">{adjustment.notes}</p> : null}
                    </div>
                    <div className="text-xs text-slate-500">
                      <div>{adjustment.created_at ? new Date(adjustment.created_at).toLocaleString("en-US") : "-"}</div>
                      <div className="mt-1 font-medium text-slate-700">{formatMachineDisplayName(machineById.get(adjustment.machine_id ?? "") ?? null, { includeArea: true })}</div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="rounded-lg border border-dashed border-slate-300 bg-white p-4 md:p-6">
            <h2 className="text-lg font-semibold text-slate-900">{t("Inventory adjustments")}</h2>
            <p className="mt-1 text-sm text-slate-500">{t("No damaged or returned products have been recorded for this route yet")}</p>
          </section>
        )}

        {/* Pick List Section */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">{t("Pick list")}</h2>
          {!canonicalRouteBagAvailable ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {t("The verified operator-bag balance could not be loaded. Refresh before relying on remaining stock quantities.")}
            </div>
          ) : null}
          {isAvailableRouteStatus(routeRow.status) ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <strong>{t("Ready to start") + "?"}</strong> {t("Click")} {routeRow.operator_id ? t("Start Route") : t("Claim & Start")} {t("above to view your pick list and begin picking stock from storage.")}
            </div>
          ) : null}
          {!pickItems.length ? (
            <EmptyState title={t("No pick list yet")} body={t("This route has no products assigned to pick from storage.")} />
          ) : (
            <div className="mb-4 space-y-2">
              {sortedPickItems.map((item) => {
                const productId = String(item.product_id ?? "");
                const verifiedRemaining = canonicalRouteBagAvailable
                  ? routeBagRemainingByProduct.get(productId) ?? 0
                  : null;
                return (
                  <div key={item.id} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 break-words font-medium text-slate-900">{item.product?.name ?? t("Unknown product")}</span>
                    <span className="shrink-0 text-slate-600">
                      {Number(item.picked_qty ?? item.planned_qty ?? 0)} / {Number(item.planned_qty ?? 0)} {t("picked")} · {Number(item.returned_qty ?? 0)} {t("returned")} · {verifiedRemaining === null
                        ? t("verified remaining unavailable")
                        : `${verifiedRemaining} ${t("remaining in operator bag")}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <Link
            href={`/operator/routes/${routeId}/pick-list`}
            className="btn-secondary w-full sm:w-auto"
          >
            {t("View Pick List")}
          </Link>
        </section>

        {isPickupConfirmedStatus(routeRow.status) ? (
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
{t("Pick any prepared machine below. The default stop order is only a suggestion, so you can fill stops in the order that works best")}
          </div>
        ) : null}

        {/* Machine Stops */}
        <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="p-4 md:p-6 border-b border-slate-200">
            <h2 className="text-lg font-semibold">{t("Machine Stops")} ({totalStops})</h2>
          </div>
          {!routeStops.length ? (
            <EmptyState
              title={t("No stops")}
              body={t("This route currently has no machine stops.")}
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
                        <h3 className="break-words font-semibold text-slate-900">{formatMachineDisplayName(machine ?? null, { includeArea: true })}</h3>
                        <p className="text-sm text-slate-500">
                          {t("Code")}: {machine?.machine_code ?? "-"}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={stop.status} label={t(String(stop.status ?? "unknown"), String(stop.status ?? "unknown"))} />
                    </div>
                  </div>

                  {isActiveRouteStatus(routeRow.status) ? (
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      {isRouteStopPendingStatus(stop.status) ? (
                        <Link href={`/operator/routes/${routeId}/pick-list`} className="btn-primary w-full text-base sm:w-auto">
                          {t("Pick this stop")}
                        </Link>
                      ) : isRouteStopActiveStatus(stop.status) ? (
                        <Link
                          href={`/operator/routes/${routeId}/stops/${stop.id}`}
                          className="btn-primary w-full text-base sm:w-auto"
                        >
                          {t("Continue filling")}
                        </Link>
                      ) : null}
                      {!isRouteStopDoneStatus(stop.status) ? (
                        <ConfirmDialog
                          action={skipStop}
                          triggerLabel={t("Skip stop")}
                          title={t("Skip this machine") + "?"}
                          description={t("Skipped stops count as finished for route closure, but any picked stock must still be returned on the leftovers screen.")}
                          confirmLabel={t("Skip stop")}
                          buttonClassName="btn-secondary w-full sm:w-auto"
                          confirmButtonClassName="btn-danger"
                          hiddenFields={[{ name: "route_id", value: routeId }, { name: "stop_id", value: stop.id }]}
                          reasonLabel={t("Skip reason")}
                          reasonPlaceholder={t("Machine inaccessible, closed location, or another reason.")}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  {isRouteStopDoneStatus(stop.status) ? (
                    <div className="mt-1">
                      <Link
                        href={`/operator/routes/${routeId}/stops/${stop.id}`}
                        className="btn-secondary w-full text-base sm:w-auto"
                      >
                        {t("View stop outcome")}
                      </Link>
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
