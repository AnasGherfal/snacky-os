"use server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { calculateCashVariance, getCashCollectionStatus } from "@/lib/cash-collections";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

export async function startRoute(routeId: string) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");
  if (!routeId) throw new Error("Route id is required");

  const profile = await getCurrentProfile();
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, operator_id, status, started_at")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) throw routeError;
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
    throw new Error("You are not authorized to start this route");
  }
  if (!["draft", "assigned", "in_progress"].includes(String(route.status))) {
    throw new Error("Only draft or assigned routes can be started.");
  }
  if (route.status === "in_progress") {
    return { success: true };
  }

  const { error } = await supabase
    .from("routes")
    .update({ status: "in_progress", started_at: route.started_at ?? new Date().toISOString() })
    .eq("id", routeId)
    .eq("operator_id", route.operator_id)
    .in("status", ["draft", "assigned"]);

  if (error) throw error;
  return { success: true };
}

/**
 * Creates inventory movements from storage to operator bag
 * Called when operator confirms pick list
 */
export async function confirmPickList(
  routeId: string,
  pickedItems: { productId: string; quantity: number; plannedQty?: number; reason?: string; notes?: string }[],
  extras: { productId: string; quantity: number; reason: string; notes?: string }[] = [],
  substitutions: { plannedProductId: string; substituteProductId: string; quantity: number; reason: string; notes?: string }[] = [],
) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const profile = await getCurrentProfile();
    // Get route details
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .single();

    if (routeError || !route) throw new Error("Route not found");
    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      throw new Error("You are not authorized to pick stock for this route");
    }
    const actualPickLines = [
      ...pickedItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...extras.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...substitutions.map((item) => ({ productId: item.substituteProductId, quantity: item.quantity })),
    ];
    const pickedByProduct = new Map<string, number>();
    actualPickLines.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
    });

    let { data: routeStopItems, error: stopItemsError }: { data: any[] | null; error: any } = await supabase
      .from("route_stop_items")
      .select("product_id, planned_quantity")
      .eq("route_id", routeId);

    if (stopItemsError) {
      if (!isMissingTable(stopItemsError, "route_stop_items")) throw stopItemsError;
      const fallback = await supabase
        .from("refill_orders")
        .select("id, refill_order_lines(product_id, final_qty_to_take, suggested_qty)")
        .eq("route_id", routeId);
      if (fallback.error) throw fallback.error;
      routeStopItems = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
        })),
      );
    }
    if (!routeStopItems?.length) throw new Error("No products were planned for this route.");

    const plannedByProduct = new Map<string, number>();
    (routeStopItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id);
      plannedByProduct.set(productId, (plannedByProduct.get(productId) ?? 0) + Number(line.planned_quantity ?? 0));
    });

    // Get storage location ID (for now assume there's a default storage)
    const { data: storages } = await supabase
      .from("storage_locations")
      .select("id")
      .eq("active", true)
      .limit(1);

    const storageId = storages?.[0]?.id;
    if (!storageId) throw new Error("No active storage location found");

    const { data: storageRows, error: storageError } = await supabase
      .from("current_inventory_by_location")
      .select("product_id, quantity_on_hand")
      .eq("location_type", "storage")
      .eq("location_id", storageId)
      .in("product_id", Array.from(pickedByProduct.keys()));

    if (storageError) throw storageError;
    const storageByProduct = new Map<string, number>();
    (storageRows ?? []).forEach((row: any) => {
      const productId = String(row.product_id);
      storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
    });

    for (const [productId, quantity] of pickedByProduct) {
      if (quantity > (storageByProduct.get(productId) ?? 0)) {
        throw new Error("Picked quantity cannot exceed available storage stock.");
      }
    }

    const { data: existingMovements } = await supabase
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .eq("reason", "storage_to_operator_bag")
      .limit(1);

    if (existingMovements?.length) {
      throw new Error("This route stock has already been picked.");
    }

    // Create inventory movements for each picked item
    const movements = Array.from(pickedByProduct.entries())
      .map((item) => ({
        product_id: item[0],
        quantity: item[1],
        from_entity_type: "storage" as const,
        from_entity_id: storageId,
        to_entity_type: "operator_bag" as const,
        to_entity_id: route.operator_id,
        reason: "storage_to_operator_bag" as const,
        related_route_id: routeId,
        created_by: route.operator_id,
        notes: `Picked for route ${routeId}`,
      }));

    if (!movements.length) throw new Error("No stock quantities were picked.");

    const { error: movementError } = await supabase
      .from("inventory_movements")
      .insert(movements);

    if (movementError) throw movementError;

    const pickListRows = [
      ...pickedItems.map((item) => {
        const plannedQty = plannedByProduct.get(String(item.productId)) ?? Number(item.plannedQty ?? 0);
        const pickedQty = Math.max(0, Number(item.quantity ?? 0));
        return {
          route_id: routeId,
          product_id: item.productId,
          planned_qty: plannedQty,
          picked_qty: pickedQty,
          action_type: "planned_pick",
          reason: pickedQty !== plannedQty ? item.reason || "Other" : null,
          notes: item.notes || null,
          needs_review: pickedQty !== plannedQty,
          created_by: route.operator_id,
        };
      }),
      ...extras.map((item) => ({
        route_id: routeId,
        product_id: item.productId,
        planned_qty: 0,
        picked_qty: Math.max(0, Number(item.quantity ?? 0)),
        action_type: "extra_product",
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        created_by: route.operator_id,
      })),
      ...substitutions.map((item) => ({
        route_id: routeId,
        product_id: item.substituteProductId,
        planned_qty: 0,
        picked_qty: Math.max(0, Number(item.quantity ?? 0)),
        action_type: "substitution",
        substituted_for_product_id: item.plannedProductId,
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        created_by: route.operator_id,
      })),
    ].filter((item) => Number(item.picked_qty ?? 0) > 0 || Number(item.planned_qty ?? 0) > 0);

    if (pickListRows.length) {
      const { error: pickListError } = await supabase.from("route_pick_list_items").insert(pickListRows);
      if (pickListError && !isMissingTable(pickListError, "route_pick_list_items")) throw pickListError;
    }

    const { data: routeOrders } = await supabase
      .from("refill_orders")
      .select("id, refill_order_lines(id, product_id, final_qty_to_take, suggested_qty)")
      .eq("route_id", routeId);
    const linesByProduct = new Map<string, any[]>();
    routeOrders?.forEach((order: any) => {
      order.refill_order_lines?.forEach((line: any) => {
        const key = String(line.product_id);
        linesByProduct.set(key, [...(linesByProduct.get(key) ?? []), line]);
      });
    });

    const { data: routeStockLines, error: routeStockError } = await supabase
      .from("route_stock_lines")
      .select("id, product_id")
      .eq("route_id", routeId);
    if (routeStockError) throw routeStockError;

    const stockLineRows = Array.from(new Set([...Array.from(plannedByProduct.keys()), ...Array.from(pickedByProduct.keys())])).map((productId) => ({
      route_id: routeId,
      product_id: productId,
      planned_qty: plannedByProduct.get(productId) ?? 0,
      picked_qty: pickedByProduct.get(productId) ?? 0,
      updated_at: new Date().toISOString(),
    }));

    if (stockLineRows.length) {
      const { error: stockLineError } = await supabase
        .from("route_stock_lines")
        .upsert(stockLineRows, { onConflict: "route_id,product_id" });

      if (stockLineError) throw stockLineError;
    }

    for (const item of pickedItems.filter((entry) => Number(entry.quantity) >= 0)) {
      let remaining = Number(item.quantity);
      const lines = linesByProduct.get(String(item.productId)) ?? [];

      for (const line of lines) {
        const plannedQty = Number(line.final_qty_to_take ?? line.suggested_qty ?? 0);
        const pickedQty = Math.max(0, Math.min(remaining, plannedQty));
        remaining -= pickedQty;

        const { error: lineError } = await supabase
          .from("refill_order_lines")
          .update({ picked_qty: pickedQty })
          .eq("id", line.id);

        if (lineError) throw lineError;
      }
    }

    // Update route status to in_progress
    const { error: statusError } = await supabase
      .from("routes")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", routeId);

    if (statusError) throw statusError;

    // Update all refill orders for this route to picked
    const { error: refillError } = await supabase
      .from("refill_orders")
      .update({ status: "picked" })
      .eq("route_id", routeId)
      .eq("status", "assigned");

    if (refillError) throw refillError;

    return { success: true };
  } catch (error) {
    console.error("Error confirming pick list:", error);
    throw error;
  }
}

