import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { inventoryMovementIdempotencyKey } from "@/lib/inventory-movement";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: unknown) { return String(value ?? "").trim(); }
function isUuid(value: unknown) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value)); }
function intValue(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0; }
function moneyValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Number(parsed.toFixed(2))) : null; }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown database error";
}
function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || String(row?.message ?? "").includes("route_customer_compensations");
}
function isLocked(status: unknown) { return ["completed", "cancelled", "canceled"].includes(clean(status).toLowerCase()); }

async function loadContext(routeId: string, stopId: string) {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  const writeClient = getSupabaseAdminClient() ?? client;
  if (!accessToken || !profile) return { error: NextResponse.json({ success: false, error: "Session expired. Please sign in again." }, { status: 401 }) };
  if (!client || !writeClient) return { error: NextResponse.json({ success: false, error: "Database is not available." }, { status: 500 }) };
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
  return { profile, client, writeClient, route, stop, machine };
}

async function bagQty(client: any, routeId: string, productId: string) {
  const { data, error } = await client
    .from("inventory_movements")
    .select("quantity, from_entity_type, to_entity_type")
    .eq("related_route_id", routeId)
    .eq("product_id", productId)
    .limit(5000);
  if (error) throw error;
  return (data ?? []).reduce((sum: number, row: any) => {
    const qty = intValue(row.quantity);
    if (row.to_entity_type === "operator_bag" && row.from_entity_type !== "operator_bag") return sum + qty;
    if (row.from_entity_type === "operator_bag" && row.to_entity_type !== "operator_bag") return sum - qty;
    return sum;
  }, 0);
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
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;
  if (isLocked(context.route.status)) return NextResponse.json({ success: false, error: "This route is closed, so new customer compensation cannot be added." }, { status: 409 });

  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ success: false, error: "Invalid compensation payload." }, { status: 400 }); }

  const productId = clean(payload.productId);
  const quantity = intValue(payload.quantity);
  const claimType = clean(payload.claimType) || "paid_no_product";
  const claimedAmountLyd = clean(payload.claimedAmountLyd) ? moneyValue(payload.claimedAmountLyd) : null;
  const notes = clean(payload.notes) || null;
  const clientSubmissionId = clean(payload.clientSubmissionId);
  if (!isUuid(productId)) return NextResponse.json({ success: false, error: "Choose the product given to the customer." }, { status: 400 });
  if (quantity <= 0) return NextResponse.json({ success: false, error: "Quantity must be greater than 0." }, { status: 400 });
  if (!clientSubmissionId) return NextResponse.json({ success: false, error: "Missing submission id. Refresh and try again." }, { status: 400 });
  if (!["paid_no_product", "wrong_product", "damaged_or_stuck", "other"].includes(claimType)) return NextResponse.json({ success: false, error: "Invalid compensation reason." }, { status: 400 });

  const { data: existing, error: existingError } = await context.writeClient.from("route_customer_compensations")
    .select("id, product_id, product_name, quantity, claim_type, claimed_amount_lyd, notes, compensated_at, needs_review, review_reason, inventory_movement_id")
    .eq("client_submission_id", clientSubmissionId).maybeSingle();
  if (existingError && isMissingTable(existingError)) return NextResponse.json({ success: false, installed: false, error: "Apply the customer compensation migration first." }, { status: 503 });
  if (existingError) return NextResponse.json({ success: false, error: errorMessage(existingError) }, { status: 500 });
  if (existing) return NextResponse.json({ success: true, installed: true, record: existing });

  const { data: product, error: productError } = await context.writeClient.from("products")
    .select("id, name, current_cost_price_lyd, cost_price")
    .eq("id", productId).maybeSingle();
  if (productError || !product) return NextResponse.json({ success: false, error: errorMessage(productError) || "Product not found." }, { status: 404 });

  const operatorId = context.route.operator_id ?? context.profile.team_member_id ?? null;
  let available = 0;
  let needsReview = false;
  let reviewReason: string | null = null;
  try {
    available = await bagQty(context.writeClient, routeId, productId);
    if (available < quantity) {
      needsReview = true;
      reviewReason = `Actual customer compensation exceeds recorded operator-bag stock by ${quantity - Math.max(0, available)} unit(s).`;
    }
  } catch (balanceError) {
    needsReview = true;
    reviewReason = `Could not verify operator-bag balance: ${errorMessage(balanceError)}`;
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await context.writeClient.from("route_customer_compensations").insert({
    route_id: routeId,
    route_stop_id: stopId,
    machine_id: context.stop.machine_id,
    location_id: context.machine.location_id ?? null,
    operator_id: operatorId,
    product_id: productId,
    product_name: product.name,
    quantity,
    claim_type: claimType,
    claimed_amount_lyd: claimedAmountLyd,
    notes,
    compensated_at: now,
    client_submission_id: clientSubmissionId,
    needs_review: needsReview,
    review_reason: reviewReason,
    created_by_user_id: context.profile.id,
  }).select("id, product_id, product_name, quantity, claim_type, claimed_amount_lyd, notes, compensated_at, needs_review, review_reason, inventory_movement_id").single();
  if (insertError && isMissingTable(insertError)) return NextResponse.json({ success: false, installed: false, error: "Apply the customer compensation migration first." }, { status: 503 });
  if (insertError) return NextResponse.json({ success: false, error: errorMessage(insertError) }, { status: 500 });

  let record = inserted;
  let warning = reviewReason;
  if (operatorId) {
    try {
      const unitCost = moneyValue(product.current_cost_price_lyd ?? product.cost_price ?? 0) ?? 0;
      const idempotencyKey = inventoryMovementIdempotencyKey("customer-compensation", routeId, stopId, inserted.id, productId, operatorId, quantity);
      const { data: movement, error: movementError } = await context.writeClient.from("inventory_movements").insert({
        product_id: productId,
        quantity,
        from_entity_type: "operator_bag",
        from_entity_id: operatorId,
        to_entity_type: "customer",
        to_entity_id: null,
        reason: "customer_compensation",
        related_route_id: routeId,
        related_route_stop_id: stopId,
        related_machine_id: context.stop.machine_id,
        unit_cost_lyd: unitCost,
        line_total_lyd: Number((unitCost * quantity).toFixed(2)),
        source_type: "route_customer_compensation",
        source_id: inserted.id,
        idempotency_key: idempotencyKey,
        created_by: operatorId,
        notes: `Customer compensation: ${product.name}`,
      }).select("id").single();
      if (movementError) throw movementError;
      const { data: updated } = await context.writeClient.from("route_customer_compensations")
        .update({ inventory_movement_id: movement.id, updated_at: now }).eq("id", inserted.id)
        .select("id, product_id, product_name, quantity, claim_type, claimed_amount_lyd, notes, compensated_at, needs_review, review_reason, inventory_movement_id").single();
      if (updated) record = updated;
    } catch (movementError) {
      warning = [warning, `Compensation was saved, but inventory movement needs review: ${errorMessage(movementError)}`].filter(Boolean).join(" ");
      await context.writeClient.from("route_customer_compensations").update({ needs_review: true, review_reason: warning, updated_at: now }).eq("id", inserted.id);
      record = { ...record, needs_review: true, review_reason: warning };
    }
  }

  revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/routes/${routeId}`);
  if (context.stop.machine_id) revalidatePath(`/machines/${context.stop.machine_id}`);
  if (operatorId) revalidatePath(`/team/${operatorId}`);
  return NextResponse.json({ success: true, installed: true, record, warning, recordedBagQtyBefore: available });
}
