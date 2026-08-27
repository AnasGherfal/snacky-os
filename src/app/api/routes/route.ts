import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canExecuteRoutes, isOwnerAdminRole } from "@/lib/authz";
import {
  fallbackRouteStatusForEnumMismatch,
  isRouteReservationStatus,
  isRouteStatusEnumMismatch,
  routeStatusForNewRoute,
  type RouteStatus,
} from "@/lib/route-workflow";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { notifyRouteAssigned } from "@/lib/notification-delivery";

type CreateRoutePayload = {
  routeDate?: string;
  creationMode?: "full" | "stops_only";
  assignmentMode?: "assigned" | "unassigned";
  operatorId?: string;
  machineIds?: string[];
  recommendationKeys?: string[];
  machineSlotIds?: string[];
  recommendationFinalTakeQty?: { machineId?: string; productId?: string; finalTakeQty?: number }[];
  routeStock?: { productId?: string; quantity?: number; available?: number }[];
  manualStopItems?: { machineId?: string; productId?: string; quantity?: number }[];
  adminOverride?: boolean;
};

type RecommendationSlotAllocation = {
  recommendation_key: string | null;
  machine_slot_id: string | null;
  slot_code: string | null;
  current_qty: number;
  target_qty: number;
  recommended_take_qty: number;
  final_take_qty: number;
  priority: string | null;
  allocation_kind?: "slot" | "extra";
  over_recommended?: boolean;
};

type StockValidationIssue = {
  product_id: string;
  product_name: string;
  selected_qty: number;
  available_qty: number;
  shortage_qty: number;
};

type StockValidationResult = {
  issues: StockValidationIssue[];
  availableByProduct: Map<string, number>;
  error?: string;
  status?: number;
};

type DbRecord = Record<string, unknown>;

type RecommendationRow = {
  recommendation_key?: string | null;
  machine_id?: string | null;
  machine_slot_id?: string | null;
  slot_code?: string | null;
  product_id?: string | null;
  current_qty?: unknown;
  capacity?: unknown;
  par_qty?: unknown;
  suggested_qty?: unknown;
  available_storage_qty?: unknown;
  final_qty_to_take?: unknown;
  priority?: string | null;
};

type GroupedRecommendationRow = {
  group_key: string;
  machine_id: string;
  product_id: string;
  current_qty: number;
  par_qty: number;
  suggested_qty: number;
  recommended_take_qty: number;
  available_storage_qty: number;
  final_qty_to_take: number;
  final_take_qty: number;
  machine_slot_id: string | null;
  slot_code: string | null;
  rows: RecommendationRow[];
  slot_allocations: RecommendationSlotAllocation[];
};

type RouteStopItemInsert = DbRecord & {
  route_stop_id?: string;
  product_id?: string | null;
  planned_quantity?: number;
};

type RefillLineInsert = DbRecord & {
  refill_order_id?: string;
};

const priorityOrder = ["critical", "high", "medium", "low"];

function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

function recordValue(value: unknown, key: string) {
  return typeof value === "object" && value !== null ? (value as DbRecord)[key] : undefined;
}

function errorText(error: unknown) {
  return ["message", "details", "hint", "code"]
    .map((key) => String(recordValue(error, key) ?? ""))
    .filter(Boolean)
    .join(" ");
}

function isMissingRouteStopItems(error: unknown) {
  return recordValue(error, "code") === "PGRST205" && errorText(error).includes("route_stop_items");
}

function isStatementTimeout(error: unknown) {
  const text = errorText(error).toLowerCase();
  return recordValue(error, "code") === "57014" || text.includes("statement timeout") || text.includes("canceling statement due to statement timeout");
}

function isMissingPlanningStockView(error: unknown) {
  const text = errorText(error).toLowerCase();
  return ["42P01", "PGRST205"].includes(String(recordValue(error, "code") ?? ""))
    && text.includes("route_storage_stock_by_product");
}

