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
  notes?: unknown;
  photoUrl?: unknown;
  clientSubmissionId?: unknown;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
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
  const adjustmentId = clean(payload.adjustmentId);
  const productId = clean(payload.productId);
  const machineId = clean(payload.machineId);
  const quantity = quantityValue(payload.quantity);
  const reason = clean(payload.reason);
  const notes = clean(payload.notes);
  const photoUrl = clean(payload.photoUrl);
  const clientSubmissionId = clean(payload.clientSubmissionId);

  if (!["damaged", "returned_from_machine"].includes(adjustmentType)) {
    return NextResponse.json({ success: false, code: "INVALID_ADJUSTMENT_TYPE", error: "Choose damaged or returned product." }, { status: 400 });
  }
  if (!adjustmentId) {
    return NextResponse.json({ success: false, code: "MISSING_ADJUSTMENT_ID", error: "Adjustment id is required. Refresh the page and retry." }, { status: 400 });
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
  if (!reason) {
    return NextResponse.json({ success: false, code: "MISSING_REASON", error: "Reason is required." }, { status: 400 });
  }

  try {
    const { data, error } = await supabase.rpc("create_route_inventory_adjustment", {
      p_adjustment_id: adjustmentId,
      p_adjustment_type: adjustmentType,
      p_product_id: productId,
      p_machine_id: machineId,
      p_route_id: routeId,
      p_route_stop_id: stopId,
      p_quantity: quantity,
      p_reason: reason,
      p_notes: notes || null,
      p_photo_url: photoUrl || null,
      p_client_submission_id: clientSubmissionId || `route-inventory-adjustment:${adjustmentId}`,
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

    return NextResponse.json({ success: true, adjustment });
  } catch (error) {
    const status = responseStatusForAdjustment(error);
    console.error("[operator:inventory-adjustment] Failed to save adjustment", {
      ...requestContext,
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
