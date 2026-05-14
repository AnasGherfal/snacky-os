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

    const { data, error } = await supabase
      .from("route_stock_lines")
      .select(
        `id,
        product_id,
        planned_qty,
        picked_qty,
        product:products(id, name)`
      )
      .eq("route_id", routeId);

    if (error) throw error;

    const items = (data ?? []).map((line: any) => ({
      product_id: line.product_id,
      product_name: line.product?.name || "Unknown Product",
      planned_qty: Number(line.planned_qty ?? 0),
      picked_qty: Number(line.picked_qty ?? 0),
      final_qty_to_take: Number(line.planned_qty ?? 0),
      suggested_qty: Number(line.planned_qty ?? 0),
    }));

    return NextResponse.json({ items });
  } catch (error) {
    console.error("Error fetching pick list:", error);
    return NextResponse.json(
      { error: "Failed to fetch pick list" },
      { status: 500 }
    );
  }
}
