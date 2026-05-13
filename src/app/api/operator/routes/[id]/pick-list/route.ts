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
    // Get all refill order lines for this route
    const { data, error } = await supabase
      .from("refill_orders")
      .select(
        `refill_order_lines(
          id,
          product_id,
          product(id, name),
          final_qty_to_take,
          suggested_qty
        )`
      )
      .eq("route_id", routeId);

    if (error) throw error;

    // Aggregate by product
    const itemMap = new Map<string, any>();

    data?.forEach((refillOrder: any) => {
      refillOrder.refill_order_lines?.forEach((line: any) => {
        const productId = String(line.product_id);
        const productName = line.product?.name || "Unknown Product";
        const qty = line.final_qty_to_take || line.suggested_qty || 0;

        if (itemMap.has(productId)) {
          itemMap.get(productId).final_qty_to_take += qty;
        } else {
          itemMap.set(productId, {
            product_id: productId,
            product_name: productName,
            final_qty_to_take: qty,
            suggested_qty: qty,
          });
        }
      });
    });

    const items = Array.from(itemMap.values());

    return NextResponse.json({ items });
  } catch (error) {
    console.error("Error fetching pick list:", error);
    return NextResponse.json(
      { error: "Failed to fetch pick list" },
      { status: 500 }
    );
  }
}