function missingOptionalColumn(error: unknown, optionalColumns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String(recordValue(error, "code") ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return null;
  return optionalColumns.find((column) => text.includes(column.toLowerCase())) ?? null;
}

function stripColumn<T extends DbRecord>(rows: T[], column: string) {
  return rows.map((row) => {
    const next = { ...row };
    delete next[column];
    return next;
  });
}

async function insertRowsWithOptionalColumnFallback(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tableName: "route_stop_items" | "refill_order_lines",
  rows: DbRecord[],
  optionalColumns: string[],
) {
  let rowsToInsert = rows;
  const removedColumns: string[] = [];

  for (;;) {
    const result = await supabase.from(tableName).insert(rowsToInsert);
    if (!result.error) return { error: null, removedColumns };

    const missingColumn = missingOptionalColumn(result.error, optionalColumns.filter((column) => !removedColumns.includes(column)));
    if (!missingColumn) return { error: result.error, removedColumns };

    removedColumns.push(missingColumn);
    rowsToInsert = stripColumn(rowsToInsert, missingColumn);
    console.warn("[routes:create] Retrying insert without optional column rejected by PostgREST schema cache", {
      tableName,
      missingColumn,
      removedColumns,
    });
  }
}

function recommendationQuantity(row: RecommendationRow) {
  return Math.max(0, recommendationTarget(row) - planQuantity(row.current_qty));
}

function recommendationTarget(row: RecommendationRow) {
  return planQuantity(row.capacity ?? row.par_qty);
}

function planQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function signedQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function stockValidationMessage(issues: StockValidationIssue[]) {
  return [
    "These products exceed available storage stock:",
    ...issues.map((issue) => `- ${issue.product_name}: selected ${issue.selected_qty}, available ${issue.available_qty}, shortage ${issue.shortage_qty}`),
  ].join("\n");
}

async function validateRouteStock(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  stockByProduct: Map<string, number>,
  excludeRouteId?: string,
): Promise<StockValidationResult> {
  const productIds = Array.from(stockByProduct.keys()).filter((productId) => planQuantity(stockByProduct.get(productId)) > 0);
  const availableByProduct = new Map<string, number>();
  if (!productIds.length) return { issues: [], availableByProduct };

  let reservedQuery = supabase
    .from("route_stock_lines")
    .select("route_id, product_id, planned_qty, picked_qty")
    .in("product_id", productIds);
  if (excludeRouteId) reservedQuery = reservedQuery.neq("route_id", excludeRouteId);

  let storagePromise = supabase
    .from("route_storage_stock_by_product")
    .select("product_id, quantity_on_hand")
    .in("product_id", productIds);
  const [initialStorageResult, reservedResult, productsResult] = await Promise.all([
    storagePromise,
    reservedQuery,
    supabase
      .from("products")
      .select("id, name")
      .in("id", productIds),
  ]);
  let storageResult = initialStorageResult;

  if (storageResult.error && isMissingPlanningStockView(storageResult.error)) {
    console.warn("[routes:create] Narrow storage planning view is not deployed; using the legacy inventory view", { error: storageResult.error });
    storagePromise = supabase
      .from("current_inventory_by_location")
      .select("product_id, quantity_on_hand")
      .eq("location_type", "storage")
      .in("product_id", productIds);
    storageResult = await storagePromise;
  }

  if (storageResult.error) {
    console.error("[routes:create] Failed to verify storage inventory", { error: storageResult.error });
    return {
      issues: [],
      availableByProduct,
      error: isStatementTimeout(storageResult.error)
        ? "Storage quantities could not be verified in time. Retry, or create a stops-only route."
        : "Could not verify storage inventory.",
      status: isStatementTimeout(storageResult.error) ? 503 : 500,
    };
  }
  if (reservedResult.error) {
    console.error("[routes:create] Failed to verify reserved route stock", { error: reservedResult.error });
    return {
      issues: [],
      availableByProduct,
      error: isStatementTimeout(reservedResult.error)
        ? "Existing route reservations could not be verified in time. Retry, or create a stops-only route."
        : "Could not verify existing route reservations.",
      status: isStatementTimeout(reservedResult.error) ? 503 : 500,
    };
  }
  if (productsResult.error) {
    console.error("[routes:create] Failed to load product names for stock validation", { error: productsResult.error });
    return { issues: [], availableByProduct, error: "Could not verify selected products.", status: 500 };
  }

  const storageByProduct = new Map<string, number>();
  ((storageResult.data ?? []) as { product_id?: string | null; quantity_on_hand?: unknown }[]).forEach((row) => {
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + signedQuantity(row.quantity_on_hand));
  });

  const reservedRows = (reservedResult.data ?? []) as { route_id?: string | null; product_id?: string | null; planned_qty?: unknown; picked_qty?: unknown }[];
  const reservedRouteIds = Array.from(new Set(reservedRows.map((row) => String(row.route_id ?? "")).filter(Boolean)));
  const routeStatusById = new Map<string, string | null>();
  if (reservedRouteIds.length) {
    const routeStatusResult = await supabase
      .from("routes")
      .select("id, status")
      .in("id", reservedRouteIds);
    if (routeStatusResult.error) {
      console.warn("[routes:create] Failed to load route statuses for reservation filtering; treating matching stock lines as reserved", {
        route_ids: reservedRouteIds,
        error: routeStatusResult.error,
      });
    } else {
      (routeStatusResult.data ?? []).forEach((route: { id?: unknown; status?: unknown }) => routeStatusById.set(String(route.id), String(route.status ?? "")));
    }
  }

  const reservedByProduct = new Map<string, number>();
  reservedRows
    .filter((row) => {
      const routeId = String(row.route_id ?? "");
      if (!routeId) return true;
      if (!routeStatusById.size) return true;
      return isRouteReservationStatus(routeStatusById.get(routeId));
    })
    .forEach((row) => {
      const productId = String(row.product_id ?? "");
      if (!productId) return;
      const reserved = Math.max(0, planQuantity(row.planned_qty) - planQuantity(row.picked_qty));
      reservedByProduct.set(productId, (reservedByProduct.get(productId) ?? 0) + reserved);
    });
  const productNameById = new Map(((productsResult.data ?? []) as { id?: string | null; name?: string | null }[]).map((product) => [String(product.id), String(product.name ?? "Unknown product")]));
  const issues: StockValidationIssue[] = [];

  for (const productId of productIds) {
    const selectedQty = planQuantity(stockByProduct.get(productId));
    if (selectedQty <= 0) continue;

    const productName = productNameById.get(productId) ?? productId;
    const storageQty = planQuantity(storageByProduct.get(productId));
    const reservedQty = planQuantity(reservedByProduct.get(productId));
    const availableQty = Math.max(0, storageQty - reservedQty);
    const shortageQty = Math.max(0, selectedQty - availableQty);
    availableByProduct.set(productId, availableQty);

    console.info("[routes:create] Stock validation", {
      product_id: productId,
      product_name: productName,
      selected_qty: selectedQty,
      available_storage_stock: availableQty,
      calculated_shortage: shortageQty,
      storage_stock_units: storageQty,
      reserved_route_units: reservedQty,
      unit: "units",
      exclude_route_id: excludeRouteId ?? null,
    });

    if (shortageQty > 0) {
      issues.push({
        product_id: productId,
        product_name: productName,
        selected_qty: selectedQty,
        available_qty: availableQty,
        shortage_qty: shortageQty,
      });
    }
  }

  if (issues.length) console.warn("[routes:create] Stock validation failed", { issues });
  return { issues, availableByProduct };
}