/**
 * Updates a route stop status and creates inventory movements
 * Called when operator arrives at a machine
 */
export async function arrivedAtStop(stopId: string) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const { error } = await supabase
      .from("route_stops")
      .update({ status: "arrived", arrived_at: new Date().toISOString() })
      .eq("id", stopId);

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error("Error marking arrival:", error);
    throw error;
  }
}

/**
 * Completes a machine stop with refill data
 * Creates inventory movements: operator_bag -> machine
 * Creates cash collection record
 */
export async function completeStop({
  stopId,
  routeId,
  machineId,
  filledItems,
  extraItems = [],
  substitutions = [],
  missingProducts = [],
  cashCollected,
  notes,
  issue,
}: {
  stopId: string;
  routeId: string;
  machineId: string;
  filledItems: { refillOrderLineId?: string | null; productId: string; quantity: number; assignedQty?: number; reason?: string; notes?: string; unavailable?: boolean }[];
  extraItems?: { productId: string; quantity: number; reason: string; notes?: string }[];
  substitutions?: { assignedProductId: string; substituteProductId: string; quantity: number; reason: string; notes?: string }[];
  missingProducts?: { productName: string; reason: string; notes?: string }[];
  cashCollected: number;
  notes?: string;
  issue?: {
    issueType: string;
    priority: "critical" | "high" | "normal" | "low";
    description: string;
  };
}) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const profile = await getCurrentProfile();
    // Get route to find operator
    const { data: route } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .single();

    if (!route) throw new Error("Route not found");
    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      throw new Error("You are not authorized to complete this stop");
    }

    const { data: stop } = await supabase.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).single();
    if (!stop || stop.route_id !== routeId || stop.machine_id !== machineId) {
      throw new Error("This stop does not belong to the selected route.");
    }
    if (stop?.status === "completed") {
      throw new Error("This stop has already been completed.");
    }

    const { data: existingFillMovements } = await supabase
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .eq("to_entity_id", machineId)
      .eq("reason", "operator_bag_to_machine")
      .limit(1);

    if (existingFillMovements?.length) {
      throw new Error("This machine stop already has fill movements recorded.");
    }
    const { data: routeStockLines, error: stockError } = await supabase
      .from("route_stock_lines")
      .select("product_id, picked_qty, returned_qty")
      .eq("route_id", routeId);
    if (stockError) throw stockError;

    const { data: existingRouteFills, error: fillsError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity")
      .eq("related_route_id", routeId)
      .eq("reason", "operator_bag_to_machine");
    if (fillsError) throw fillsError;

    const filledSoFar = new Map<string, number>();
    (existingRouteFills ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledSoFar.set(productId, (filledSoFar.get(productId) ?? 0) + Number(movement.quantity ?? 0));
    });

    const actualFillLines = [
      ...filledItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...extraItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...substitutions.map((item) => ({ productId: item.substituteProductId, quantity: item.quantity })),
    ];

    const requestedFills = new Map<string, number>();
    actualFillLines.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) requestedFills.set(productId, (requestedFills.get(productId) ?? 0) + quantity);
    });

    const stockByProduct = new Map((routeStockLines ?? []).map((line: any) => [String(line.product_id), Number(line.picked_qty ?? 0) - Number(line.returned_qty ?? 0)]));
    for (const [productId, quantity] of requestedFills) {
      const available = (stockByProduct.get(productId) ?? 0) - (filledSoFar.get(productId) ?? 0);
      if (quantity > available) {
        throw new Error("Filled quantity cannot exceed the stock picked for this route.");
      }
    }

    const assignedProductIds = new Set(filledItems.map((item) => String(item.productId)));
    const fillAuditRows = [
      ...filledItems.map((item) => {
        const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
        const actualQty = Math.max(0, Number(item.quantity ?? 0));
        return {
          route_id: routeId,
          route_stop_id: stopId,
          machine_id: machineId,
          refill_order_line_id: item.refillOrderLineId || null,
          assigned_product_id: item.productId,
          product_id: item.productId,
          action_type: "assigned_fill",
          assigned_qty: assignedQty,
          actual_qty: actualQty,
          difference_qty: actualQty - assignedQty,
          reason: item.unavailable ? (item.reason || "Product not in operator bag") : item.reason || null,
          notes: item.notes || null,
          needs_review: Boolean(item.unavailable) || actualQty !== assignedQty,
          created_by: route.operator_id,
        };
      }),
      ...extraItems.map((item) => ({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        refill_order_line_id: null,
        assigned_product_id: null,
        product_id: item.productId,
        action_type: "extra_product",
        assigned_qty: 0,
        actual_qty: Math.max(0, Number(item.quantity ?? 0)),
        difference_qty: Math.max(0, Number(item.quantity ?? 0)),
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        created_by: route.operator_id,
      })),
      ...substitutions.map((item) => ({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        refill_order_line_id: null,
        assigned_product_id: item.assignedProductId,
        product_id: item.substituteProductId,
        substitute_product_id: item.substituteProductId,
        action_type: "substitution",
        assigned_qty: 0,
        actual_qty: Math.max(0, Number(item.quantity ?? 0)),
        difference_qty: Math.max(0, Number(item.quantity ?? 0)),
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        created_by: route.operator_id,
      })),
      ...missingProducts.map((item) => ({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        refill_order_line_id: null,
        assigned_product_id: null,
        product_id: null,
        action_type: "missing_product_report",
        assigned_qty: 0,
        actual_qty: 0,
        difference_qty: 0,
        reason: item.reason || "Other",
        notes: item.notes || null,
        missing_product_name: item.productName,
        needs_review: true,
        created_by: route.operator_id,
      })),
    ].filter((row) => row.action_type === "missing_product_report" || Number(row.actual_qty ?? 0) >= 0);

    const invalidExtra = extraItems.find((item) => assignedProductIds.has(String(item.productId)));
    if (invalidExtra) {
      throw new Error("Use the assigned product row instead of adding the same product as extra.");
    }

    // Create inventory movements: operator_bag -> machine
    const movements = Array.from(requestedFills.entries())
      .map((item) => ({
        product_id: item[0],
        quantity: item[1],
        from_entity_type: "operator_bag" as const,
        from_entity_id: route.operator_id,
        to_entity_type: "machine" as const,
        to_entity_id: machineId,
        reason: "operator_bag_to_machine" as const,
        related_route_id: routeId,
        related_route_stop_id: stopId,
        created_by: route.operator_id,
        notes: `Filled at machine ${machineId}`,
      }));

    if (movements.length) {
      const { error: movementError } = await supabase
        .from("inventory_movements")
        .insert(movements);

      if (movementError) throw movementError;
    }

    if (fillAuditRows.length) {
      const { error: auditError } = await supabase
        .from("route_stop_fill_lines")
        .insert(fillAuditRows);

      if (auditError) throw auditError;
    }

    const { data: refillOrders } = await supabase
      .from("refill_orders")
      .select("id")
      .eq("route_id", routeId)
      .eq("machine_id", machineId);
    const refillOrderIds = refillOrders?.map((order: any) => order.id) ?? [];

    if (refillOrderIds.length) {
      for (const item of filledItems.filter((entry) => Number(entry.quantity) >= 0)) {
        const { error: lineError } = await supabase
          .from("refill_order_lines")
          .update({ filled_qty: item.quantity })
          .eq("product_id", item.productId)
          .in("refill_order_id", refillOrderIds);

        if (lineError) throw lineError;
      }
    }

    if (refillOrderIds.length) {
      const { error: refillStatusError } = await supabase
        .from("refill_orders")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .in("id", refillOrderIds);

      if (refillStatusError) throw refillStatusError;
    }

    // Get expected cash from latest VMS sales
    const { data: sales } = await supabase
      .from("vms_sales_snapshots")
      .select("cash_sales_amount")
      .eq("machine_id", machineId)
      .order("period_end", { ascending: false })
      .limit(1);

    const expectedCash = Number(sales?.[0]?.cash_sales_amount ?? 0);
    const variance = calculateCashVariance(cashCollected, expectedCash);

    // Create cash collection record
    const { error: cashError } = await supabase
      .from("cash_collections")
      .insert({
        route_id: routeId,
        machine_id: machineId,
        operator_id: route.operator_id,
        vms_expected_cash: expectedCash,
        actual_cash_collected: cashCollected,
        review_status: getCashCollectionStatus(null, variance),
        notes,
      });

    if (cashError) throw cashError;

    if (issue?.issueType && issue.description) {
      const { error: issueError } = await supabase
        .from("issues")
        .insert({
          machine_id: machineId,
          issue_type: issue.issueType,
          priority: issue.priority,
          description: issue.description,
          reported_by: route.operator_id,
          status: "open",
        });

      if (issueError) throw issueError;
    }

    // Update stop status
    const { error: stopError } = await supabase
      .from("route_stops")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        notes,
      })
      .eq("id", stopId);

    if (stopError) throw stopError;

    return { success: true, expectedCash };
  } catch (error) {
    console.error("Error completing stop:", error);
    throw error;
  }
}

