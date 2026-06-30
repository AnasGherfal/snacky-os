import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, getEffectivePermissions } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { completeStop } from "@/lib/operator-actions";
import { ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";

function buildDebugDetails({
  profile,
  routeId,
  stopId,
  route,
  stop,
}: {
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  routeId: string;
  stopId: string;
  route?: { operator_id?: string | null } | null;
  stop?: { route_id?: string | null } | null;
}) {
  if (process.env.NODE_ENV !== "development") return undefined;

  return {
    authUserId: profile?.id ?? null,
    matchedTeamMemberId: profile?.team_member_id ?? null,
    routeId,
    stopId,
    routeOperatorId: route?.operator_id ?? null,
    routeStopRouteId: stop?.route_id ?? null,
  };
}

type DbErrorLike = { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
type LegacyPickupRow = { id?: string | null; route_stop_id?: string | null; route_stop_item_id?: string | null; machine_id?: string | null; picked_qty?: unknown };
type MachineLocationRow = { id?: string | null; name?: string | null };
type MachineRow = { id?: string | null; name?: string | null; machine_code?: string | null; location?: MachineLocationRow | MachineLocationRow[] | null };
type ProductRelationRow = { id?: string | null; name?: string | null };
type StopPlanItemRow = {
  id?: string | null;
  slot_code?: string | null;
  machine_slot_id?: string | null;
  product_id?: string | null;
  planned_quantity?: unknown;
  source?: string | null;
  product?: ProductRelationRow | ProductRelationRow[] | null;
};
type RefillOrderLineRow = {
  id?: string | null;
  slot_code?: string | null;
  machine_slot_id?: string | null;
  product_id?: string | null;
  final_qty_to_take?: unknown;
  suggested_qty?: unknown;
  source?: string | null;
  product?: ProductRelationRow | ProductRelationRow[] | null;
};
type RefillOrderFallbackRow = { refill_order_lines?: RefillOrderLineRow[] | null };
type SlotRow = { id?: string | null; slot_code?: string | null; product_id?: string | null };
type FillLineRow = { product_id?: string | null; action_type?: string | null; actual_qty?: unknown; reason?: string | null; notes?: string | null; assigned_product_id?: string | null };
type MovementRow = { product_id?: string | null; quantity?: unknown; related_route_stop_id?: string | null; reason?: string | null; from_entity_type?: string | null; to_entity_type?: string | null };
type RouteStockLineRow = { product_id?: string | null; picked_qty?: unknown; returned_qty?: unknown };
type ProductOptionRow = { id: string; sku?: string | null; barcode?: string | null; name: string; category?: string | null; brand?: string | null; image_url?: string | null };
type MachineProductSignalRow = { product_id?: string | null };
type AdjustmentRow = {
  id: string;
  adjustment_type?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  quantity?: unknown;
  reason?: string | null;
  notes?: string | null;
  photo_url?: string | null;
  status?: string | null;
  created_at?: string | null;
  product?: ProductOptionRow | ProductOptionRow[] | null;
};
type PlannedProductLine = {
  refillOrderLineId: string | null;
  routeStopItemId?: string | null;
  machineSlotId?: string | null;
  slotCodes: Set<string>;
  productId: string;
  productName: string;
  currentQty: number;
  assignedQty: number;
  parQty: number;
  filledQty: number | null;
  availableQty?: number;
};
type RefillLineItem = {
  refillOrderLineId: string | null;
  routeStopItemId?: string | null;
  machineSlotId?: string | null;
  slotCode: string;
  productId: string;
  productName: string;
  currentQty: number;
  assignedQty: number;
  parQty: number;
  filledQty: number | null;
  reason: string | null;
  notes: string | null;
  availableQty?: number;
};

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isMissingTable(error: DbErrorLike | null | undefined, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

function isMissingColumn(error: DbErrorLike | null | undefined, columns: string[]) {
  const code = String(error?.code ?? "");
  const text = [error?.code, error?.message, error?.details, error?.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? "Unknown database error");
  }
  return "Unknown database error";
}

function responseStatusForCompleteStop(result: { success: boolean; error?: string; code?: string }) {
  if (result.success) return 200;
  const code = String(result.code ?? "");
  const text = `${code} ${result.error ?? ""}`.toLowerCase();
  if (text.includes("session") || text.includes("sign in")) return 401;
  if (code === "42501" || text.includes("permission") || text.includes("authorized")) return 403;
  if (text.includes("already completed") || text.includes("completed/canceled") || text.includes("not in progress") || text.includes("duplicate")) return 409;
  if (text.includes("required") || text.includes("invalid") || text.includes("missing") || text.includes("cannot exceed")) return 400;
  return 500;
}

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function payloadByteSize(text: string, fallbackHeader: string | null) {
  const fallback = Number(fallbackHeader ?? 0);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return new TextEncoder().encode(text).length;
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? "").trim());
}

