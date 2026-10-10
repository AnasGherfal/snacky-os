import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot } from "@/lib/xy-vms-control";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toPositiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

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
  const supabase = getSupabaseServerClient(accessToken);
  if (!accessToken || !profile || !supabase) {
    return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  }

  let body: { slotCode?: unknown; productId?: unknown; smartRouteSwap?: unknown; queueOnOffline?: unknown; physicalChangeConfirmed?: unknown; laneDisabledConfirmed?: unknown; actualSlotQty?: unknown; priceLyd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  const slotCode = String(body.slotCode ?? "").trim();
  const productId = String(body.productId ?? "").trim();
  const requestedPrice = body.priceLyd === undefined || body.priceLyd === null
    ? null : Number(body.priceLyd);
  if (requestedPrice !== null && (!Number.isFinite(requestedPrice)
    || requestedPrice <= 0 || requestedPrice > 1000
    || Math.abs(requestedPrice * 100 - Math.round(requestedPrice * 100)) > 0.0001)) {
    return NextResponse.json({ success: false, error: "Enter a positive LYD selling price with up to two decimals." }, { status: 400 });
  }
  const smartRouteSwapRequested = body.smartRouteSwap === true;
  // A normal change is a *desired catalogue selection*, not evidence that
  // somebody physically emptied/refilled a lane. To keep it one tap, retry
  // automatically while forcing the new mapping's sellable quantity to ZERO.
  // Smart Route execution still follows its stricter physical-return workflow.
  const verifiedPhysicalSwap = body.physicalChangeConfirmed === true
    && body.laneDisabledConfirmed === true
    && Number.isSafeInteger(Number(body.actualSlotQty))
    && Number(body.actualSlotQty) >= 0;
  const queueOnOffline = body.queueOnOffline !== false
    && (!smartRouteSwapRequested || verifiedPhysicalSwap);
  const zeroStockRelabel = !smartRouteSwapRequested && !verifiedPhysicalSwap;
  const actualSlotQty = verifiedPhysicalSwap ? Number(body.actualSlotQty) : 0;
  if (!slotCode || !isUuid(productId)) {
    return NextResponse.json({ success: false, error: "Choose a valid slot and product." }, { status: 400 });
  }

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    supabase.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    supabase.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) {
    return NextResponse.json({ success: false, error: "Could not load this route stop." }, { status: 500 });
  }
  if (!route || !stop || stop.route_id !== routeId) {
    return NextResponse.json({ success: false, error: "Route stop not found." }, { status: 404 });
  }

  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 });
  }
  if (["completed", "cancelled"].includes(String(stop.status ?? "").toLowerCase())) {
    return NextResponse.json({ success: false, error: "This stop is already closed." }, { status: 409 });
  }

  const admin = getSupabaseAdminClient() ?? supabase;
  const [{ data: machine, error: machineError }, { data: product, error: productError }, { data: mapping, error: mappingError }] = await Promise.all([
    admin
      .from("machines")
      .select("id, name, machine_code, vms_machine_id")
      .eq("id", stop.machine_id)
      .maybeSingle(),
    admin
      .from("products")
      .select("id, name, active, image_url, vms_selling_price_lyd, current_selling_price_lyd")
      .eq("id", productId)
      .maybeSingle(),
    admin
      .from("vms_product_mappings")
      .select("vms_product_id, vms_product_name, match_status, last_seen_at")
      .eq("product_id", productId)
      .eq("match_status", "confirmed")
      .not("vms_product_id", "is", null)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (machineError || !machine?.vms_machine_id) {
    return NextResponse.json({ success: false, error: "This machine is not linked to XY." }, { status: 409 });
  }
  if (productError || !product?.active) {
    return NextResponse.json({ success: false, error: "That product is not active." }, { status: 409 });
  }
  if (mappingError || !mapping?.vms_product_id) {
    return NextResponse.json({ success: false, error: "That product does not have a confirmed XY mapping yet." }, { status: 409 });
  }

  let smartRouteSwap: {
    fromProductId: string;
    returnCurrentQty: number;
  } | null = null;

  if (smartRouteSwapRequested) {
    const { data: smartRows, error: smartRowsError } = await admin
      .from("route_stop_items")
      .select("product_id, source, slot_allocations")
      .eq("route_stop_id", stopId)
      .eq("source", "smart_ai_plan");
    if (smartRowsError) {
      return NextResponse.json({ success: false, error: "Could not verify the Smart Route product-change plan." }, { status: 500 });
    }

    for (const row of smartRows ?? []) {
      if (String(row.product_id ?? "") !== productId) continue;
      const allocations = Array.isArray(row.slot_allocations) ? row.slot_allocations : [];
      const allocation = allocations.find((value: any) => (
        String(value?.slot_code ?? "").trim() === slotCode
        && String(value?.transition_mode ?? "") === "replace_now"
        && value?.substituted === true
        && String(value?.from_product_id ?? "").trim()
        && Number(value?.return_current_qty ?? 0) > 0
      ));
      if (!allocation) continue;
      smartRouteSwap = {
        fromProductId: String(allocation.from_product_id),
        returnCurrentQty: Number(allocation.return_current_qty),
      };
      break;
    }

    if (!smartRouteSwap) {
      return NextResponse.json({
        success: false,
        error: "This XY change does not match the current Smart Route swap plan. Refresh the stop before continuing.",
      }, { status: 409 });
    }

    const { data: returnRows, error: returnError } = await admin
      .from("inventory_adjustments")
      .select("quantity, notes")
      .eq("route_stop_id", stopId)
      .eq("machine_id", stop.machine_id)
      .eq("product_id", smartRouteSwap.fromProductId)
      .eq("adjustment_type", "returned_from_machine")
      .eq("reason", "Product replaced")
      .eq("status", "confirmed");
    if (returnError) {
      return NextResponse.json({ success: false, error: "Could not verify the old-product return before changing XY." }, { status: 500 });
    }
    const recordedReturnQty = (returnRows ?? [])
      .filter((row: any) => (
        String(row.notes ?? "").startsWith("Smart Route product swap")
        && String(row.notes ?? "").includes(`lane ${slotCode}`)
      ))
      .reduce((sum: number, row: any) => sum + Math.max(0, Number(row.quantity ?? 0)), 0);
    if (recordedReturnQty < smartRouteSwap.returnCurrentQty) {
      return NextResponse.json({
        success: false,
        error: `Record the ${smartRouteSwap.returnCurrentQty} returned old units before changing this Smart Route lane in XY.`,
      }, { status: 409 });
    }
  }

  const beforeLayout = await readXyMachineLayout(String(machine.vms_machine_id));
  const beforeSlot = beforeLayout.find((slot) => slot.slotCode === slotCode) ?? null;
  if (!beforeSlot) {
    return NextResponse.json({ success: false, error: "XY no longer reports that slot. Refresh the machine layout." }, { status: 409 });
  }

  const currentStockQty = beforeSlot.currentQty;
  if (!smartRouteSwap && (currentStockQty === null || !Number.isSafeInteger(Number(currentStockQty)) || Number(currentStockQty) < 0)) {
    return NextResponse.json({
      success: false,
      code: "MISSING_XY_STOCK_QTY",
      error: "XY did not report a reliable current stock quantity for this slot. Snacky will not change the product until the lane can be read safely.",
    }, { status: 409 });
  }
  const targetStockQty = zeroStockRelabel ? 0 : verifiedPhysicalSwap ? actualSlotQty : smartRouteSwap ? 0 : Number(currentStockQty);
  if (targetStockQty > 500 || (beforeSlot.capacity !== null && targetStockQty > beforeSlot.capacity)) {
    return NextResponse.json({ success: false, code: "XY_CAPACITY_EXCEEDED", error: "Actual lane stock exceeds the XY lane capacity." }, { status: 400 });
  }

  // An existing pending operation wins. Never allow two remote writers to race
  // over the same physical lane when the machine reconnects.
  const { data: pendingLane, error: pendingLaneError } = await admin.from("xy_pending_slot_changes")
    .select("id,route_id,route_stop_id,target_product_id,target_stock_qty,status")
    .eq("machine_id", machine.id).eq("slot_code", slotCode).eq("status", "pending")
    .maybeSingle();
  if (pendingLaneError) {
    return NextResponse.json({ success: false, error: "Could not verify queued XY lane changes." }, { status: 500 });
  }
  if (pendingLane) {
    if (pendingLane.route_id === routeId && pendingLane.route_stop_id === stopId && pendingLane.target_product_id === productId) {
      if (queueOnOffline && verifiedPhysicalSwap && Number(pendingLane.target_stock_qty ?? -1) !== actualSlotQty) {
        const { error: correctionError } = await admin.from("xy_pending_slot_changes")
          .update({ target_stock_qty: actualSlotQty, updated_at: new Date().toISOString() })
          .eq("id", pendingLane.id).eq("status", "pending");
        if (correctionError) {
          return NextResponse.json({
            success: false, code: "XY_QUEUE_QUANTITY_UPDATE_FAILED",
            error: "Could not update the saved lane quantity. Keep the lane disabled and ask an admin.",
          }, { status: 409 });
        }
      }
      return NextResponse.json({
        success: true, verified: false, queued: true, queueId: pendingLane.id,
        error: null, message: "Change saved in Snacky. XY will be retried automatically after reconnecting. Sellable stock will remain zero until the lane is physically checked/refilled.",
      }, { status: 202 });
    }
    return NextResponse.json({
      success: false, code: "XY_LANE_ALREADY_QUEUED",
      error: "This XY lane already has a different pending change. An admin must resolve it before another change is allowed.",
    }, { status: 409 });
  }

  const targetVmsProductId = String(mapping.vms_product_id);
  const machinePrices = Array.from(new Set(
    beforeLayout
      .filter((slot) => slot.vmsProductId === targetVmsProductId && slot.priceLyd !== null && slot.priceLyd > 0)
      .map((slot) => Number(slot.priceLyd)),
  ));

  if (machinePrices.length > 1 && requestedPrice === null) {
    return NextResponse.json({
      success: false,
      error: `${product.name} currently has more than one XY price on this machine. Snacky will not guess which price to use.`,
      code: "AMBIGUOUS_MACHINE_PRICE",
      prices: machinePrices,
    }, { status: 409 });
  }

  let priceLyd: number | null = requestedPrice ?? (machinePrices.length > 0 ? machinePrices[0] : null);
  if (!priceLyd) {
    const { data: catalog } = await admin
      .from("vms_product_catalog_snapshots")
      .select("selling_price_lyd")
      .eq("vms_product_id", targetVmsProductId)
      .not("selling_price_lyd", "is", null)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    priceLyd = toPositiveNumber(catalog?.selling_price_lyd)
      ?? toPositiveNumber(product.vms_selling_price_lyd)
      ?? toPositiveNumber(product.current_selling_price_lyd);
  }

  if (!priceLyd) {
    return NextResponse.json({
      success: false,
      error: "XY has no reliable selling price for that product, so Snacky will not change the slot yet.",
      code: "MISSING_XY_PRICE",
    }, { status: 409 });
  }

  const write = await setXySlotProduct({
    vmsMachineId: String(machine.vms_machine_id),
    slotCode,
    vmsProductId: targetVmsProductId,
    priceLyd,
    stockQty: targetStockQty,
  });

  if (!write.accepted) {
    await admin.from("system_activity_logs").insert({
      actor_user_id: profile.id,
      actor_team_member_id: profile.team_member_id,
      actor_name: profile.full_name,
      actor_role: profile.role,
      action: "xy_slot_product_change_rejected",
      entity_type: "machine_xy_layout",
      entity_id: machine.id,
      entity_label: machine.name ?? machine.machine_code ?? machine.id,
      before_data: beforeSlot,
      after_data: beforeSlot,
      metadata: {
        route_id: routeId,
        route_stop_id: stopId,
        vms_machine_id: machine.vms_machine_id,
        selected_product_id: product.id,
        selected_vms_product_id: targetVmsProductId,
        slot_code: slotCode,
        price_source: machinePrices.length === 1 ? "same_machine_existing_product" : "xy_catalog_or_product",
        xy_http_status: write.httpStatus,
        xy_code: write.code,
        xy_message: write.message,
        xy_stock_qty_sent: targetStockQty,
        accepted: false,
        smart_route_swap: Boolean(smartRouteSwap),
      },
      summary: `XY rejected slot ${slotCode} product change before machine verification`,
    });

    const xyMachineOffline = /设备不在线|device\s*(?:is\s*)?offline|machine\s*(?:is\s*)?offline|not\s+online/i.test(String(write.message ?? ""));
    if (xyMachineOffline && queueOnOffline) {
      if (currentStockQty === null || !beforeSlot.vmsProductId) {
        return NextResponse.json({
          success: false, code: "XY_QUEUE_REQUIRES_BASELINE",
          error: "XY did not provide a safe original product/quantity baseline for this lane. Save the change for admin review.",
        }, { status: 409 });
      }
      const { data: queued, error: queueError } = await admin.from("xy_pending_slot_changes").insert({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machine.id,
        vms_machine_id: String(machine.vms_machine_id),
        slot_code: slotCode,
        previous_vms_product_id: beforeSlot.vmsProductId,
        previous_stock_qty: Number(currentStockQty),
        target_product_id: product.id,
        target_vms_product_id: targetVmsProductId,
        target_price_lyd: priceLyd,
        target_stock_qty: zeroStockRelabel ? 0 : actualSlotQty,
        physical_change_confirmed: !zeroStockRelabel && verifiedPhysicalSwap,
        lane_disabled_confirmed: !zeroStockRelabel && verifiedPhysicalSwap,
        zero_stock_relabel: zeroStockRelabel,
        smart_route_swap: Boolean(smartRouteSwap),
        created_by_user_id: profile.id,
      }).select("id").single();
      if (queueError || !queued) {
        return NextResponse.json({
          success: false, code: "XY_QUEUE_SAVE_FAILED",
          error: "Could not safely save the change for automatic retry. The machine was not changed.",
        }, { status: 409 });
      }
      return NextResponse.json({
        success: true, verified: false, queued: true, queueId: queued.id,
        message: "Saved in Snacky. XY will retry automatically. The new product starts with zero sellable units until the lane is physically verified and refilled.",
      }, { status: 202 });
    }
    return NextResponse.json({
      success: false,
      verified: false,
      writeAccepted: false,
      xyCode: write.code,
      xyMessage: write.message,
      code: xyMachineOffline ? "XY_MACHINE_OFFLINE" : "XY_WRITE_REJECTED",
      error: xyMachineOffline
        ? "XY says this machine is offline. No product change was made. Check machine power and internet/SIM connection. If powered on, do not mark it as having no electricity. Retry after XY reconnects. Do not load the replacement product until XY verifies the lane change."
        : write.message
          ? `XY rejected this change: ${write.message} No machine change was made.`
          : "XY rejected this change before it reached the machine. No machine change was made.",
      slot: beforeSlot,
    }, { status: xyMachineOffline ? 503 : 502 });
  }

  const verification = await verifyXySlot({
    vmsMachineId: String(machine.vms_machine_id),
    slotCode,
    expectedVmsProductId: targetVmsProductId,
    expectedPriceLyd: priceLyd,
    expectedStockQty: targetStockQty,
  });

  await admin.from("system_activity_logs").insert({
    actor_user_id: profile.id,
    actor_team_member_id: profile.team_member_id,
    actor_name: profile.full_name,
    actor_role: profile.role,
    action: verification.verified ? "xy_slot_product_change" : "xy_slot_product_change_unverified",
    entity_type: "machine_xy_layout",
    entity_id: machine.id,
    entity_label: machine.name ?? machine.machine_code ?? machine.id,
    before_data: beforeSlot,
    after_data: verification.state ?? {
      slotCode,
      vmsProductId: targetVmsProductId,
      productName: product.name,
      priceLyd,
    },
    metadata: {
      route_id: routeId,
      route_stop_id: stopId,
      vms_machine_id: machine.vms_machine_id,
      selected_product_id: product.id,
      selected_vms_product_id: targetVmsProductId,
      price_source: machinePrices.length === 1 ? "same_machine_existing_product" : "xy_catalog_or_product",
      xy_http_status: write.httpStatus,
      xy_code: write.code,
      xy_message: write.message,
      xy_stock_qty_sent: targetStockQty,
      verified: verification.verified,
      smart_route_swap: Boolean(smartRouteSwap),
    },
    summary: `XY slot ${slotCode}: ${beforeSlot.productName ?? beforeSlot.vmsProductId ?? "empty"} → ${product.name}`,
  });

  if (!verification.verified) {
    return NextResponse.json({
      success: false,
      verified: false,
      writeAccepted: write.accepted,
      xyCode: write.code,
      xyMessage: write.message,
      error: "XY accepted the change, but the machine has not reported the new slot yet. Do not send it again. Refresh XY after a moment.",
      slot: verification.state,
    }, { status: 409 });
  }

  return NextResponse.json({
    success: true,
    verified: true,
    product: {
      id: product.id,
      name: product.name,
      imageUrl: product.image_url,
      vmsProductId: targetVmsProductId,
      vmsProductName: mapping.vms_product_name ?? product.name,
      priceLyd,
    },
    slot: verification.state,
  });
}