/**
 * Records leftovers and creates inventory movements
 * operator_bag -> storage
 */
export async function recordLeftovers({
  routeId,
  leftoverItems,
}: {
  routeId: string;
  leftoverItems: { productId: string; quantity: number }[];
}) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const profile = await getCurrentProfile();
    // Get route to find operator
    const { data: route } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .single();

    if (!route) throw new Error("Route not found");
    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      throw new Error("You are not authorized to return leftovers for this route");
    }
    const { data: existingLeftovers } = await supabase
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .eq("reason", "operator_bag_to_storage")
      .limit(1);

    if (existingLeftovers?.length) {
      throw new Error("Leftovers have already been recorded for this route.");
    }

    // Get storage location
    const { data: storages } = await supabase
      .from("storage_locations")
      .select("id")
      .eq("active", true)
      .limit(1);

    const storageId = storages?.[0]?.id;
    if (!storageId) throw new Error("No active storage location found");

    // Create inventory movements: operator_bag -> storage
    const leftoversByProduct = new Map<string, number>();
    leftoverItems.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) leftoversByProduct.set(productId, (leftoversByProduct.get(productId) ?? 0) + quantity);
    });

    const { data: routeStockLines, error: routeStockError } = await supabase
      .from("route_stock_lines")
      .select("id, product_id, picked_qty, returned_qty")
      .eq("route_id", routeId);
    if (routeStockError) throw routeStockError;

    const { data: filledMovements, error: filledError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity")
      .eq("related_route_id", routeId)
      .eq("reason", "operator_bag_to_machine");
    if (filledError) throw filledError;

    const filledByProduct = new Map<string, number>();
    (filledMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + Number(movement.quantity ?? 0));
    });

    const routeProductIds = new Set((routeStockLines ?? []).map((line: any) => String(line.product_id)));
    for (const productId of leftoversByProduct.keys()) {
      if (!routeProductIds.has(productId)) throw new Error("Returned product is not part of this route stock.");
    }

    for (const line of routeStockLines ?? []) {
      const productId = String(line.product_id);
      const returnQty = leftoversByProduct.get(productId) ?? 0;
      const available = Math.max(0, Number(line.picked_qty ?? 0) - (filledByProduct.get(productId) ?? 0) - Number(line.returned_qty ?? 0));
      if (returnQty > available) throw new Error("Returned quantity cannot exceed remaining operator bag stock.");
    }

    const movements = Array.from(leftoversByProduct.entries())
      .map((item) => ({
        product_id: item[0],
        quantity: item[1],
        from_entity_type: "operator_bag" as const,
        from_entity_id: route.operator_id,
        to_entity_type: "storage" as const,
        to_entity_id: storageId,
        reason: "operator_bag_to_storage" as const,
        related_route_id: routeId,
        created_by: route.operator_id,
        notes: `Leftovers returned from route ${routeId}`,
      }));

    if (movements.length > 0) {
      const { error: movementError } = await supabase
        .from("inventory_movements")
        .insert(movements);

      if (movementError) throw movementError;
    }

    for (const line of routeStockLines ?? []) {
      const productId = String(line.product_id);
      const returnQty = leftoversByProduct.get(productId) ?? 0;
      const { error: stockLineError } = await supabase
        .from("route_stock_lines")
        .update({ returned_qty: Number(line.returned_qty ?? 0) + returnQty, updated_at: new Date().toISOString() })
        .eq("id", line.id);
      if (stockLineError) throw stockLineError;
    }

    const { data: routeOrders } = await supabase
      .from("refill_orders")
      .select("id, refill_order_lines(id, product_id, picked_qty, filled_qty, returned_qty)")
      .eq("route_id", routeId);
    const linesByProduct = new Map<string, any[]>();
    routeOrders?.forEach((order: any) => {
      order.refill_order_lines?.forEach((line: any) => {
        const key = String(line.product_id);
        linesByProduct.set(key, [...(linesByProduct.get(key) ?? []), line]);
      });
    });

    if (routeOrders?.length) {
      for (const item of leftoverItems.filter((entry) => Number(entry.quantity) >= 0)) {
        let remaining = Number(item.quantity);
        const lines = linesByProduct.get(String(item.productId)) ?? [];

        for (const line of lines) {
          const available = Math.max(0, Number(line.picked_qty ?? 0) - Number(line.filled_qty ?? 0) - Number(line.returned_qty ?? 0));
          const returnedQty = Math.max(0, Math.min(remaining, available));
          remaining -= returnedQty;

          const { error: lineError } = await supabase
            .from("refill_order_lines")
            .update({ returned_qty: Number(line.returned_qty ?? 0) + returnedQty })
            .eq("id", line.id);

          if (lineError) throw lineError;
        }
      }
    }

    return { success: true };
  } catch (error) {
    console.error("Error recording leftovers:", error);
    throw error;
  }
}

