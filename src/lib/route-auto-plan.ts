import { ROUTE_RESERVATION_STATUSES } from "@/lib/route-workflow";

type SupabaseLike = any;

type RecommendationRow = {
  recommendation_key?: string | null;
  machine_id?: string | null;
  machine_slot_id?: string | null;
  slot_code?: string | null;
  product_id?: string | null;
  current_qty?: number | string | null;
  capacity?: number | string | null;
  par_qty?: number | string | null;
  available_storage_qty?: number | string | null;
  priority?: string | null;
  latest_vms_at?: string | null;
  imported_at?: string | null;
};

type RouteStopRow = {
  id: string;
  machine_id: string;
  stop_order?: number | string | null;
};

type AutoPlanGroup = {
  machineId: string;
  routeStopId: string;
  productId: string;
  rows: RecommendationRow[];
  recommendedQty: number;
  priority: string;
  stopOrder: number;
};

export type AutoPlanRouteProductsResult = {
  prepared: boolean;
  reason:
    | "prepared"
    | "already_prepared"
    | "no_stops"
    | "no_recommendations"
    | "no_available_storage"
    | "stale_recommendations"
    | "route_has_pickup_history";
  plannedItemCount: number;
  plannedUnitCount: number;
  productCount: number;
  shortageProductCount: number;
};

