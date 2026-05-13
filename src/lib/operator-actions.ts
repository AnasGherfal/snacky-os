"use server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { calculateCashVariance, getCashCollectionStatus } from "@/lib/cash-collections";

/**
 * Creates inventory movements from storage to operator bag
 * Called when operator confirms pick list
 */
export async function confirmPickList(routeId: string, pickedItems: { productId: string; quantity: number }[]) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    // Get route details
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .single();

    if (routeError || !route) throw new Error("Route not found");

    // Get storage location ID (for now assume there's a default storage)
    const { data: storages } = await supabase
      .from("storage_locations")
      .select("id")
      .eq("active", true)
      .limit(1);

    const storageId = storages?.[0]?.id;
    if (!storageId) throw new Error("No active storage location found");

    // Create inventory movements for each picked item
    const movements = pickedItems.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
      from_entity_type: "storage" as const,
      from_entity_id: storageId,
      to_entity_type: "operator_bag" as const,
      to_entity_id: route.operator_id,
      reason: "storage_to_operator_bag" as const,
      related_route_id: routeId,
      created_by: route.operator_id,
      notes: `Picked for route ${routeId}`,
    }));

    const { error: movementError } = await supabase
      .from("inventory_movements")
      .insert(movements);

    if (movementError) throw movementError;

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
}: {
  stopId: string;
  routeId: string;
  machineId: string;
  filledItems: { productId: string; quantity: number }[];
  cashCollected: number;
  notes?: string;
}) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    // Get route to find operator
    const { data: route } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .single();

    if (!route) throw new Error("Route not found");

    // Create inventory movements: operator_bag -> machine
    const movements = filledItems.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
      from_entity_type: "operator_bag" as const,
      from_entity_id: route.operator_id,
      to_entity_type: "machine" as const,
      to_entity_id: machineId,
      reason: "operator_bag_to_machine" as const,
      related_route_id: routeId,
      created_by: route.operator_id,
      notes: `Filled at machine ${machineId}`,
    }));

    const { error: movementError } = await supabase
      .from("inventory_movements")
      .insert(movements);

    if (movementError) throw movementError;

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

    // Update stop status
    const { error: stopError } = await supabase
      .from("route_stops")
      .update({
        status: "cash_collected",
        completed_at: new Date().toISOString(),
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
    // Get route to find operator
    const { data: route } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .single();

    if (!route) throw new Error("Route not found");

    // Get storage location
    const { data: storages } = await supabase
      .from("storage_locations")
      .select("id")
      .eq("active", true)
      .limit(1);

    const storageId = storages?.[0]?.id;
    if (!storageId) throw new Error("No active storage location found");

    // Create inventory movements: operator_bag -> storage
    const movements = leftoverItems.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
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
