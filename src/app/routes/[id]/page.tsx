import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { RouteCompletionImages, type RouteCompletionStop } from "@/components/RouteCompletionImages";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canExecuteRoutes, isAdminRole, isOwnerAdminRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { moneyLabel } from "@/lib/payroll";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { privateStorageObjectUrl, REFILL_PHOTO_BUCKET } from "@/lib/storage-buckets";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { ROUTE_CANCELED_STATUS, isActiveRouteStatus, isAvailableRouteStatus, isCompletedRouteStatus, isPickupConfirmedStatus, isRouteItemsEditableStatus, isRouteStopDoneStatus, isTerminalRouteStatus, nextOperatorRouteHref, routeDisplayStatus } from "@/lib/route-workflow";
import { RouteCreatedToast } from "@/app/routes/[id]/RouteCreatedToast";
import { assignRoute, cancelRoute, deleteDraftRoute } from "@/lib/route-actions";
import { repairRouteCompletion } from "@/lib/operator-actions";
import { getServerI18n } from "@/lib/i18n/server";
import Link from "next/link";
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

function routeEntityLabel(locale: "ar" | "en", entity: string) {
  const value = String(entity ?? "").toLowerCase();
  if (value === "storage") return tr(locale, "Storage", "المخزن");
  if (value === "operator_bag") return tr(locale, "Operator bag", "حقيبة المشغل");
  if (value === "machine") return tr(locale, "Machine", "الجهاز");
  if (value === "supplier") return tr(locale, "Supplier", "المورد");
  if (value === "waste") return tr(locale, "Waste", "هالك");
  if (value === "cash_collection") return tr(locale, "Cash collection", "تحصيل كاش");
  if (value === "route_stop") return tr(locale, "Route stop", "موقع الجولة");
  if (value === "route") return tr(locale, "Route", "الجولة");
  return value.replaceAll("_", " ");
}

