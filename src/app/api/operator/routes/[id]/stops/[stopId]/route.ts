import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> }
) {
  const { id: routeId, stopId } = await params;
  const supabase = getSupabaseServerClient();
  const profile = await getCurrentProfile();

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  try {
    const { data: route } = await supabase.from("routes").select("id, operator_id").eq("id", routeId).single();
    if (!route || !canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      return NextResponse.json({ error: "Route not available" }, { status: 403 });
    }

    // Get the route stop
    const { data: stop, error: stopError } = await supabase
      .from("route_stops")
      .select(
        `id, machine_id, machine(id, name, machine_code, location_id, locations(id, name))`
      )
      .eq("route_id", routeId)
      .eq("id", stopId)
      .single();

    if (stopError || !stop) {
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    }

    const machine = stop.machine as any;
    const locations = machine?.locations as any[];
    const location = locations?.[0];
    const locationName = location?.name || "Unknown Location";

    // Get refill order for this machine on this route
    const { data: refillOrder, error: refillError } = await supabase
      .from("refill_orders")
      .select(
        `id, refill_order_lines(
          id,
          machine_slot_id,
          product_id,
          product(id, name),
          current_qty_vms,
          par_qty,
          final_qty_to_take,
          suggested_qty
        )`
      )
      .eq("route_id", routeId)
      .eq("machine_id", stop.machine_id)
      .maybeSingle();

    if (refillError) throw refillError;

    // Get machine slot codes
    const { data: slots } = await supabase
      .from("machine_slots")
      .select("id, slot_code, product_id")
      .eq("machine_id", stop.machine_id);

    const slotMap = new Map(slots?.map((s: any) => [s.product_id, s.slot_code]) ?? []);

    const lineItems = refillOrder?.refill_order_lines?.map((line: any) => ({
      machineSlotId: line.machine_slot_id,
      slotCode: slotMap.get(line.product_id) || "Unknown",
      productId: line.product_id,
      productName: line.product?.name || "Unknown",
      currentQty: line.current_qty_vms || 0,
      parQty: line.final_qty_to_take || line.suggested_qty || line.par_qty || 0,
      filledQty: 0,
    })) ?? [];

    const [{ data: routeStockLines }, { data: fillMovements }] = await Promise.all([
      supabase
        .from("route_stock_lines")
        .select("product_id, picked_qty, returned_qty, product:products(id, name)")
        .eq("route_id", routeId),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity")
        .eq("related_route_id", routeId)
        .eq("reason", "operator_bag_to_machine"),
    ]);

    const filledByProduct = new Map<string, number>();
    (fillMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + Number(movement.quantity ?? 0));
    });

    const itemByProduct = new Map(lineItems.map((item: any) => [String(item.productId), item]));
    (routeStockLines ?? []).forEach((line: any) => {
      const productId = String(line.product_id);
      const availableQty = Math.max(0, Number(line.picked_qty ?? 0) - Number(line.returned_qty ?? 0) - (filledByProduct.get(productId) ?? 0));
      if (itemByProduct.has(productId)) {
        const item = itemByProduct.get(productId);
        item.availableQty = availableQty;
        return;
      }
      if (availableQty > 0) {
        itemByProduct.set(productId, {
          machineSlotId: null,
          slotCode: "Route stock",
          productId,
          productName: line.product?.name || "Unknown",
          currentQty: 0,
          parQty: availableQty,
          availableQty,
          filledQty: 0,
        });
      }
    });

    const refillItems = Array.from(itemByProduct.values());

    return NextResponse.json({
      stopId,
      routeId,
      machineId: stop.machine_id,
      machineName: machine?.name,
      machineCode: machine?.machine_code,
      location: locationName,
      refillItems,
    });
  } catch (error) {
    console.error("Error fetching stop data:", error);
    return NextResponse.json(
      { error: "Failed to fetch stop data" },
      { status: 500 }
    );
  }
}
