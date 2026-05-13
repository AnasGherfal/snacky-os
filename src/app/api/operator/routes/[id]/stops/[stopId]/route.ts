import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> }
) {
  const { id: routeId, stopId } = await params;
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  try {
    // Get the route stop
    const { data: stop, error: stopError } = await supabase
      .from("route_stops")
      .select(
        `id, machine_id, machine(id, name, machine_code, location_id, locations(id, name))`
      )
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
      .single();

    if (refillError || !refillOrder) {
      return NextResponse.json(
        { error: "Refill order not found" },
        { status: 404 }
      );
    }

    // Get machine slot codes
    const { data: slots } = await supabase
      .from("machine_slots")
      .select("id, slot_code, product_id")
      .eq("machine_id", stop.machine_id);

    const slotMap = new Map(slots?.map((s: any) => [s.product_id, s.slot_code]) ?? []);

    const refillItems = refillOrder.refill_order_lines?.map((line: any) => ({
      machineSlotId: line.machine_slot_id,
      slotCode: slotMap.get(line.product_id) || "Unknown",
      productId: line.product_id,
      productName: line.product?.name || "Unknown",
      currentQty: line.current_qty_vms || 0,
      parQty: line.par_qty || 0,
      filledQty: 0,
    })) ?? [];

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