function priorityScore(priority: string | null | undefined) {
  const index = priorityOrder.indexOf(String(priority ?? "low").toLowerCase());
  return index === -1 ? 0 : priorityOrder.length - index;
}

function allocationSort(a: RecommendationRow, b: RecommendationRow) {
  const priorityDifference = priorityScore(b.priority) - priorityScore(a.priority);
  if (priorityDifference) return priorityDifference;
  const quantityDifference = Math.max(0, Number(a.current_qty ?? 0)) - Math.max(0, Number(b.current_qty ?? 0));
  if (quantityDifference) return quantityDifference;
  return String(a.slot_code ?? "").localeCompare(String(b.slot_code ?? ""));
}

function allocateFinalTake(rows: RecommendationRow[], finalTakeQty: number, adminOverride: boolean): RecommendationSlotAllocation[] {
  let remaining = planQuantity(finalTakeQty);
  const allocations = [...rows].sort(allocationSort).map((row) => {
    const recommendedTakeQty = recommendationQuantity(row);
    const allocation: RecommendationSlotAllocation = {
      recommendation_key: row.recommendation_key ?? null,
      machine_slot_id: row.machine_slot_id ?? null,
      slot_code: row.slot_code ?? null,
      current_qty: planQuantity(row.current_qty),
      target_qty: recommendationTarget(row),
      recommended_take_qty: recommendedTakeQty,
      final_take_qty: 0,
      priority: row.priority ?? null,
      allocation_kind: "slot",
    };
    const allocated = Math.min(remaining, recommendedTakeQty);
    allocation.final_take_qty = allocated;
    remaining -= allocated;
    return allocation;
  });

  if (remaining > 0 && adminOverride && allocations.length) {
    allocations[0].final_take_qty += remaining;
    allocations[0].over_recommended = true;
    remaining = 0;
  }

  if (remaining > 0) {
    allocations.push({
      recommendation_key: null,
      machine_slot_id: null,
      slot_code: null,
      current_qty: 0,
      target_qty: 0,
      recommended_take_qty: 0,
      final_take_qty: remaining,
      priority: null,
      allocation_kind: "extra",
      over_recommended: true,
    });
  }

  return allocations.filter((allocation) => allocation.final_take_qty > 0 || allocation.recommended_take_qty > 0);
}

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes/new")) {
    return jsonError("You are not authorized to create routes.", 403);
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return jsonError("Supabase is not configured.", 500);
  const planningReadClient = getSupabaseAdminClient() ?? supabase;

  let payload: CreateRoutePayload;

  try {
    payload = await request.json();
  } catch {
    return jsonError("Invalid route request.");
  }

  const routeDate = String(payload.routeDate ?? "").trim();
  const creationMode = payload.creationMode === "stops_only" ? "stops_only" : "full";
  const stopsOnly = creationMode === "stops_only";
  const assignmentMode = payload.assignmentMode === "assigned" ? "assigned" : "unassigned";
  const operatorId = assignmentMode === "assigned" ? String(payload.operatorId ?? "").trim() : "";
  const manualMachineIds = Array.from(new Set((payload.machineIds ?? []).map(String).filter(Boolean)));
  const recommendationKeys = Array.from(new Set((payload.recommendationKeys ?? []).map(String).filter(Boolean)));
  const requestedFinalTakeByGroup = new Map<string, number>();
  (payload.recommendationFinalTakeQty ?? []).forEach((item) => {
    const machineId = String(item.machineId ?? "").trim();
    const productId = String(item.productId ?? "").trim();
    const finalTakeQty = planQuantity(item.finalTakeQty);
    if (machineId && productId) requestedFinalTakeByGroup.set(`${machineId}:${productId}`, finalTakeQty);
  });
  const legacyRecommendationSlotIds = Array.from(new Set((payload.machineSlotIds ?? []).map(String).filter(Boolean)));
  const adminOverride = Boolean(payload.adminOverride);
  const manualStopItems = (payload.manualStopItems ?? [])
    .map((item) => ({
      machineId: String(item.machineId ?? "").trim(),
      productId: String(item.productId ?? "").trim(),
      quantity: planQuantity(item.quantity),
    }))
    .filter((item) => item.machineId && item.productId && item.quantity > 0);

  if (!routeDate) return jsonError("Route date is required.");
  if (assignmentMode === "assigned" && !operatorId) return jsonError("Choose a route performer or leave this route unassigned.");
  if (adminOverride && !isOwnerAdminRole(profile)) return jsonError("Only owner or admin can override the VMS recommendation.", 403);
  if (stopsOnly && !manualMachineIds.length) return jsonError("Choose at least one machine stop for this route plan.");
  if (!stopsOnly && !recommendationKeys.length && !legacyRecommendationSlotIds.length && !manualStopItems.length) return jsonError("Choose machine-level refill items for this route.");

  const recommendationsResult = recommendationKeys.length
    ? await planningReadClient
        .from("refill_recommendations")
        .select("recommendation_key, machine_id, machine_slot_id, slot_code, product_id, current_qty, capacity, par_qty, suggested_qty, available_storage_qty, final_qty_to_take, priority")
        .in("recommendation_key", recommendationKeys)
    : legacyRecommendationSlotIds.length
      ? await planningReadClient
          .from("refill_recommendations")
          .select("recommendation_key, machine_id, machine_slot_id, slot_code, product_id, current_qty, capacity, par_qty, suggested_qty, available_storage_qty, final_qty_to_take, priority")
          .in("machine_slot_id", legacyRecommendationSlotIds)
    : { data: [], error: null };

  if (recommendationsResult.error) {
    console.error("[routes:create] Failed to load selected recommendations", { recommendationKeys, legacyRecommendationSlotIds, error: recommendationsResult.error });
    return jsonError("Could not load selected refill recommendations.", 500);
  }

  const recommendationRows = (recommendationsResult.data ?? []) as RecommendationRow[];
  const actionableRecommendationRows = recommendationRows.filter((row) => recommendationQuantity(row) > 0);
  const groupedRecommendationRows = Array.from(
    actionableRecommendationRows.reduce((groups: Map<string, GroupedRecommendationRow>, row) => {
      const machineId = String(row.machine_id ?? "").trim();
      const productId = String(row.product_id ?? "").trim();
      if (!machineId || !productId) return groups;
      const groupKey = `${machineId}:${productId}`;
      const quantity = recommendationQuantity(row);
      const current = groups.get(groupKey) ?? {
        group_key: groupKey,
        machine_id: machineId,
        product_id: productId,
        current_qty: 0,
        par_qty: 0,
        suggested_qty: 0,
        recommended_take_qty: 0,
        available_storage_qty: planQuantity(row.available_storage_qty),
        final_qty_to_take: 0,
        final_take_qty: 0,
        machine_slot_id: null,
        slot_code: null,
        rows: [],
        slot_allocations: [],
      };

      current.rows.push(row);
      current.current_qty += planQuantity(row.current_qty);
      current.par_qty += recommendationTarget(row);
      current.suggested_qty += quantity;
      current.recommended_take_qty += quantity;
      current.available_storage_qty = Math.max(current.available_storage_qty, planQuantity(row.available_storage_qty));
      groups.set(groupKey, current);
      return groups;
    }, new Map<string, GroupedRecommendationRow>()).values(),
  ).map((group) => {
    const requestedFinalTake = requestedFinalTakeByGroup.get(group.group_key);
    const defaultFinalTakeQty = Math.min(group.recommended_take_qty, group.available_storage_qty);
    const finalTakeQty = requestedFinalTake === undefined ? defaultFinalTakeQty : planQuantity(requestedFinalTake);
    group.final_take_qty = finalTakeQty;
    group.final_qty_to_take = finalTakeQty;
    group.slot_allocations = allocateFinalTake(group.rows, finalTakeQty, adminOverride);

    if (group.rows.length === 1) {
      group.machine_slot_id = group.rows[0].machine_slot_id ?? null;
      group.slot_code = group.rows[0].slot_code ?? null;
    } else {
      const slotCodes = Array.from(new Set(group.rows.map((row) => row.slot_code).filter(Boolean)));
      group.slot_code = slotCodes.length ? slotCodes.join(", ") : null;
    }
    return group;
  });
  const plannedRecommendationRows = groupedRecommendationRows.filter((row) => planQuantity(row.final_take_qty) > 0);
  const recommendationMachineIds = plannedRecommendationRows.map((row) => row.machine_id).filter(Boolean);
  const selectedMachineIds = stopsOnly
    ? manualMachineIds
    : Array.from(new Set([...manualMachineIds, ...recommendationMachineIds, ...manualStopItems.map((item) => item.machineId)]));
  const stockByProduct = new Map<string, number>();
  plannedRecommendationRows.forEach((row) => {
    const productId = String(row.product_id);
    const quantity = planQuantity(row.final_take_qty ?? row.final_qty_to_take);
    if (productId && quantity > 0) stockByProduct.set(productId, (stockByProduct.get(productId) ?? 0) + quantity);
  });
  manualStopItems.forEach((item) => {
    if (item.quantity > 0) stockByProduct.set(item.productId, (stockByProduct.get(item.productId) ?? 0) + item.quantity);
  });
  if (!stopsOnly && recommendationRows.length && !actionableRecommendationRows.length && !manualStopItems.length) {
    return jsonError("Enter planned quantities for capacity-missing VMS rows before creating a route.");
  }
  if (!stopsOnly && !stockByProduct.size) return jsonError("Planned machine refill quantities must be greater than zero.");
  if (!selectedMachineIds.length) return jsonError("Choose at least one machine stop with a planned refill quantity greater than zero.");

  let availableUnitsByProduct = new Map<string, number>();
  if (!stopsOnly) {
    const stockValidation = await validateRouteStock(planningReadClient, stockByProduct);
    availableUnitsByProduct = stockValidation.availableByProduct;
    if (stockValidation.error) return jsonError(stockValidation.error, stockValidation.status ?? 500);
    if (stockValidation.issues.length) {
      return jsonError(stockValidationMessage(stockValidation.issues), 400, { code: "stock_exceeded", stockErrors: stockValidation.issues });
    }
  }

  if (operatorId) {
    const { data: performer, error: performerError } = await supabase
      .from("team_members")
      .select("id, role, roles, active")
      .eq("id", operatorId)
      .maybeSingle();
    if (performerError) {
      console.error("[routes:create] Failed to verify selected performer", { operatorId, error: performerError });
      return jsonError("Could not verify the selected route performer.", 500);
    }
    if (!performer || performer.active === false || !canExecuteRoutes({ id: performer.id, role: performer.role, roles: performer.roles })) {
      return jsonError("Selected route performer must be an active owner, admin, supervisor, or operator.");
    }
  }

  let routeStatus: RouteStatus = routeStatusForNewRoute(operatorId || null);
  let routeInsert = await supabase
    .from("routes")
    .insert({ route_date: routeDate, operator_id: operatorId || null, status: routeStatus, created_by: profile.team_member_id })
    .select("id")
    .single();

  if (routeInsert.error && isRouteStatusEnumMismatch(routeInsert.error, routeStatus)) {
    const fallbackStatus = fallbackRouteStatusForEnumMismatch(routeStatus);
    if (fallbackStatus) {
      console.warn("[routes:create] Retrying route insert with deployed enum fallback", {
        routeDate,
        operatorId: operatorId || null,
        rejectedStatus: routeStatus,
        fallbackStatus,
      });
      routeStatus = fallbackStatus;
      routeInsert = await supabase
        .from("routes")
        .insert({ route_date: routeDate, operator_id: operatorId || null, status: routeStatus, created_by: profile.team_member_id })
        .select("id")
        .single();
    }
  }

  if (routeInsert.error || !routeInsert.data?.id) {
    console.error("[routes:create] Failed to insert route", { routeDate, operatorId, error: routeInsert.error });
    return jsonError("Could not create the route. Check database permissions and try again.", 500);
  }

  const routeId = String(routeInsert.data.id);
  console.info("[routes:create] Route inserted", { routeId, routeDate, operatorId: operatorId || null, routeStatus });
  const cleanupRoute = async () => {
    const stopItemsCleanup = await supabase.from("route_stop_items").delete().eq("route_id", routeId);
    if (stopItemsCleanup.error && !isMissingRouteStopItems(stopItemsCleanup.error)) {
      console.error("[routes:create] Failed to cleanup route_stop_items", { routeId, error: stopItemsCleanup.error });
    }
    await supabase.from("route_pick_list_items").delete().eq("route_id", routeId);
    await supabase.from("refill_orders").delete().eq("route_id", routeId);
    await supabase.from("route_stock_lines").delete().eq("route_id", routeId);
    await supabase.from("routes").delete().eq("id", routeId);
  };

  const stopByMachine = new Map<string, string>();
  if (selectedMachineIds.length) {
    const stopsInsert = await supabase.from("route_stops").insert(
      selectedMachineIds.map((machineId, index) => ({
        route_id: routeId,
        machine_id: machineId,
        stop_order: index + 1,
      })),
    ).select("id, machine_id");

    if (stopsInsert.error || !stopsInsert.data?.length) {
      console.error("[routes:create] Failed to insert route stops", { routeId, selectedMachineIds, error: stopsInsert.error });
      await cleanupRoute();
      return jsonError("Could not save route stops. The route was not created.", 500);
    }
    (stopsInsert.data as { id: string; machine_id: string }[]).forEach((stop) => stopByMachine.set(stop.machine_id, stop.id));
  }

  const routeStopItems: RouteStopItemInsert[] = [
    ...plannedRecommendationRows.map((row) => ({
      route_id: routeId,
      route_stop_id: stopByMachine.get(row.machine_id),
      machine_id: row.machine_id,
      product_id: row.product_id,
      machine_slot_id: row.machine_slot_id,
      slot_code: row.slot_code ?? null,
      planned_quantity: row.final_take_qty,
      recommended_take_qty: row.recommended_take_qty,
      final_take_qty: row.final_take_qty,
      picked_quantity: null,
      filled_quantity: null,
      returned_quantity: null,
      source: "refill_recommendation",
      slot_allocations: row.slot_allocations,
    })),
    ...manualStopItems.map((item) => ({
      route_id: routeId,
      route_stop_id: stopByMachine.get(item.machineId),
      machine_id: item.machineId,
      product_id: item.productId,
      machine_slot_id: null,
      slot_code: null,
      planned_quantity: item.quantity,
      recommended_take_qty: item.quantity,
      final_take_qty: item.quantity,
      picked_quantity: null,
      filled_quantity: null,
      returned_quantity: null,
      source: "manual_admin_assignment",
    })),
  ].filter((item) => Boolean(item.route_stop_id && item.product_id && planQuantity(item.planned_quantity) > 0));

  if (routeStopItems.length) {
    console.info("[routes:create] Machine-level planned item rows", {
      routeId,
      count: routeStopItems.length,
      rows: routeStopItems.map((item) => ({
        route_stop_id: item.route_stop_id ?? null,
        machine_id: item.machine_id ?? null,
        product_id: item.product_id ?? null,
        planned_quantity: planQuantity(item.planned_quantity),
        recommended_take_qty: planQuantity(item.recommended_take_qty),
        final_take_qty: planQuantity(item.final_take_qty),
        source: item.source ?? null,
      })),
    });

    const stopItemsInsert = await insertRowsWithOptionalColumnFallback(supabase, "route_stop_items", routeStopItems, ["slot_allocations", "recommended_take_qty", "final_take_qty"]);

    if (stopItemsInsert.removedColumns.length) {
      console.warn("[routes:create] Saved route stop items without optional columns", { routeId, removedColumns: stopItemsInsert.removedColumns });
    }

    if (stopItemsInsert.error) {
      console.error("[routes:create] Failed to insert route stop items", { routeId, error: stopItemsInsert.error });
      if (!isMissingRouteStopItems(stopItemsInsert.error)) {
        {
          const stockValidation = await validateRouteStock(planningReadClient, stockByProduct, routeId);
          if (stockValidation.error) console.error("[routes:create] Stock recheck after planned item insert failure failed", { routeId, error: stockValidation.error });
          if (stockValidation.issues.length) {
            await cleanupRoute();
            return jsonError(stockValidationMessage(stockValidation.issues), 400, { code: "stock_exceeded", stockErrors: stockValidation.issues });
          }
        }
        await cleanupRoute();
        const databaseMessage = errorText(stopItemsInsert.error).trim();
        return jsonError(databaseMessage ? `Could not save machine-level planned items. The route was not created. ${databaseMessage}` : "Could not save machine-level planned items. The route was not created.", 500);
      }
      console.warn("[routes:create] route_stop_items table is missing; continuing with refill_order_lines fallback", { routeId });
    }
  }

  if (plannedRecommendationRows.length || manualStopItems.length) {
    const refillMachineIds = Array.from(new Set([...recommendationMachineIds, ...manualStopItems.map((item) => item.machineId)]));
    const refillOrderInsert = await supabase
      .from("refill_orders")
      .insert(
        refillMachineIds.map((machineId) => ({
          route_id: routeId,
          machine_id: machineId,
          status: operatorId ? "assigned" : "draft",
        })),
      )
      .select("id, machine_id");

    if (refillOrderInsert.error || !refillOrderInsert.data?.length) {
      console.error("[routes:create] Failed to insert refill orders", { routeId, refillMachineIds, error: refillOrderInsert.error });
      await cleanupRoute();
      return jsonError("Could not create refill orders. The route was not created.", 500);
    }

    const orderByMachine = new Map<string, string>();
    (refillOrderInsert.data as { id: string; machine_id: string }[]).forEach((order) => {
      orderByMachine.set(order.machine_id, order.id);
    });

    const recommendationLines = plannedRecommendationRows
      .map((row): RefillLineInsert => ({
        refill_order_id: orderByMachine.get(row.machine_id),
        machine_slot_id: row.machine_slot_id,
        slot_code: row.slot_code ?? null,
        product_id: row.product_id,
        current_qty_vms: row.current_qty,
        par_qty: row.par_qty,
        suggested_qty: row.recommended_take_qty,
        available_storage_qty: availableUnitsByProduct.get(String(row.product_id)) ?? planQuantity(row.available_storage_qty),
        final_qty_to_take: row.final_take_qty,
        recommended_take_qty: row.recommended_take_qty,
        final_take_qty: row.final_take_qty,
        source: "refill_recommendation",
        slot_allocations: row.slot_allocations,
      }))
      .filter((line): line is RefillLineInsert => Boolean(line.refill_order_id));
    const manualLines = manualStopItems
      .map((item): RefillLineInsert => ({
        refill_order_id: orderByMachine.get(item.machineId),
        machine_slot_id: null,
        slot_code: null,
        product_id: item.productId,
        current_qty_vms: 0,
        par_qty: item.quantity,
        suggested_qty: item.quantity,
        available_storage_qty: availableUnitsByProduct.get(item.productId) ?? 0,
        final_qty_to_take: item.quantity,
        recommended_take_qty: item.quantity,
        final_take_qty: item.quantity,
        source: "manual_admin_assignment",
      }))
      .filter((line): line is RefillLineInsert => Boolean(line.refill_order_id));
    const refillLines = [...recommendationLines, ...manualLines];

    if (!refillLines.length) {
      console.error("[routes:create] No refill lines matched created orders", { routeId, recommendationRows: actionableRecommendationRows, orderIds: refillOrderInsert.data });
      await cleanupRoute();
      return jsonError("Could not match refill lines to created refill orders.", 500);
    }

    const linesInsert = await insertRowsWithOptionalColumnFallback(supabase, "refill_order_lines", refillLines, ["slot_allocations", "recommended_take_qty", "final_take_qty", "source"]);

    if (linesInsert.removedColumns.length) {
      console.warn("[routes:create] Saved refill order lines without optional columns", { routeId, removedColumns: linesInsert.removedColumns });
    }

    if (linesInsert.error) {
      console.error("[routes:create] Failed to insert refill order lines", { routeId, error: linesInsert.error });
      await cleanupRoute();
      return jsonError("Could not save refill order lines. The route was not created.", 500);
    }
  }

  if (!stopsOnly) {
    const routeStockInsert = await supabase.from("route_stock_lines").insert(
      Array.from(stockByProduct.entries()).map(([productId, quantity]) => ({
        route_id: routeId,
        product_id: productId,
        planned_qty: planQuantity(quantity),
      })),
    );

    if (routeStockInsert.error) {
      console.error("[routes:create] Failed to insert route stock lines", { routeId, error: routeStockInsert.error });
      {
        const stockValidation = await validateRouteStock(planningReadClient, stockByProduct, routeId);
        if (stockValidation.error) console.error("[routes:create] Stock recheck after route stock insert failure failed", { routeId, error: stockValidation.error });
        if (stockValidation.issues.length) {
          await cleanupRoute();
          return jsonError(stockValidationMessage(stockValidation.issues), 400, { code: "stock_exceeded", stockErrors: stockValidation.issues });
        }
      }
      await cleanupRoute();
      return jsonError("Could not save route stock. The route was not created.", 500);
    }
  }

  const verifyRoute = await supabase.from("routes").select("id").eq("id", routeId).single();

  if (verifyRoute.error || !verifyRoute.data?.id) {
    console.error("[routes:create] Inserted route failed verification", { routeId, error: verifyRoute.error });
    await cleanupRoute();
    return jsonError("The route was created but could not be verified. Please try again.", 500);
  }

  console.info("[routes:create] Route verified; returning redirect id", { routeId });

  await logActivity({
    profile,
    action: "create_route",
    entityType: "route",
    entityId: routeId,
    entityLabel: `Route ${routeDate}`,
    afterData: {
      id: routeId,
      route_date: routeDate,
      operator_id: operatorId,
      status: routeStatus,
      machine_ids: selectedMachineIds,
      stock_lines: Array.from(stockByProduct.entries()).map(([productId, quantity]) => ({ product_id: productId, quantity })),
    },
    metadata: {
      recommendation_count: recommendationKeys.length || legacyRecommendationSlotIds.length,
      actionable_recommendation_count: actionableRecommendationRows.length,
      grouped_recommendation_count: groupedRecommendationRows.length,
      manual_stop_item_count: manualStopItems.length,
      admin_override: adminOverride,
      assignment_mode: assignmentMode,
      creation_mode: creationMode,
      products_deferred_until_storage: stopsOnly,
    },
    summary: operatorId
      ? `Created assigned route for ${routeDate} with ${selectedMachineIds.length} stops`
      : `Created available route for ${routeDate} with ${selectedMachineIds.length} stops`,
  });
  if (operatorId) {
    try {
      await notifyRouteAssigned(supabase, {
        routeId,
        routeDate,
        operatorTeamMemberId: operatorId,
        assignedBy: profile.full_name,
        stopCount: selectedMachineIds.length,
      });
    } catch (error) {
      console.warn("[routes:create] Failed to dispatch route assignment notification", { routeId, operatorId, error });
    }
  }

  revalidatePath("/routes");
  revalidatePath("/operator");
  revalidatePath("/operator/routes");
  revalidatePath(`/routes/${routeId}`);

  return NextResponse.json({ routeId, productsDeferred: stopsOnly });
}

// TODO: Add update_route activity logging when Snacky OS gets a route edit/update endpoint.