function routeMovementReasonLabel(locale: "ar" | "en", reason: string | null | undefined) {
  const value = String(reason ?? "").toLowerCase();
  if (value === "storage_to_operator_bag") return tr(locale, "Storage to operator bag", "من المخزن إلى حقيبة المشغل");
  if (value === "operator_bag_to_storage") return tr(locale, "Operator bag to storage", "من حقيبة المشغل إلى المخزن");
  if (value === "operator_bag_to_machine") return tr(locale, "Operator bag to machine", "من حقيبة المشغل إلى الجهاز");
  if (value === "machine_to_waste") return tr(locale, "Machine to waste", "من الجهاز إلى الهالك");
  if (value === "manual_adjustment") return tr(locale, "Manual adjustment", "تسوية يدوية");
  if (value === "inventory_correction") return tr(locale, "Inventory correction", "تصحيح مخزون");
  if (value === "damaged") return tr(locale, "Damaged", "تالف");
  if (value === "expired") return tr(locale, "Expired", "منتهي الصلاحية");
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

function routeActivityActionLabel(locale: "ar" | "en", action: string | null | undefined) {
  const value = String(action ?? "").toLowerCase();
  if (value === "created") return tr(locale, "Created", "تم الإنشاء");
  if (value === "updated") return tr(locale, "Updated", "تم التحديث");
  if (value === "assigned") return tr(locale, "Assigned", "تم التعيين");
  if (value === "started") return tr(locale, "Started", "بدأ");
  if (value === "completed") return tr(locale, "Completed", "مكتمل");
  if (value === "cancelled" || value === "canceled") return tr(locale, "Cancelled", "ملغاة");
  if (value === "reviewed") return tr(locale, "Reviewed", "تمت المراجعة");
  if (value === "cash_collected") return tr(locale, "Cash collected", "تم تحصيل الكاش");
  if (value === "inventory_moved") return tr(locale, "Inventory moved", "تم نقل المخزون");
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
  const supportClient = getSupabaseAdminClient() ?? supabase;
  const [{ data: operator }, { data: performers }, { data: stops, error: stopsError }, { data: stopItems, error: stopItemsError }, { data: routeStock, error: routeStockError }, { data: fillLines, error: fillLinesError }, { data: pickListItems, error: pickListItemsError }] = await Promise.all([
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
      .select("id, route_stop_id, machine_id, product_id, machine_slot_id, slot_code, planned_quantity, source")
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
  const machineIds = Array.from(new Set([...routeStops.map((stop: any) => stop.machine_id), ...(stopItems ?? []).map((item: any) => item.machine_id)].filter(Boolean)));
  const productIds = Array.from(new Set([
    ...routeStopItems.map((line: any) => line.product_id),
    ...(routeStock ?? []).map((line: any) => line.product_id),
    ...(fillLines ?? []).flatMap((line: any) => [line.assigned_product_id, line.product_id, line.substitute_product_id]),
    ...routePickListItems.flatMap((line: any) => [line.product_id, line.substituted_for_product_id]),
  ].filter(Boolean)));
  const [{ data: machines }, { data: products }, { data: movements }, { data: cashCollections }, { data: issues }, { data: routePayBreakdown, error: routePayError }] = await Promise.all([
    machineIds.length ? supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", machineIds) : Promise.resolve({ data: [] }),
    productIds.length ? supabase.from("products").select("id, name").in("id", productIds) : Promise.resolve({ data: [] }),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")
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
  ]);
  if (routePayError) console.error("[routes:detail] Failed to load route pay breakdown", { id, error: routePayError });
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  const [manualSalesResult, adjustmentsResult] = await Promise.all([
    supportClient
      .from("route_manual_sales")
      .select("id, route_id, route_stop_id, machine_id, product_id, product_name, quantity, unit_price_lyd, total_amount_lyd, payment_method, sale_time, status")
      .eq("route_id", id)
      .order("sale_time", { ascending: true }),
    supportClient
      .from("inventory_adjustments")
      .select("id, route_id, route_stop_id, machine_id, adjustment_type, product_id, product_name, quantity, reason, notes, status, created_at")
      .eq("route_id", id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: true }),
  ]);
  if (manualSalesResult.error && !isMissingTable(manualSalesResult.error, "route_manual_sales")) console.warn("[routes:detail] Manual sales unavailable", { id, error: manualSalesResult.error });
  if (adjustmentsResult.error && !isMissingTable(adjustmentsResult.error, "inventory_adjustments")) console.warn("[routes:detail] Inventory adjustments unavailable", { id, error: adjustmentsResult.error });
  const manualSales = manualSalesResult.error ? [] : (manualSalesResult.data ?? []);
  const routeAdjustments = adjustmentsResult.error ? [] : (adjustmentsResult.data ?? []);
  const stopIds = routeStops.map((stop: any) => stop.id).filter(Boolean);
  let completionProofRows: any[] = [];
  if (stopIds.length) {
    let completionProofResult: any = await supabase
      .from("machine_refill_history")
      .select("id, legacy_refill_id, route_stop_id, refill_at, machine_id, machine_name, operator_email, machine_photo_url, machine_photo_path, raw_record, operator:team_members(full_name)")
      .eq("route_id", id)
      .order("refill_at", { ascending: false });

    if (completionProofResult.error && isMissingColumn(completionProofResult.error, ["route_id", "route_stop_id"])) {
      completionProofResult = await supabase
        .from("machine_refill_history")
        .select("id, legacy_refill_id, refill_at, machine_id, machine_name, operator_email, machine_photo_url, machine_photo_path, raw_record, operator:team_members(full_name)")
        .in("legacy_refill_id", stopIds.map((stopId: string) => `route_stop:${stopId}`))
        .order("refill_at", { ascending: false });
    }

    if (completionProofResult.error) {
      if (!isMissingTable(completionProofResult.error, "machine_refill_history")) {
        console.error("[routes:detail] Failed to load route completion images", { id, error: completionProofResult.error });
      }
    } else {
      completionProofRows = completionProofResult.data ?? [];
    }
  }
  const completionProofsByStopId = new Map<string, RouteCompletionStop["images"]>();
  completionProofRows.forEach((row: any) => {
    const legacyRefillId = String(row.legacy_refill_id ?? "");
    const rowStopId = row.route_stop_id ? String(row.route_stop_id) : legacyRefillId.startsWith("route_stop:") ? legacyRefillId.replace("route_stop:", "") : "";
    if (!rowStopId) return;
    const savedUrl = String(row.machine_photo_url ?? "").trim();
    const savedPath = String(row.machine_photo_path ?? "").trim();
    const photoUrl = savedUrl && (savedUrl.startsWith("/") || savedUrl.startsWith("http://") || savedUrl.startsWith("https://"))
      ? savedUrl
      : privateStorageObjectUrl(REFILL_PHOTO_BUCKET, savedPath || savedUrl);
    const operator = firstRelation(row.operator);
    const rawRecord = row.raw_record && typeof row.raw_record === "object" ? row.raw_record : {};
    const images = completionProofsByStopId.get(rowStopId) ?? [];
    images.push({
      id: String(row.id ?? `${rowStopId}-${images.length}`),
      url: photoUrl,
      storagePath: savedPath || null,
      uploadedAt: row.refill_at ?? null,
      uploadedBy: (operator as any)?.full_name ?? row.operator_email ?? (rawRecord as any).operator_name ?? null,
      label: tr(locale, `${row.machine_name ?? "Machine"} completion image`, `صورة إكمال ${row.machine_name ?? "الجهاز"}`),
    });
    completionProofsByStopId.set(rowStopId, images);
  });
  const completionImageStops: RouteCompletionStop[] = routeStops.map((stop: any) => ({
    id: String(stop.id),
    title: formatMachineDisplayName(machineById.get(stop.machine_id) ?? null, { includeArea: true }),
    subtitle: tr(locale, `Stop ${stop.stop_order || "-"} - ${machineById.get(stop.machine_id)?.machine_code ?? "-"}`, `الموقع ${stop.stop_order || "-"} - ${machineById.get(stop.machine_id)?.machine_code ?? "-"}`),
    images: completionProofsByStopId.get(String(stop.id)) ?? [],
  }));
  const canManageRouteAssignment = isAdminRole(profile);
  const canEditRouteItems = isOwnerAdminRole(profile) && isRouteItemsEditableStatus(routeRow.status);
  const routeProductsPrepared = Boolean((routeStock ?? []).some((item: any) => Number(item.planned_qty ?? 0) > 0) || routeStopItems.some((item: any) => Number(item.planned_quantity ?? 0) > 0));
  const productsPendingAtStorage = routeStops.length > 0 && !routeProductsPrepared && isAvailableRouteStatus(routeRow.status);
  const hasPickMovements = Boolean(movements?.some((movement: any) => movement.reason === "storage_to_operator_bag"));
  const hasReturnMovements = Boolean(movements?.some((movement: any) => movement.reason === "operator_bag_to_storage"));
  const canStartRoute = canExecuteRoutes(profile) && Boolean(profile.team_member_id) && isAvailableRouteStatus(routeRow.status) && routeProductsPrepared;
  const continueHref = canExecuteRoutes(profile) && routeProductsPrepared
    ? nextOperatorRouteHref({ routeId: id, status: routeRow.status, hasPickup: hasPickMovements, stops: routeStops, start: true })
    : null;
  const productById = new Map((products ?? []).map((product: any) => [product.id, product]));
  const confirmedManualSales = manualSales.filter((sale: any) => String(sale.status ?? "confirmed").toLowerCase() === "confirmed");
  const manualSalesTotal = confirmedManualSales.reduce((sum: number, sale: any) => sum + Number(sale.total_amount_lyd ?? 0), 0);
  const damagedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "damaged");
  const returnedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "returned_from_machine");
  const machineStorageMovements = (movements ?? []).filter((movement: any) => {
    const reason = String(movement.reason ?? "").toLowerCase();
    return reason === "extra_stock_left_at_machine"
      || reason === "machine_storage"
      || (movement.from_entity_type === "operator_bag" && movement.to_entity_type === "machine");
  });
  const damagedTotalQty = damagedAdjustments.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);
  const returnedTotalQty = returnedAdjustments.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);
  const machineStorageTotalQty = machineStorageMovements.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);
  const outcomeByMachine = routeStops.map((stop: any) => {
    const machineId = String(stop.machine_id ?? "");
    const fills = (fillLines ?? []).filter((line: any) => String(line.machine_id ?? "") === machineId && Number(line.actual_qty ?? 0) > 0);
    const sales = confirmedManualSales.filter((sale: any) => String(sale.machine_id ?? "") === machineId);
    const damaged = damagedAdjustments.filter((row: any) => String(row.machine_id ?? "") === machineId || String(row.route_stop_id ?? "") === String(stop.id));
    const returned = returnedAdjustments.filter((row: any) => String(row.machine_id ?? "") === machineId || String(row.route_stop_id ?? "") === String(stop.id));
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
  const routeActivityQueries: PromiseLike<any>[] = [
    supabase
      .from("system_activity_logs")
      .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
      .eq("entity_type", "route")
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ];
  const cashIds = (cashCollections ?? []).map((cash: any) => cash.id).filter(Boolean);
  if (stopIds.length) {
    routeActivityQueries.push(
      supabase
        .from("system_activity_logs")
        .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
        .eq("entity_type", "route_stop")
        .in("entity_id", stopIds)
        .order("created_at", { ascending: false })
        .limit(100),
    );
  }
  if (cashIds.length) {
    routeActivityQueries.push(
      supabase
        .from("system_activity_logs")
        .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
        .eq("entity_type", "cash_collection")
        .in("entity_id", cashIds)
        .order("created_at", { ascending: false })
        .limit(100),
    );
  }
  routeActivityQueries.push(
    supabase
      .from("system_activity_logs")
      .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
      .contains("metadata", { route_id: id })
      .order("created_at", { ascending: false })
      .limit(100),
  );
  const activityResults = await Promise.all(routeActivityQueries);
  activityResults.forEach((result: any) => {
    if (result.error) console.error("[routes:detail] Failed to load route activity", { id, error: result.error });
  });
  const routeActivityRows = activityResults
    .flatMap((result: any) => result.data ?? [])
    .filter((activity: any, index: number, rows: any[]) => rows.findIndex((row: any) => row.id === activity.id) === index)
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 100);
  const completedStopCount = routeStops.filter((stop: any) => isRouteStopDoneStatus(stop.status)).length;
  const timeline = [
    { label: tr(locale, "Draft", "مسودة"), done: true, detail: tr(locale, `Created ${new Date(routeRow.created_at).toLocaleString("en-US")}`, `تم الإنشاء ${new Date(routeRow.created_at).toLocaleString("ar-LY")}`) },
    { label: tr(locale, "Available", "متاحة"), done: isAvailableRouteStatus(routeRow.status) || isActiveRouteStatus(routeRow.status) || isCompletedRouteStatus(routeRow.status), detail: operator?.full_name ?? tr(locale, "Unassigned / available", "غير مسندة / متاحة") },
    { label: tr(locale, "Picked", "تم التحميل"), done: hasPickMovements || isPickupConfirmedStatus(routeRow.status), detail: hasPickMovements ? tr(locale, "Storage moved to operator bag", "تم نقل المخزون إلى حقيبة المشغل") : tr(locale, "Awaiting pick confirmation", "بانتظار تأكيد التحميل") },
    { label: tr(locale, "Stops completed", "المواقع المكتملة"), done: routeStops.length > 0 && completedStopCount === routeStops.length, detail: tr(locale, `${completedStopCount}/${routeStops.length} completed or skipped`, `${completedStopCount}/${routeStops.length} مكتملة أو متخطاة`) },
    { label: tr(locale, "Cash recorded", "تم تسجيل الكاش"), done: Boolean(cashCollections?.length), detail: tr(locale, `${cashCollections?.length ?? 0} cash records`, `${cashCollections?.length ?? 0} سجل كاش`) },
    { label: tr(locale, "Leftovers returned", "تمت إعادة المتبقي"), done: hasReturnMovements || isCompletedRouteStatus(routeRow.status), detail: hasReturnMovements ? tr(locale, "Operator bag returned to storage", "تمت إعادة حقيبة المشغل إلى المخزن") : tr(locale, "Awaiting leftover return", "بانتظار إعادة المتبقي") },
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
              {!isTerminalRouteStatus(routeRow.status) ? (
                <ConfirmDialog
                  action={cancelRoute}
                  triggerLabel={tr(locale, "Cancel route", "إلغاء الجولة")}
                  title={tr(locale, "Cancel route?", "إلغاء الجولة؟")}
                  description={tr(locale, "Cancelled routes stay in history with their planned work, movements, and operator activity.", "تبقى الجولات الملغاة في السجل مع العمل المخطط والحركات ونشاط المشغل.")}
                  confirmLabel={tr(locale, "Cancel route", "إلغاء الجولة")}
                  buttonClassName="btn-danger"
                  confirmButtonClassName="btn-danger"
                  hiddenFields={[{ name: "id", value: id }]}
                />
              ) : null}
              {canManageRouteAssignment && !isTerminalRouteStatus(routeRow.status) ? (
                <ConfirmDialog
                  action={repairRouteCompletion}
                  triggerLabel={tr(locale, "Repair & complete", "إصلاح وإكمال")}
                  title={tr(locale, "Repair and complete route?", "إصلاح وإكمال الجولة؟")}
                  description={tr(locale, "Snacky OS will reuse existing return movements, repair saved returned quantities, and complete the route without duplicating inventory.", "سيعيد Snacky OS استخدام حركات الإرجاع الموجودة، ويصلح الكميات المرتجعة المحفوظة، ويكمل الجولة من دون تكرار المخزون.")}
                  confirmLabel={tr(locale, "Repair & complete", "إصلاح وإكمال")}
                  buttonClassName="btn-secondary"
                  confirmButtonClassName="btn-primary"
                  hiddenFields={[{ name: "route_id", value: id }]}
                />
              ) : null}
            </div>
          }
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}
        {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}
        {productsPendingAtStorage ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
            <div className="font-semibold">{tr(locale, "Machine stops planned — products pending at storage", "تم تخطيط مواقع الأجهزة — المنتجات بانتظار التجهيز في المخزن")}</div>
            <p className="mt-1 leading-6">{tr(locale, "The operator can already see the machines on this route. Add the exact product quantities when you reach storage; Start Route remains locked until then.", "يمكن للمشغل رؤية الأجهزة في هذه الجولة بالفعل. أضف كميات المنتجات الدقيقة عند الوصول إلى المخزن؛ وسيبقى بدء الجولة مقفلاً حتى ذلك الحين.")}</p>
            {canEditRouteItems ? <Link href={`/routes/${id}/edit`} className="btn-primary mt-3 inline-flex">{tr(locale, "Prepare products now", "تجهيز المنتجات الآن")}</Link> : null}
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
          <section className="surface-card p-4">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{tr(locale, "Completion images", "صور الإكمال")}</h2>
              <p className="mt-1 text-sm text-slate-500">{tr(locale, "Final machine photos uploaded when the operator completes each stop.", "صور الجهاز النهائية المرفوعة عندما يكمل المشغل كل موقع.")}</p>
            </div>
            <RouteCompletionImages stops={completionImageStops} />
          </section>
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

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">{tr(locale, "Route activity", "نشاط الجولة")}</h2>
          <p className="mt-1 text-sm text-slate-500">{tr(locale, "Audit trail for route creation, picking, stop completion, cash review, issues, and leftover return.", "سجل تدقيق لإنشاء الجولة، والتحميل، وإكمال المواقع، ومراجعة الكاش، والأعطال، وإرجاع المتبقي.")}</p>
          {!routeActivityRows.length ? (
            <div className="mt-4">
              <EmptyState title={tr(locale, "No route activity yet", "لا يوجد نشاط للجولة بعد")} body={tr(locale, "Route actions will appear here as operators and admins work through the route.", "ستظهر إجراءات الجولة هنا أثناء تنفيذ المشغلين والإداريين للجولة.")} />
            </div>
          ) : (
            <div className="mt-4">
              <DataTable headers={[tr(locale, "Created", "الإنشاء"), tr(locale, "Action", "الإجراء"), tr(locale, "Entity", "العنصر"), tr(locale, "User", "المستخدم"), tr(locale, "Summary", "الملخص")]}>
                {routeActivityRows.map((activity: any) => (
                  <tr key={activity.id}>
                    <td>{new Date(activity.created_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}</td>
                    <td><StatusBadge status={activity.action} label={routeActivityActionLabel(locale, activity.action)} /></td>
                    <td>{routeEntityLabel(locale, activity.entity_type)}</td>
                    <td>{activity.actor_name ?? routeRoleLabel(locale, activity.actor_role) ?? "-"}</td>
                    <td>{activity.summary ?? activity.entity_label ?? "-"}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
