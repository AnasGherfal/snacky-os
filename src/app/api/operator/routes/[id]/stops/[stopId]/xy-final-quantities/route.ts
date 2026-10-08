import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

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
  const selections = payload.selections as SlotInput[];
  const requested = new Map<string, { finalQty: number | null; priceLyd: number | null }>();
  for (const value of selections) {
    const slotCode = clean(value?.slotCode);
    const hasStock = value.finalQty !== null && value.finalQty !== undefined;
    const hasPrice = value.priceLyd !== null && value.priceLyd !== undefined;
    const finalQty = hasStock ? whole(value.finalQty) : null;
    const priceLyd = hasPrice ? Number(value.priceLyd) : null;
    if (!/^\d{3,4}$/.test(slotCode) || requested.has(slotCode) || (!hasStock && !hasPrice)
      || (hasStock && (finalQty === null || finalQty < 0))
      || (hasPrice && (priceLyd === null || !Number.isFinite(priceLyd)
        || priceLyd <= 0 || priceLyd > 1000
        || Math.abs(priceLyd * 100 - Math.round(priceLyd * 100)) > 0.00001))) {
      return NextResponse.json({ error: "Enter a valid selection and final quantity and/or selling price." }, { status: 400 });
    }
    requested.set(slotCode, { finalQty, priceLyd });
  }
  if (requested.size === 0) return NextResponse.json({ ok: true, queued: 0 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Protected XY synchronization is unavailable." }, { status: 500 });
  const [{ data: machine, error: machineError }, { data: stock, error: stockError }, { data: relabels, error: relabelError }, { data: hidden, error: hiddenError }, { data: prices, error: pricesError }] = await Promise.all([
    admin.from("machines").select("id,vms_machine_id").eq("id", stop.machine_id).maybeSingle(),
    admin.from("latest_vms_stock_by_slot").select("slot_code,vms_product_id,current_qty,capacity,captured_at")
      .eq("machine_id", stop.machine_id).in("slot_code", Array.from(requested.keys())),
    admin.from("xy_pending_slot_changes").select("slot_code")
      .eq("machine_id", stop.machine_id).eq("status", "pending").in("slot_code", Array.from(requested.keys())),
    admin.from("xy_hidden_machine_selections").select("slot_code").eq("machine_id", stop.machine_id)
      .in("slot_code", Array.from(requested.keys())),
    admin.from("vms_stock_snapshots").select("slot_code,vms_selling_price_lyd,captured_at")
      .eq("machine_id", stop.machine_id).eq("source_provider","xy")
      .in("slot_code", Array.from(requested.keys())).order("captured_at", { ascending: false }).limit(500),
  ]);
  if (machineError || stockError || relabelError || hiddenError || pricesError || !machine?.vms_machine_id) {
    return NextResponse.json({ error: "Could not verify the machine and its XY selections." }, { status: 500 });
  }
  if ((hidden ?? []).length) return NextResponse.json({ error: "A selected channel is marked physically absent; restore it before editing." }, { status: 409 });
  if ((relabels ?? []).length) {
    return NextResponse.json({ error: "A selected lane has a pending product change. Wait until its product is verified before setting its sellable stock." }, { status: 409 });
  }
  const bySlot = new Map((stock ?? []).map((s: any) => [clean(s.slot_code), s]));
  const priceBySlot = new Map<string, number>();
  (prices ?? []).forEach((row: any) => {
    const code = clean(row.slot_code);
    const price = Number(row.vms_selling_price_lyd);
    if (!priceBySlot.has(code) && Number.isFinite(price) && price > 0) priceBySlot.set(code, price);
  });
  const prepared = [];
  for (const [slotCode, change] of requested) {
    const slot = bySlot.get(slotCode);
    const baselineQty = whole(slot?.current_qty);
    const capacity = whole(slot?.capacity);
    const vmsProductId = clean(slot?.vms_product_id);
    const oldPrice = priceBySlot.get(slotCode) ?? null;
    const nextQty = change.finalQty ?? baselineQty;
    if (!slot || !vmsProductId || baselineQty < 0 || capacity <= 0 || nextQty > capacity
      || (change.priceLyd !== null && oldPrice === null)) {
      return NextResponse.json({ error: `Selection ${slotCode} has no verified XY mapping, capacity or price baseline. Nothing was changed.` }, { status: 409 });
    }
    prepared.push({
      route_id: routeId, route_stop_id: stopId, machine_id: stop.machine_id,
      vms_machine_id: String(machine.vms_machine_id), slot_code: slotCode,
      expected_vms_product_id: vmsProductId,
      expected_xy_qty: baselineQty, target_qty: nextQty, max_capacity: capacity,
      expected_price_lyd: change.priceLyd === null ? null : oldPrice,
      target_price_lyd: change.priceLyd,
      update_stock: change.finalQty !== null,
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
  return NextResponse.json({ ok: true, queued: saved?.length ?? prepared.length });
}