/**
 * Completes entire route
 * Updates route status to completed
 */
export async function completeRoute(routeId: string) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const profile = await getCurrentProfile();
    const { data: route } = await supabase.from("routes").select("id, operator_id").eq("id", routeId).single();
    if (!route) throw new Error("Route not found");
    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      throw new Error("You are not authorized to complete this route");
    }
    const { data: openStops, error: stopsError } = await supabase
      .from("route_stops")
      .select("id")
      .eq("route_id", routeId)
      .neq("status", "completed")
      .limit(1);
    if (stopsError) throw stopsError;
    if (openStops?.length) throw new Error("Complete every machine stop before closing the route.");

    const { error } = await supabase
      .from("routes")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", routeId);

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error("Error completing route:", error);
    throw error;
  }
}

/**
 * Reports an issue with photo upload
 */
export async function reportIssue({
  machineId,
  issueType,
  priority,
  description,
  reportedBy,
}: {
  machineId: string;
  issueType: string;
  priority: "critical" | "high" | "normal" | "low";
  description: string;
  reportedBy: string;
}) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const { error } = await supabase
      .from("issues")
      .insert({
        machine_id: machineId,
        issue_type: issueType,
        priority,
        description,
        reported_by: reportedBy,
        status: "open",
      });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error("Error reporting issue:", error);
    throw error;
  }
}
