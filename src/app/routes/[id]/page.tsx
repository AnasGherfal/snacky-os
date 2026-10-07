import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import {
  AdminMissedPickupRecorder,
  type MissedPickupProductOption,
  type MissedPickupStorageOption,
} from "@/components/routes/AdminMissedPickupRecorder";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canExecuteRoutes, isAdminRole, isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { moneyLabel } from "@/lib/payroll";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { ROUTE_CANCELED_STATUS, isActiveRouteStatus, isAvailableRouteStatus, isCompletedRouteStatus, isPickupConfirmedStatus, isRouteInventoryFinalizableStatus, isRouteItemsEditableStatus, isRouteStopDoneStatus, isTerminalRouteStatus, nextOperatorRouteHref, routeDisplayStatus } from "@/lib/route-workflow";
import { RouteCreatedToast } from "@/app/routes/[id]/RouteCreatedToast";
import { assignRoute, autoPrepareRouteProducts, deleteDraftRoute } from "@/lib/route-actions";
import { getServerI18n } from "@/lib/i18n/server";
import {
  ROUTE_INVENTORY_OPEN_STATUSES,
  isMissingRouteInventoryReviewSchema,
  routeInventoryDiscrepancyStatusLabel,
  routeInventoryDiscrepancyTypeLabel,
  type RouteInventoryDiscrepancyRow,
} from "@/lib/route-inventory-discrepancies";
import Link from "next/link";
import { Suspense } from "react";
import { RouteActivitySection, RouteCompletionImagesSection, RouteDeferredSectionSkeleton } from "@/app/routes/[id]/RouteDeferredSections";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
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

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function tr(locale: "ar" | "en", en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

function routeBadgeLabel(locale: "ar" | "en", status: string) {
  const value = String(status ?? "").toLowerCase();
  if (value === "available") return tr(locale, "Available", "متاحة");
  if (value === "active" || value === "in_progress" || value === "started" || value === "filling" || value === "machine_filling") return tr(locale, "In progress", "قيد التنفيذ");
  if (value === "completed") return tr(locale, "Completed", "مكتملة");
  if (value === "cancelled" || value === "canceled") return tr(locale, "Cancelled", "ملغاة");
  return tr(locale, value.replaceAll("_", " "), value.replaceAll("_", " "));
}

function routeStepLabel(locale: "ar" | "en", status: string) {
  const value = String(status ?? "").toLowerCase();
  if (value === "completed" || value === "done") return tr(locale, "Completed", "مكتمل");
  if (value === "pending") return tr(locale, "Pending", "قيد الانتظار");
  if (value === "active" || value === "in_progress") return tr(locale, "Active", "نشط");
  if (value === "skipped") return tr(locale, "Skipped", "متخطى");
  if (value === "available") return tr(locale, "Available", "متاح");
  return value.replaceAll("_", " ");
}

function routeActionLabel(locale: "ar" | "en", action: string) {
  const value = String(action ?? "").toLowerCase();
  if (value === "storage_to_operator_bag") return tr(locale, "Storage to operator bag", "من المخزن إلى حقيبة المشغل");
  if (value === "operator_bag_to_storage") return tr(locale, "Operator bag to storage", "من حقيبة المشغل إلى المخزن");
  if (value === "operator_to_machine") return tr(locale, "Operator to machine", "من المشغل إلى الجهاز");
  if (value === "manual_admin_assignment") return tr(locale, "Manual admin assignment", "تعيين إداري يدوي");
  if (value === "refill_recommendation") return tr(locale, "Refill recommendation", "توصية تعبئة");
  return value.replaceAll("_", " ");
}

function routeReviewLabel(locale: "ar" | "en", status: string) {
  const value = String(status ?? "").toLowerCase();
  if (value === "verified") return tr(locale, "Verified", "مؤكد");
  if (value === "payroll_pending") return tr(locale, "Payroll pending", "بانتظار الأجور");
  if (value === "paid") return tr(locale, "Paid", "مدفوع");
  if (value === "reviewed") return tr(locale, "Reviewed", "تمت المراجعة");
  if (value === "needs_review") return tr(locale, "Needs review", "يحتاج مراجعة");
  if (value === "ok") return tr(locale, "OK", "سليم");
  if (value === "deducted") return tr(locale, "Deducted", "تم الخصم");
  if (value === "none") return tr(locale, "None", "لا يوجد");
  return value.replaceAll("_", " ");
}

function routeRoleLabel(locale: "ar" | "en", role: string | null | undefined) {
  const value = String(role ?? "").toLowerCase();
  if (value === "owner") return tr(locale, "Owner", "المالك");
  if (value === "admin") return tr(locale, "Admin", "الإدارة");
  if (value === "supervisor") return tr(locale, "Supervisor", "مشرف");
  if (value === "operator") return tr(locale, "Operator", "مشغل");
  if (value === "finance") return tr(locale, "Finance", "المالية");
  if (value === "warehouse") return tr(locale, "Warehouse", "المخزن");
  return value.replaceAll("_", " ");
}

function routeIssueTypeLabel(locale: "ar" | "en", issueType: string | null | undefined) {
  const value = String(issueType ?? "").toLowerCase();
  if (value === "critical") return tr(locale, "Critical", "حرج");
  if (value === "high") return tr(locale, "High", "مرتفع");
  if (value === "medium") return tr(locale, "Medium", "متوسط");
  if (value === "low") return tr(locale, "Low", "منخفض");
  if (value === "machine_jam") return tr(locale, "Machine jam", "تعطل الجهاز");
  if (value === "stock_missing") return tr(locale, "Missing stock", "مخزون مفقود");
  if (value === "cash_variance") return tr(locale, "Cash variance", "فارق الكاش");
  if (value === "damaged_item") return tr(locale, "Damaged item", "منتج تالف");
  if (value === "expired_item") return tr(locale, "Expired item", "منتج منتهي الصلاحية");
  return value.replaceAll("_", " ");
}

export default async function RouteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const { id } = await params;
  const { error = "", success = "" } = await searchParams;
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes")) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title={tr(locale, "Route unavailable", "الجولة غير متاحة")} body={tr(locale, "Supabase is not configured, so route details cannot be loaded.", "لم يتم إعداد Supabase، لذلك لا يمكن تحميل تفاصيل الجولة.")} action={<SecondaryButton href="/routes">{tr(locale, "Back to routes", "العودة إلى الجولات")}</SecondaryButton>} />
      </>
    );
  }

  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status, started_at, completed_at, cancelled_at, cancelled_by, cancellation_reason, notes, created_at")
    .eq("id", id)
    .maybeSingle();

  if (routeError) {
    console.error("[routes:detail] Failed to load route by id", { id, error: routeError });
  }

  if (!route) {
    return (
      <>
        <PageHeader
          title={tr(locale, "Route details", "تفاصيل الجولة")}
          subtitle={tr(locale, "This route could not be loaded.", "تعذر تحميل هذه الجولة.")}
          breadcrumbs={[{ label: tr(locale, "Operations", "العمليات"), href: "/routes" }, { label: tr(locale, "Routes", "الجولات"), href: "/routes" }, { label: tr(locale, "Missing route", "الجولة غير موجودة") }]}
          action={<SecondaryButton href="/routes">{tr(locale, "Back to routes", "العودة إلى الجولات")}</SecondaryButton>}
        />
        <ErrorState
          title={tr(locale, "Route not found", "لم يتم العثور على الجولة")}
          body={tr(locale, "The route may have been deleted, failed to save, or you may not have permission to view it.", "قد تكون الجولة حُذفت، أو تعذر حفظها، أو لا تملك صلاحية عرضها.")}
          action={<SecondaryButton href="/routes/new">{tr(locale, "Create route", "إنشاء جولة")}</SecondaryButton>}
        />
      </>
    );
  }

  const routeRow: any = route;
  const canReviewRouteInventory = isAdminRole(profile);
  const supportClient = getSupabaseAdminClient() ?? supabase;
  const [routeDiscrepancyResult, { data: operator }, { data: performers }, { data: stops, error: stopsError }, { data: stopItems, error: stopItemsError }, { data: routeStock, error: routeStockError }, { data: fillLines, error: fillLinesError }, { data: pickListItems, error: pickListItemsError }] = await Promise.all([
    canReviewRouteInventory
      ? supabase
          .from("route_inventory_discrepancies")
          .select("id, route_id, route_stop_id, machine_id, operator_id, product_id, discrepancy_type, recorded_quantity, actual_quantity, difference_quantity, absolute_quantity, status, source_type, source_id, details, detected_at, resolution_type, resolution_notes, resolved_at, correcting_movement_id, updated_at, product:products(name, sku)", { count: "exact" })
          .eq("route_id", id)
          .in("status", [...ROUTE_INVENTORY_OPEN_STATUSES])
          .order("detected_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null, count: 0 }),
    routeRow.operator_id
      ? supabase.from("team_members").select("id, full_name").eq("id", routeRow.operator_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("team_members").select("id, full_name, role, roles").or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}").eq("active", true).order("full_name"),
    supabase
      .from("route_stops")
      .select("id, stop_order, status, machine_id")
      .eq("route_id", id)
      .order("stop_order", { ascending: true }),
    supabase
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, machine_slot_id, slot_code, planned_quantity, recommended_take_qty, final_take_qty, picked_quantity, filled_quantity, source, notes, slot_allocations")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name)")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("route_stop_fill_lines")
      .select("id, route_stop_id, machine_id, assigned_product_id, product_id, substitute_product_id, action_type, assigned_qty, actual_qty, difference_qty, reason, notes, missing_product_name, needs_review, created_at")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("route_pick_list_items")
      .select("id, pickup_batch_id, product_id, planned_qty, picked_qty, action_type, substituted_for_product_id, reason, notes, needs_review, is_active, created_at, product:products!route_pick_list_items_product_id_fkey(id, name), substituted_product:products!route_pick_list_items_substituted_for_product_id_fkey(id, name)")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
  ]);

  const routeDiscrepancySchemaMissing = Boolean(
    routeDiscrepancyResult.error && isMissingRouteInventoryReviewSchema(routeDiscrepancyResult.error),
  );
  const routeDiscrepancyLoadError = routeDiscrepancyResult.error && !routeDiscrepancySchemaMissing
    ? routeDiscrepancyResult.error
    : null;
  if (routeDiscrepancyLoadError) {
    console.error("[routes:detail] Failed to load route inventory discrepancies", { id, error: routeDiscrepancyLoadError });
  }
  const routeDiscrepancies = (routeDiscrepancyResult.data ?? []) as Array<RouteInventoryDiscrepancyRow & { product?: { name?: string | null; sku?: string | null } | Array<{ name?: string | null; sku?: string | null }> | null }>;
  const openRouteDiscrepancies = routeDiscrepancies;
  const openRouteDiscrepancyCount = routeDiscrepancyResult.count ?? openRouteDiscrepancies.length;
  let openRouteDiscrepancyUnits: number | null = canReviewRouteInventory && !routeDiscrepancyResult.error
    ? routeDiscrepancies.reduce((sum, row) => sum + Math.max(0, Number(row.absolute_quantity ?? 0)), 0)
    : null;
  // The detail query already carries the first 100 discrepancy quantities.
  // Only fetch extra pages for the exceptional route with more than 100 open rows.
  if (openRouteDiscrepancyUnits !== null && openRouteDiscrepancyCount > routeDiscrepancies.length) {
    const pageSize = 1_000;
    let offset = routeDiscrepancies.length;
    while (offset < openRouteDiscrepancyCount) {
      const discrepancyUnitsPage = await supabase
        .from("route_inventory_discrepancies")
        .select("id, absolute_quantity")
        .eq("route_id", id)
        .in("status", [...ROUTE_INVENTORY_OPEN_STATUSES])
        .order("detected_at", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (discrepancyUnitsPage.error) {
        console.error("[routes:detail] Failed to load remaining route discrepancy unit total", { id, error: discrepancyUnitsPage.error });
        openRouteDiscrepancyUnits = null;
        break;
      }
      const rows = discrepancyUnitsPage.data ?? [];
      openRouteDiscrepancyUnits += rows.reduce((sum, row) => sum + Math.max(0, Number(row.absolute_quantity ?? 0)), 0);
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
  }

  if (stopsError) console.error("[routes:detail] Failed to load route stops", { id, error: stopsError });
  let routeStopItems = stopItems ?? [];
  if (stopItemsError) {
    if (isMissingTable(stopItemsError, "route_stop_items")) {
      const { data: fallbackOrders, error: fallbackError } = await supabase
        .from("refill_orders")
        .select("id, machine_id, refill_order_lines(id, machine_slot_id, slot_code, product_id, final_qty_to_take, suggested_qty, source)")
        .eq("route_id", id);
      if (fallbackError) {
        console.error("[routes:detail] Failed to load fallback refill lines", { id, error: fallbackError });
      } else {
        routeStopItems = (fallbackOrders ?? []).flatMap((order: any) =>
          (order.refill_order_lines ?? []).map((line: any) => {
            const stop = (stops ?? []).find((routeStop: any) => routeStop.machine_id === order.machine_id);
            return {
              id: line.id,
              route_stop_id: stop?.id ?? null,
              machine_id: order.machine_id,
              product_id: line.product_id,
              machine_slot_id: line.machine_slot_id,
              slot_code: line.slot_code,
              planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
              source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
            };
          }),
        );
      }
    } else {
      console.error("[routes:detail] Failed to load route stop items", { id, error: stopItemsError });
    }
  }
  if (routeStockError) console.error("[routes:detail] Failed to load route stock", { id, error: routeStockError });
  if (fillLinesError) console.error("[routes:detail] Failed to load operator fill lines", { id, error: fillLinesError });
  let routePickListItems: any[] = pickListItems ?? [];
  if (pickListItemsError && isMissingColumn(pickListItemsError, ["pickup_batch_id"])) {
    const { data: fallbackPickListItems, error: fallbackPickListItemsError } = await supabase
      .from("route_pick_list_items")
      .select("id, product_id, planned_qty, picked_qty, action_type, substituted_for_product_id, reason, notes, needs_review, is_active, created_at, product:products!route_pick_list_items_product_id_fkey(id, name), substituted_product:products!route_pick_list_items_substituted_for_product_id_fkey(id, name)")
      .eq("route_id", id)
      .order("created_at", { ascending: true });
    routePickListItems = fallbackPickListItems ?? [];
    if (fallbackPickListItemsError && !isMissingTable(fallbackPickListItemsError, "route_pick_list_items")) console.error("[routes:detail] Failed to load fallback route pick list items", { id, error: fallbackPickListItemsError });
  } else if (pickListItemsError && !isMissingTable(pickListItemsError, "route_pick_list_items")) {
    console.error("[routes:detail] Failed to load route pick list items", { id, error: pickListItemsError });
  }

  const routeStops = stops ?? [];
  routePickListItems = routePickListItems.filter((item: any) => item.is_active !== false);
  const stopIds = routeStops.map((stop: any) => stop.id).filter(Boolean);
  const machineIds = Array.from(new Set([...routeStops.map((stop: any) => stop.machine_id), ...(stopItems ?? []).map((item: any) => item.machine_id)].filter(Boolean)));
  const productIds = Array.from(new Set([
    ...routeStopItems.map((line: any) => line.product_id),
    ...(routeStock ?? []).map((line: any) => line.product_id),
    ...(fillLines ?? []).flatMap((line: any) => [line.assigned_product_id, line.product_id, line.substitute_product_id]),
    ...routePickListItems.flatMap((line: any) => [line.product_id, line.substituted_for_product_id]),
  ].filter(Boolean)));
  const [
    { data: machines },
    { data: products },
    { data: movements },
    { data: cashCollections },
    { data: issues },
    { data: routePayBreakdown, error: routePayError },
    terminalReconciliationResult,
    canonicalRouteBagSnapshotResult,
    pendingStopInventoryCommitResult,
    manualSalesResult,
    adjustmentsResult,
    quantityConfirmationsResult,
    smartXyEventsResult,
  ] = await Promise.all([
    machineIds.length ? supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", machineIds) : Promise.resolve({ data: [] }),
    productIds.length ? supabase.from("products").select("id, name").in("id", productIds) : Promise.resolve({ data: [] }),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, movement_type, source_type, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")
      .eq("related_route_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("cash_collections")
      .select("id, machine_id, vms_expected_cash, actual_cash_collected, variance, review_status, collected_at")
      .eq("route_id", id)
      .order("collected_at", { ascending: false }),
    machineIds.length
      ? supabase
          .from("issues")
          .select("id, machine_id, issue_type, priority, status, description, created_at")
          .in("machine_id", machineIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    supabase.from("route_pay_breakdowns").select("id, total_pay_lyd, payroll_period_id, recalculated_at").eq("route_id", id).maybeSingle(),
    supportClient
      .from("route_inventory_reconciliations")
      .select("id, action, status, returned_units, finalized_at")
      .eq("route_id", id)
      .maybeSingle(),
    supabase.rpc("snacky_route_bag_snapshot", { p_route_id: id }),
    supportClient
      .from("route_stop_inventory_commits")
      .select("id, route_stop_id", { count: "exact" })
      .eq("route_id", id)
      .is("workflow_completed_at", null)
      .order("created_at", { ascending: true })
      .limit(20),
    supportClient
      .from("route_manual_sales")
      .select("id, route_id, route_stop_id, machine_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, sale_time, status")
      .eq("route_id", id)
      .order("sale_time", { ascending: true }),
    supportClient
      .from("inventory_adjustments")
      .select("id, route_id, route_stop_id, machine_id, adjustment_type, product_id, product_name, quantity, reason, notes, status, created_at")
      .eq("route_id", id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: true }),
    stopIds.length
      ? supportClient
          .from("route_stop_quantity_confirmations")
          .select("route_stop_id, quantity_rows, verification_status, submitted_at, confirmed_at, resolved_at")
          .in("route_stop_id", stopIds)
      : Promise.resolve({ data: [], error: null }),
    supportClient
      .from("system_activity_logs")
      .select("action, entity_id, metadata, summary, created_at")
      .contains("metadata", { route_id: id })
      .in("action", ["xy_slot_product_change", "xy_slot_product_change_unverified", "xy_slot_product_change_rejected"])
      .order("created_at", { ascending: true }),
  ]);
  if (routePayError) console.error("[routes:detail] Failed to load route pay breakdown", { id, error: routePayError });
  if (terminalReconciliationResult.error && !isMissingRouteInventoryReviewSchema(terminalReconciliationResult.error)) {
    console.error("[routes:detail] Failed to load terminal inventory reconciliation", { id, error: terminalReconciliationResult.error });
  }
  if (canonicalRouteBagSnapshotResult.error && !isMissingRouteInventoryReviewSchema(canonicalRouteBagSnapshotResult.error)) {
    console.error("[routes:detail] Failed to load canonical route bag snapshot", { id, error: canonicalRouteBagSnapshotResult.error });
  }
  if (pendingStopInventoryCommitResult.error && !isMissingRouteInventoryReviewSchema(pendingStopInventoryCommitResult.error)) {
    console.error("[routes:detail] Failed to check pending stop inventory commits", { id, error: pendingStopInventoryCommitResult.error });
  }
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  if (manualSalesResult.error && !isMissingTable(manualSalesResult.error, "route_manual_sales")) console.warn("[routes:detail] Manual sales unavailable", { id, error: manualSalesResult.error });
  if (adjustmentsResult.error && !isMissingTable(adjustmentsResult.error, "inventory_adjustments")) console.warn("[routes:detail] Inventory adjustments unavailable", { id, error: adjustmentsResult.error });
  if (quantityConfirmationsResult.error && !isMissingTable(quantityConfirmationsResult.error, "route_stop_quantity_confirmations")) console.warn("[routes:detail] Quantity confirmations unavailable", { id, error: quantityConfirmationsResult.error });
  if (smartXyEventsResult.error && !isMissingTable(smartXyEventsResult.error, "system_activity_logs")) console.warn("[routes:detail] Smart Route XY events unavailable", { id, error: smartXyEventsResult.error });
  const manualSales = manualSalesResult.error ? [] : (manualSalesResult.data ?? []);
  const routeAdjustments = adjustmentsResult.error ? [] : (adjustmentsResult.data ?? []);
  const routeQuantityConfirmations = quantityConfirmationsResult.error ? [] : (quantityConfirmationsResult.data ?? []);
  const smartXyEvents = smartXyEventsResult.error ? [] : (smartXyEventsResult.data ?? []);
  const { data: queuedXyChanges, error: queuedXyError } = await supportClient
    .from("xy_pending_slot_changes")
    .select("id,machine_id,slot_code,target_product_id,target_stock_qty,status,last_error,attempt_count,verified_at,created_at")
    .eq("route_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (queuedXyError && !isMissingTable(queuedXyError, "xy_pending_slot_changes")) {
    console.warn("[routes:detail] Pending XY changes unavailable", { id, error: queuedXyError });
  }
  const xyQueueRows = queuedXyError ? [] : (queuedXyChanges ?? []);
  const completionImageStopDescriptors = routeStops.map((stop: any) => ({
    id: String(stop.id),
    title: formatMachineDisplayName(machineById.get(stop.machine_id) ?? null, { includeArea: true }),
    subtitle: tr(locale, `Stop ${stop.stop_order || "-"} - ${machineById.get(stop.machine_id)?.machine_code ?? "-"}`, `الموقع ${stop.stop_order || "-"} - ${machineById.get(stop.machine_id)?.machine_code ?? "-"}`),
  }));
  const canManageRouteAssignment = isAdminRole(profile);
  const canEditRouteItems = isOwnerAdminRole(profile) && isRouteItemsEditableStatus(routeRow.status);
  const routeProductsPrepared = Boolean((routeStock ?? []).some((item: any) => Number(item.planned_qty ?? 0) > 0) || routeStopItems.some((item: any) => Number(item.planned_quantity ?? 0) > 0));
  const productsPendingAtStorage = routeStops.length > 0 && !routeProductsPrepared && isAvailableRouteStatus(routeRow.status);
  const hasPickMovements = Boolean(movements?.some((movement: any) => movement.reason === "storage_to_operator_bag"));
  const terminalInventoryReconciliation = terminalReconciliationResult.error ? null : terminalReconciliationResult.data;
  const canonicalRouteBagSnapshot = !canonicalRouteBagSnapshotResult.error
    && canonicalRouteBagSnapshotResult.data
    && typeof canonicalRouteBagSnapshotResult.data === "object"
    && !Array.isArray(canonicalRouteBagSnapshotResult.data)
    ? canonicalRouteBagSnapshotResult.data as { balances?: Array<{ signed_quantity?: number | string | null }> }
    : null;
  const canonicalRouteBagBalances = Array.isArray(canonicalRouteBagSnapshot?.balances) ? canonicalRouteBagSnapshot.balances : [];
  const hasAuthoritativeZeroRouteBag = canonicalRouteBagBalances.length > 0
    && canonicalRouteBagBalances.every((balance) => Number(balance.signed_quantity ?? 0) === 0);
  const leftoversReconciled = Boolean(terminalInventoryReconciliation) || hasAuthoritativeZeroRouteBag;
  const hasPendingStopInventoryCommit = Boolean(pendingStopInventoryCommitResult.error)
    || Number(pendingStopInventoryCommitResult.count ?? 0) > 0;
  const pendingStopInventoryCommits = pendingStopInventoryCommitResult.error
    ? []
    : (pendingStopInventoryCommitResult.data ?? []) as Array<{ id: string; route_stop_id: string }>;
  const firstPendingStopInventoryCommit = pendingStopInventoryCommits[0] ?? null;
  const cashIds = (cashCollections ?? []).map((cash: any) => cash.id).filter(Boolean);
  const canRecordMissedPickup = isOwnerAdminRole(profile)
    && Boolean(profile.team_member_id)
    && Boolean(routeRow.operator_id)
    && ["in_progress", "pickup_confirmed"].includes(String(routeRow.status ?? ""))
    && routePickListItems.length > 0;
  let missedPickupStorages: MissedPickupStorageOption[] = [];
  let missedPickupProducts: MissedPickupProductOption[] = [];
  let missedPickupDataError = "";
  if (canRecordMissedPickup) {
    const [storageResult, catalogResult] = await Promise.all([
      supabase
        .from("storage_locations")
        .select("id, name, location_type")
        .eq("active", true)
        .in("location_type", ["main_storage", "vehicle", "temporary", "other"])
        .order("location_type")
        .order("name"),
      supabase.from("products").select("id, name, sku, barcode, category, brand, image_url").eq("active", true).order("name"),
    ]);
    if (storageResult.error) {
      console.error("[routes:detail] Failed to load storage locations for missed pickup recorder", { id, error: storageResult.error });
      missedPickupDataError = tr(locale, "Storage locations could not be loaded for this correction.", "تعذر تحميل مواقع التخزين لهذا التصحيح.");
    } else {
      missedPickupStorages = (storageResult.data ?? []).map((storage: { id: string; name: string | null }) => ({ id: String(storage.id), name: String(storage.name ?? tr(locale, "Storage", "المخزن")) }));
      const activeStorageIds = missedPickupStorages.map((storage) => storage.id);
      const inventoryResult = activeStorageIds.length
        ? await supabase
            .from("current_inventory_by_location")
            .select("product_id, location_id, quantity_on_hand")
            .eq("location_type", "storage")
            .in("location_id", activeStorageIds)
        : { data: [], error: null };
      if (catalogResult.error || inventoryResult.error) {
        console.error("[routes:detail] Failed to load products for missed pickup recorder", { id, catalogError: catalogResult.error, inventoryError: inventoryResult.error });
        missedPickupDataError = tr(locale, "The active product catalog or storage balance could not be loaded.", "تعذر تحميل المنتجات النشطة أو رصيد المخزون.");
      } else {
        const quantityByProductAndStorage = new Map<string, number>();
        (inventoryResult.data ?? []).forEach((row: { product_id: string | null; location_id: string | null; quantity_on_hand: number | string | null }) => {
          const productId = String(row.product_id ?? "");
          const storageId = String(row.location_id ?? "");
          if (!productId || !storageId) return;
          const key = `${productId}:${storageId}`;
          quantityByProductAndStorage.set(key, Math.max(0, Number(quantityByProductAndStorage.get(key) ?? 0) + Number(row.quantity_on_hand ?? 0)));
        });
        missedPickupProducts = (catalogResult.data ?? []).map((product: { id: string; name: string | null; sku: string | null; barcode: string | null; category: string | null; brand: string | null; image_url: string | null }) => ({
          id: String(product.id),
          name: String(product.name ?? tr(locale, "Unknown product", "منتج غير معروف")),
          sku: product.sku ?? null,
          barcode: product.barcode ?? null,
          category: product.category ?? null,
          brand: product.brand ?? null,
          imageUrl: product.image_url ?? null,
          quantityByStorageId: Object.fromEntries(activeStorageIds.map((storageId) => [storageId, Math.max(0, Math.floor(quantityByProductAndStorage.get(`${product.id}:${storageId}`) ?? 0))])),
        }));
      }
    }
  }
  const canStartRoute = canExecuteRoutes(profile) && Boolean(profile.team_member_id) && isAvailableRouteStatus(routeRow.status) && routeProductsPrepared;
  const continueHref = canExecuteRoutes(profile) && routeProductsPrepared
    ? nextOperatorRouteHref({ routeId: id, status: routeRow.status, hasPickup: hasPickMovements, stops: routeStops, start: true })
    : null;
  const productById = new Map((products ?? []).map((product: any) => [product.id, product]));
  const quantityConfirmationByStop = new Map(routeQuantityConfirmations.map((row: any) => [row.route_stop_id, row]));
  const smartXyEventByStopLane = new Map<string, any>();
  smartXyEvents.forEach((event: any) => {
    const stopId = String(event?.metadata?.route_stop_id ?? "");
    const slotCode = String(event?.metadata?.slot_code ?? event?.metadata?.slot ?? "");
    if (!stopId || !slotCode) return;
    smartXyEventByStopLane.set(`${stopId}:${slotCode}`, event);
  });
  const smartRouteLaneRows = routeStopItems.flatMap((item: any) => {
    if (item.source !== "smart_ai_plan") return [];
    const allocations = Array.isArray(item.slot_allocations) && item.slot_allocations.length
      ? item.slot_allocations
      : [{
          machine_slot_id: item.machine_slot_id ?? null,
          slot_code: item.slot_code ?? null,
          current_qty: 0,
          observed_current_qty: 0,
          target_qty: Number(item.planned_quantity ?? 0),
          recommended_take_qty: Number(item.planned_quantity ?? 0),
          final_take_qty: Number(item.planned_quantity ?? 0),
          allocation_kind: "slot",
          transition_mode: "none",
          substituted: false,
          from_product_id: item.product_id,
          from_product_name: productById.get(item.product_id)?.name ?? null,
          return_current_qty: 0,
        }];

    return allocations.map((allocation: any) => {
      const slotCode = String(allocation.slot_code ?? item.slot_code ?? "");
      const confirmation = quantityConfirmationByStop.get(item.route_stop_id) as any;
      const quantityRows = Array.isArray(confirmation?.quantity_rows) ? confirmation.quantity_rows : [];
      const actualLane = quantityRows.find((row: any) => (
        String(row.slotCode ?? row.slot_code ?? "") === slotCode
        && String(row.productId ?? row.product_id ?? "") === String(item.product_id)
      )) ?? null;
      const fromProductId = String(allocation.from_product_id ?? item.product_id ?? "");
      const requiredReturnQty = Math.max(0, Number(allocation.return_current_qty ?? 0));
      const returnRows = routeAdjustments.filter((adjustment: any) => (
        adjustment.route_stop_id === item.route_stop_id
        && adjustment.adjustment_type === "returned_from_machine"
        && adjustment.reason === "Product replaced"
        && String(adjustment.product_id ?? "") === fromProductId
        && String(adjustment.notes ?? "").startsWith("Smart Route product swap")
        && String(adjustment.notes ?? "").includes(`lane ${slotCode}`)
      ));
      const returnedQty = returnRows.reduce((sum: number, adjustment: any) => sum + Math.max(0, Number(adjustment.quantity ?? 0)), 0);
      const xyEvent = smartXyEventByStopLane.get(`${item.route_stop_id}:${slotCode}`) ?? null;
      return {
        routeStopItemId: item.id,
        routeStopId: item.route_stop_id,
        machineId: item.machine_id,
        productId: item.product_id,
        productName: productById.get(item.product_id)?.name ?? tr(locale, "Unknown product", "منتج غير معروف"),
        slotCode: slotCode || "-",
        plannedAdd: Math.max(0, Number(allocation.final_take_qty ?? item.planned_quantity ?? 0)),
        previousQty: Math.max(0, Number(allocation.current_qty ?? 0)),
        observedPreviousQty: Math.max(0, Number(allocation.observed_current_qty ?? allocation.current_qty ?? 0)),
        targetQty: Math.max(0, Number(allocation.target_qty ?? 0)),
        actualAdded: actualLane ? Math.max(0, Number(actualLane.addedQty ?? actualLane.added_qty ?? 0)) : null,
        actualFinal: actualLane ? Math.max(0, Number(actualLane.finalQty ?? actualLane.final_qty ?? 0)) : null,
        verificationStatus: String(confirmation?.verification_status ?? ""),
        transitionMode: String(allocation.transition_mode ?? "none"),
        substituted: allocation.substituted === true,
        fromProductId,
        fromProductName: String(allocation.from_product_name ?? productById.get(fromProductId)?.name ?? "-"),
        requiredReturnQty,
        returnedQty,
        xyAction: String(xyEvent?.action ?? ""),
        xySummary: String(xyEvent?.summary ?? ""),
      };
    });
  });
  const confirmedManualSales = manualSales.filter((sale: any) => String(sale.status ?? "confirmed").toLowerCase() === "confirmed");
  const manualSalesTotal = confirmedManualSales.reduce((sum: number, sale: any) => sum + Number(sale.total_amount_lyd ?? 0), 0);
  const damagedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "damaged");
  const returnedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "returned_from_machine");
  const zeroFillReturnMovementRows = (movements ?? []).filter((movement: any) => ["route_stop_zero_fill_return", "route_stop_zero_fill_return_reversal"].includes(String(movement.source_type ?? "")));
  const zeroFillReturnByScope = new Map<string, any>();
  zeroFillReturnMovementRows.forEach((movement: any) => {
    const productId = String(movement.product_id ?? "");
    const stopScope = String(movement.related_route_stop_id ?? "");
    const machineScope = String(movement.related_machine_id ?? "");
    if (!productId) return;
    const key = [stopScope, machineScope, productId].join(":");
    const current = zeroFillReturnByScope.get(key) ?? { ...movement, quantity: 0 };
    const direction = String(movement.source_type ?? "") === "route_stop_zero_fill_return_reversal" ? -1 : 1;
    current.quantity = Number(current.quantity ?? 0) + direction * Number(movement.quantity ?? 0);
    zeroFillReturnByScope.set(key, current);
  });
  const zeroFillReturnMovements = Array.from(zeroFillReturnByScope.values())
    .map((movement: any) => ({ ...movement, quantity: Math.max(0, Number(movement.quantity ?? 0)) }))
    .filter((movement: any) => Number(movement.quantity ?? 0) > 0);
  const machineStorageMovements = (movements ?? []).filter((movement: any) => {
    const reason = String(movement.reason ?? "").toLowerCase();
    return movement.to_entity_type === "machine_storage"
      || movement.movement_type === "route_to_machine_storage"
      || reason === "extra_stock_left_at_machine"
      || reason === "machine_storage";
  });
  const damagedTotalQty = damagedAdjustments.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);
  const returnedTotalQty = returnedAdjustments.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0)
    + zeroFillReturnMovements.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);
  const machineStorageTotalQty = machineStorageMovements.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);
  const outcomeByMachine = routeStops.map((stop: any) => {
    const machineId = String(stop.machine_id ?? "");
    const fills = (fillLines ?? []).filter((line: any) => String(line.machine_id ?? "") === machineId && String(line.action_type ?? "") !== "missing_product_report");
    const sales = confirmedManualSales.filter((sale: any) => String(sale.machine_id ?? "") === machineId);
    const damaged = damagedAdjustments.filter((row: any) => String(row.machine_id ?? "") === machineId || String(row.route_stop_id ?? "") === String(stop.id));
    const returned = [
      ...returnedAdjustments.filter((row: any) => String(row.machine_id ?? "") === machineId || String(row.route_stop_id ?? "") === String(stop.id)),
      ...zeroFillReturnMovements
        .filter((row: any) => String(row.related_machine_id ?? "") === machineId || String(row.related_route_stop_id ?? "") === String(stop.id))
        .map((row: any) => ({
          ...row,
          product_name: firstRelation(row.product)?.name ?? tr(locale, "Product", "منتج"),
        })),
    ];
    const machineStorage = machineStorageMovements.filter((row: any) => String(row.related_machine_id ?? "") === machineId || String(row.related_route_stop_id ?? "") === String(stop.id));
    return {
      stop,
      machineId,
      fills,
      sales,
      damaged,
      returned,
      machineStorage,
      salesTotal: sales.reduce((sum: number, sale: any) => sum + Number(sale.total_amount_lyd ?? 0), 0),
    };
  });
  const completedStopCount = routeStops.filter((stop: any) => isRouteStopDoneStatus(stop.status)).length;
  const routeAllowsInventoryCompletion = isRouteInventoryFinalizableStatus(routeRow.status);
  const canCountAndFinishRoute = canManageRouteAssignment
    && Boolean(routeRow.operator_id)
    && routeAllowsInventoryCompletion
    && routeStops.length > 0
    && completedStopCount === routeStops.length
    && !hasPendingStopInventoryCommit;
  const leftoverReturnDetail = terminalInventoryReconciliation
    ? tr(locale, "Terminal inventory count finalized", "تم اعتماد العدّ النهائي للمخزون")
    : hasAuthoritativeZeroRouteBag
      ? tr(locale, "Canonical operator bag balance is zero", "الرصيد المعتمد لحقيبة المشغل يساوي صفرًا")
      : tr(locale, "Awaiting verified leftover reconciliation", "بانتظار التسوية المؤكدة للمتبقي");
  const timeline = [
    { label: tr(locale, "Draft", "مسودة"), done: true, detail: tr(locale, `Created ${new Date(routeRow.created_at).toLocaleString("en-US")}`, `تم الإنشاء ${new Date(routeRow.created_at).toLocaleString("ar-LY")}`) },
    { label: tr(locale, "Available", "متاحة"), done: isAvailableRouteStatus(routeRow.status) || isActiveRouteStatus(routeRow.status) || isCompletedRouteStatus(routeRow.status), detail: operator?.full_name ?? tr(locale, "Unassigned / available", "غير مسندة / متاحة") },
    { label: tr(locale, "Picked", "تم التحميل"), done: hasPickMovements || isPickupConfirmedStatus(routeRow.status), detail: hasPickMovements ? tr(locale, "Storage moved to operator bag", "تم نقل المخزون إلى حقيبة المشغل") : tr(locale, "Awaiting pick confirmation", "بانتظار تأكيد التحميل") },
    { label: tr(locale, "Stops completed", "المواقع المكتملة"), done: routeStops.length > 0 && completedStopCount === routeStops.length, detail: tr(locale, `${completedStopCount}/${routeStops.length} completed or skipped`, `${completedStopCount}/${routeStops.length} مكتملة أو متخطاة`) },
    { label: tr(locale, "Cash recorded", "تم تسجيل الكاش"), done: Boolean(cashCollections?.length), detail: tr(locale, `${cashCollections?.length ?? 0} cash records`, `${cashCollections?.length ?? 0} سجل كاش`) },
    { label: tr(locale, "Leftovers returned", "تمت إعادة المتبقي"), done: leftoversReconciled, detail: leftoverReturnDetail },
    { label: tr(locale, "Completed", "مكتملة"), done: isCompletedRouteStatus(routeRow.status), detail: routeRow.completed_at ? new Date(routeRow.completed_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US") : tr(locale, "Not completed", "غير مكتملة") },
    {
      label: tr(locale, "Payroll verified", "تم التحقق من الأجور"),
      done: ["verified", "payroll_pending", "paid", "reviewed"].includes(String(routeRow.status ?? "")),
      detail: ["verified", "payroll_pending", "paid"].includes(String(routeRow.status ?? ""))
        ? tr(locale, "Ready for payroll", "جاهزة للأجور")
        : routeRow.status === "reviewed"
          ? tr(locale, "Legacy reviewed route", "جولة مراجعة قديمة")
          : tr(locale, "Pending payroll review", "بانتظار مراجعة الأجور"),
    },
  ];
  return (
    <>
      <RouteCreatedToast />
      <div className="space-y-6">
        <PageHeader
          title={tr(locale, "Route details", "تفاصيل الجولة")}
          subtitle={tr(locale, `Route for ${routeRow.route_date}`, `جولة بتاريخ ${routeRow.route_date}`)}
          breadcrumbs={[{ label: tr(locale, "Operations", "العمليات"), href: "/routes" }, { label: tr(locale, "Routes", "الجولات"), href: "/routes" }, { label: routeRow.route_date }]}
          action={
            <div className="flex flex-wrap gap-2">
              <SecondaryButton href="/routes">{tr(locale, "Back to routes", "العودة إلى الجولات")}</SecondaryButton>
              {canReviewRouteInventory ? (
                <SecondaryButton href={`/routes/inventory-review?route=${id}`}>
                  {tr(locale, "Inventory review", "مراجعة المخزون")}{openRouteDiscrepancyCount ? ` (${openRouteDiscrepancyCount})` : ""}
                </SecondaryButton>
              ) : null}
              {canEditRouteItems ? (
                <Link href={`/routes/${id}/edit`} className="btn-secondary">
                  {productsPendingAtStorage ? tr(locale, "Prepare products at storage", "تجهيز المنتجات في المخزن") : tr(locale, "Edit route items", "تعديل عناصر الجولة")}
                </Link>
              ) : null}
              {continueHref ? (
                <Link href={continueHref} className="btn-primary">
                  {canStartRoute ? (routeRow.operator_id ? tr(locale, "Start Route", "بدء الجولة") : tr(locale, "Claim & Start", "استلام وبدء")) : tr(locale, "Continue Route", "متابعة الجولة")}
                </Link>
              ) : null}
              {canStartRoute && !continueHref ? (
                <Link href={`/operator/routes/${id}/pick-list?start=1`} className="btn-primary">
                  {routeRow.operator_id ? tr(locale, "Start Route", "بدء الجولة") : tr(locale, "Claim & Start", "استلام وبدء")}
                </Link>
              ) : null}
              {isAvailableRouteStatus(routeRow.status) ? (
                <ConfirmDialog
                  action={deleteDraftRoute}
                  triggerLabel={tr(locale, "Delete route", "حذف الجولة")}
                  title={tr(locale, "Delete route?", "حذف الجولة؟")}
                  description={tr(locale, "Routes can be hard-deleted only before inventory, cash, or finance history exists.", "يمكن حذف الجولة نهائيًا فقط قبل وجود أي سجل للمخزون أو الكاش أو المالية.")}
                  confirmLabel={tr(locale, "Delete route", "حذف الجولة")}
                  buttonClassName="btn-danger"
                  confirmButtonClassName="btn-danger"
                  hiddenFields={[{ name: "id", value: id }]}
                />
              ) : null}
              {canManageRouteAssignment && !isTerminalRouteStatus(routeRow.status) ? (
                <Link href={`/operator/routes/${id}/leftovers?mode=cancel`} className="btn-danger">
                  {tr(locale, "Count & cancel route", "عدّ وإلغاء الجولة")}
                </Link>
              ) : null}
              {canCountAndFinishRoute ? (
                <Link href={`/operator/routes/${id}/leftovers`} className="btn-secondary">
                  {tr(locale, "Count & finish route", "عدّ وإنهاء الجولة")}
                </Link>
              ) : null}
            </div>
          }
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}
        {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}
        {pendingStopInventoryCommitResult.error && !isMissingRouteInventoryReviewSchema(pendingStopInventoryCommitResult.error) ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950">
            <div className="font-semibold">{tr(locale, "Stop inventory recovery could not be checked", "تعذر التحقق من استعادة مخزون الموقع")}</div>
            <p className="mt-1">{tr(locale, "Count & finish is locked until this safety check loads. Refresh the page; no inventory was changed by this check.", "تم إيقاف العدّ والإنهاء حتى يكتمل فحص الأمان. حدّث الصفحة؛ لم يغيّر هذا الفحص أي مخزون.")}</p>
          </div>
        ) : null}
        {firstPendingStopInventoryCommit ? (
          <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold">{tr(locale, "A stop inventory commit still needs workflow recovery", "ما زال اعتماد مخزون أحد المواقع يحتاج إلى استعادة سير العمل")}</div>
              <p className="mt-1">{tr(locale, `${pendingStopInventoryCommitResult.count ?? pendingStopInventoryCommits.length} pending stop commit(s) block route closure so inventory cannot be finalized twice.`, `${pendingStopInventoryCommitResult.count ?? pendingStopInventoryCommits.length} اعتماد موقع معلق يمنع إغلاق الجولة حتى لا تتم تسوية المخزون مرتين.`)}</p>
            </div>
            <Link href={`/operator/routes/${id}/stops/${firstPendingStopInventoryCommit.route_stop_id}`} className="btn-secondary shrink-0">
              {tr(locale, "Recover this stop", "استعادة هذا الموقع")}
            </Link>
          </div>
        ) : null}
        {canReviewRouteInventory && routeDiscrepancyLoadError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950">
            <div className="font-semibold">{tr(locale, "Inventory review could not load", "تعذر تحميل مراجعة المخزون")}</div>
            <p className="mt-1">{tr(locale, "The route is available, but discrepancy access failed. Refresh before making a review decision.", "الجولة متاحة، لكن تحميل صلاحيات الفروقات فشل. حدّث الصفحة قبل اتخاذ قرار المراجعة.")}</p>
          </div>
        ) : null}
        {canReviewRouteInventory && routeDiscrepancySchemaMissing ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            {tr(locale, "The route inventory review database migration is not installed yet. Existing route data is unchanged.", "ترحيل قاعدة بيانات مراجعة مخزون الجولات غير مثبت بعد. بيانات الجولة الحالية لم تتغير.")}
          </div>
        ) : null}
        {canReviewRouteInventory && openRouteDiscrepancyCount ? (
          <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-950">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="font-semibold">{tr(locale, `${openRouteDiscrepancyCount} inventory difference${openRouteDiscrepancyCount === 1 ? "" : "s"} need review`, `${openRouteDiscrepancyCount} فرق في المخزون يحتاج إلى مراجعة`)}</h2>
                <p className="mt-1 text-sm">
                  {openRouteDiscrepancyUnits === null
                    ? tr(locale, "The complete unit total could not be loaded. Open the review before making a decision.", "تعذر تحميل إجمالي الوحدات الكامل. افتح المراجعة قبل اتخاذ قرار.")
                    : tr(locale, `${openRouteDiscrepancyUnits} unit${openRouteDiscrepancyUnits === 1 ? "" : "s"} are represented. Review status actions do not move inventory.`, `تشمل الفروقات ${openRouteDiscrepancyUnits} وحدة. إجراءات حالة المراجعة لا تنقل المخزون.`)}
                </p>
              </div>
              <Link href={`/routes/inventory-review?route=${id}`} className="btn-secondary shrink-0">{tr(locale, "Open review", "فتح المراجعة")}</Link>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {openRouteDiscrepancies.slice(0, 4).map((row) => {
                const productRelation = firstRelation(row.product);
                return (
                  <div key={row.id} className="rounded-xl border border-rose-200 bg-white p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-slate-950">{productRelation?.name ?? tr(locale, "Product", "منتج")}</div>
                      <StatusBadge status={row.status} label={routeInventoryDiscrepancyStatusLabel(row.status, locale)} />
                    </div>
                    <div className="mt-1 text-slate-600">{routeInventoryDiscrepancyTypeLabel(row.discrepancy_type, locale)}</div>
                    <div className="mt-1 font-semibold text-rose-800">{tr(locale, "Difference", "الفرق")}: {Number(row.difference_quantity ?? 0) > 0 ? "+" : ""}{Math.trunc(Number(row.difference_quantity ?? 0))}</div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {productsPendingAtStorage ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
            <div className="font-semibold">{tr(locale, "Machine stops planned — let Snacky prepare the pickup", "تم تخطيط مواقع الأجهزة — دع Snacky يجهز قائمة التحميل")}</div>
            <p className="mt-1 leading-6">
              {tr(
                locale,
                "Snacky can calculate the products and quantities automatically from the latest XY refill needs, available storage stock, and stock already reserved by other routes. Only edit the result when you want an override, such as replacing a slow-selling product.",
                "يمكن لـ Snacky حساب المنتجات والكميات تلقائياً من أحدث احتياجات التعبئة في XY، والمخزون المتاح، والمخزون المحجوز لجولات أخرى. عدّل النتيجة فقط عندما تريد استثناءً، مثل استبدال منتج بطيء البيع.",
              )}
            </p>
            {canEditRouteItems ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <form action={autoPrepareRouteProducts}>
                  <input type="hidden" name="id" value={id} />
                  <button type="submit" className="btn-primary">{tr(locale, "Auto prepare products", "تجهيز المنتجات تلقائياً")}</button>
                </form>
                <Link href={`/routes/${id}/edit`} className="btn-secondary inline-flex">{tr(locale, "Manual override", "تعديل يدوي")}</Link>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <SectionCard>
            <div className="space-y-2 p-4">
              <div className="text-sm text-slate-500">{tr(locale, "Status", "الحالة")}</div>
              <StatusBadge status={routeDisplayStatus(routeRow.status, routeRow.operator_id)} label={routeBadgeLabel(locale, routeRow.status)} />
            </div>
          </SectionCard>
          <SectionCard>
            <div className="space-y-2 p-4">
              <div className="text-sm text-slate-500">{tr(locale, "Performer", "المسؤول")}</div>
              <div>{operator?.id ? <Link href={`/team/${operator.id}`} className="link-secondary">{operator.full_name}</Link> : tr(locale, "Unassigned / Available", "غير مسندة / متاحة")}</div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="space-y-2 p-4">
              <div className="text-sm text-slate-500">{tr(locale, "Stops", "المواقع")}</div>
              <div>{routeStops.length}</div>
            </div>
          </SectionCard>
        </div>

        <section className="surface-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{tr(locale, "Payroll", "الأجور")}</h2>
              <p className="mt-1 text-sm text-slate-500">{tr(locale, "Saved route pay breakdown used for verification and monthly payroll periods.", "تفصيل أجر الجولة المحفوظ المستخدم للمراجعة وفترات الأجور الشهرية.")}</p>
            </div>
            <SecondaryButton href={`/payroll/routes/${id}`}>{tr(locale, "Open route pay detail", "فتح تفاصيل أجر الجولة")}</SecondaryButton>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <div className="text-sm text-slate-500">{tr(locale, "Route pay", "أجر الجولة")}</div>
              <div className="mt-1 text-xl font-semibold text-slate-900">{routePayBreakdown ? moneyLabel(routePayBreakdown.total_pay_lyd) : tr(locale, "Not calculated yet", "لم يتم احتسابه بعد")}</div>
            </div>
            <div>
              <div className="text-sm text-slate-500">{tr(locale, "Payroll period", "فترة الأجور")}</div>
              <div className="mt-1 font-medium text-slate-900">
                {routePayBreakdown?.payroll_period_id ? <Link href={`/payroll/periods/${routePayBreakdown.payroll_period_id}`} className="link-secondary">{tr(locale, "Open linked period", "فتح الفترة المرتبطة")}</Link> : tr(locale, "Not linked yet", "غير مرتبطة بعد")}
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-500">{tr(locale, "Last recalculated", "آخر إعادة احتساب")}</div>
              <div className="mt-1 font-medium text-slate-900">{routePayBreakdown?.recalculated_at ? new Date(routePayBreakdown.recalculated_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US") : "-"}</div>
            </div>
          </div>
        </section>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">{tr(locale, "Route stops", "مواقع الجولة")}</h2>
          {!routeStops.length ? (
            <EmptyState title={tr(locale, "No stops added yet", "لم تتم إضافة مواقع بعد")} body={tr(locale, "This route was created successfully, but it does not have machine stops yet.", "تم إنشاء هذه الجولة بنجاح، لكنها لا تحتوي بعد على مواقع أجهزة.")} />
          ) : (
            <DataTable headers={[tr(locale, "Order", "الترتيب"), tr(locale, "Machine", "الجهاز"), tr(locale, "Code", "الرمز"), tr(locale, "Stop status", "حالة الموقع")]}>
              {routeStops.map((stop: any) => (
                <tr key={stop.id}>
                  <td>{stop.stop_order}</td>
                  <td><Link href={`/machines/${stop.machine_id}`} className="link-secondary">{formatMachineDisplayName(machineById.get(stop.machine_id) ?? null, { includeArea: true })}</Link></td>
                  <td>{machineById.get(stop.machine_id)?.machine_code ?? "-"}</td>
                  <td><StatusBadge status={stop.status} label={routeStepLabel(locale, stop.status)} /></td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>


        {isCompletedRouteStatus(routeRow.status) ? (
          <section className="surface-card p-4">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{tr(locale, "Completed route outcome", "نتيجة الجولة المكتملة")}</h2>
              <p className="mt-1 text-sm text-slate-500">{tr(locale, "What was filled, sold manually, damaged, returned, or left as machine storage at each stop.", "ما تم تعبئته أو بيعه يدويًا أو تسجيله كتالف أو مرتجع أو مخزون جهاز في كل موقع.")}</p>
            </div>
            <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-sky-800">{tr(locale, "Manual sales", "المبيعات اليدوية")}</div><div className="mt-1 text-2xl font-semibold text-sky-950">{lyd(manualSalesTotal)}</div></div>
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-rose-800">{tr(locale, "Damaged", "التالف")}</div><div className="mt-1 text-2xl font-semibold text-rose-950">{damagedTotalQty}</div></div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{tr(locale, "Returned", "المرتجع")}</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{returnedTotalQty}</div></div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-amber-800">{tr(locale, "Machine storage", "مخزون الجهاز")}</div><div className="mt-1 text-2xl font-semibold text-amber-950">{machineStorageTotalQty}</div></div>
            </div>
            <div className="space-y-4">
              {outcomeByMachine.map((outcome: any) => {
                const machine = machineById.get(outcome.machineId);
                return (
                  <article key={outcome.stop.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-col gap-2 border-b border-slate-100 pb-3 sm:flex-row sm:items-start sm:justify-between">
                      <div><Link href={`/machines/${outcome.machineId}`} className="font-semibold text-slate-900 hover:underline">{formatMachineDisplayName(machine ?? null, { includeArea: true })}</Link><div className="text-xs text-slate-500">{machine?.machine_code ?? "-"}</div></div>
                      <div className="text-sm font-semibold text-sky-800">{tr(locale, "Manual sales", "المبيعات اليدوية")}: {lyd(outcome.salesTotal)}</div>
                    </div>
                    <div className="mt-4 grid gap-4 xl:grid-cols-2">
                      <div><div className="text-sm font-semibold text-slate-800">{tr(locale, "Products filled", "المنتجات المعبأة")}</div><div className="mt-2 text-sm text-slate-600">{outcome.fills.length ? outcome.fills.map((line: any) => `${productById.get(line.product_id)?.name ?? productById.get(line.substitute_product_id)?.name ?? line.missing_product_name ?? tr(locale, "Product", "منتج")}: ${line.actual_qty}`).join(" · ") : tr(locale, "No fill rows recorded", "لم تسجل عناصر تعبئة")}</div></div>
                      <div><div className="text-sm font-semibold text-slate-800">{tr(locale, "Manual sales items", "عناصر المبيعات اليدوية")}</div><div className="mt-2 text-sm text-slate-600">{outcome.sales.length ? outcome.sales.map((sale: any) => `${sale.product_name ?? productById.get(sale.product_id)?.name ?? tr(locale, "Product", "منتج")} × ${sale.quantity ?? 0} — ${lyd(Number(sale.total_amount_lyd ?? 0))}`).join(" · ") : tr(locale, "No manual sales", "لا توجد مبيعات يدوية")}</div></div>
                      <div><div className="text-sm font-semibold text-slate-800">{tr(locale, "Damaged and returned", "التالف والمرتجع")}</div><div className="mt-2 text-sm text-slate-600">{[...outcome.damaged.map((row: any) => `${row.product_name ?? tr(locale, "Product", "منتج")}: ${row.quantity} ${tr(locale, "damaged", "تالف")}`), ...outcome.returned.map((row: any) => `${row.product_name ?? tr(locale, "Product", "منتج")}: ${row.quantity} ${tr(locale, "returned", "مرتجع")}`)].join(" · ") || tr(locale, "None recorded", "لا يوجد")}</div></div>
                      <div><div className="text-sm font-semibold text-slate-800">{tr(locale, "Added to machine storage", "المضاف إلى مخزون الجهاز")}</div><div className="mt-2 text-sm text-slate-600">{outcome.machineStorage.length ? outcome.machineStorage.map((row: any) => `${row.product?.name ?? tr(locale, "Product", "منتج")}: ${row.quantity}`).join(" · ") : tr(locale, "None recorded", "لا يوجد")}</div></div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {routeStops.length ? (
          <Suspense fallback={<RouteDeferredSectionSkeleton label={tr(locale, "Completion images", "صور الإكمال")} />}>
            <RouteCompletionImagesSection routeId={id} locale={locale} stops={completionImageStopDescriptors} />
          </Suspense>
        ) : null}

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">{tr(locale, "Route stock", "مخزون الجولة")}</h2>
          {!routeStock?.length ? (
            <EmptyState title={tr(locale, "No route stock", "لا يوجد مخزون للجولة")} body={tr(locale, "No storage stock has been planned for this route yet.", "لم يتم تخطيط أي مخزون من المخزن لهذه الجولة بعد.")} />
          ) : (
            <DataTable headers={[tr(locale, "Product", "المنتج"), tr(locale, "Planned", "المخطط"), tr(locale, "Picked", "المسحوب"), tr(locale, "Returned", "المرتجع")]}>
              {routeStock.map((item: any) => (
                <tr key={item.id}>
                  <td>{item.product?.name ?? productById.get(item.product_id)?.name ?? tr(locale, "Unknown product", "منتج غير معروف")}</td>
                  <td>{item.planned_qty}</td>
                  <td>{item.picked_qty}</td>
                  <td>{item.returned_qty}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        {canRecordMissedPickup ? (
          missedPickupDataError || !missedPickupStorages.length ? (
            <section className="surface-card border-amber-200 bg-amber-50 p-4">
              <h2 className="text-lg font-semibold text-amber-950">{tr(locale, "Missed pickup correction unavailable", "تصحيح الكمية المنسية غير متاح")}</h2>
              <p className="mt-1 text-sm text-amber-900">{missedPickupDataError || tr(locale, "Add or activate a storage location before recording products taken by the operator.", "أضف موقع تخزين أو فعّله قبل تسجيل المنتجات التي أخذها المشغّل.")}</p>
            </section>
          ) : (
            <AdminMissedPickupRecorder
              routeId={id}
              operatorName={operator?.full_name ?? tr(locale, "the assigned operator", "المشغّل المسند")}
              storages={missedPickupStorages}
              products={missedPickupProducts}
            />
          )
        ) : null}

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">{tr(locale, "Machine-level planned items", "عناصر التخطيط حسب الجهاز")}</h2>
          {!routeStops.length ? (
            <EmptyState title={tr(locale, "No stops added yet", "لم تتم إضافة مواقع بعد")} body={tr(locale, "Machine-level planned products will appear under each stop.", "ستظهر المنتجات المخططة لكل جهاز تحت كل موقع.")} />
          ) : (
            <div className="space-y-6">
              {routeStops.map((stop: any) => {
                const items = routeStopItems.filter((item: any) => item.route_stop_id === stop.id || item.machine_id === stop.machine_id);
                return (
                <div key={stop.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm text-slate-500">{tr(locale, "Machine", "الجهاز")}</div>
                      <div className="font-medium">{formatMachineDisplayName(machineById.get(stop.machine_id) ?? null, { includeArea: true })}</div>
                      <div className="text-sm text-slate-500">{machineById.get(stop.machine_id)?.machine_code ?? "-"}</div>
                    </div>
                    <StatusBadge status={stop.status} label={routeStepLabel(locale, stop.status)} />
                  </div>
                  {items.length ? (
                    <DataTable headers={[tr(locale, "Slot", "الفتحة"), tr(locale, "Product", "المنتج"), tr(locale, "Planned qty", "الكمية المخططة"), tr(locale, "Source", "المصدر")]}>
                      {items.map((line: any) => (
                        <tr key={line.id}>
                          <td>{line.slot_code ?? "-"}</td>
                          <td>{productById.get(line.product_id)?.name ?? tr(locale, "Unknown product", "منتج غير معروف")}</td>
                          <td>{line.planned_quantity}</td>
                          <td>{line.source === "refill_recommendation" ? tr(locale, "Refill recommendation", "توصية تعبئة") : tr(locale, "Manual admin assignment", "تعيين يدوي من الإدارة")}</td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <div className="text-sm text-slate-500">{tr(locale, "No planned products for this machine.", "لا توجد منتجات مخططة لهذا الجهاز.")}</div>
                  )}
                </div>
              )})}
            </div>
          )}
        </section>


        <section className="surface-card p-4">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{tr(locale, "Confirmed pick list", "قائمة التحميل المؤكدة")}</h2>
              <p className="text-sm text-slate-500">{tr(locale, "Actual products picked before the operator left storage.", "المنتجات الفعلية التي تم تحميلها قبل مغادرة المشغل للمخزن.")}</p>
            </div>
            <StatusBadge status={routePickListItems.some((line: any) => line.needs_review) ? "needs_review" : "ok"} label={routePickListItems.some((line: any) => line.needs_review) ? tr(locale, "Needs review", "يحتاج مراجعة") : tr(locale, "OK", "سليم")} />
          </div>
          {!routePickListItems.length ? (
            <EmptyState title={tr(locale, "Pick list not confirmed", "لم يتم تأكيد قائمة التحميل")} body={tr(locale, "The operator has not confirmed storage-to-bag picking for this route yet.", "لم يؤكد المشغل بعد التحميل من المخزن إلى الحقيبة لهذه الجولة.")} />
          ) : (
            <DataTable headers={[tr(locale, "Product", "المنتج"), tr(locale, "Type", "النوع"), tr(locale, "Planned", "المخطط"), tr(locale, "Picked", "المسحوب"), tr(locale, "Review", "المراجعة"), tr(locale, "Reason", "السبب")]}>
              {routePickListItems.map((line: any) => (
                <tr key={line.id}>
                  <td>{line.product?.name ?? productById.get(line.product_id)?.name ?? tr(locale, "Unknown product", "منتج غير معروف")}</td>
                  <td><StatusBadge status={line.action_type} label={routeActionLabel(locale, line.action_type)} /></td>
                  <td>{line.planned_qty}</td>
                  <td>{line.picked_qty}</td>
                  <td><StatusBadge status={line.needs_review ? "needs_review" : "ok"} label={line.needs_review ? tr(locale, "Needs review", "يحتاج مراجعة") : tr(locale, "OK", "سليم")} /></td>
                  <td>
                    <div>{line.reason ?? "-"}</div>
                    {line.substituted_for_product_id ? (
                      <div className="mt-1 text-xs text-slate-500">
                        {tr(locale, "Substituted for", "تم الاستبدال بـ")} {line.substituted_product?.name ?? productById.get(line.substituted_for_product_id)?.name ?? tr(locale, "unknown product", "منتج غير معروف")}
                      </div>
                    ) : null}
                    {line.notes ? <div className="mt-1 text-xs text-slate-500">{line.notes}</div> : null}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        {xyQueueRows.length ? (
          <section className="surface-card border-amber-200 p-4">
            <h2 className="text-lg font-semibold">{tr(locale, "XY changes awaiting reconnect", "تغييرات XY التي تنتظر عودة الاتصال")}</h2>
            <p className="mt-1 text-sm text-slate-600">{tr(locale,
              "Pending changes are retried by the secured XY scheduler after the stop is completed. Operators must keep those lanes disabled from vending until verified.",
              "يعيد مجدول XY الآمن المحاولة بعد إنهاء الموقع. يجب إبقاء الخانات المعنية معطلة عن البيع إلى حين التحقق.",
            )}</p>
            <DataTable headers={[
              tr(locale, "Machine", "الجهاز"),
              tr(locale, "Lane", "الخانة"),
              tr(locale, "New product", "المنتج الجديد"),
              tr(locale, "Quantity", "الكمية"),
              tr(locale, "Status", "الحالة"),
              tr(locale, "Attempts / notes", "المحاولات والملاحظات"),
            ]}>
              {xyQueueRows.map((row: any) => (
                <tr key={row.id}>
                  <td>{formatMachineDisplayName(machineById.get(row.machine_id) ?? null, { includeArea: true })}</td>
                  <td>{row.slot_code}</td>
                  <td>{productById.get(row.target_product_id)?.name ?? row.target_product_id}</td>
                  <td>{row.target_stock_qty}</td>
                  <td><StatusBadge status={row.status === "verified" ? "complete" : "needs_review"}
                    label={row.status === "verified" ? tr(locale, "Verified", "تم التحقق") : row.status === "conflict" ? tr(locale, "Manual review", "مراجعة يدوية") : tr(locale, "Pending", "معلق")} /></td>
                  <td>{row.attempt_count ?? 0} {row.last_error ? <p className="text-xs text-rose-700">{row.last_error}</p> : null}</td>
                </tr>
              ))}
            </DataTable>
          </section>
        ) : null}

        {smartRouteLaneRows.length ? (
          <section className="surface-card border-violet-200 p-4">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-violet-700">{tr(locale, "Smart Route audit", "تدقيق الجولة الذكية")}</div>
                <h2 className="mt-1 text-lg font-semibold">{tr(locale, "AI lane plan vs operator execution", "خطة الخانات بالذكاء الاصطناعي مقابل التنفيذ الفعلي")}</h2>
                <p className="text-sm text-slate-500">{tr(
                  locale,
                  "Each Smart Route lane keeps its planned product, actual filled quantity, required old-product return, XY product-change result, and quantity-verification evidence.",
                  "تحتفظ كل خانة في الجولة الذكية بالمنتج المخطط، والكمية الفعلية، وإرجاع المنتج القديم المطلوب، ونتيجة تغيير المنتج في XY، وإثبات الكمية.",
                )}</p>
              </div>
              <StatusBadge
                status={smartRouteLaneRows.some((row: any) => (
                  (row.substituted && row.actualAdded !== null && row.actualAdded > 0 && (row.returnedQty < row.requiredReturnQty || row.xyAction !== "xy_slot_product_change"))
                  || row.verificationStatus === "offline_pending"
                )) ? "needs_review" : "ok"}
                label={smartRouteLaneRows.some((row: any) => (
                  (row.substituted && row.actualAdded !== null && row.actualAdded > 0 && (row.returnedQty < row.requiredReturnQty || row.xyAction !== "xy_slot_product_change"))
                  || row.verificationStatus === "offline_pending"
                )) ? tr(locale, "Needs review", "يحتاج مراجعة") : tr(locale, "OK", "سليم")}
              />
            </div>
            <DataTable headers={[
              tr(locale, "Machine", "الجهاز"),
              tr(locale, "Lane", "الخانة"),
              tr(locale, "Plan", "الخطة"),
              tr(locale, "Actual", "الفعلي"),
              tr(locale, "Swap / return", "التبديل / الإرجاع"),
              tr(locale, "XY", "XY"),
            ]}>
              {smartRouteLaneRows.map((row: any) => {
                const swapExecuted = row.actualAdded !== null && row.actualAdded > 0;
                const returnOk = !row.substituted || !swapExecuted || row.returnedQty >= row.requiredReturnQty;
                const xyProductOk = !row.substituted || !swapExecuted || row.xyAction === "xy_slot_product_change";
                const quantityStatusLabel = row.verificationStatus === "xy_api_verified"
                  ? tr(locale, "XY synced + verified", "تم تحديث XY والتحقق")
                  : row.verificationStatus === "xy_screenshot_saved"
                    ? tr(locale, "Screenshot verified", "تم التحقق بصورة")
                    : row.verificationStatus === "offline_pending"
                      ? tr(locale, "Power-off pending", "معلق بسبب انقطاع الكهرباء")
                      : tr(locale, "Not confirmed yet", "لم يتم التأكيد بعد");
                return (
                  <tr key={`${row.routeStopItemId}:${row.slotCode}`}>
                    <td>{formatMachineDisplayName(machineById.get(row.machineId) ?? null, { includeArea: true })}</td>
                    <td><strong>{row.slotCode}</strong></td>
                    <td>
                      <div>{row.productName} +{row.plannedAdd}</div>
                      <div className="mt-1 text-xs text-slate-500">{row.previousQty} → {row.targetQty || row.previousQty + row.plannedAdd}</div>
                    </td>
                    <td>
                      {row.actualAdded === null ? (
                        <span className="text-slate-500">{tr(locale, "Pending", "معلق")}</span>
                      ) : (
                        <>
                          <strong>+{row.actualAdded}</strong>
                          <div className="mt-1 text-xs text-slate-500">{tr(locale, "Final", "النهائي")} {row.actualFinal}</div>
                        </>
                      )}
                    </td>
                    <td>
                      {row.substituted ? (
                        <>
                          <div>{row.fromProductName} → <strong>{row.productName}</strong></div>
                          <div className={returnOk ? "mt-1 text-xs font-semibold text-emerald-700" : "mt-1 text-xs font-semibold text-rose-700"}>
                            {tr(locale, "Return", "الإرجاع")}: {row.returnedQty}/{row.requiredReturnQty}
                          </div>
                        </>
                      ) : <span className="text-slate-500">-</span>}
                    </td>
                    <td>
                      <div className={xyProductOk ? "text-sm font-semibold text-emerald-700" : "text-sm font-semibold text-rose-700"}>
                        {row.substituted && swapExecuted
                          ? (xyProductOk ? tr(locale, "Product verified", "تم التحقق من المنتج") : tr(locale, "Product change pending", "تغيير المنتج معلق"))
                          : tr(locale, "No product change", "لا يوجد تغيير منتج")}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{quantityStatusLabel}</div>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </section>
        ) : null}

        <section className="surface-card p-4">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{tr(locale, "Operator changes", "تغييرات المشغل")}</h2>
              <p className="text-sm text-slate-500">{tr(locale, "Actual stop fills, shortages, extras, substitutions, and missing product reports.", "عمليات التعبئة الفعلية، والنقص، والزيادة، والاستبدالات، وتقارير المنتجات المفقودة.")}</p>
            </div>
            <StatusBadge status={(fillLines ?? []).some((line: any) => line.needs_review) ? "needs_review" : "ok"} label={(fillLines ?? []).some((line: any) => line.needs_review) ? tr(locale, "Needs review", "يحتاج مراجعة") : tr(locale, "OK", "سليم")} />
          </div>
          {!fillLines?.length ? (
            <EmptyState title={tr(locale, "No operator changes recorded", "لم تُسجل أي تغييرات للمشغل")} body={tr(locale, "Completed stop actuals will appear here after the operator finishes a machine stop.", "ستظهر بيانات الموقع المكتمل هنا بعد أن ينهي المشغل موقع الجهاز.")} />
          ) : (
            <DataTable headers={[tr(locale, "Machine", "الجهاز"), tr(locale, "Type", "النوع"), tr(locale, "Planned product", "المنتج المخطط"), tr(locale, "Actual product", "المنتج الفعلي"), tr(locale, "Assigned", "المسند"), tr(locale, "Actual", "الفعلي"), tr(locale, "Diff", "الفرق"), tr(locale, "Review", "المراجعة"), tr(locale, "Reason", "السبب")]}>
              {fillLines.map((line: any) => (
                <tr key={line.id}>
                  <td>{formatMachineDisplayName(machineById.get(line.machine_id) ?? null, { includeArea: true })}</td>
                  <td><StatusBadge status={line.action_type} label={routeActionLabel(locale, line.action_type)} /></td>
                  <td>{line.missing_product_name ?? productById.get(line.assigned_product_id)?.name ?? "-"}</td>
                  <td>{productById.get(line.product_id)?.name ?? productById.get(line.substitute_product_id)?.name ?? "-"}</td>
                  <td>{line.assigned_qty}</td>
                  <td>{line.actual_qty}</td>
                  <td>{line.difference_qty > 0 ? `+${line.difference_qty}` : line.difference_qty}</td>
                  <td><StatusBadge status={line.needs_review ? "needs_review" : "ok"} label={line.needs_review ? tr(locale, "Needs review", "يحتاج مراجعة") : tr(locale, "OK", "سليم")} /></td>
                  <td>
                    <div>{line.reason ?? "-"}</div>
                    {line.notes ? <div className="mt-1 text-xs text-slate-500">{line.notes}</div> : null}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>


        <div className="grid gap-4 xl:grid-cols-2">
          <section className="surface-card p-4">
            <h2 className="text-lg font-semibold">{tr(locale, "Cash collections", "تحصيلات الكاش")}</h2>
            {!cashCollections?.length ? (
              <EmptyState title={tr(locale, "No cash collected yet", "لم يتم تحصيل كاش بعد")} body={tr(locale, "Cash records are created when operators complete machine stops.", "تُنشأ سجلات الكاش عندما يكمل المشغل مواقع الأجهزة.")} />
            ) : (
              <DataTable headers={[tr(locale, "Machine", "الجهاز"), tr(locale, "Expected", "المتوقع"), tr(locale, "Counted", "المعدود"), tr(locale, "Variance", "الفارق"), tr(locale, "Status", "الحالة")]}>
                {cashCollections.map((cash: any) => (
                  <tr key={cash.id}>
                    <td>{formatMachineDisplayName(machineById.get(cash.machine_id) ?? null, { includeArea: true })}</td>
                    <td>{cash.vms_expected_cash === null ? "-" : lyd(cash.vms_expected_cash)}</td>
                    <td>{cash.actual_cash_collected === null ? "-" : lyd(cash.actual_cash_collected)}</td>
                    <td>{cash.variance === null ? "-" : lyd(cash.variance)}</td>
                    <td><StatusBadge status={String(cash.review_status ?? "").replaceAll("_", " ")} label={routeReviewLabel(locale, String(cash.review_status ?? ""))} /></td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>

          <section className="surface-card p-4">
            <h2 className="text-lg font-semibold">{tr(locale, "Issues reported", "الأعطال المبلغ عنها")}</h2>
            {!issues?.length ? (
              <EmptyState title={tr(locale, "No issues reported", "لم يتم الإبلاغ عن أعطال")} body={tr(locale, "Operator-reported machine issues for this route will appear here.", "ستظهر أعطال الأجهزة التي يبلغ عنها المشغل هنا.")} />
            ) : (
              <DataTable headers={[tr(locale, "Machine", "الجهاز"), tr(locale, "Type", "النوع"), tr(locale, "Priority", "الأولوية"), tr(locale, "Status", "الحالة")]}>
                {issues.map((issue: any) => (
                  <tr key={issue.id}>
                    <td>{formatMachineDisplayName(machineById.get(issue.machine_id) ?? null, { includeArea: true })}</td>
                    <td>{routeIssueTypeLabel(locale, issue.issue_type)}</td>
                    <td><StatusBadge status={issue.priority} label={routeReviewLabel(locale, issue.priority)} /></td>
                    <td><StatusBadge status={issue.status} label={routeReviewLabel(locale, issue.status)} /></td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
        </div>

        {canManageRouteAssignment && !isTerminalRouteStatus(routeRow.status) ? (
          <section className="surface-card p-4">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{tr(locale, "Route assignment", "تعيين الجولة")}</h2>
              <p className="mt-1 text-sm text-slate-500">{tr(locale, "Assign a route performer now, or leave this route available for an eligible user to claim when starting it.", "عيّن منفذ الجولة الآن، أو اتركها متاحة لمستخدم مؤهل ليستلمها عند البدء.")}</p>
              <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
                {tr(
                  locale,
                  "If this route has stops but no products prepared yet, Snacky will automatically build the pickup plan from refill needs and available storage. You only need to edit it when you want an override.",
                  "إذا كانت الجولة تحتوي على مواقع ولم يتم تجهيز المنتجات بعد، سيبني Snacky خطة التحميل تلقائياً من احتياجات التعبئة والمخزون المتاح. تحتاج للتعديل فقط إذا أردت استثناءً أو تغييراً.",
                )}
              </p>
            </div>
            <form action={assignRoute} className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <input type="hidden" name="id" value={id} />
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-800">{tr(locale, "Performer", "المسؤول")}</span>
                <select name="operator_id" defaultValue={routeRow.operator_id ?? ""} className="field-input">
                  <option value="">{tr(locale, "Leave unassigned / available", "اتركها غير مسندة / متاحة")}</option>
                  {(performers ?? []).map((performer: any) => (
                  <option key={performer.id} value={performer.id}>
                      {performer.full_name} ({routeRoleLabel(locale, performer.role)})
                  </option>
                ))}
              </select>
              </label>
              <button type="submit" className="btn-primary">{tr(locale, "Update assignment", "تحديث التعيين")}</button>
            </form>
          </section>
        ) : null}

        {routeRow.status === ROUTE_CANCELED_STATUS ? (
          <section className="surface-card p-4">
            <h2 className="text-lg font-semibold">{tr(locale, "Cancellation", "الإلغاء")}</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div><div className="text-sm text-slate-500">{tr(locale, "Cancelled at", "تم الإلغاء في")}</div><div className="font-medium">{routeRow.cancelled_at ? new Date(routeRow.cancelled_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US") : "-"}</div></div>
              <div><div className="text-sm text-slate-500">{tr(locale, "Reason", "السبب")}</div><div className="font-medium">{routeRow.cancellation_reason ?? "-"}</div></div>
            </div>
          </section>
        ) : null}

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">{tr(locale, "Status timeline", "الخط الزمني للحالة")}</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            {timeline.map((item) => (
              <div key={item.label} className={`rounded-lg border p-3 ${item.done ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                <div className="text-sm font-semibold text-slate-900">{item.label}</div>
                <div className="mt-1 text-xs text-slate-600">{item.detail}</div>
                <div className="mt-2"><StatusBadge status={item.done ? "complete" : "pending"} label={item.done ? tr(locale, "Complete", "مكتمل") : tr(locale, "Pending", "قيد الانتظار")} /></div>
              </div>
            ))}
          </div>
        </section>

        <Suspense fallback={<RouteDeferredSectionSkeleton label={tr(locale, "Route activity", "نشاط الجولة")} />}>
          <RouteActivitySection routeId={id} locale={locale} stopIds={stopIds} cashIds={cashIds} />
        </Suspense>
      </div>
    </>
  );
}