type CompleteStopArgs = Parameters<typeof completeStop>[0];
type CompleteStopPayload = Partial<CompleteStopArgs> & { clientSubmissionId?: unknown };

function movementQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function machineFillDelta(movement: MovementRow) {
  const qty = movementQuantity(movement?.quantity);
  if (movement?.reason === "manual_correction" && movement?.from_entity_type === "machine" && movement?.to_entity_type === "operator_bag") return -qty;
  return qty;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> }
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400, headers: jsonHeaders() });
  }
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  let route: { id: string; operator_id: string | null; status?: string | null } | null = null;
  let stop: { id: string; route_id: string; machine_id: string; stop_order: number; status: string } | null = null;

  try {
    const { data: routeRow, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();
    if (routeError) throw routeError;
    route = routeRow;

    if (!route) {
      return NextResponse.json(
        {
          error: "Route not found",
          code: "ROUTE_NOT_FOUND",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 404 },
      );
    }

    const { data: stopRow, error: stopError } = await supabase
      .from("route_stops")
      .select("id, route_id, machine_id, stop_order, status")
      .eq("id", stopId)
      .maybeSingle();
    if (stopError) throw stopError;
    stop = stopRow;

    if (!stop) {
      return NextResponse.json(
        {
          error: "Stop not found",
          code: "STOP_NOT_FOUND",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 404 },
      );
    }

    if (stop.route_id !== routeId) {
      return NextResponse.json(
        {
          error: "This stop does not belong to the route in the URL.",
          code: "STOP_ROUTE_MISMATCH",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 409 },
      );
    }

    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return NextResponse.json(
        {
          error: "This route is not assigned to you.",
          code: "UNAUTHORIZED",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 403 },
      );
    }

    if (stop.status === ROUTE_STOP_PENDING_STATUS) {
      let { data: legacyPickupRows, error: legacyPickupError }: { data: LegacyPickupRow[] | null; error: DbErrorLike | null } = await supabase
        .from("route_pick_list_items")
        .select("id, route_stop_id, route_stop_item_id, machine_id, picked_qty")
        .eq("route_id", routeId)
        .gt("picked_qty", 0);

      if (legacyPickupError && isMissingColumn(legacyPickupError, ["route_stop_id", "route_stop_item_id", "machine_id"])) {
        const fallback = await supabase
          .from("route_pick_list_items")
          .select("id, picked_qty")
          .eq("route_id", routeId)
          .gt("picked_qty", 0);
        legacyPickupRows = fallback.data ? fallback.data.map((row: LegacyPickupRow) => ({ ...row, route_stop_id: null, route_stop_item_id: null, machine_id: null })) : null;
        legacyPickupError = fallback.error;
      }

      const hasLegacyRoutePickup = !legacyPickupError && (legacyPickupRows ?? []).some((row) => {
        const rowStopId = row.route_stop_id ? String(row.route_stop_id) : null;
        const rowMachineId = row.machine_id ? String(row.machine_id) : null;
        return rowStopId === stopId || rowMachineId === String(stop?.machine_id ?? "") || (!rowStopId && !rowMachineId);
      });

      if (!hasLegacyRoutePickup) {
        if (legacyPickupError && !isMissingTable(legacyPickupError, "route_pick_list_items")) console.error("[operator:stop] Failed to verify pending stop pickup", { routeId, stopId, error: legacyPickupError });
        return NextResponse.json(
          {
            error: "Pick this stop's products before opening machine execution.",
            code: "STOP_PICKUP_REQUIRED",
            debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
          },
          { status: 409 },
        );
      }
    }

    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("id, name, machine_code, location:locations(id, name)")
      .eq("id", stop.machine_id)
      .maybeSingle();

    if (machineError) throw machineError;
    const machineRow = machine as MachineRow | null;
    const location = firstRelation(machineRow?.location);
    const locationName = location?.name || "Unknown Location";

    const stopPlanResponse: { data: StopPlanItemRow[] | null; error: DbErrorLike | null } = await supabase
      .from("route_stop_items")
      .select(
        `id,
        slot_code,
        machine_slot_id,
        product_id,
        planned_quantity,
        source,
        product:products(id, name)`
      )
      .eq("route_stop_id", stopId);
    let stopPlanItems = stopPlanResponse.data;
    const stopPlanError = stopPlanResponse.error;

    if (stopPlanError) {
      if (!isMissingTable(stopPlanError, "route_stop_items")) throw stopPlanError;
      const fallback = await supabase
        .from("refill_orders")
        .select(
          `id,
          refill_order_lines(
            id,
            slot_code,
            machine_slot_id,
            product_id,
            final_qty_to_take,
            suggested_qty,
            source,
            product:products(id, name)
          )`
        )
        .eq("route_id", routeId)
        .eq("machine_id", stop.machine_id);
      if (fallback.error) throw fallback.error;
      stopPlanItems = ((fallback.data ?? []) as RefillOrderFallbackRow[]).flatMap((order) =>
        (order.refill_order_lines ?? []).map((line) => ({
          id: line.id,
          slot_code: line.slot_code,
          machine_slot_id: line.machine_slot_id,
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
          source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
          product: line.product,
        })),
      );
    }

    // Get machine slot codes
    const { data: slots, error: slotsError }: { data: SlotRow[] | null; error: DbErrorLike | null } = await supabase
      .from("machine_slots")
      .select("id, slot_code, product_id")
      .eq("machine_id", stop.machine_id);
    if (slotsError) throw slotsError;

    const slotMap = new Map((slots ?? []).map((slot) => [String(slot.product_id ?? ""), slot.slot_code ?? ""]));

    const plannedByProduct = new Map<string, PlannedProductLine>();
    (stopPlanItems ?? []).forEach((line) => {
      const productId = String(line.product_id ?? "");
      if (!productId) return;
      const product = firstRelation(line.product);
      const slotCode = line.slot_code || slotMap.get(productId) || "VMS item";
      const assignedQty = Number(line.planned_quantity ?? 0);
      const current = plannedByProduct.get(productId) ?? {
        refillOrderLineId: null,
        routeStopItemId: line.id,
        machineSlotId: line.machine_slot_id,
        slotCodes: new Set<string>(),
        productId,
        productName: product?.name || "Unknown",
        currentQty: 0,
        assignedQty: 0,
        parQty: 0,
        filledQty: 0,
      };
      current.slotCodes.add(slotCode);
      current.assignedQty += assignedQty;
      current.parQty += assignedQty;
      plannedByProduct.set(productId, current);
    });

    const { data: existingFillLines, error: existingFillLinesError } = await supabase
      .from("route_stop_fill_lines")
      .select("product_id, action_type, actual_qty, reason, notes, assigned_product_id")
      .eq("route_stop_id", stopId);
    if (existingFillLinesError && !isMissingTable(existingFillLinesError, "route_stop_fill_lines")) throw existingFillLinesError;

    const existingAssignedFillByProduct = new Map<string, { quantity: number; reason?: string | null; notes?: string | null }>();
    const fillLineRows = (existingFillLines ?? []) as FillLineRow[];
    const existingExtraItems = fillLineRows
      .filter((line) => line.action_type === "extra_product" && line.product_id)
      .map((line) => ({
        productId: line.product_id,
        quantity: Number(line.actual_qty ?? 0),
        reason: line.reason ?? "Customer demand",
        notes: line.notes ?? "",
      }));
    fillLineRows.forEach((line) => {
      if (line.action_type !== "assigned_fill") return;
      const productId = String(line.product_id ?? line.assigned_product_id ?? "");
      if (!productId) return;
      const current = existingAssignedFillByProduct.get(productId);
      existingAssignedFillByProduct.set(productId, {
        quantity: (current?.quantity ?? 0) + Number(line.actual_qty ?? 0),
        reason: line.reason ?? current?.reason ?? null,
        notes: line.notes ?? current?.notes ?? null,
      });
    });

    const lineItems: RefillLineItem[] = Array.from(plannedByProduct.values()).map((line) => {
      const existingFill = existingAssignedFillByProduct.get(String(line.productId));
      return ({
      refillOrderLineId: line.refillOrderLineId,
      routeStopItemId: line.routeStopItemId,
      machineSlotId: line.machineSlotId,
      slotCode: Array.from(line.slotCodes).join(", "),
      productId: line.productId,
      productName: line.productName,
      currentQty: line.currentQty,
      assignedQty: line.assignedQty,
      parQty: line.parQty,
      filledQty: existingFill ? existingFill.quantity : null,
      reason: existingFill?.reason ?? null,
      notes: existingFill?.notes ?? null,
    });
    });

    const [
      { data: routeMovements, error: movementError },
      { data: fillMovements, error: fillMovementsError },
      { data: products, error: productsError },
      { data: refillHistory, error: refillHistoryError },
      latestStockResult,
      recentSalesResult,
      adjustmentsResult,
    ] = await Promise.all([
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, related_route_stop_id, reason, from_entity_type, to_entity_type")
        .eq("related_route_id", routeId)
        .limit(5000),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, related_route_stop_id, reason, from_entity_type, to_entity_type")
        .eq("related_route_id", routeId)
        .in("reason", ["operator_bag_to_machine", "manual_correction"]),
      supabase
        .from("products")
        .select("id, sku, barcode, name, category, brand, image_url")
        .eq("active", true)
        .order("name"),
      supabase
        .from("machine_refill_history")
        .select("machine_photo_url, machine_photo_path")
        .eq("legacy_refill_id", `route_stop:${stopId}`)
        .maybeSingle(),
      supabase
        .from("latest_vms_stock_by_slot")
        .select("product_id")
        .eq("machine_id", stop.machine_id)
        .not("product_id", "is", null)
        .limit(500),
      supabase
        .from("vms_sales_snapshots")
        .select("product_id")
        .eq("machine_id", stop.machine_id)
        .not("product_id", "is", null)
        .order("period_end", { ascending: false })
        .limit(500),
      supabase
        .from("inventory_adjustments")
        .select("id, adjustment_type, product_id, product_name, quantity, reason, notes, photo_url, status, created_at, product:products(id, sku, barcode, name, category, brand, image_url)")
        .eq("route_stop_id", stopId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false }),
    ]);
    if (movementError) throw movementError;
    if (fillMovementsError) throw fillMovementsError;
    if (productsError) throw productsError;
    if (refillHistoryError) throw refillHistoryError;
    if (latestStockResult.error && !isMissingTable(latestStockResult.error, "latest_vms_stock_by_slot")) {
      console.warn("[operator:stop-data] Could not load latest VMS stock products for picker priority", { routeId, stopId, error: latestStockResult.error });
    }
    if (recentSalesResult.error && !isMissingTable(recentSalesResult.error, "vms_sales_snapshots")) {
      console.warn("[operator:stop-data] Could not load recent machine sales products for picker priority", { routeId, stopId, error: recentSalesResult.error });
    }
    if (adjustmentsResult.error && !isMissingTable(adjustmentsResult.error, "inventory_adjustments")) {
      throw adjustmentsResult.error;
    }

    const filledByProduct = new Map<string, number>();
    const currentStopFilledByProduct = new Map<string, number>();
    ((fillMovements ?? []) as MovementRow[]).forEach((movement) => {
      const productId = String(movement.product_id);
      const qty = machineFillDelta(movement);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + qty);
      if (movement.related_route_stop_id === stopId) currentStopFilledByProduct.set(productId, (currentStopFilledByProduct.get(productId) ?? 0) + qty);
    });

    const bagBalanceByProduct = new Map<string, number>();
    ((routeMovements ?? []) as MovementRow[]).forEach((movement) => {
      const productId = String(movement.product_id ?? "");
      const qty = movementQuantity(movement.quantity);
      if (!productId || qty <= 0) return;
      if (movement.to_entity_type === "operator_bag" && movement.from_entity_type !== "operator_bag") {
        bagBalanceByProduct.set(productId, (bagBalanceByProduct.get(productId) ?? 0) + qty);
      }
      if (movement.from_entity_type === "operator_bag" && movement.to_entity_type !== "operator_bag") {
        bagBalanceByProduct.set(productId, (bagBalanceByProduct.get(productId) ?? 0) - qty);
      }
    });

    const availableByProduct = new Map<string, number>();
    new Set([...bagBalanceByProduct.keys(), ...currentStopFilledByProduct.keys()]).forEach((productId) => {
      availableByProduct.set(productId, Math.max(0, (bagBalanceByProduct.get(productId) ?? 0) + (currentStopFilledByProduct.get(productId) ?? 0)));
    });

    lineItems.forEach((item) => {
      item.availableQty = availableByProduct.get(String(item.productId)) ?? 0;
    });

    const productPriority = new Map<string, { rank: number; label: string }>();
    const markProductPriority = (productId: unknown, rank: number, label: string) => {
      const key = String(productId ?? "");
      if (!key) return;
      const existing = productPriority.get(key);
      if (!existing || rank < existing.rank) productPriority.set(key, { rank, label });
    };

    (slots ?? []).forEach((slot) => markProductPriority(slot.product_id, 1, "Machine products"));
    lineItems.forEach((item) => markProductPriority(item.productId, 2, "Route pickup list"));
    ((latestStockResult.data ?? []) as MachineProductSignalRow[]).forEach((row) => markProductPriority(row.product_id, 3, "Latest VMS stock"));
    ((recentSalesResult.data ?? []) as MachineProductSignalRow[]).forEach((row) => markProductPriority(row.product_id, 4, "Known machine product"));

    const refillItems = lineItems;
    const productOptions = ((products ?? []) as ProductOptionRow[]).map((product) => ({
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      category: product.category,
      brand: product.brand,
      imageUrl: product.image_url,
      availableQty: availableByProduct.get(String(product.id)) ?? 0,
      sourceLabel: productPriority.get(String(product.id))?.label ?? null,
    }));
    const productOptionById = new Map(productOptions.map((product) => [product.id, product]));
    const machineProductOptions = Array.from(productPriority.entries())
      .sort((a, b) => a[1].rank - b[1].rank || (productOptionById.get(a[0])?.name ?? "").localeCompare(productOptionById.get(b[0])?.name ?? ""))
      .map(([productId]) => productOptionById.get(productId))
      .filter((product): product is (typeof productOptions)[number] => Boolean(product));
    const adjustments = ((adjustmentsResult.data ?? []) as AdjustmentRow[]).map((adjustment) => {
      const product = firstRelation(adjustment.product);
      return {
        id: adjustment.id,
        adjustmentType: adjustment.adjustment_type ?? "damaged",
        productId: adjustment.product_id ?? product?.id ?? null,
        productName: adjustment.product_name ?? product?.name ?? "Unknown product",
        quantity: movementQuantity(adjustment.quantity),
        reason: adjustment.reason ?? "",
        notes: adjustment.notes ?? "",
        photoUrl: adjustment.photo_url ?? null,
        status: adjustment.status ?? "confirmed",
        createdAt: adjustment.created_at ?? null,
      };
    });

    return NextResponse.json({
      stopId,
      routeId,
      machineId: stop.machine_id,
      machineName: machine?.name ?? "Unknown machine",
      machineCode: machine?.machine_code ?? "-",
      location: locationName,
      stopStatus: stop.status,
      routeStatus: route.status,
      refillItems,
      extraItems: existingExtraItems,
      productOptions,
      machineProductOptions,
      adjustments,
      hasCompletionPhoto: Boolean(refillHistory?.machine_photo_url || refillHistory?.machine_photo_path),
      debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
    });
  } catch (error) {
    console.error("[operator:stop-data] Error fetching stop data", {
      route_id: routeId,
      stop_id: stopId,
      user_id: profile?.id ?? null,
      user_roles: profile?.roles ?? [],
      route_status: route?.status ?? null,
      route_operator_id: route?.operator_id ?? null,
      stop_status: stop?.status ?? null,
      stop_route_id: stop?.route_id ?? null,
      machine_id: stop?.machine_id ?? null,
      error_message: errorMessage(error),
      error_stack: error instanceof Error ? error.stack : null,
      error,
    });
    return NextResponse.json(
      {
        error: "Could not load this stop. Please refresh or return to route.",
        details: process.env.NODE_ENV === "development" ? errorMessage(error) : undefined,
        debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400, headers: jsonHeaders() });
  }
  const requestTimestamp = new Date().toISOString();
  const userAgent = request.headers.get("user-agent") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const effectivePermissions = profile ? getEffectivePermissions(profile) : [];

  let payload: CompleteStopPayload | null = null;
  let payloadText = "";
  let statusCode = 500;
  const baseLog = {
    route_id: routeId,
    route_stop_id: stopId,
    user_id: profile?.id ?? null,
    user_roles: profile?.roles ?? [],
    effective_permissions: effectivePermissions,
    session_valid: Boolean(accessToken && profile),
    request_timestamp: requestTimestamp,
    request_content_type: contentType || null,
    user_agent: userAgent,
  };

  try {
    if (!accessToken || !profile) {
      statusCode = 401;
      console.warn("[operator:complete-stop-api] Session missing", baseLog);
      return NextResponse.json(
        { success: false, code: "SESSION_EXPIRED", error: "Session expired. Your refill draft is saved. Please sign in again and retry." },
        { status: statusCode, headers: jsonHeaders() },
      );
    }

    if (!contentType.toLowerCase().includes("application/json")) {
      payloadText = await request.text().catch(() => "");
      statusCode = 415;
      console.warn("[operator:complete-stop-api] Non-JSON request", {
        ...baseLog,
        payload_size: payloadByteSize(payloadText, request.headers.get("content-length")),
        response_status_code: statusCode,
        response_content_type: "application/json",
        response_body_text: payloadText.slice(0, 1000),
      });
      return NextResponse.json(
        { success: false, code: "INVALID_CONTENT_TYPE", error: "Invalid refill payload. Please refresh the page and retry." },
        { status: statusCode, headers: jsonHeaders() },
      );
    }

    payloadText = await request.text();
    try {
      payload = JSON.parse(payloadText) as CompleteStopPayload;
    } catch (error) {
      statusCode = 400;
      console.warn("[operator:complete-stop-api] Invalid JSON payload", {
        ...baseLog,
        payload_size: payloadByteSize(payloadText, request.headers.get("content-length")),
        response_status_code: statusCode,
        response_content_type: "application/json",
        response_body_text: payloadText.slice(0, 1000),
        error_message: errorMessage(error),
      });
      return NextResponse.json(
        { success: false, code: "INVALID_JSON", error: "Invalid refill payload. Your draft is saved; refresh and retry." },
        { status: statusCode, headers: jsonHeaders() },
      );
    }

    const machineId = String(payload.machineId ?? "").trim();
    if (!isUuid(machineId)) {
      statusCode = 400;
      return NextResponse.json(
        { success: false, code: "INVALID_MACHINE_ID", error: "Invalid machine id." },
        { status: statusCode, headers: jsonHeaders() },
      );
    }
    const filledItems: CompleteStopArgs["filledItems"] = Array.isArray(payload.filledItems) ? payload.filledItems : [];
    const extraItems: NonNullable<CompleteStopArgs["extraItems"]> = Array.isArray(payload.extraItems) ? payload.extraItems : [];
    const missingProducts: NonNullable<CompleteStopArgs["missingProducts"]> = Array.isArray(payload.missingProducts) ? payload.missingProducts : [];
    const clientSubmissionId = String(payload.clientSubmissionId ?? "").trim() || null;
    const issuePriority = payload.issue?.priority ? String(payload.issue.priority) : "";
    const issue: CompleteStopArgs["issue"] = payload.issue && typeof payload.issue === "object"
      ? {
          issueType: String(payload.issue.issueType ?? ""),
          priority: issuePriority === "critical" || issuePriority === "high" || issuePriority === "normal" || issuePriority === "low" ? issuePriority : "normal",
          description: String(payload.issue.description ?? ""),
        }
      : undefined;

    console.info("[operator:complete-stop-api] Request received", {
      ...baseLog,
      machine_id: machineId || null,
      client_submission_id: clientSubmissionId,
      payload_size: payloadByteSize(payloadText, request.headers.get("content-length")),
      refill_line_count: filledItems.length,
      extra_item_count: extraItems.length,
      missing_product_count: missingProducts.length,
    });

    if (!machineId) {
      statusCode = 400;
      return NextResponse.json(
        { success: false, code: "MISSING_MACHINE_ID", error: "Missing route, stop, or machine. Return to the route and open this stop again." },
        { status: statusCode, headers: jsonHeaders() },
      );
    }

    const result = await completeStop({
      stopId,
      routeId,
      machineId,
      filledItems,
      extraItems,
      missingProducts,
      cashCollected: Boolean(payload.cashCollected),
      cashBagId: String(payload.cashBagId ?? ""),
      notes: String(payload.notes ?? ""),
      completionPhotoUrl: payload.completionPhotoUrl ? String(payload.completionPhotoUrl) : null,
      completionPhotoPath: payload.completionPhotoPath ? String(payload.completionPhotoPath) : null,
      completionPhotoOriginalName: payload.completionPhotoOriginalName ? String(payload.completionPhotoOriginalName) : null,
      completionPhotoUploadUnavailable: Boolean(payload.completionPhotoUploadUnavailable),
      issue,
      clientSubmissionId,
    });
    statusCode = responseStatusForCompleteStop(result);

    console.info("[operator:complete-stop-api] Response ready", {
      ...baseLog,
      machine_id: machineId,
      client_submission_id: clientSubmissionId,
      payload_size: payloadByteSize(payloadText, request.headers.get("content-length")),
      refill_line_count: filledItems.length,
      response_status_code: statusCode,
      response_content_type: "application/json",
      error_code: result.success ? null : result.code ?? null,
      error_message: result.success ? null : result.error ?? null,
    });

    return NextResponse.json(result, { status: statusCode, headers: jsonHeaders() });
  } catch (error) {
    statusCode = 500;
    console.error("[operator:complete-stop-api] Unexpected failure", {
      ...baseLog,
      machine_id: payload?.machineId ?? null,
      payload_size: payloadByteSize(payloadText, request.headers.get("content-length")),
      refill_line_count: Array.isArray(payload?.filledItems) ? payload.filledItems.length : null,
      response_status_code: statusCode,
      response_content_type: "application/json",
      supabase_error_code: error && typeof error === "object" ? (error as { code?: unknown }).code ?? null : null,
      supabase_error_message: errorMessage(error),
      error_stack: error instanceof Error ? error.stack : null,
      error,
    });
    return NextResponse.json(
      { success: false, code: "SERVER_ERROR", error: "Could not complete stop. Technical details are in the server logs." },
      { status: statusCode, headers: jsonHeaders() },
    );
  }
}