function units(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function signed(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function target(row: RecommendationRow) {
  return units(row.capacity ?? row.par_qty);
}

function recommended(row: RecommendationRow) {
  return Math.max(0, target(row) - units(row.current_qty));
}

function priorityScore(value: unknown) {
  switch (String(value ?? "").toLowerCase()) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    case "normal": return 2;
    default: return 1;
  }
}

function allocateAcrossSlots(rows: RecommendationRow[], finalTakeQty: number) {
  let remaining = units(finalTakeQty);
  return [...rows]
    .sort((a, b) => {
      const priorityDifference = priorityScore(b.priority) - priorityScore(a.priority);
      if (priorityDifference) return priorityDifference;
      const currentDifference = units(a.current_qty) - units(b.current_qty);
      if (currentDifference) return currentDifference;
      return String(a.slot_code ?? "").localeCompare(String(b.slot_code ?? ""), undefined, { numeric: true });
    })
    .map((row) => {
      const recommendedTakeQty = recommended(row);
      const finalTake = Math.min(remaining, recommendedTakeQty);
      remaining = Math.max(0, remaining - finalTake);
      return {
        recommendation_key: row.recommendation_key ?? null,
        machine_slot_id: row.machine_slot_id ?? null,
        slot_code: row.slot_code ?? null,
        current_qty: units(row.current_qty),
        target_qty: target(row),
        recommended_take_qty: recommendedTakeQty,
        final_take_qty: finalTake,
        over_recommended: false,
      };
    })
    .filter((row) => row.final_take_qty > 0 || row.recommended_take_qty > 0);
}

export async function autoPlanRouteProducts(args: {
  writeClient: SupabaseLike;
  readClient?: SupabaseLike;
  routeId: string;
}): Promise<AutoPlanRouteProductsResult> {
  const writeClient = args.writeClient;
  const readClient = args.readClient ?? writeClient;
  const routeId = String(args.routeId ?? "").trim();

  const { data: existingItems, error: existingItemsError } = await readClient
    .from("route_stop_items")
    .select("id, planned_quantity, picked_quantity")
    .eq("route_id", routeId);
  if (existingItemsError) throw existingItemsError;

  if ((existingItems ?? []).some((row: any) => units(row.planned_quantity) > 0)) {
    return {
      prepared: false,
      reason: "already_prepared",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: 0,
    };
  }
  if ((existingItems ?? []).some((row: any) => units(row.picked_quantity) > 0)) {
    return {
      prepared: false,
      reason: "route_has_pickup_history",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: 0,
    };
  }

  const { data: stops, error: stopsError } = await readClient
    .from("route_stops")
    .select("id, machine_id, stop_order")
    .eq("route_id", routeId)
    .order("stop_order", { ascending: true });
  if (stopsError) throw stopsError;

  const routeStops = (stops ?? []) as RouteStopRow[];
  if (!routeStops.length) {
    return {
      prepared: false,
      reason: "no_stops",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: 0,
    };
  }

  const machineIds = Array.from(new Set(routeStops.map((stop) => String(stop.machine_id ?? "")).filter(Boolean)));
  const stopByMachine = new Map(routeStops.map((stop) => [String(stop.machine_id), stop]));

  const [{ data: recommendations, error: recommendationsError }, { data: storageRows, error: storageError }, { data: reservedRows, error: reservedError }] = await Promise.all([
    readClient
      .from("refill_recommendations")
      .select("recommendation_key, machine_id, machine_slot_id, slot_code, product_id, current_qty, capacity, par_qty, available_storage_qty, priority, latest_vms_at, imported_at")
      .in("machine_id", machineIds),
    readClient
      .from("route_storage_stock_by_product")
      .select("product_id, quantity_on_hand"),
    readClient
      .from("route_stock_lines")
      .select("route_id, product_id, planned_qty, picked_qty, route:routes!inner(status)")
      .neq("route_id", routeId)
      .in("route.status", [...ROUTE_RESERVATION_STATUSES]),
  ]);
  if (recommendationsError) throw recommendationsError;
  if (storageError) throw storageError;
  if (reservedError) throw reservedError;

  const rawRecommendationRows = ((recommendations ?? []) as RecommendationRow[])
    .filter((row) => row.machine_id && row.product_id && recommended(row) > 0);
  const maxAgeMs = 72 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const staleRows = rawRecommendationRows.filter((row) => {
    const timestamp = Date.parse(String(row.latest_vms_at ?? row.imported_at ?? ""));
    return Number.isFinite(timestamp) && nowMs - timestamp > maxAgeMs;
  });
  const recommendationRows = rawRecommendationRows.filter((row) => !staleRows.includes(row));

  if (!recommendationRows.length && staleRows.length) {
    return {
      prepared: false,
      reason: "stale_recommendations",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: 0,
    };
  }

  if (!recommendationRows.length) {
    return {
      prepared: false,
      reason: "no_recommendations",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: 0,
    };
  }

  const productIds = Array.from(new Set(recommendationRows.map((row) => String(row.product_id))));
  const { data: activeProducts, error: activeProductsError } = await readClient
    .from("products")
    .select("id")
    .in("id", productIds)
    .eq("active", true);
  if (activeProductsError) throw activeProductsError;
  const activeProductIds = new Set((activeProducts ?? []).map((row: any) => String(row.id ?? "")));

  const storageByProduct = new Map<string, number>();
  (storageRows ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + signed(row.quantity_on_hand));
  });

  const reservedByProduct = new Map<string, number>();
  (reservedRows ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    const quantity = Math.max(0, units(row.planned_qty) - units(row.picked_qty));
    reservedByProduct.set(productId, (reservedByProduct.get(productId) ?? 0) + quantity);
  });

  const availableByProduct = new Map<string, number>();
  productIds.forEach((productId) => {
    availableByProduct.set(
      productId,
      Math.max(0, Math.floor((storageByProduct.get(productId) ?? 0) - (reservedByProduct.get(productId) ?? 0))),
    );
  });

  const groups = new Map<string, AutoPlanGroup>();
  recommendationRows.forEach((row) => {
    const machineId = String(row.machine_id ?? "");
    const productId = String(row.product_id ?? "");
    if (!activeProductIds.has(productId)) return;
    const stop = stopByMachine.get(machineId);
    if (!stop) return;
    const key = `${machineId}:${productId}`;
    const current = groups.get(key) ?? {
      machineId,
      routeStopId: String(stop.id),
      productId,
      rows: [],
      recommendedQty: 0,
      priority: String(row.priority ?? "low"),
      stopOrder: units(stop.stop_order),
    };
    current.rows.push(row);
    current.recommendedQty += recommended(row);
    if (priorityScore(row.priority) > priorityScore(current.priority)) current.priority = String(row.priority ?? "low");
    groups.set(key, current);
  });

  const orderedGroups = Array.from(groups.values()).sort((a, b) => {
    const priorityDifference = priorityScore(b.priority) - priorityScore(a.priority);
    if (priorityDifference) return priorityDifference;
    if (a.stopOrder !== b.stopOrder) return a.stopOrder - b.stopOrder;
    return a.productId.localeCompare(b.productId);
  });

  const usedByProduct = new Map<string, number>();
  const plannedRows: any[] = [];
  const shortageProducts = new Set<string>();

  orderedGroups.forEach((group) => {
    const available = availableByProduct.get(group.productId) ?? 0;
    const used = usedByProduct.get(group.productId) ?? 0;
    const remaining = Math.max(0, available - used);
    const finalTakeQty = Math.min(group.recommendedQty, remaining);
    if (finalTakeQty < group.recommendedQty) shortageProducts.add(group.productId);
    if (finalTakeQty <= 0) return;

    const slotCodes = Array.from(new Set(group.rows.map((row) => String(row.slot_code ?? "").trim()).filter(Boolean)));
    const slotAllocations = allocateAcrossSlots(group.rows, finalTakeQty);
    plannedRows.push({
      route_id: routeId,
      route_stop_id: group.routeStopId,
      machine_id: group.machineId,
      product_id: group.productId,
      machine_slot_id: group.rows.length === 1 ? group.rows[0].machine_slot_id ?? null : null,
      slot_code: slotCodes.length ? slotCodes.join(", ") : null,
      planned_quantity: finalTakeQty,
      recommended_take_qty: group.recommendedQty,
      final_take_qty: finalTakeQty,
      picked_quantity: null,
      filled_quantity: null,
      returned_quantity: null,
      source: "refill_recommendation",
      notes: null,
      slot_allocations: slotAllocations,
      is_checked: false,
      checked_at: null,
      checked_by: null,
    });
    usedByProduct.set(group.productId, used + finalTakeQty);
  });

  if (!plannedRows.length) {
    return {
      prepared: false,
      reason: "no_available_storage",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: shortageProducts.size,
    };
  }

  // Re-check immediately before writing so a second assignment/save cannot create duplicate active rows.
  const { data: finalExistingCheck, error: finalExistingError } = await readClient
    .from("route_stop_items")
    .select("id, planned_quantity")
    .eq("route_id", routeId)
    .gt("planned_quantity", 0)
    .limit(1);
  if (finalExistingError) throw finalExistingError;
  if ((finalExistingCheck ?? []).length) {
    return {
      prepared: false,
      reason: "already_prepared",
      plannedItemCount: 0,
      plannedUnitCount: 0,
      productCount: 0,
      shortageProductCount: 0,
    };
  }

  const { data: insertedItems, error: insertItemsError } = await writeClient
    .from("route_stop_items")
    .insert(plannedRows)
    .select("id, product_id, planned_quantity");
  if (insertItemsError) throw insertItemsError;

  const plannedByProduct = new Map<string, number>();
  plannedRows.forEach((row) => {
    plannedByProduct.set(row.product_id, (plannedByProduct.get(row.product_id) ?? 0) + units(row.planned_quantity));
  });

  const { data: existingStockLines, error: stockLinesError } = await writeClient
    .from("route_stock_lines")
    .select("id, product_id, picked_qty, returned_qty")
    .eq("route_id", routeId);
  if (stockLinesError) throw stockLinesError;
  const stockLineByProduct = new Map((existingStockLines ?? []).map((row: any) => [String(row.product_id ?? ""), row]));
  const now = new Date().toISOString();

  for (const [productId, plannedQty] of plannedByProduct.entries()) {
    const existing = stockLineByProduct.get(productId);
    if (existing) {
      const { error } = await writeClient
        .from("route_stock_lines")
        .update({ planned_qty: plannedQty, updated_at: now })
        .eq("id", String(existing.id));
      if (error) throw error;
    } else {
      const { error } = await writeClient.from("route_stock_lines").insert({
        route_id: routeId,
        product_id: productId,
        planned_qty: plannedQty,
        picked_qty: 0,
        returned_qty: 0,
        updated_at: now,
      });
      if (error) throw error;
    }
  }

  return {
    prepared: true,
    reason: "prepared",
    plannedItemCount: insertedItems?.length ?? plannedRows.length,
    plannedUnitCount: plannedRows.reduce((sum, row) => sum + units(row.planned_quantity), 0),
    productCount: plannedByProduct.size,
    shortageProductCount: shortageProducts.size,
  };
}
