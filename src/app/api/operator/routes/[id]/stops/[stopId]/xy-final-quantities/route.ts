import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { readXyMachineLayout } from "@/lib/xy-vms-control";

type SlotInput = { slotCode?: unknown; finalQty?: unknown; priceLyd?: unknown };
const clean = (value: unknown) => String(value ?? "").trim();
const whole = (value: unknown) => Number.isSafeInteger(Number(value)) ? Number(value) : -1;
const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));

/** Save ONLY selected real XY final-lane quantities, never route bag refills.
 * The worker waits for Complete Stop and checks the live original product + stock
 * baseline before changing anything remotely.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!uuid(routeId) || !uuid(stopId)) return NextResponse.json({ error: "Invalid stop." }, { status: 400 });
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  if (!accessToken || !profile || !client) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id,operator_id,status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id,route_id,machine_id,status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) return NextResponse.json({ error: "Could not load this route stop." }, { status: 500 });
  if (!route || !stop || stop.route_id !== routeId) return NextResponse.json({ error: "Stop not found." }, { status: 404 });
  const access = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(access, route.operator_id)) return NextResponse.json({ error: "Not assigned to this route." }, { status: 403 });
  if (["completed", "reviewed", "skipped", "cancelled", "canceled"].includes(clean(stop.status).toLowerCase())
    || ["completed", "reviewed", "cancelled", "canceled"].includes(clean(route.status).toLowerCase())) {
    return NextResponse.json({ error: "This route stop is already closed." }, { status: 409 });
  }

  let payload: Record<string, unknown>;
  try { payload = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid quantity input." }, { status: 400 }); }
  if (!Array.isArray(payload.selections) || payload.selections.length > 120) {
    return NextResponse.json({ error: "Too many machine selections." }, { status: 400 });
  }
  const applyImmediately = payload.applyImmediately === true;
  const selections = payload.selections as SlotInput[];
  const requested = new Map<string, { finalQty: number | null; priceLyd: number | null }>();
  for (const value of selections) {
    const slotCode = clean(value?.slotCode);
    const hasStock = value?.finalQty !== undefined && value?.finalQty !== null;
    const hasPrice = value?.priceLyd !== undefined && value?.priceLyd !== null;
    const finalQty = hasStock ? whole(value?.finalQty) : null;
    const priceLyd = hasPrice ? Number(value?.priceLyd) : null;
    if (!/^\d{3,4}$/.test(slotCode) || requested.has(slotCode)
      || (!hasStock && !hasPrice)
      || (hasStock && (finalQty === null || finalQty < 0))
      || (hasPrice && (priceLyd === null || !Number.isFinite(priceLyd)
        || priceLyd <= 0 || priceLyd > 1000
        || Math.abs(priceLyd * 100 - Math.round(priceLyd * 100)) > 0.0001))) {
      return NextResponse.json({ error: "Each selection must have a valid final quantity and/or price in LYD." }, { status: 400 });
    }
    requested.set(slotCode, { finalQty, priceLyd });
  }
  if (requested.size === 0) return NextResponse.json({ ok: true, queued: 0 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Protected XY synchronization is unavailable." }, { status: 500 });
  const [{ data: machine, error: machineError }, { data: stock, error: stockError }, { data: relabels, error: relabelError }, { data: hidden, error: hiddenError }] = await Promise.all([
    admin.from("machines").select("id,vms_machine_id").eq("id", stop.machine_id).maybeSingle(),
    admin.from("latest_vms_stock_by_slot").select("slot_code,vms_product_id,current_qty,capacity,captured_at,import_batch_id")
      .eq("machine_id", stop.machine_id).in("slot_code", Array.from(requested.keys())),
    admin.from("xy_pending_slot_changes").select("slot_code")
      .eq("machine_id", stop.machine_id).eq("status", "pending").in("slot_code", Array.from(requested.keys())),
    admin.from("xy_hidden_machine_selections").select("slot_code")
      .eq("machine_id", stop.machine_id).in("slot_code", Array.from(requested.keys())),
  ]);
  if (machineError || stockError || relabelError || hiddenError || !machine?.vms_machine_id) {
    return NextResponse.json({ error: "Could not verify the machine and its XY selections." }, { status: 500 });
  }
  if ((hidden ?? []).length) {
    return NextResponse.json({ error: "A selected lane is hidden because it is not physically present." }, { status: 409 });
  }
  if ((relabels ?? []).length) {
    return NextResponse.json({ error: "A selected lane has a pending product change. Wait until its product is verified before setting its sellable stock." }, { status: 409 });
  }
  const batchId = clean((stock ?? [])[0]?.import_batch_id);
  const { data: priceRows, error: priceError } = batchId
    ? await admin.from("vms_stock_snapshots").select("slot_code,vms_selling_price_lyd")
        .eq("machine_id", stop.machine_id).eq("import_batch_id", batchId)
        .eq("source_provider", "xy").in("slot_code", Array.from(requested.keys()))
    : { data: [], error: null };
  if (priceError) return NextResponse.json({ error: "Could not verify XY prices. No quantities were queued." }, { status: 503 });
  const priceBySlot = new Map((priceRows ?? []).map((row: any) =>
    [clean(row.slot_code), Number(row.vms_selling_price_lyd)] as const));
  const bySlot = new Map((stock ?? []).map((s: any) => [clean(s.slot_code), s]));
  // A confirmed selection edit should compare against a direct XY read, not
  // pretend the most recent import is current. If XY is offline, use the
  // explicit cached baseline and let the async worker detect any conflict.
  let directSlots: Awaited<ReturnType<typeof readXyMachineLayout>> | null = null;
  if (applyImmediately) {
    try {
      directSlots = await readXyMachineLayout(String(machine.vms_machine_id));
    } catch (error) {
      console.warn("[operator:save-selection] XY unreachable; queued with imported baseline", {
        routeId, stopId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const directBySlot = new Map((directSlots ?? []).map((slot) => [slot.slotCode, slot]));
  const prepared = [];
  for (const [slotCode, selection] of requested) {
    const { finalQty, priceLyd } = selection;
    const slot = bySlot.get(slotCode);
    const liveSlot = directBySlot.get(slotCode);
    if (applyImmediately && directSlots && !liveSlot) {
      return NextResponse.json({ error: `Selection ${slotCode} is not present in XY's current layout.` }, { status: 409 });
    }
    const baselineQty = whole(liveSlot?.currentQty ?? slot?.current_qty);
    const capacity = whole(liveSlot?.capacity ?? slot?.capacity);
    const vmsProductId = clean(liveSlot?.vmsProductId ?? slot?.vms_product_id);
    if (!slot || !vmsProductId || baselineQty < 0 || capacity <= 0 || (finalQty !== null && finalQty > capacity)) {
      return NextResponse.json({ error: `Selection ${slotCode} is missing XY mapping, reliable stock/capacity, or exceeds its capacity.` }, { status: 409 });
    }
    const originalPrice = liveSlot?.priceLyd ?? priceBySlot.get(slotCode);
    if (priceLyd !== null && (!originalPrice || !Number.isFinite(originalPrice) || originalPrice <= 0)) {
      return NextResponse.json({ error: `Selection ${slotCode} has no reliable previous XY price; retry after refreshing XY.` }, { status: 409 });
    }
    prepared.push({
      route_id: routeId, route_stop_id: stopId, machine_id: stop.machine_id,
      vms_machine_id: String(machine.vms_machine_id), slot_code: slotCode,
      expected_vms_product_id: vmsProductId,
      expected_xy_qty: baselineQty, target_qty: finalQty ?? baselineQty, max_capacity: capacity,
      expected_price_lyd: priceLyd === null ? null : originalPrice,
      target_price_lyd: priceLyd,
      update_stock: finalQty !== null,
      apply_immediately: applyImmediately,
      status: "pending", attempt_count: 0, next_attempt_at: new Date().toISOString(),
      last_error: null, verified_at: null, last_attempt_at: null,
      created_by_user_id: profile.id, updated_at: new Date().toISOString(),
    });
  }

  const { data: saved, error: saveError } = await admin.from("xy_stop_quantity_syncs")
    .upsert(prepared, { onConflict: "route_stop_id,slot_code" })
    .select("id,slot_code,status");
  if (saveError) {
    console.error("[operator:XY-quantity-queue] Save failed", { routeId, stopId, error: saveError });
    return NextResponse.json({ error: "Could not save XY selection changes. The route has not been completed; retry." }, { status: 409 });
  }
  return NextResponse.json({
    ok: true, queued: saved?.length ?? prepared.length,
    syncStatus: "pending",
    baselineSource: directSlots ? "xy_live" : "last_import",
    message: "Saved in Snacky. XY synchronization will run in the background.",
  });
}
