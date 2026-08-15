import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { inventoryMovementIdempotencyKey } from "@/lib/inventory-movement";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

const compensationSelect =
  "id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, claim_type, claimed_amount_lyd, notes, compensated_at, client_submission_id, inventory_movement_id, needs_review, review_reason";

const allowedClaimTypes = new Set([
  "paid_no_product",
  "product_jammed",
  "wrong_product",
  "dispensing_damage",
  "previous_unresolved_issue",
  "damaged_or_stuck", // Legacy value retained for existing rows.
  "other",
]);

type CompensationRow = {
  id: string;
  route_id: string;
  route_stop_id: string;
  machine_id: string;
  location_id?: string | null;
  operator_id?: string | null;
  product_id: string;
  product_name: string;
  quantity: number;
  claim_type: string;
  claimed_amount_lyd?: number | null;
  notes?: string | null;
  compensated_at: string;
  client_submission_id?: string | null;
  inventory_movement_id?: string | null;
  needs_review?: boolean;
  review_reason?: string | null;
};

type ProductRow = {
  id: string;
  name: string;
  current_cost_price_lyd?: number | string | null;
  cost_price?: number | string | null;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function intValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function moneyValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown database error";
}

function errorCode(error: unknown) {
  return clean((error as { code?: unknown } | null)?.code);
}

function isDuplicate(error: unknown) {
  return errorCode(error) === "23505" || errorMessage(error).toLowerCase().includes("duplicate");
}

function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || String(row?.message ?? "").includes("route_customer_compensations");
}

function isLocked(status: unknown) {
  return ["completed", "reviewed", "paid", "cancelled", "canceled"].includes(clean(status).toLowerCase());
}

function bagReviewReason(available: number, quantity: number) {
  if (available >= quantity) return null;
  return `Actual customer compensation exceeds recorded operator-bag stock by ${quantity - Math.max(0, available)} unit(s).`;
}

async function loadContext(routeId: string, stopId: string) {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  const writeClient = getSupabaseAdminClient() ?? client;

  if (!accessToken || !profile) {
    return { error: NextResponse.json({ success: false, error: "Session expired. Please sign in again." }, { status: 401 }) };
  }
  if (!client || !writeClient) {
    return { error: NextResponse.json({ success: false, error: "Database is not available." }, { status: 500 }) };
  }

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) {
    return { error: NextResponse.json({ success: false, error: errorMessage(routeError ?? stopError) }, { status: 500 }) };
  }
  if (!route || !stop || stop.route_id !== routeId) {
    return { error: NextResponse.json({ success: false, error: "Route stop was not found." }, { status: 404 }) };
  }

  const routeAccessProfile = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return { error: NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 }) };
  }

  const { data: machine, error: machineError } = await client
    .from("machines")
    .select("id, location_id")
    .eq("id", stop.machine_id)
    .maybeSingle();
  if (machineError) {
    return { error: NextResponse.json({ success: false, error: errorMessage(machineError) }, { status: 500 }) };
  }
  if (!machine) {
    return { error: NextResponse.json({ success: false, error: "Machine not found." }, { status: 404 }) };
  }

  return { profile, client, writeClient, route, stop, machine };
}

async function bagQty(client: any, routeId: string, productId: string, operatorId: string | null) {
  const { data, error } = await client
    .from("inventory_movements")
    .select("quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id")
    .eq("related_route_id", routeId)
    .eq("product_id", productId)
    .limit(5000);
  if (error) throw error;

  return (data ?? []).reduce((sum: number, row: any) => {
    const qty = intValue(row.quantity);
    const entersOperatorBag = row.to_entity_type === "operator_bag"
      && row.from_entity_type !== "operator_bag"
      && (!operatorId || !row.to_entity_id || String(row.to_entity_id) === operatorId);
    const leavesOperatorBag = row.from_entity_type === "operator_bag"
      && row.to_entity_type !== "operator_bag"
      && (!operatorId || !row.from_entity_id || String(row.from_entity_id) === operatorId);
    if (entersOperatorBag) return sum + qty;
    if (leavesOperatorBag) return sum - qty;
    return sum;
  }, 0);
}

async function loadProduct(client: any, productId: string): Promise<ProductRow> {
  const { data, error } = await client
    .from("products")
    .select("id, name, current_cost_price_lyd, cost_price")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Product not found.");
  return data as ProductRow;
}

