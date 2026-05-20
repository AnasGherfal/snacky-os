import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? "Unknown database error");
  }
  return "Unknown database error";
}

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
    const { data: route, error: routeError } = await supabase.from("routes").select("id, operator_id").eq("id", routeId).maybeSingle();
    if (routeError) throw routeError;
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
      { error: "Failed to fetch picked items", details: process.env.NODE_ENV === "development" ? errorMessage(error) : undefined },
      { status: 500 }
    );
  }
}
