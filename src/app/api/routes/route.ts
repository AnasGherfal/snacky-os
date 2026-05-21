import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type CreateRoutePayload = {
  routeDate?: string;
  assignmentMode?: "assigned" | "unassigned";
  operatorId?: string;
  machineIds?: string[];
  recommendationKeys?: string[];
  machineSlotIds?: string[];
  routeStock?: { productId?: string; quantity?: number; available?: number }[];
  manualStopItems?: { machineId?: string; productId?: string; quantity?: number }[];
  adminOverride?: boolean;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isMissingRouteStopItems(error: any) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes("route_stop_items");
}

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes/new")) {
    return jsonError("You are not authorized to create routes.", 403);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) return jsonError("Supabase is not configured.", 500);

  let payload: CreateRoutePayload;

  try {
    payload = await request.json();
  } catch {
    return jsonError("Invalid route request.");
  }

  const routeDate = String(payload.routeDate ?? "").trim();
  const assignmentMode = payload.assignmentMode === "assigned" ? "assigned" : "unassigned";
  const operatorId = assignmentMode === "assigned" ? String(payload.operatorId ?? "").trim() : "";
  const manualMachineIds = Array.from(new Set((payload.machineIds ?? []).map(String).filter(Boolean)));
  const recommendationKeys = Array.from(new Set((payload.recommendationKeys ?? []).map(String).filter(Boolean)));
  const legacyRecommendationSlotIds = Array.from(new Set((payload.machineSlotIds ?? []).map(String).filter(Boolean)));
  const adminOverride = Boolean(payload.adminOverride);
  const manualStopItems = (payload.manualStopItems ?? [])
    .map((item) => ({
      machineId: String(item.machineId ?? "").trim(),
      productId: String(item.productId ?? "").trim(),
      quantity: Math.max(0, Number(item.quantity ?? 0)),
    }))
    .filter((item) => item.machineId && item.productId && item.quantity > 0);

  if (!routeDate) return jsonError("Route date is required.");
  if (assignmentMode === "assigned" && !operatorId) return jsonError("Choose a route performer or leave this route unassigned.");
  if (adminOverride && !isOwnerAdminRole(profile.role)) return jsonError("Only owner or admin can override storage availability.", 403);
  if (!recommendationKeys.length && !legacyRecommendationSlotIds.length && !manualStopItems.length) return jsonError("Choose machine-level refill items for this route.");

  const recommendationsResult = recommendationKeys.length
    ? await supabase
        .from("refill_recommendations")
        .select("recommendation_key, machine_id, machine_slot_id, slot_code, product_id, current_qty, par_qty, suggested_qty, available_storage_qty, final_qty_to_take")
        .in("recommendation_key", recommendationKeys)
    : legacyRecommendationSlotIds.length
      ? await supabase
          .from("refill_recommendations")
          .select("recommendation_key, machine_id, machine_slot_id, slot_code, product_id, current_qty, par_qty, suggested_qty, available_storage_qty, final_qty_to_take")
          .in("machine_slot_id", legacyRecommendationSlotIds)
    : { data: [], error: null };

  if (recommendationsResult.error) {
    console.error("[routes:create] Failed to load selected recommendations", { recommendationKeys, legacyRecommendationSlotIds, error: recommendationsResult.error });
    return jsonError("Could not load selected refill recommendations.", 500);
  }

  const recommendationRows = recommendationsResult.data ?? [];
  const actionableRecommendationRows = recommendationRows.filter((row: any) => Math.max(0, Number(row.final_qty_to_take ?? row.suggested_qty ?? 0)) > 0);
  const recommendationMachineIds = actionableRecommendationRows.map((row: any) => row.machine_id).filter(Boolean);
  const selectedMachineIds = Array.from(new Set([...manualMachineIds, ...recommendationMachineIds, ...manualStopItems.map((item) => item.machineId)]));
  const stockByProduct = new Map<string, number>();
  actionableRecommendationRows.forEach((row: any) => {
    const productId = String(row.product_id);
    const quantity = Math.max(0, Number(row.final_qty_to_take ?? row.suggested_qty ?? 0));
    if (productId && quantity > 0) stockByProduct.set(productId, (stockByProduct.get(productId) ?? 0) + quantity);
  });
  manualStopItems.forEach((item) => {
    stockByProduct.set(item.productId, (stockByProduct.get(item.productId) ?? 0) + item.quantity);
  });
  if (recommendationRows.length && !actionableRecommendationRows.length && !manualStopItems.length) {
    return jsonError("Enter planned quantities for capacity-missing VMS rows before creating a route.");
  }
  if (!stockByProduct.size) return jsonError("Planned machine refill quantities must be greater than zero.");

  if (!adminOverride) {
    const storageResult = await supabase
      .from("current_inventory_by_location")
      .select("product_id, quantity_on_hand")
      .eq("location_type", "storage")
      .in("product_id", Array.from(stockByProduct.keys()));

    if (storageResult.error) {
      console.error("[routes:create] Failed to verify storage inventory", { error: storageResult.error });
      return jsonError("Could not verify storage inventory.", 500);
    }

    const storageByProduct = new Map<string, number>();
    (storageResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id);
      storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
    });

    const reservedResult = await supabase
      .from("route_stock_lines")
      .select("product_id, planned_qty, picked_qty, routes!inner(status)")
      .in("product_id", Array.from(stockByProduct.keys()))
      .in("routes.status", ["draft", "assigned"]);

    if (reservedResult.error) {
      console.error("[routes:create] Failed to verify reserved route stock", { error: reservedResult.error });
      return jsonError("Could not verify existing route reservations.", 500);
    }

    const reservedByProduct = new Map<string, number>();
    (reservedResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id);
      const reserved = Math.max(0, Number(row.planned_qty ?? 0) - Number(row.picked_qty ?? 0));
      reservedByProduct.set(productId, (reservedByProduct.get(productId) ?? 0) + reserved);
    });

    for (const [productId, quantity] of stockByProduct) {
      const available = Math.max(0, (storageByProduct.get(productId) ?? 0) - (reservedByProduct.get(productId) ?? 0));
      if (quantity > available) {
        return jsonError("One or more selected products exceeds available storage stock.");
      }
    }
  }

  if (operatorId) {
    const { data: performer, error: performerError } = await supabase
      .from("team_members")
      .select("id, role, active")
      .eq("id", operatorId)
      .maybeSingle();
    if (performerError) {
      console.error("[routes:create] Failed to verify selected performer", { operatorId, error: performerError });
      return jsonError("Could not verify the selected route performer.", 500);
    }
    if (!performer || performer.active === false || !["owner", "admin", "supervisor", "operator"].includes(String(performer.role))) {
      return jsonError("Selected route performer must be an active owner, admin, supervisor, or operator.");
    }
  }

  const routeStatus = operatorId ? "assigned" : "draft";
  const routeInsert = await supabase
    .from("routes")
    .insert({ route_date: routeDate, operator_id: operatorId || null, status: routeStatus, created_by: profile.team_member_id })
    .select("id")
    .single();

  if (routeInsert.error || !routeInsert.data?.id) {
    console.error("[routes:create] Failed to insert route", { routeDate, operatorId, error: routeInsert.error });
    return jsonError("Could not create the route. Check database permissions and try again.", 500);
  }

  const routeId = routeInsert.data.id;
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
    stopsInsert.data.forEach((stop: any) => stopByMachine.set(stop.machine_id, stop.id));
  }

  const routeStockInsert = await supabase.from("route_stock_lines").insert(
    Array.from(stockByProduct.entries()).map(([productId, quantity]) => ({
      route_id: routeId,
      product_id: productId,
      planned_qty: quantity,
    })),
  );

  if (routeStockInsert.error) {
    console.error("[routes:create] Failed to insert route stock lines", { routeId, error: routeStockInsert.error });
    await cleanupRoute();
    return jsonError("Could not save route stock. The route was not created.", 500);
  }

  const routeStopItems = [
    ...actionableRecommendationRows.map((row: any) => ({
      route_id: routeId,
      route_stop_id: stopByMachine.get(row.machine_id),
      machine_id: row.machine_id,
      product_id: row.product_id,
      machine_slot_id: row.machine_slot_id,
      slot_code: row.slot_code ?? null,
      planned_quantity: Math.max(0, Number(row.final_qty_to_take ?? row.suggested_qty ?? 0)),
      picked_quantity: null,
      filled_quantity: null,
      returned_quantity: null,
      source: "refill_recommendation",
    })),
    ...manualStopItems.map((item) => ({
      route_id: routeId,
      route_stop_id: stopByMachine.get(item.machineId),
      machine_id: item.machineId,
      product_id: item.productId,
      machine_slot_id: null,
      slot_code: null,
      planned_quantity: item.quantity,
      picked_quantity: null,
      filled_quantity: null,
      returned_quantity: null,
      source: "manual_admin_assignment",
    })),
  ].filter((item: any) => item.route_stop_id && item.product_id && item.planned_quantity > 0);

  if (routeStopItems.length) {
    const stopItemsInsert = await supabase.from("route_stop_items").insert(routeStopItems);
    if (stopItemsInsert.error) {
      console.error("[routes:create] Failed to insert route stop items", { routeId, error: stopItemsInsert.error });
      if (!isMissingRouteStopItems(stopItemsInsert.error)) {
        await cleanupRoute();
        return jsonError("Could not save machine-level planned items. The route was not created.", 500);
      }
      console.warn("[routes:create] route_stop_items table is missing; continuing with refill_order_lines fallback", { routeId });
    }
  }

  if (actionableRecommendationRows.length || manualStopItems.length) {
    const refillMachineIds = Array.from(new Set([...recommendationMachineIds, ...manualStopItems.map((item) => item.machineId)]));
    const refillOrderInsert = await supabase
      .from("refill_orders")
      .insert(
        refillMachineIds.map((machineId) => ({
          route_id: routeId,
          machine_id: machineId,
          status: routeStatus,
        })),
      )
      .select("id, machine_id");

    if (refillOrderInsert.error || !refillOrderInsert.data?.length) {
      console.error("[routes:create] Failed to insert refill orders", { routeId, refillMachineIds, error: refillOrderInsert.error });
      await cleanupRoute();
      return jsonError("Could not create refill orders. The route was not created.", 500);
    }

    const orderByMachine = new Map<string, string>();
    refillOrderInsert.data.forEach((order: any) => {
      orderByMachine.set(order.machine_id, order.id);
    });

    const recommendationLines = actionableRecommendationRows
      .map((row: any) => ({
        refill_order_id: orderByMachine.get(row.machine_id),
        machine_slot_id: row.machine_slot_id,
        slot_code: row.slot_code ?? null,
        product_id: row.product_id,
        current_qty_vms: row.current_qty,
        par_qty: row.par_qty,
        suggested_qty: row.suggested_qty,
        available_storage_qty: row.available_storage_qty,
        final_qty_to_take: row.final_qty_to_take,
        source: "refill_recommendation",
      }))
      .filter((line: any) => Boolean(line.refill_order_id));
    const manualLines = manualStopItems
      .map((item) => ({
        refill_order_id: orderByMachine.get(item.machineId),
        machine_slot_id: null,
        slot_code: null,
        product_id: item.productId,
        current_qty_vms: 0,
        par_qty: item.quantity,
        suggested_qty: item.quantity,
        available_storage_qty: stockByProduct.get(item.productId) ?? 0,
        final_qty_to_take: item.quantity,
        source: "manual_admin_assignment",
      }))
      .filter((line: any) => Boolean(line.refill_order_id));
    const refillLines = [...recommendationLines, ...manualLines];

    if (!refillLines.length) {
      console.error("[routes:create] No refill lines matched created orders", { routeId, recommendationRows: actionableRecommendationRows, orderIds: refillOrderInsert.data });
      await cleanupRoute();
      return jsonError("Could not match refill lines to created refill orders.", 500);
    }

    let linesInsert = await supabase.from("refill_order_lines").insert(refillLines);
    if (linesInsert.error?.code === "42703" && linesInsert.error.message?.includes("source")) {
      linesInsert = await supabase.from("refill_order_lines").insert(refillLines.map(({ source, ...line }: any) => line));
    }

    if (linesInsert.error) {
      console.error("[routes:create] Failed to insert refill order lines", { routeId, error: linesInsert.error });
      await cleanupRoute();
      return jsonError("Could not save refill order lines. The route was not created.", 500);
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
      manual_stop_item_count: manualStopItems.length,
      admin_override: adminOverride,
      assignment_mode: assignmentMode,
    },
    summary: operatorId
      ? `Created assigned route for ${routeDate} with ${selectedMachineIds.length} stops`
      : `Created available route for ${routeDate} with ${selectedMachineIds.length} stops`,
  });

  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);

  return NextResponse.json({ routeId });
}

// TODO: Add update_route activity logging when Snacky OS gets a route edit/update endpoint.
