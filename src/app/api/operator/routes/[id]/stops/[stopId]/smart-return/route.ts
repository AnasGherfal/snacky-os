import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function quantity(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return [row.message, row.details, row.hint].map(clean).filter(Boolean).join(" — ");
  }
  return "Could not record the Smart Route return.";
}

type AllocationRow = {
  slot_code?: unknown;
  transition_mode?: unknown;
  substituted?: unknown;
  from_product_id?: unknown;
  return_current_qty?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, error: "Invalid route or stop." }, { status: 400 });
  }

  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  const admin = getSupabaseAdminClient();
  if (!accessToken || !profile || !client) {
    return NextResponse.json({ success: false, error: "Session expired. Sign in again." }, { status: 401 });
  }
  if (!admin) {
    return NextResponse.json({ success: false, error: "Protected Smart Route inventory access is unavailable." }, { status: 500 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid Smart Route return request." }, { status: 400 });
  }

  const productId = clean(payload.productId);
  const slotCode = clean(payload.slotCode);
  const returnedQty = quantity(payload.quantity);
  const clientSubmissionId = clean(payload.clientSubmissionId);
  if (!isUuid(productId) || !slotCode || returnedQty <= 0 || !clientSubmissionId || clientSubmissionId.length > 200) {
    return NextResponse.json({ success: false, error: "Product, lane, return quantity and submission id are required." }, { status: 400 });
  }

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) {
    return NextResponse.json({ success: false, error: "Could not load this route stop." }, { status: 500 });
  }
  if (!route || !stop || stop.route_id !== routeId) {
    return NextResponse.json({ success: false, error: "Route stop not found." }, { status: 404 });
  }

  const accessProfile = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(accessProfile, route.operator_id)) {
    return NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 });
  }
  if (["completed", "reviewed", "cancelled", "canceled"].includes(clean(route.status).toLowerCase())
      || ["completed", "skipped", "cancelled", "canceled"].includes(clean(stop.status).toLowerCase())) {
    return NextResponse.json({ success: false, error: "This route stop is already closed." }, { status: 409 });
  }

  const { data: planRows, error: planError } = await admin
    .from("route_stop_items")
    .select("id, product_id, source, slot_allocations")
    .eq("route_stop_id", stopId)
    .eq("source", "smart_ai_plan");

  if (planError) {
    return NextResponse.json({ success: false, error: "Could not verify the Smart Route swap plan." }, { status: 500 });
  }

  const matched = (planRows ?? []).some((row: any) => {
    const allocations = Array.isArray(row.slot_allocations) ? row.slot_allocations as AllocationRow[] : [];
    return allocations.some((allocation) => (
      clean(allocation.slot_code) === slotCode
      && clean(allocation.transition_mode) === "replace_now"
      && allocation.substituted === true
      && clean(allocation.from_product_id) === productId
      && Number(allocation.return_current_qty ?? 0) === returnedQty
    ));
  });

  if (!matched) {
    return NextResponse.json({
      success: false,
      error: "This return does not match the current Smart Route swap plan. Refresh the stop before continuing.",
    }, { status: 409 });
  }

  if (!profile.id || !profile.team_member_id) {
    return NextResponse.json({ success: false, error: "Your account is not linked to a Snacky team member." }, { status: 403 });
  }

  const { data, error } = await admin.rpc("snacky_record_smart_route_return_v1", {
    p_route_id: routeId,
    p_route_stop_id: stopId,
    p_machine_id: stop.machine_id,
    p_product_id: productId,
    p_quantity: returnedQty,
    p_slot_code: slotCode,
    p_actor_user_id: profile.id,
    p_actor_team_member_id: profile.team_member_id,
    p_client_submission_id: clientSubmissionId,
  });

  if (error) {
    console.error("[operator:smart-route-return] Failed", {
      route_id: routeId,
      route_stop_id: stopId,
      machine_id: stop.machine_id,
      product_id: productId,
      slot_code: slotCode,
      quantity: returnedQty,
      error,
    });
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 409 });
  }

  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
  revalidatePath(`/routes/${routeId}`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");

  return NextResponse.json({ success: true, adjustment: data });
}
