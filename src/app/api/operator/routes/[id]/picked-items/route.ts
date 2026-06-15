import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? "Unknown database error");
  }
  return "Unknown database error";
}

function movementQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  try {
    const { data: route, error: routeError } = await supabase.from("routes").select("id, operator_id").eq("id", routeId).maybeSingle();
    if (routeError) throw routeError;
    if (!route || !canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return NextResponse.json({ error: "Route not available" }, { status: 403 });
    }

    const { data: routeMovements, error: movementError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, reason, from_entity_type, to_entity_type")
      .eq("related_route_id", routeId)
      .limit(5000);

    if (movementError) throw movementError;

    const balanceByProduct = new Map<string, number>();
    const summaryByProduct = new Map<string, { productId: string; loadedQty: number; filledQty: number; returnedQty: number; adjustmentQty: number; remainingQty: number }>();
    const summaryFor = (productId: string) => {
      const existing = summaryByProduct.get(productId);
      if (existing) return existing;
      const created = { productId, loadedQty: 0, filledQty: 0, returnedQty: 0, adjustmentQty: 0, remainingQty: 0 };
      summaryByProduct.set(productId, created);
      return created;
    };
    (routeMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id ?? "");
      const quantity = movementQuantity(movement.quantity);
      if (!productId || quantity <= 0) return;
      const summary = summaryFor(productId);
      if (movement.to_entity_type === "operator_bag" && movement.from_entity_type !== "operator_bag") {
        balanceByProduct.set(productId, (balanceByProduct.get(productId) ?? 0) + quantity);
        summary.loadedQty += quantity;
      }
      if (movement.from_entity_type === "operator_bag" && movement.to_entity_type !== "operator_bag") {
        balanceByProduct.set(productId, (balanceByProduct.get(productId) ?? 0) - quantity);
        if (movement.to_entity_type === "machine") summary.filledQty += quantity;
        else if (movement.to_entity_type === "storage") summary.returnedQty += quantity;
        else summary.adjustmentQty += quantity;
      }
    });

    const positiveBalances = Array.from(balanceByProduct.entries())
      .map(([productId, quantity]) => ({ productId, quantity: Math.max(0, quantity) }))
      .filter((item: any) => item.quantity > 0);
    const productIds = Array.from(new Set([...positiveBalances.map((item) => item.productId), ...summaryByProduct.keys()]));
    const { data: products, error: productError } = productIds.length
      ? await supabase.from("products").select("id, name").in("id", productIds)
      : { data: [], error: null };
    if (productError) throw productError;
    const productById = new Map((products ?? []).map((product: any) => [String(product.id), product.name ?? "Unknown Product"]));

    const items = positiveBalances.map((item) => ({
      productId: item.productId,
      productName: productById.get(item.productId) ?? "Unknown Product",
      quantity: item.quantity,
    }));
    const reconciliation = Array.from(summaryByProduct.values())
      .map((row) => ({
        ...row,
        productName: productById.get(row.productId) ?? "Unknown Product",
        remainingQty: Math.max(0, balanceByProduct.get(row.productId) ?? 0),
      }))
      .filter((row) => row.loadedQty > 0 || row.filledQty > 0 || row.returnedQty > 0 || row.adjustmentQty > 0 || row.remainingQty > 0)
      .sort((a, b) => a.productName.localeCompare(b.productName));

    return NextResponse.json({ items, reconciliation });
  } catch (error) {
    console.error("Error fetching picked items:", error);
    return NextResponse.json(
      { error: "Failed to fetch picked items", details: process.env.NODE_ENV === "development" ? errorMessage(error) : undefined },
      { status: 500 }
    );
  }
}
