import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, getEffectivePermissions } from "@/lib/authz";
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

function responseStatusForError(error: unknown) {
  const code = errorCode(error);
  const text = errorMessage(error).toLowerCase();
  if (code === "28000" || text.includes("not authenticated") || text.includes("session")) return 401;
  if (code === "42501" || text.includes("authorized") || text.includes("permission")) return 403;
  if (code === "INVENTORY_MOVEMENT_RECOVERY_CONFLICT") return 409;
  if (code === "23514" && (text.includes("review") || text.includes("closed") || text.includes("terminal"))) return 409;
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
  revalidatePath("/sales");
  revalidatePath("/reports");
  revalidatePath("/reports/route-product-activity");
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
  if (!routeClient) {
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
  const clientSubmissionId = clean(payload.clientSubmissionId);

  if (productId && !isUuid(productId)) {
    return NextResponse.json({ success: false, code: "INVALID_PRODUCT_ID", error: "Invalid product id." }, { status: 400 });
  }
  if (!isUuid(machineId)) {
    return NextResponse.json({ success: false, code: "INVALID_MACHINE_ID", error: "A valid stop machine is required." }, { status: 400 });
  }
  if (!productId && !fallbackProductName) {
    return NextResponse.json({ success: false, code: "MISSING_PRODUCT", error: "Choose a product or type a product name." }, { status: 400 });
  }
  if (quantity <= 0) {
    return NextResponse.json({ success: false, code: "INVALID_QUANTITY", error: "Quantity must be greater than 0." }, { status: 400 });
  }
  if (!productId && unitSalePriceLyd <= 0) {
    return NextResponse.json({ success: false, code: "INVALID_UNIT_PRICE", error: "A productless sale requires a unit price greater than 0." }, { status: 400 });
  }
  if (!clientSubmissionId || clientSubmissionId.length > 200) {
    return NextResponse.json({ success: false, code: "MISSING_SUBMISSION_ID", error: "Missing or invalid submission id. Refresh and try again." }, { status: 400 });
  }

  try {
    const { data, error } = await routeClient.rpc("snacky_create_route_manual_sale_v1", {
      p_route_id: routeId,
      p_route_stop_id: stopId,
      p_machine_id: machineId,
      p_product_id: productId || null,
      p_product_name: productId ? null : fallbackProductName,
      p_quantity: quantity,
      p_unit_sale_price_lyd: productId ? null : unitSalePriceLyd,
      p_payment_method: paymentMethod,
      p_notes: notes || null,
      p_client_submission_id: clientSubmissionId,
    });
    if (error) {
      if (String(error.code ?? "") === "PGRST202") {
        return NextResponse.json(
          {
            success: false,
            code: "MANUAL_SALE_SCHEMA_UPDATE_REQUIRED",
            error: "The atomic manual-sale database update is not active yet. Nothing was changed.",
          },
          { status: 503 },
        );
      }
      throw error;
    }

    const result = (data ?? {}) as {
      sale?: RouteManualSaleRow;
      inventoryMovementCreated?: unknown;
      inventoryMovementRecovered?: unknown;
      alreadyApplied?: unknown;
      warning?: unknown;
      recordedBagQtyBefore?: unknown;
    };
    if (!result.sale?.id) {
      throw new Error("The atomic manual-sale transaction returned no saved sale.");
    }

    const sale = normalizeRouteManualSale(result.sale);
    revalidateManualSalePaths(routeId, stopId);
    return NextResponse.json({
      success: true,
      sale,
      inventoryMovementCreated: Boolean(result.inventoryMovementCreated),
      inventoryMovementRecovered: Boolean(result.inventoryMovementRecovered),
      alreadyApplied: Boolean(result.alreadyApplied),
      warning: clean(result.warning) || null,
      recordedBagQtyBefore: result.recordedBagQtyBefore != null && Number.isFinite(Number(result.recordedBagQtyBefore))
        ? Number(result.recordedBagQtyBefore)
        : null,
      totalAmountLyd: sale.totalAmountLyd,
    });
  } catch (error) {
    const status = responseStatusForError(error);
    console.error("[operator:manual-route-sales] Failed to save manual sale atomically", {
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
    return NextResponse.json(
      {
        success: false,
        code: "MANUAL_SALE_SAVE_FAILED",
        error: errorMessage(error) || "Could not save manual sale.",
      },
      { status },
    );
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
    const { route } = await loadRouteContext(routeClient, routeId, stopId);
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return NextResponse.json({ success: false, code: "UNAUTHORIZED", error: "This route is not assigned to you." }, { status: 403 });
    }
    const { data: cancellationRows, error: cancellationError } = await routeClient.rpc(
      "snacky_cancel_route_manual_sale_v1",
      {
        p_route_id: routeId,
        p_route_stop_id: stopId,
        p_sale_id: saleId,
        p_cancellation_reason: cancellationReason,
      },
    );
    if (cancellationError) {
      if (String(cancellationError.code ?? "") === "PGRST202") {
        return NextResponse.json(
          {
            success: false,
            code: "MANUAL_SALE_SCHEMA_UPDATE_REQUIRED",
            error: "The atomic manual-sale cancellation database update is not active yet. Nothing was changed.",
          },
          { status: 503 },
        );
      }
      throw cancellationError;
    }

    const cancellationResult = Array.isArray(cancellationRows) ? cancellationRows[0] : cancellationRows;
    const { data: cancelledSale, error: cancelError } = await writeClient
      .from("route_manual_sales")
      .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, client_submission_id, inventory_movement_id, inventory_reversal_movement_id, cash_collection_id, cancellation_reason, cancelled_at, cancelled_by_user_id, cancelled_by_team_member_id, created_by_user_id, created_by_team_member_id, needs_review, review_reason")
      .eq("id", saleId)
      .eq("route_id", routeId)
      .eq("route_stop_id", stopId)
      .maybeSingle();
    if (cancelError) throw cancelError;
    if (!cancelledSale) {
      return NextResponse.json({ success: false, code: "SALE_NOT_FOUND", error: "Manual sale was not found." }, { status: 404 });
    }

    const saleRow = cancelledSale as RouteManualSaleRow & {
      needs_review?: boolean | null;
      review_reason?: string | null;
    };
    if (saleRow.needs_review) {
      revalidateManualSalePaths(routeId, stopId);
      return NextResponse.json(
        {
          success: false,
          code: "MANUAL_SALE_REVIEW_REQUIRED",
          error: clean(saleRow.review_reason) || "This manual sale requires inventory review before it can be cancelled.",
          sale: normalizeRouteManualSale(saleRow),
          requiresReview: true,
        },
        { status: 409 },
      );
    }
    const inventoryReversed = Boolean((cancellationResult as { inventory_reversed?: unknown } | null)?.inventory_reversed);
    const alreadyCancelled = Boolean((cancellationResult as { already_cancelled?: unknown } | null)?.already_cancelled);

    revalidateManualSalePaths(routeId, stopId);
    return NextResponse.json({ success: true, sale: normalizeRouteManualSale(saleRow), inventoryReversed, alreadyCancelled, warning: null });
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
