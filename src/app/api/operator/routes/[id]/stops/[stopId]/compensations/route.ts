import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: unknown) { return String(value ?? "").trim(); }
function isUuid(value: unknown) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value)); }
function intValue(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0; }
function moneyValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Number(parsed.toFixed(2))) : null; }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown database error";
}
function errorCode(error: unknown) {
  return clean((error as { code?: unknown } | null)?.code);
}
function responseStatusForError(error: unknown) {
  const code = errorCode(error);
  const text = errorMessage(error).toLowerCase();
  if (code === "28000" || text.includes("not authenticated") || text.includes("session")) return 401;
  if (code === "42501" || text.includes("not assigned") || text.includes("permission")) return 403;
  if (code === "23505" || text.includes("submission id") || text.includes("conflict")) return 409;
  if (code === "23514" && (text.includes("closed") || text.includes("terminal"))) return 409;
  if (["23502", "23503", "23514", "22023"].includes(code)) return 400;
  return 500;
}
function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || String(row?.message ?? "").includes("route_customer_compensations");
}
type CompensationRow = {
  id: string;
  route_id?: string | null;
  route_stop_id?: string | null;
  machine_id?: string | null;
  location_id?: string | null;
  operator_id?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | string | null;
  claim_type?: string | null;
  claimed_amount_lyd?: number | string | null;
  notes?: string | null;
  compensated_at?: string | null;
  client_submission_id?: string | null;
  needs_review?: boolean | null;
  review_reason?: string | null;
  inventory_movement_id?: string | null;
};

async function loadContext(routeId: string, stopId: string) {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  if (!accessToken || !profile) return { error: NextResponse.json({ success: false, error: "Session expired. Please sign in again." }, { status: 401 }) };
  if (!client) return { error: NextResponse.json({ success: false, error: "Database is not available." }, { status: 500 }) };
  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) return { error: NextResponse.json({ success: false, error: errorMessage(routeError ?? stopError) }, { status: 500 }) };
  if (!route || !stop || stop.route_id !== routeId) return { error: NextResponse.json({ success: false, error: "Route stop was not found." }, { status: 404 }) };
  const routeAccessProfile = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) return { error: NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 }) };
  const { data: machine, error: machineError } = await client.from("machines").select("id, location_id").eq("id", stop.machine_id).maybeSingle();
  if (machineError || !machine) return { error: NextResponse.json({ success: false, error: errorMessage(machineError) || "Machine not found." }, { status: 500 }) };
  return { profile, client, route, stop, machine };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  const [recordsResult, productsResult] = await Promise.all([
    context.client.from("route_customer_compensations")
      .select("id, product_id, product_name, quantity, claim_type, claimed_amount_lyd, notes, compensated_at, needs_review, review_reason, inventory_movement_id")
      .eq("route_stop_id", stopId).order("compensated_at", { ascending: false }).limit(100),
    context.client.from("products")
      .select("id, name, sku, barcode, category, brand, current_selling_price_lyd, selling_price")
      .eq("active", true).order("name").limit(2000),
  ]);
  if (recordsResult.error && isMissingTable(recordsResult.error)) {
    return NextResponse.json({ success: true, installed: false, records: [], products: productsResult.data ?? [] });
  }
  if (recordsResult.error) return NextResponse.json({ success: false, installed: true, error: errorMessage(recordsResult.error) }, { status: 500 });
  if (productsResult.error) return NextResponse.json({ success: false, installed: true, error: errorMessage(productsResult.error) }, { status: 500 });
  return NextResponse.json({ success: true, installed: true, records: recordsResult.data ?? [], products: productsResult.data ?? [] });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  }

  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  if (!accessToken || !profile) {
    return NextResponse.json({ success: false, error: "Session expired. Please sign in again." }, { status: 401 });
  }
  if (!client) {
    return NextResponse.json({ success: false, error: "Database is not available." }, { status: 500 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid compensation payload." }, { status: 400 });
  }

  const productId = clean(payload.productId);
  const quantity = intValue(payload.quantity);
  const claimType = clean(payload.claimType) || "paid_no_product";
  const claimedAmountLyd = clean(payload.claimedAmountLyd) ? moneyValue(payload.claimedAmountLyd) : null;
  const notes = clean(payload.notes) || null;
  const clientSubmissionId = clean(payload.clientSubmissionId);

  if (!isUuid(productId)) {
    return NextResponse.json({ success: false, error: "Choose the product given to the customer." }, { status: 400 });
  }
  if (quantity <= 0) {
    return NextResponse.json({ success: false, error: "Quantity must be greater than 0." }, { status: 400 });
  }
  if (!clientSubmissionId || clientSubmissionId.length > 200) {
    return NextResponse.json({ success: false, error: "Missing or invalid submission id. Refresh and try again." }, { status: 400 });
  }
  if (!["paid_no_product", "wrong_product", "damaged_or_stuck", "other"].includes(claimType)) {
    return NextResponse.json({ success: false, error: "Invalid compensation reason." }, { status: 400 });
  }

  try {
    const { data, error } = await client.rpc("snacky_create_route_customer_compensation_v1", {
      p_route_id: routeId,
      p_route_stop_id: stopId,
      p_product_id: productId,
      p_quantity: quantity,
      p_claim_type: claimType,
      p_claimed_amount_lyd: claimedAmountLyd,
      p_notes: notes,
      p_client_submission_id: clientSubmissionId,
    });
    if (error) {
      const code = errorCode(error);
      if (code === "PGRST202" || code === "PGRST205") {
        return NextResponse.json(
          {
            success: false,
            installed: false,
            code: "COMPENSATION_SCHEMA_UPDATE_REQUIRED",
            error: "The atomic customer-compensation database update is not active yet. Nothing was changed.",
          },
          { status: 503 },
        );
      }
      throw error;
    }

    const result = (data ?? {}) as {
      record?: CompensationRow;
      inventoryMovementCreated?: unknown;
      inventoryMovementRecovered?: unknown;
      alreadyApplied?: unknown;
      warning?: unknown;
      recordedBagQtyBefore?: unknown;
    };
    if (!result.record?.id) {
      throw new Error("The atomic compensation transaction returned no saved record.");
    }

    revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
    revalidatePath(`/operator/routes/${routeId}`);
    revalidatePath(`/routes/${routeId}`);
    if (result.record.machine_id) revalidatePath(`/machines/${result.record.machine_id}`);
    if (result.record.operator_id) revalidatePath(`/team/${result.record.operator_id}`);

    return NextResponse.json({
      success: true,
      installed: true,
      record: result.record,
      inventoryMovementCreated: Boolean(result.inventoryMovementCreated),
      inventoryMovementRecovered: Boolean(result.inventoryMovementRecovered),
      alreadyApplied: Boolean(result.alreadyApplied),
      warning: clean(result.warning) || null,
      recordedBagQtyBefore: result.recordedBagQtyBefore != null && Number.isFinite(Number(result.recordedBagQtyBefore))
        ? Number(result.recordedBagQtyBefore)
        : null,
    });
  } catch (error) {
    console.error("[operator:customer-compensation] Failed to save compensation atomically", {
      route_id: routeId,
      route_stop_id: stopId,
      user_id: profile.id,
      product_id: productId,
      quantity,
      claim_type: claimType,
      client_submission_id: clientSubmissionId,
      error_code: errorCode(error),
      error_message: errorMessage(error),
      error,
    });
    return NextResponse.json(
      { success: false, installed: true, code: "COMPENSATION_SAVE_FAILED", error: errorMessage(error) || "Could not save compensation." },
      { status: responseStatusForError(error) },
    );
  }
}
