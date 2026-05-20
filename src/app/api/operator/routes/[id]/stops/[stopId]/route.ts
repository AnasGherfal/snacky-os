import { getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";

function buildDebugDetails({
  profile,
  routeId,
  stopId,
  route,
  stop,
}: {
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  routeId: string;
  stopId: string;
  route?: { operator_id?: string | null } | null;
  stop?: { route_id?: string | null } | null;
}) {
  if (process.env.NODE_ENV !== "development") return undefined;

  return {
    authUserId: profile?.id ?? null,
    matchedTeamMemberId: profile?.team_member_id ?? null,
    routeId,
    stopId,
    routeOperatorId: route?.operator_id ?? null,
    routeStopRouteId: stop?.route_id ?? null,
  };
}

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
  { params }: { params: Promise<{ id: string; stopId: string }> }
) {
  const { id: routeId, stopId } = await params;
  const supabase = getSupabaseServerClient();
  const profile = await getCurrentProfile();

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  let route: { id: string; operator_id: string | null } | null = null;
  let stop: { id: string; route_id: string; machine_id: string; stop_order: number; status: string } | null = null;

  try {
    const { data: routeRow, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .maybeSingle();
    if (routeError) throw routeError;
    route = routeRow;

    if (!route) {
      return NextResponse.json(
        {
          error: "Route not found",
          code: "ROUTE_NOT_FOUND",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 404 },
      );
    }

    const { data: stopRow, error: stopError } = await supabase
      .from("route_stops")
      .select("id, route_id, machine_id, stop_order, status")
      .eq("id", stopId)
      .maybeSingle();
    if (stopError) throw stopError;
    stop = stopRow;

    if (!stop) {
      return NextResponse.json(
        {
          error: "Stop not found",
          code: "STOP_NOT_FOUND",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 404 },
      );
    }

    if (stop.route_id !== routeId) {
      return NextResponse.json(
        {
          error: "This stop does not belong to the route in the URL.",
          code: "STOP_ROUTE_MISMATCH",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 409 },
      );
    }

    if (!canAccessOperatorRoute(profile ? { id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null, route.operator_id)) {
      return NextResponse.json(
        {
          error: "This route is not assigned to you.",
          code: "UNAUTHORIZED",
          debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
        },
        { status: 403 },
      );
    }

    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("id, name, machine_code, location:locations(id, name)")
      .eq("id", stop.machine_id)
      .maybeSingle();

    if (machineError) throw machineError;
    const location = Array.isArray((machine as any)?.location) ? (machine as any).location[0] : (machine as any)?.location;
    const locationName = location?.name || "Unknown Location";

    let { data: stopPlanItems, error: stopPlanError }: { data: any[] | null; error: any } = await supabase
      .from("route_stop_items")
      .select(
        `id,
        slot_code,
        machine_slot_id,
        product_id,
        planned_quantity,
        source,
        product:products(id, name)`
      )
      .eq("route_stop_id", stopId);

    if (stopPlanError) {
      if (!isMissingTable(stopPlanError, "route_stop_items")) throw stopPlanError;
      const fallback = await supabase
        .from("refill_orders")
        .select(
          `id,
          refill_order_lines(
            id,
            slot_code,
            machine_slot_id,
            product_id,
            final_qty_to_take,
            suggested_qty,
            source,
            product:products(id, name)
          )`
        )
        .eq("route_id", routeId)
        .eq("machine_id", stop.machine_id);
      if (fallback.error) throw fallback.error;
      stopPlanItems = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          id: line.id,
          slot_code: line.slot_code,
          machine_slot_id: line.machine_slot_id,
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
          source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
          product: line.product,
        })),
      );
    }

    // Get machine slot codes
    const { data: slots, error: slotsError } = await supabase
      .from("machine_slots")
      .select("id, slot_code, product_id")
      .eq("machine_id", stop.machine_id);
    if (slotsError) throw slotsError;

    const slotMap = new Map(slots?.map((s: any) => [s.product_id, s.slot_code]) ?? []);

    const plannedByProduct = new Map<string, any>();
    (stopPlanItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id ?? "");
      if (!productId) return;
      const product = Array.isArray(line.product) ? line.product[0] : line.product;
      const slotCode = line.slot_code || slotMap.get(line.product_id) || "VMS item";
      const assignedQty = Number(line.planned_quantity ?? 0);
      const current = plannedByProduct.get(productId) ?? {
        refillOrderLineId: null,
        routeStopItemId: line.id,
        machineSlotId: line.machine_slot_id,
        slotCodes: new Set<string>(),
        productId,
        productName: product?.name || "Unknown",
        currentQty: 0,
        assignedQty: 0,
        parQty: 0,
        filledQty: 0,
      };
      current.slotCodes.add(slotCode);
      current.assignedQty += assignedQty;
      current.parQty += assignedQty;
      plannedByProduct.set(productId, current);
    });

    const lineItems = Array.from(plannedByProduct.values()).map((line: any) => ({
      refillOrderLineId: line.refillOrderLineId,
      routeStopItemId: line.routeStopItemId,
      machineSlotId: line.machineSlotId,
      slotCode: Array.from(line.slotCodes).join(", "),
      productId: line.productId,
      productName: line.productName,
      currentQty: line.currentQty,
      assignedQty: line.assignedQty,
      parQty: line.parQty,
      filledQty: line.filledQty,
    }));

    const [{ data: pickListItems, error: pickListError }, { data: fillMovements, error: fillMovementsError }, { data: products, error: productsError }] = await Promise.all([
      supabase
        .from("route_pick_list_items")
        .select("product_id, picked_qty, product:products!route_pick_list_items_product_id_fkey(id, name), substituted_product:products!route_pick_list_items_substituted_for_product_id_fkey(id, name)")
        .eq("route_id", routeId),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity")
        .eq("related_route_id", routeId)
        .eq("reason", "operator_bag_to_machine"),
      supabase
        .from("products")
        .select("id, sku, barcode, name, category, brand, image_url")
        .eq("active", true)
        .order("name"),
    ]);
    if (pickListError && !isMissingTable(pickListError, "route_pick_list_items")) throw pickListError;
    if (fillMovementsError) throw fillMovementsError;
    if (productsError) throw productsError;

    const filledByProduct = new Map<string, number>();
    (fillMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + Number(movement.quantity ?? 0));
    });

    const pickedByProduct = new Map<string, number>();
    (pickListItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id);
      pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + Number(line.picked_qty ?? 0));
    });

    const availableByProduct = new Map<string, number>();
    pickedByProduct.forEach((pickedQty, productId) => {
      availableByProduct.set(productId, Math.max(0, pickedQty - (filledByProduct.get(productId) ?? 0)));
    });

    lineItems.forEach((item: any) => {
      item.availableQty = availableByProduct.get(String(item.productId)) ?? 0;
    });

    const refillItems = lineItems;
    const productOptions = (products ?? []).map((product: any) => ({
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      category: product.category,
      brand: product.brand,
      imageUrl: product.image_url,
      availableQty: availableByProduct.get(String(product.id)) ?? 0,
    }));

    return NextResponse.json({
      stopId,
      routeId,
      machineId: stop.machine_id,
      machineName: machine?.name ?? "Unknown machine",
      machineCode: machine?.machine_code ?? "-",
      location: locationName,
      refillItems,
      productOptions,
      debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
    });
  } catch (error) {
    console.error("Error fetching stop data:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch stop data",
        details: process.env.NODE_ENV === "development" ? errorMessage(error) : undefined,
        debug: buildDebugDetails({ profile, routeId, stopId, route, stop }),
      },
      { status: 500 }
    );
  }
}
