import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type CreateRoutePayload = {
  routeDate?: string;
  operatorId?: string;
  machineIds?: string[];
  machineSlotIds?: string[];
  routeStock?: { productId?: string; quantity?: number; available?: number }[];
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
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
  const operatorId = String(payload.operatorId ?? "").trim();
  const manualMachineIds = Array.from(new Set((payload.machineIds ?? []).map(String).filter(Boolean)));
  const recommendationSlotIds = Array.from(new Set((payload.machineSlotIds ?? []).map(String).filter(Boolean)));
  const requestedRouteStock = (payload.routeStock ?? [])
    .map((item) => ({ productId: String(item.productId ?? "").trim(), quantity: Math.max(0, Number(item.quantity ?? 0)) }))
    .filter((item) => item.productId && item.quantity > 0);

  if (!routeDate) return jsonError("Route date is required.");
  if (!operatorId) return jsonError("Operator is required when creating an assigned route.");
  if (!manualMachineIds.length && !recommendationSlotIds.length) {
    return jsonError("Select at least one machine stop or refill recommendation.");
  }
  if (!requestedRouteStock.length) return jsonError("Choose products to take from storage for this route.");

  const recommendationsResult = recommendationSlotIds.length
    ? await supabase
        .from("refill_recommendations")
        .select("machine_id, machine_slot_id, product_id, current_qty, par_qty, suggested_qty, available_storage_qty, final_qty_to_take")
        .in("machine_slot_id", recommendationSlotIds)
    : { data: [], error: null };

  if (recommendationsResult.error) {
    console.error("[routes:create] Failed to load selected recommendations", { recommendationSlotIds, error: recommendationsResult.error });
    return jsonError("Could not load selected refill recommendations.", 500);
  }

  const recommendationRows = recommendationsResult.data ?? [];
  const recommendationMachineIds = recommendationRows.map((row: any) => row.machine_id).filter(Boolean);
  const selectedMachineIds = Array.from(new Set([...manualMachineIds, ...recommendationMachineIds]));

  if (!selectedMachineIds.length) return jsonError("No valid machines were selected for this route.");

  const storageResult = await supabase
    .from("current_inventory_by_location")
    .select("product_id, quantity_on_hand")
    .eq("location_type", "storage")
    .in("product_id", requestedRouteStock.map((item) => item.productId));

  if (storageResult.error) {
    console.error("[routes:create] Failed to verify storage inventory", { error: storageResult.error });
    return jsonError("Could not verify storage inventory.", 500);
  }

  const storageByProduct = new Map<string, number>();
  (storageResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id);
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
  });
  const stockByProduct = new Map<string, number>();
  requestedRouteStock.forEach((item) => {
    stockByProduct.set(item.productId, (stockByProduct.get(item.productId) ?? 0) + item.quantity);
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

  const routeInsert = await supabase
    .from("routes")
    .insert({ route_date: routeDate, operator_id: operatorId, status: "assigned", created_by: profile.team_member_id })
    .select("id")
    .single();

  if (routeInsert.error || !routeInsert.data?.id) {
    console.error("[routes:create] Failed to insert route", { routeDate, operatorId, error: routeInsert.error });
    return jsonError("Could not create the route. Check database permissions and try again.", 500);
  }

  const routeId = routeInsert.data.id;
  console.info("[routes:create] Route inserted", { routeId, routeDate, operatorId });
  const cleanupRoute = async () => {
    await supabase.from("refill_orders").delete().eq("route_id", routeId);
    await supabase.from("routes").delete().eq("id", routeId);
  };

  const stopsInsert = await supabase.from("route_stops").insert(
    selectedMachineIds.map((machineId, index) => ({
      route_id: routeId,
      machine_id: machineId,
      stop_order: index + 1,
    })),
  );

  if (stopsInsert.error) {
    console.error("[routes:create] Failed to insert route stops", { routeId, selectedMachineIds, error: stopsInsert.error });
    await cleanupRoute();
    return jsonError("Could not save route stops. The route was not created.", 500);
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

  if (recommendationRows.length) {
    const refillOrderInsert = await supabase
      .from("refill_orders")
      .insert(
        Array.from(new Set(recommendationMachineIds)).map((machineId) => ({
          route_id: routeId,
          machine_id: machineId,
          status: "assigned",
        })),
      )
      .select("id, machine_id");

    if (refillOrderInsert.error || !refillOrderInsert.data?.length) {
      console.error("[routes:create] Failed to insert refill orders", { routeId, recommendationMachineIds, error: refillOrderInsert.error });
      await cleanupRoute();
      return jsonError("Could not create refill orders. The route was not created.", 500);
    }

    const orderByMachine = new Map<string, string>();
    refillOrderInsert.data.forEach((order: any) => {
      orderByMachine.set(order.machine_id, order.id);
    });

    const refillLines = recommendationRows
      .map((row: any) => ({
        refill_order_id: orderByMachine.get(row.machine_id),
        machine_slot_id: row.machine_slot_id,
        product_id: row.product_id,
        current_qty_vms: row.current_qty,
        par_qty: row.par_qty,
        suggested_qty: row.suggested_qty,
        available_storage_qty: row.available_storage_qty,
        final_qty_to_take: row.final_qty_to_take,
      }))
      .filter((line: any) => Boolean(line.refill_order_id));

    if (!refillLines.length) {
      console.error("[routes:create] No refill lines matched created orders", { routeId, recommendationRows, orderIds: refillOrderInsert.data });
      await cleanupRoute();
      return jsonError("Could not match refill lines to created refill orders.", 500);
    }

    const linesInsert = await supabase.from("refill_order_lines").insert(refillLines);

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

  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);

  return NextResponse.json({ routeId });
}
