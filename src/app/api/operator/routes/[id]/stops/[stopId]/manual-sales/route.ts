import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, getEffectivePermissions, isAdminRole } from "@/lib/authz";
import { inventoryMovementIdempotencyKey } from "@/lib/inventory-movement";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { normalizeRouteManualSale, parseRouteManualSalePaymentMethod, type RouteManualSaleRow } from "@/lib/manual-route-sales";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

type ManualSalePayload = {
  saleId?: unknown;
  productId?: unknown;
  productName?: unknown;
  quantity?: unknown;
  unitSalePriceLyd?: unknown;
  paymentMethod?: unknown;
  notes?: unknown;
  machineId?: unknown;
  clientSubmissionId?: unknown;
  cancellationReason?: unknown;
};

type RouteRow = {
  id: string;
  operator_id?: string | null;
  status?: string | null;
};

type StopRow = {
  id: string;
  route_id?: string | null;
  machine_id?: string | null;
  status?: string | null;
};

type MachineRow = {
  id: string;
  location_id?: string | null;
};

type ProductRow = {
  id: string;
  name?: string | null;
  cost_price?: number | string | null;
  current_cost_price_lyd?: number | string | null;
};

type InventoryMovementBalanceRow = {
  quantity?: unknown;
  from_entity_type?: string | null;
  to_entity_type?: string | null;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function moneyValue(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function quantityValue(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
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

function errorCode(error: unknown) {
  return String((error as { code?: unknown } | null)?.code ?? "");
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function isRouteLocked(status: string | null | undefined) {
  const normalized = clean(status).toLowerCase();
  return normalized === "completed" || normalized === "cancelled" || normalized === "canceled";
}

function responseStatusForError(error: unknown) {
  const code = errorCode(error);
  const text = errorMessage(error).toLowerCase();
  if (code === "28000" || text.includes("not authenticated") || text.includes("session")) return 401;
  if (code === "42501" || text.includes("authorized") || text.includes("permission")) return 403;
  if (["23502", "23503", "23514", "22023"].includes(code) || text.includes("required") || text.includes("invalid") || text.includes("quantity") || text.includes("price")) return 400;
  if (code === "23505" || text.includes("duplicate")) return 409;
  return 500;
}

function revalidateManualSalePaths(routeId: string, stopId: string) {
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
  revalidatePath(`/routes/${routeId}`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
}

async function loadRouteContext(routeClient: NonNullable<ReturnType<typeof getSupabaseServerClient>>, routeId: string, stopId: string) {
  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    routeClient.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    routeClient.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError) throw routeError;
  if (stopError) throw stopError;
  if (!route) throw new Error("Route not found.");
  if (!stop) throw new Error("Stop not found.");
  if (stop.route_id !== routeId) throw new Error("This stop does not belong to the route in the URL.");
  const { data: machine, error: machineError } = await routeClient.from("machines").select("id, location_id").eq("id", stop.machine_id).maybeSingle();
  if (machineError) throw machineError;
  return { route: route as RouteRow, stop: stop as StopRow, machine: (machine ?? { id: stop.machine_id, location_id: null }) as MachineRow };
}

async function loadProduct(productClient: NonNullable<ReturnType<typeof getSupabaseServerClient>>, productId: string) {
  const { data, error } = await productClient.from("products").select("id, name, cost_price, current_cost_price_lyd").eq("id", productId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Selected product was not found.");
  return data as ProductRow;
}

async function availableRouteBagQty(client: NonNullable<ReturnType<typeof getSupabaseServerClient>>, routeId: string, productId: string) {
  const { data, error } = await client
    .from("inventory_movements")
    .select("quantity, from_entity_type, to_entity_type")
    .eq("related_route_id", routeId)
    .eq("product_id", productId)
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as InventoryMovementBalanceRow[]).reduce((sum, movement) => {
    const qty = quantityValue(movement.quantity);
    if (movement.to_entity_type === "operator_bag" && movement.from_entity_type !== "operator_bag") return sum + qty;
    if (movement.from_entity_type === "operator_bag" && movement.to_entity_type !== "operator_bag") return sum - qty;
    return sum;
  }, 0);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400 });
  }

  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const routeClient = getSupabaseServerClient(accessToken);
  const writeClient = getSupabaseAdminClient() ?? routeClient;
  const requestContext = {
    route_id: routeId,
    route_stop_id: stopId,
    user_id: profile?.id ?? null,
    user_roles: profile?.roles ?? [],
    effective_permissions: profile ? getEffectivePermissions(profile) : [],
  };

  if (!accessToken || !profile) {
    return NextResponse.json({ success: false, code: "SESSION_EXPIRED", error: "Session expired. Please sign in again and retry." }, { status: 401 });
  }
  if (!routeClient || !writeClient) {
    return NextResponse.json({ success: false, code: "NO_SUPABASE", error: "Database is not available." }, { status: 500 });
  }

  let payload: ManualSalePayload;
  try {
    payload = await request.json() as ManualSalePayload;
  } catch {
    return NextResponse.json({ success: false, code: "INVALID_JSON", error: "Invalid manual sale payload." }, { status: 400 });
  }

  const productId = clean(payload.productId);
  const fallbackProductName = clean(payload.productName);
  const machineId = clean(payload.machineId);
  const quantity = quantityValue(payload.quantity);
  const unitSalePriceLyd = moneyValue(payload.unitSalePriceLyd);
  const paymentMethod = parseRouteManualSalePaymentMethod(payload.paymentMethod);
  const notes = clean(payload.notes);
  const clientSubmissionId = clean(payload.clientSubmissionId) || `manual_sale:${routeId}:${stopId}:${Date.now()}`;

  if (productId && !isUuid(productId)) {
    return NextResponse.json({ success: false, code: "INVALID_PRODUCT_ID", error: "Invalid product id." }, { status: 400 });
  }
  if (machineId && !isUuid(machineId)) {
    return NextResponse.json({ success: false, code: "INVALID_MACHINE_ID", error: "Invalid machine id." }, { status: 400 });
  }
  if (!productId && !fallbackProductName) {
    return NextResponse.json({ success: false, code: "MISSING_PRODUCT", error: "Choose a product or type a product name." }, { status: 400 });
  }
  if (quantity <= 0) {
    return NextResponse.json({ success: false, code: "INVALID_QUANTITY", error: "Quantity must be greater than 0." }, { status: 400 });
  }
  if (unitSalePriceLyd <= 0) {
    return NextResponse.json({ success: false, code: "INVALID_UNIT_PRICE", error: "Unit sale price must be greater than 0." }, { status: 400 });
  }

  try {
    const routeAccessProfile = await buildOperatorRouteAccessContext(routeClient, profile);
    const { route, stop, machine } = await loadRouteContext(routeClient, routeId, stopId);
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return NextResponse.json({ success: false, code: "UNAUTHORIZED", error: "This route is not assigned to you." }, { status: 403 });
    }
    if (machineId && stop.machine_id && machineId !== stop.machine_id) {
      return NextResponse.json({ success: false, code: "STOP_MACHINE_MISMATCH", error: "This sale does not match the selected machine." }, { status: 409 });
    }
    if (isRouteLocked(route.status) && !isAdminRole(profile)) {
      return NextResponse.json({ success: false, code: "ROUTE_LOCKED", error: "This route is completed or cancelled, so new manual sales cannot be added." }, { status: 409 });
    }

    const { data: existingSale, error: existingError } = await writeClient
      .from("route_manual_sales")
      .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, client_submission_id, inventory_movement_id, cash_collection_id, cancellation_reason, cancelled_at, cancelled_by_user_id")
      .eq("client_submission_id", clientSubmissionId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existingSale) {
      const existingSaleRow = existingSale as RouteManualSaleRow;
      return NextResponse.json({
        success: true,
        sale: normalizeRouteManualSale(existingSaleRow),
        inventoryMovementCreated: Boolean(existingSaleRow.inventory_movement_id),
      });
    }

    const product = productId ? await loadProduct(writeClient, productId) : null;
    const productName = clean(product?.name) || fallbackProductName;
    const operatorId = clean(route.operator_id) || clean(profile.team_member_id) || null;
    const totalAmountLyd = moneyValue(quantity * unitSalePriceLyd);

    const insertPayload: Record<string, unknown> = {
      route_id: routeId,
      route_stop_id: stopId,
      machine_id: stop.machine_id,
      location_id: machine.location_id ?? null,
      operator_id: operatorId,
      product_id: productId || null,
      product_name: productName,
      quantity,
      unit_sale_price_lyd: unitSalePriceLyd,
      payment_method: paymentMethod,
      notes: notes || null,
      status: "confirmed",
      client_submission_id: clientSubmissionId,
      created_by_user_id: profile.id,
    };

    const { data: insertedSale, error: insertError } = await writeClient
      .from("route_manual_sales")
      .insert(insertPayload)
      .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, client_submission_id, inventory_movement_id, cash_collection_id, cancellation_reason, cancelled_at, cancelled_by_user_id")
      .single();
    if (insertError) throw insertError;

    let warning: string | null = null;
    let inventoryMovementCreated = false;
    let saleRow = insertedSale as RouteManualSaleRow;

    if (productId && operatorId) {
      try {
        const availableQty = await availableRouteBagQty(writeClient, routeId, productId);
        if (availableQty < quantity) {
          warning = "Manual sale was saved, but operator bag stock was not reduced because available route stock is lower than the sale quantity.";
        } else {
          const unitCostLyd = moneyValue(product?.current_cost_price_lyd ?? product?.cost_price ?? 0);
          const lineTotalLyd = moneyValue(unitCostLyd * quantity);
          const idempotencyKey = inventoryMovementIdempotencyKey("route-manual-sale", routeId, stopId, saleRow.id, productId, operatorId, quantity);
          const { data: existingMovement, error: existingMovementError } = await writeClient
            .from("inventory_movements")
            .select("id")
            .eq("idempotency_key", idempotencyKey)
            .maybeSingle();
          if (existingMovementError) throw existingMovementError;
          const movementId = existingMovement?.id
            ? String(existingMovement.id)
            : await (async () => {
                const { data: createdMovement, error: movementError } = await writeClient
                  .from("inventory_movements")
                  .insert({
                    product_id: productId,
                    quantity,
                    from_entity_type: "operator_bag",
                    from_entity_id: operatorId,
                    to_entity_type: "customer",
                    to_entity_id: null,
                    reason: "manual_sale",
                    related_route_id: routeId,
                    related_route_stop_id: stopId,
                    related_machine_id: stop.machine_id,
                    unit_cost_lyd: unitCostLyd,
                    line_total_lyd: lineTotalLyd,
                    source_type: "route_manual_sale",
                    source_id: saleRow.id,
                    idempotency_key: idempotencyKey,
                    created_by: operatorId,
                    notes: `Manual route sale: ${productName}`,
                  })
                  .select("id")
                  .single();
                if (movementError) throw movementError;
                return String(createdMovement?.id ?? "");
              })();
          if (movementId) {
            inventoryMovementCreated = true;
            const { data: updatedSale, error: updateSaleError } = await writeClient
              .from("route_manual_sales")
              .update({ inventory_movement_id: movementId, updated_at: new Date().toISOString() })
              .eq("id", saleRow.id)
              .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, client_submission_id, inventory_movement_id, cash_collection_id, cancellation_reason, cancelled_at, cancelled_by_user_id")
              .single();
            if (!updateSaleError && updatedSale) saleRow = updatedSale as RouteManualSaleRow;
          }
        }
      } catch (movementError) {
        warning = "Manual sale was saved, but route inventory could not be reduced automatically.";
        console.warn("[operator:manual-route-sales] Inventory deduction skipped", {
          ...requestContext,
          sale_id: saleRow.id,
          product_id: productId,
          quantity,
          error_code: errorCode(movementError),
          error_message: errorMessage(movementError),
          error: movementError,
        });
      }
    }

    revalidateManualSalePaths(routeId, stopId);
    return NextResponse.json({
      success: true,
      sale: normalizeRouteManualSale(saleRow),
      inventoryMovementCreated,
      warning,
      totalAmountLyd,
    });
  } catch (error) {
    const status = responseStatusForError(error);
    console.error("[operator:manual-route-sales] Failed to save manual sale", {
      ...requestContext,
      product_id: productId || null,
      machine_id: machineId || null,
      quantity,
      unit_sale_price_lyd: unitSalePriceLyd,
      payment_method: paymentMethod,
      client_submission_id: clientSubmissionId,
      error_code: errorCode(error),
      error_message: errorMessage(error),
      error,
    });
    return NextResponse.json({ success: false, code: "MANUAL_SALE_SAVE_FAILED", error: errorMessage(error) || "Could not save manual sale." }, { status });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400 });
  }

  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const routeClient = getSupabaseServerClient(accessToken);
  const writeClient = getSupabaseAdminClient() ?? routeClient;
  const requestContext = {
    route_id: routeId,
    route_stop_id: stopId,
    user_id: profile?.id ?? null,
    user_roles: profile?.roles ?? [],
    effective_permissions: profile ? getEffectivePermissions(profile) : [],
  };

  if (!accessToken || !profile) {
    return NextResponse.json({ success: false, code: "SESSION_EXPIRED", error: "Session expired. Please sign in again and retry." }, { status: 401 });
  }
  if (!routeClient || !writeClient) {
    return NextResponse.json({ success: false, code: "NO_SUPABASE", error: "Database is not available." }, { status: 500 });
  }

  let payload: ManualSalePayload;
  try {
    payload = await request.json() as ManualSalePayload;
  } catch {
    return NextResponse.json({ success: false, code: "INVALID_JSON", error: "Invalid manual sale payload." }, { status: 400 });
  }

  const saleId = clean(payload.saleId);
  const cancellationReason = clean(payload.cancellationReason) || "Cancelled from route stop";
  if (!isUuid(saleId)) {
    return NextResponse.json({ success: false, code: "INVALID_SALE_ID", error: "Invalid manual sale id." }, { status: 400 });
  }

  try {
    const routeAccessProfile = await buildOperatorRouteAccessContext(routeClient, profile);
    const { route, stop } = await loadRouteContext(routeClient, routeId, stopId);
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return NextResponse.json({ success: false, code: "UNAUTHORIZED", error: "This route is not assigned to you." }, { status: 403 });
    }
    if (isRouteLocked(route.status) && !isAdminRole(profile)) {
      return NextResponse.json({ success: false, code: "ROUTE_LOCKED", error: "This route is completed or cancelled, so manual sales cannot be changed." }, { status: 409 });
    }

    const { data: existingSale, error: saleError } = await writeClient
      .from("route_manual_sales")
      .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, client_submission_id, inventory_movement_id, cash_collection_id, cancellation_reason, cancelled_at, cancelled_by_user_id")
      .eq("id", saleId)
      .eq("route_id", routeId)
      .eq("route_stop_id", stopId)
      .maybeSingle();
    if (saleError) throw saleError;
    if (!existingSale) {
      return NextResponse.json({ success: false, code: "SALE_NOT_FOUND", error: "Manual sale was not found." }, { status: 404 });
    }
    const existingSaleRow = existingSale as RouteManualSaleRow;
    if (clean(existingSaleRow.status).toLowerCase() === "cancelled") {
      return NextResponse.json({ success: true, sale: normalizeRouteManualSale(existingSale as RouteManualSaleRow), inventoryReversed: false });
    }

    const { data: cancelledSale, error: cancelError } = await writeClient
      .from("route_manual_sales")
      .update({
        status: "cancelled",
        cancellation_reason: cancellationReason,
        cancelled_at: new Date().toISOString(),
        cancelled_by_user_id: profile.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", saleId)
      .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, client_submission_id, inventory_movement_id, cash_collection_id, cancellation_reason, cancelled_at, cancelled_by_user_id")
      .single();
    if (cancelError) throw cancelError;

    let warning: string | null = null;
    let inventoryReversed = false;
    const saleRow = cancelledSale as RouteManualSaleRow;

    if (existingSaleRow.inventory_movement_id && existingSaleRow.product_id && existingSaleRow.operator_id) {
      try {
        const reversalKey = inventoryMovementIdempotencyKey("route-manual-sale-cancel", routeId, stopId, saleId);
        const { data: existingReversal, error: reversalLookupError } = await writeClient
          .from("inventory_movements")
          .select("id")
          .eq("idempotency_key", reversalKey)
          .maybeSingle();
        if (reversalLookupError) throw reversalLookupError;
        if (!existingReversal) {
          const { error: reversalError } = await writeClient
            .from("inventory_movements")
            .insert({
              product_id: existingSaleRow.product_id,
              quantity: quantityValue(existingSaleRow.quantity),
              from_entity_type: "customer",
              from_entity_id: null,
              to_entity_type: "operator_bag",
              to_entity_id: existingSaleRow.operator_id,
              reason: "manual_sale",
              related_route_id: routeId,
              related_route_stop_id: stopId,
              related_machine_id: stop.machine_id,
              source_type: "route_manual_sale_cancel",
              source_id: saleId,
              idempotency_key: reversalKey,
              created_by: clean(profile.team_member_id) || clean(existingSaleRow.operator_id) || null,
              notes: `Manual route sale cancelled: ${clean(existingSaleRow.product_name)}`,
            });
          if (reversalError) throw reversalError;
        }
        inventoryReversed = true;
      } catch (movementError) {
        warning = "Manual sale was cancelled, but route inventory could not be restored automatically.";
        console.warn("[operator:manual-route-sales] Inventory reversal skipped", {
          ...requestContext,
          sale_id: saleId,
          error_code: errorCode(movementError),
          error_message: errorMessage(movementError),
          error: movementError,
        });
      }
    }

    revalidateManualSalePaths(routeId, stopId);
    return NextResponse.json({ success: true, sale: normalizeRouteManualSale(saleRow), inventoryReversed, warning });
  } catch (error) {
    const status = responseStatusForError(error);
    console.error("[operator:manual-route-sales] Failed to cancel manual sale", {
      ...requestContext,
      sale_id: saleId,
      error_code: errorCode(error),
      error_message: errorMessage(error),
      error,
    });
    return NextResponse.json({ success: false, code: "MANUAL_SALE_CANCEL_FAILED", error: errorMessage(error) || "Could not cancel manual sale." }, { status });
  }
}
