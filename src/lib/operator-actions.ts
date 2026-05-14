"use server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { calculateCashVariance, getCashCollectionStatus } from "@/lib/cash-collections";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

/**
 * Creates inventory movements from storage to operator bag
 * Called when operator confirms pick list
 */
export async function confirmPickList(routeId: string, pickedItems: { productId: string; quantity: number }[]) {
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
    const pickedByProduct = new Map<string, number>();
    pickedItems.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
    });

    const { data: routeStockLines, error: routeStockError } = await supabase
      .from("route_stock_lines")
      .select("id, product_id, planned_qty")
      .eq("route_id", routeId);

    if (routeStockError) throw routeStockError;
    if (!routeStockLines?.length) throw new Error("This route has no planned stock to pick.");

    const plannedByProduct = new Map((routeStockLines ?? []).map((line: any) => [String(line.product_id), Number(line.planned_qty ?? 0)]));
    for (const [productId, quantity] of pickedByProduct) {
      if (quantity > (plannedByProduct.get(productId) ?? 0)) {
        throw new Error("Picked quantity cannot exceed the planned route stock.");
      }
    }

    // Get storage location ID (for now assume there's a default storage)
    const { data: storages } = await supabase
      .from("storage_locations")
      .select("id")
      .eq("active", true)
      .limit(1);

    const storageId = storages?.[0]?.id;
    if (!storageId) throw new Error("No active storage location found");

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

    for (const line of routeStockLines ?? []) {
      const { error: stockLineError } = await supabase
        .from("route_stock_lines")
        .update({ picked_qty: pickedByProduct.get(String(line.product_id)) ?? 0, updated_at: new Date().toISOString() })
        .eq("id", line.id);

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
  cashCollected,
  notes,
  issue,
}: {
  stopId: string;
  routeId: string;
  machineId: string;
  filledItems: { productId: string; quantity: number }[];
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

    const { data: stop } = await supabase.from("route_stops").select("id, status").eq("id", stopId).single();
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

    const requestedFills = new Map<string, number>();
    filledItems.forEach((item) => {
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
        created_by: route.operator_id,
        notes: `Filled at machine ${machineId}`,
      }));

    if (movements.length) {
      const { error: movementError } = await supabase
        .from("inventory_movements")
        .insert(movements);

      if (movementError) throw movementError;
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
