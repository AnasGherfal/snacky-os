import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

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

  if (!routeId) {
    return NextResponse.json({ error: "Route id is required" }, { status: 400 });
  }

  try {
    const { data: route, error: routeError } = await supabase.from("routes").select("id, operator_id").eq("id", routeId).maybeSingle();
    if (routeError) throw routeError;
    if (!route) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }
    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      return NextResponse.json({ error: "This route is not assigned to you" }, { status: 403 });
    }

    let { data: stopItems, error: stopItemsError }: { data: any[] | null; error: any } = await supabase
      .from("route_stop_items")
      .select(
        `id,
        route_stop_id,
        machine_id,
        machine:machines(id, name, machine_code),
        product_id,
        planned_quantity,
        source,
        product:products(id, name, sku)`
      )
      .eq("route_id", routeId);

    if (stopItemsError) {
      if (!isMissingTable(stopItemsError, "route_stop_items")) throw stopItemsError;
      const fallback = await supabase
        .from("refill_orders")
        .select(
          `id,
          machine_id,
          machine:machines(id, name, machine_code),
          refill_order_lines(
            id,
            machine_slot_id,
            product_id,
            final_qty_to_take,
            suggested_qty,
            source,
            product:products(id, name, sku)
          )`
        )
        .eq("route_id", routeId);
      if (fallback.error) throw fallback.error;
      stopItems = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          id: line.id,
          route_stop_id: null,
          machine_id: order.machine_id,
          machine: order.machine,
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
          source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
          product: line.product,
        })),
      );
    }

    const plannedByProduct = new Map<string, any>();
    (stopItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id);
      const plannedQty = Math.max(0, Number(line.planned_quantity ?? 0));
      if (!productId || plannedQty <= 0) return;
      const machine = Array.isArray(line.machine) ? line.machine[0] : line.machine;
      const product = Array.isArray(line.product) ? line.product[0] : line.product;
      const current = plannedByProduct.get(productId) ?? {
        product_id: productId,
        product_name: product?.name || "Unknown Product",
        sku: product?.sku ?? null,
        planned_qty: 0,
        machine_items: [],
      };
      current.planned_qty += plannedQty;
      current.machine_items.push({
        route_stop_id: line.route_stop_id,
        machine_id: line.machine_id,
        machine_name: machine?.name ?? "Unknown machine",
        machine_code: machine?.machine_code ?? "-",
        planned_qty: plannedQty,
        source: line.source ?? "manual_admin_assignment",
      });
      plannedByProduct.set(productId, current);
    });

    const productIds = Array.from(plannedByProduct.keys());
    const [storageResult, productOptionsResult] = await Promise.all([
      productIds.length
      ? supabase
          .from("current_inventory_by_location")
          .select("product_id, quantity_on_hand")
          .eq("location_type", "storage")
          .in("product_id", productIds)
      : Promise.resolve({ data: [], error: null }),
      supabase.from("products").select("id, sku, barcode, name, category, brand, image_url").eq("active", true).order("name"),
    ]);

    if (storageResult.error) throw storageResult.error;
    if (productOptionsResult.error) throw productOptionsResult.error;

    const storageByProduct = new Map<string, number>();
    (storageResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id);
      storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
    });

    const { data: pickListItems, error: pickListError } = productIds.length
      ? await supabase.from("route_pick_list_items").select("product_id, picked_qty").eq("route_id", routeId).in("product_id", productIds)
      : { data: [], error: null };
    if (pickListError && !isMissingTable(pickListError, "route_pick_list_items")) throw pickListError;
    const pickedByProduct = new Map<string, number>();
    (pickListItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id);
      pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + Number(line.picked_qty ?? 0));
    });

    const { data: pickMovements, error: pickMovementError } = await supabase
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .eq("reason", "storage_to_operator_bag")
      .limit(1);
    if (pickMovementError) throw pickMovementError;
    const confirmed = Boolean(pickMovements?.length);

    const items = Array.from(plannedByProduct.values()).map((line: any) => ({
      product_id: line.product_id,
      product_name: line.product_name,
      sku: line.sku ?? null,
      planned_qty: Number(line.planned_qty ?? 0),
      picked_qty: pickedByProduct.has(String(line.product_id)) ? pickedByProduct.get(String(line.product_id)) : null,
      available_storage_qty: storageByProduct.get(String(line.product_id)) ?? 0,
      machine_items: line.machine_items,
    }));

    const allProductIds = (productOptionsResult.data ?? []).map((product: any) => product.id);
    const optionStorageResult = allProductIds.length
      ? await supabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage").in("product_id", allProductIds)
      : { data: [], error: null };
    if (optionStorageResult.error) throw optionStorageResult.error;
    const optionStorageByProduct = new Map<string, number>();
    (optionStorageResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id);
      optionStorageByProduct.set(productId, (optionStorageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
    });
    const productOptions = (productOptionsResult.data ?? []).map((product: any) => ({
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      category: product.category,
      brand: product.brand,
      imageUrl: product.image_url,
      availableStorageQty: optionStorageByProduct.get(String(product.id)) ?? 0,
    }));

    return NextResponse.json({
      items,
      productOptions,
      confirmed,
      debug: process.env.NODE_ENV === "development"
        ? { routeId, routeStopItemsCount: stopItems?.length ?? 0, aggregatedPickListCount: items.length, routePickListItemsCount: pickListItems?.length ?? 0, operatorTeamMemberId: profile?.team_member_id ?? null }
        : undefined,
    });
  } catch (error) {
    console.error("Error fetching pick list:", error);
    return NextResponse.json(
      { error: "Failed to fetch pick list", details: errorMessage(error) },
      { status: 500 }
    );
  }
}