async function loadBySubmission(client: any, clientSubmissionId: string): Promise<CompensationRow | null> {
  const { data, error } = await client
    .from("route_customer_compensations")
    .select(compensationSelect)
    .eq("client_submission_id", clientSubmissionId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as CompensationRow | null;
}

async function findInventoryMovement(client: any, record: CompensationRow, idempotencyKey: string) {
  if (record.inventory_movement_id) {
    const { data, error } = await client
      .from("inventory_movements")
      .select("id")
      .eq("id", record.inventory_movement_id)
      .maybeSingle();
    if (error) throw error;
    if (data?.id) return String(data.id);
  }

  const { data, error } = await client
    .from("inventory_movements")
    .select("id")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data?.id ? String(data.id) : null;
}

async function ensureInventoryMovement({
  client,
  record,
  product,
  routeId,
  stopId,
  machineId,
  operatorId,
}: {
  client: any;
  record: CompensationRow;
  product: ProductRow;
  routeId: string;
  stopId: string;
  machineId: string;
  operatorId: string | null;
}) {
  if (!operatorId) {
    const warning = "Compensation was saved, but no operator identity was available for the inventory movement.";
    const { data, error } = await client
      .from("route_customer_compensations")
      .update({ needs_review: true, review_reason: warning, updated_at: new Date().toISOString() })
      .eq("id", record.id)
      .select(compensationSelect)
      .single();
    if (error) throw error;
    return { record: data as CompensationRow, warning, availableBefore: null as number | null };
  }

  const idempotencyKey = inventoryMovementIdempotencyKey(
    "customer-compensation",
    routeId,
    stopId,
    record.id,
    record.product_id,
    operatorId,
    record.quantity,
  );

  let movementId = await findInventoryMovement(client, record, idempotencyKey);
  let availableBefore: number | null = null;
  let reviewReason: string | null = record.needs_review ? clean(record.review_reason) || null : null;

  if (!movementId) {
    try {
      availableBefore = await bagQty(client, routeId, record.product_id, operatorId);
      reviewReason = bagReviewReason(availableBefore, intValue(record.quantity));
    } catch (balanceError) {
      availableBefore = null;
      reviewReason = `Could not verify operator-bag balance: ${errorMessage(balanceError)}`;
    }
    const unitCost = moneyValue(product.current_cost_price_lyd ?? product.cost_price ?? 0) ?? 0;
    const movementPayload = {
      product_id: record.product_id,
      quantity: intValue(record.quantity),
      from_entity_type: "operator_bag",
      from_entity_id: operatorId,
      to_entity_type: "customer",
      to_entity_id: null,
      reason: "customer_compensation",
      related_route_id: routeId,
      related_route_stop_id: stopId,
      related_machine_id: machineId,
      unit_cost_lyd: unitCost,
      line_total_lyd: Number((unitCost * intValue(record.quantity)).toFixed(2)),
      source_type: "route_customer_compensation",
      source_id: record.id,
      idempotency_key: idempotencyKey,
      created_by: operatorId,
      notes: `Customer compensation: ${record.product_name}`,
    };

    const { data: movement, error: movementError } = await client
      .from("inventory_movements")
      .insert(movementPayload)
      .select("id")
      .single();

    if (movementError) {
      if (!isDuplicate(movementError)) throw movementError;
      movementId = await findInventoryMovement(client, record, idempotencyKey);
      if (!movementId) throw movementError;
    } else {
      movementId = movement?.id ? String(movement.id) : null;
    }
  }

  if (!movementId) throw new Error("Customer compensation inventory movement could not be identified.");

  const { data: updated, error: updateError } = await client
    .from("route_customer_compensations")
    .update({
      operator_id: record.operator_id ?? operatorId,
      inventory_movement_id: movementId,
      needs_review: Boolean(reviewReason),
      review_reason: reviewReason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id)
    .select(compensationSelect)
    .single();
  if (updateError) throw updateError;

  return {
    record: updated as CompensationRow,
    warning: reviewReason,
    availableBefore,
  };
}

function revalidateCompensationPaths(routeId: string, stopId: string, machineId: string, operatorId: string | null) {
  revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/routes/${routeId}`);
  revalidatePath(`/machines/${machineId}`);
  if (operatorId) revalidatePath(`/team/${operatorId}`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  }

  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  const [recordsResult, productsResult] = await Promise.all([
    context.client
      .from("route_customer_compensations")
      .select(compensationSelect)
      .eq("route_stop_id", stopId)
      .order("compensated_at", { ascending: false })
      .limit(100),
    context.client
      .from("products")
      .select("id, name, sku, barcode, category, brand, current_selling_price_lyd, selling_price")
      .eq("active", true)
      .order("name")
      .limit(2000),
  ]);

  if (productsResult.error) {
    return NextResponse.json({ success: false, installed: true, error: errorMessage(productsResult.error) }, { status: 500 });
  }
  if (recordsResult.error && isMissingTable(recordsResult.error)) {
    return NextResponse.json({ success: true, installed: false, records: [], products: productsResult.data ?? [] });
  }
  if (recordsResult.error) {
    return NextResponse.json({ success: false, installed: true, error: errorMessage(recordsResult.error) }, { status: 500 });
  }
  return NextResponse.json({ success: true, installed: true, records: recordsResult.data ?? [], products: productsResult.data ?? [] });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  }

  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;
  if (isLocked(context.route.status)) {
    return NextResponse.json({ success: false, error: "This route is closed, so new customer compensation cannot be added." }, { status: 409 });
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
  const claimedAmountRaw = clean(payload.claimedAmountLyd);
  const claimedAmountLyd = claimedAmountRaw ? moneyValue(payload.claimedAmountLyd) : null;
  const notes = clean(payload.notes) || null;
  const clientSubmissionId = clean(payload.clientSubmissionId);

  if (!isUuid(productId)) {
    return NextResponse.json({ success: false, error: "Choose the product given to the customer." }, { status: 400 });
  }
  if (quantity <= 0) {
    return NextResponse.json({ success: false, error: "Quantity must be greater than 0." }, { status: 400 });
  }
  if (!clientSubmissionId) {
    return NextResponse.json({ success: false, error: "Missing submission id. Refresh and try again." }, { status: 400 });
  }
  if (claimedAmountRaw && claimedAmountLyd === null) {
    return NextResponse.json({ success: false, error: "Customer-reported amount must be zero or greater." }, { status: 400 });
  }
  if (!allowedClaimTypes.has(claimType)) {
    return NextResponse.json({ success: false, error: "Invalid compensation reason." }, { status: 400 });
  }

  const operatorId = clean(context.route.operator_id ?? context.profile.team_member_id) || null;

  try {
    let record = await loadBySubmission(context.writeClient, clientSubmissionId);

    if (record && (record.route_id !== routeId || record.route_stop_id !== stopId)) {
      return NextResponse.json({ success: false, error: "This submission id belongs to another route stop." }, { status: 409 });
    }

    const effectiveProductId = record?.product_id ?? productId;
    let product = await loadProduct(context.writeClient, effectiveProductId);

    if (!record) {
      const now = new Date().toISOString();
      let availableBefore: number | null = null;
      let initialReviewReason: string | null = null;
      if (operatorId) {
        try {
          availableBefore = await bagQty(context.writeClient, routeId, productId, operatorId);
          initialReviewReason = bagReviewReason(availableBefore, quantity);
        } catch (balanceError) {
          initialReviewReason = `Could not verify operator-bag balance: ${errorMessage(balanceError)}`;
        }
      }

      const { data: inserted, error: insertError } = await context.writeClient
        .from("route_customer_compensations")
        .insert({
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
          needs_review: Boolean(initialReviewReason),
          review_reason: initialReviewReason,
          created_by_user_id: context.profile.id,
        })
        .select(compensationSelect)
        .single();

      if (insertError) {
        if (isMissingTable(insertError)) {
          return NextResponse.json({ success: false, installed: false, error: "Apply the customer compensation migrations first." }, { status: 503 });
        }
        if (!isDuplicate(insertError)) throw insertError;
        record = await loadBySubmission(context.writeClient, clientSubmissionId);
        if (!record) throw insertError;
        if (record.product_id !== product.id) product = await loadProduct(context.writeClient, record.product_id);
      } else {
        record = inserted as CompensationRow;
      }
    }

    const result = await ensureInventoryMovement({
      client: context.writeClient,
      record,
      product,
      routeId,
      stopId,
      machineId: context.stop.machine_id,
      operatorId: record.operator_id ?? operatorId,
    }).catch(async (movementError) => {
      const { data: latestRecord } = await context.writeClient
        .from("route_customer_compensations")
        .select("review_reason")
        .eq("id", record!.id)
        .maybeSingle();
      const movementWarning = `Inventory movement needs review: ${errorMessage(movementError)}`;
      const warning = [clean(latestRecord?.review_reason ?? record!.review_reason), movementWarning].filter(Boolean).join(" ");
      const { data: reviewed, error: reviewError } = await context.writeClient
        .from("route_customer_compensations")
        .update({ needs_review: true, review_reason: warning, updated_at: new Date().toISOString() })
        .eq("id", record!.id)
        .select(compensationSelect)
        .single();
      if (reviewError) throw movementError;
      return { record: reviewed as CompensationRow, warning, availableBefore: null as number | null };
    });

    revalidateCompensationPaths(routeId, stopId, context.stop.machine_id, result.record.operator_id ?? operatorId);
    return NextResponse.json({
      success: true,
      installed: true,
      record: result.record,
      warning: result.warning,
      recordedBagQtyBefore: result.availableBefore,
    });
  } catch (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ success: false, installed: false, error: "Apply the customer compensation migrations first." }, { status: 503 });
    }
    console.error("[customer-compensation] Failed to record compensation", {
      route_id: routeId,
      route_stop_id: stopId,
      product_id: productId,
      operator_id: operatorId,
      client_submission_id: clientSubmissionId,
      error,
    });
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
