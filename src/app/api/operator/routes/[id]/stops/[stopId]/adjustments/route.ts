import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { getEffectivePermissions } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type AdjustmentType = "damaged" | "returned_from_machine";

type AdjustmentPayload = {
  adjustmentId?: unknown;
  adjustmentType?: unknown;
  productId?: unknown;
  machineId?: unknown;
  quantity?: unknown;
  reason?: unknown;
  selectedReason?: unknown;
  notes?: unknown;
  photoUrl?: unknown;
  clientSubmissionId?: unknown;
};

const defaultAdjustmentReasonByType: Record<AdjustmentType, string> = {
  damaged: "Damaged during transport",
  returned_from_machine: "Removed from machine",
};

function defaultAdjustmentReason(adjustmentType: AdjustmentType) {
  return defaultAdjustmentReasonByType[adjustmentType] ?? "Other";
}


function clean(value: unknown) {
  return String(value ?? "").trim();
}

function quantityValue(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}


function isUuid(value: unknown) {
  const text = clean(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
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

function responseStatusForAdjustment(error: unknown) {
  const text = errorMessage(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (code === "28000" || text.includes("not authenticated")) return 401;
  if (code === "42501" || text.includes("authorized") || text.includes("permission")) return 403;
  if (code === "23514" || code === "23502" || code === "22023" || text.includes("required") || text.includes("quantity")) return 400;
  if (code === "23505" || text.includes("duplicate")) return 409;
  return 500;
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
  const supabase = getSupabaseServerClient(accessToken);
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
  if (!supabase) {
    return NextResponse.json({ success: false, code: "NO_SUPABASE", error: "Database is not available." }, { status: 500 });
  }

  let payload: AdjustmentPayload;
  try {
    payload = await request.json() as AdjustmentPayload;
  } catch (error) {
    return NextResponse.json({ success: false, code: "INVALID_JSON", error: "Invalid adjustment payload." }, { status: 400 });
  }

  const adjustmentType = clean(payload.adjustmentType) as AdjustmentType;
  const rawAdjustmentId = clean(payload.adjustmentId);
  const adjustmentId = isUuid(rawAdjustmentId) ? rawAdjustmentId : "";
  const productId = clean(payload.productId);
  if (!isUuid(productId)) {
    return NextResponse.json({ success: false, code: "INVALID_PRODUCT_ID", error: "Invalid product id." }, { status: 400 });
  }
  const machineId = clean(payload.machineId);
  if (!isUuid(machineId)) {
    return NextResponse.json({ success: false, code: "INVALID_MACHINE_ID", error: "Invalid machine id." }, { status: 400 });
  }
  const quantity = quantityValue(payload.quantity);
  const directReason = clean(payload.reason);
  const legacySelectedReason = clean(payload.selectedReason);
  const notes = clean(payload.notes);
  const photoUrl = clean(payload.photoUrl);
  const clientSubmissionId = clean(payload.clientSubmissionId);

  if (!["damaged", "returned_from_machine"].includes(adjustmentType)) {
    return NextResponse.json({ success: false, code: "INVALID_ADJUSTMENT_TYPE", error: "Choose damaged or returned product." }, { status: 400 });
  }
  const reason = directReason || legacySelectedReason || defaultAdjustmentReason(adjustmentType);
  if (!directReason && legacySelectedReason) {
    console.warn("[operator:inventory-adjustment] Using legacy selectedReason payload field", {
      ...requestContext,
      adjustment_type: adjustmentType,
      product_id: productId,
      machine_id: machineId,
      reason: legacySelectedReason,
    });
  } else if (!directReason) {
    console.warn("[operator:inventory-adjustment] Missing adjustment reason in payload, using default", {
      ...requestContext,
      adjustment_type: adjustmentType,
      product_id: productId,
      machine_id: machineId,
      fallback_reason: reason,
    });
  }

  if (!productId) {
    return NextResponse.json({ success: false, code: "MISSING_PRODUCT", error: "Product is required." }, { status: 400 });
  }
  if (!machineId) {
    return NextResponse.json({ success: false, code: "MISSING_MACHINE", error: "Machine is required." }, { status: 400 });
  }
  if (quantity <= 0) {
    return NextResponse.json({ success: false, code: "INVALID_QUANTITY", error: "Quantity must be greater than 0." }, { status: 400 });
  }

  if (rawAdjustmentId && !adjustmentId) {
    console.warn("[operator:inventory-adjustment] Ignoring non-UUID adjustmentId", {
      ...requestContext,
      adjustment_id: rawAdjustmentId || null,
      adjustment_type: adjustmentType,
      product_id: productId,
      machine_id: machineId,
    });
  }

  try {
    const { data, error } = await supabase.rpc("create_route_inventory_adjustment", {
      p_adjustment_id: adjustmentId || null,
      p_adjustment_type: adjustmentType,
      p_product_id: productId,
      p_machine_id: machineId,
      p_route_id: routeId,
      p_route_stop_id: stopId,
      p_quantity: quantity,
      p_reason: reason,
      p_notes: notes || null,
      p_photo_url: photoUrl || null,
      p_client_submission_id: clientSubmissionId || `route-inventory-adjustment:${routeId}:${stopId}:${productId}:${adjustmentType}`,
    });

    if (error) throw error;
    const adjustment = Array.isArray(data) ? data[0] : data;
    if (!adjustment) throw new Error("Adjustment was not returned after saving.");

    revalidatePath(`/operator/routes/${routeId}`);
    revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
    revalidatePath(`/routes/${routeId}`);
    revalidatePath("/inventory");
    revalidatePath("/inventory/movements");
    revalidatePath("/reports/inventory-adjustments");
    revalidatePath("/reports/route-product-activity");

    return NextResponse.json({ success: true, adjustment });
  } catch (error) {
    const status = responseStatusForAdjustment(error);
    console.error("[operator:inventory-adjustment] Failed to save adjustment", {
      ...requestContext,
      adjustment_id: rawAdjustmentId || null,
      adjustment_type: adjustmentType,
      product_id: productId,
      quantity,
      error_message: errorMessage(error),
      supabase_error_code: error && typeof error === "object" ? (error as { code?: unknown }).code ?? null : null,
      error,
    });
    return NextResponse.json(
      { success: false, code: "ADJUSTMENT_SAVE_FAILED", error: errorMessage(error) || "Could not save inventory adjustment." },
      { status },
    );
  }
}
