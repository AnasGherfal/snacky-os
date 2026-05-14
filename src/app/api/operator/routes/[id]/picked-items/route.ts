import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
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

    const [{ data: stockLines, error: stockError }, { data: fillMovements, error: fillError }] = await Promise.all([
      supabase
        .from("route_stock_lines")
        .select(`id, product_id, picked_qty, returned_qty, product:products(id, name)`)
        .eq("route_id", routeId),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity")
        .eq("related_route_id", routeId)
        .eq("reason", "operator_bag_to_machine"),
    ]);

    if (stockError) throw stockError;
    if (fillError) throw fillError;

    const filledByProduct = new Map<string, number>();
    (fillMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + Number(movement.quantity ?? 0));
    });

    const items = (stockLines ?? [])
      .map((line: any) => ({
        productId: line.product_id,
        productName: line.product?.name || "Unknown Product",
        quantity: Math.max(0, Number(line.picked_qty ?? 0) - (filledByProduct.get(String(line.product_id)) ?? 0) - Number(line.returned_qty ?? 0)),
      }))
      .filter((item: any) => item.quantity > 0);

    return NextResponse.json({ items });
  } catch (error) {
    console.error("Error fetching picked items:", error);
    return NextResponse.json(
      { error: "Failed to fetch picked items" },
      { status: 500 }
    );
  }
}
