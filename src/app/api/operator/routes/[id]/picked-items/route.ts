import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  try {
    // Get all refill order lines for this route to determine what was picked
    const { data, error } = await supabase
      .from("refill_orders")
      .select(
        `refill_order_lines(
          id,
          product_id,
          product(id, name),
          final_qty_to_take,
          suggested_qty,
          filled_qty
        )`
      )
      .eq("route_id", routeId);

    if (error) throw error;

    // Aggregate by product - sum of all suggested/final_qty_to_take items
    const itemMap = new Map<string, any>();

    data?.forEach((refillOrder: any) => {
      refillOrder.refill_order_lines?.forEach((line: any) => {
        const productId = String(line.product_id);
        const productName = line.product?.name || "Unknown Product";
        // Use filled_qty if available, otherwise use final_qty_to_take or suggested_qty
        const qty = line.filled_qty || line.final_qty_to_take || line.suggested_qty || 0;

        if (itemMap.has(productId)) {
          itemMap.get(productId).quantity += qty;
        } else {
          itemMap.set(productId, {
            productId,
            productName,
            quantity: qty,
          });
        }
      });
    });

    const items = Array.from(itemMap.values()).filter((item) => item.quantity > 0);

    return NextResponse.json({ items });
  } catch (error) {
    console.error("Error fetching picked items:", error);
    return NextResponse.json(
      { error: "Failed to fetch picked items" },
      { status: 500 }
    );
  }
}
