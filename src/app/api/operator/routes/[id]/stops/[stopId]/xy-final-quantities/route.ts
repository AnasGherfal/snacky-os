import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

type SlotInput = { slotCode?: unknown; finalQty?: unknown };
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
  const requested = new Map<string, number>();
  for (const value of selections) {
    const slotCode = clean(value?.slotCode);
    const finalQty = whole(value?.finalQty);
    if (!/^\d{3,4}$/.test(slotCode) || finalQty < 0 || requested.has(slotCode)) {
      return NextResponse.json({ error: "Machine selections need unique XY lane codes and nonnegative whole quantities." }, { status: 400 });
    }
    requested.set(slotCode, finalQty);
  }
  if (requested.size === 0) return NextResponse.json({ ok: true, queued: 0 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Protected XY synchronization is unavailable." }, { status: 500 });
  const [{ data: machine, error: machineError }, { data: stock, error: stockError }, { data: relabels, error: relabelError }] = await Promise.all([
    admin.from("machines").select("id,vms_machine_id").eq("id", stop.machine_id).maybeSingle(),
    admin.from("latest_vms_stock_by_slot").select("slot_code,vms_product_id,current_qty,capacity,captured_at")
      .eq("machine_id", stop.machine_id).in("slot_code", Array.from(requested.keys())),
    admin.from("xy_pending_slot_changes").select("slot_code")
      .eq("machine_id", stop.machine_id).eq("status", "pending").in("slot_code", Array.from(requested.keys())),
  ]);
  if (machineError || stockError || relabelError || !machine?.vms_machine_id) {
    return NextResponse.json({ error: "Could not verify the machine and its XY selections." }, { status: 500 });
  }
  if ((relabels ?? []).length) {
    return NextResponse.json({ error: "A selected lane has a pending product change. Wait until its product is verified before setting its sellable stock." }, { status: 409 });
  }
  const bySlot = new Map((stock ?? []).map((s: any) => [clean(s.slot_code), s]));
  const prepared = [];
  for (const [slotCode, finalQty] of requested) {
    const slot = bySlot.get(slotCode);
    const baselineQty = whole(slot?.current_qty);
    const capacity = whole(slot?.capacity);
    const vmsProductId = clean(slot?.vms_product_id);
    if (!slot || !vmsProductId || baselineQty < 0 || capacity <= 0 || finalQty > capacity) {
      return NextResponse.json({ error: `Selection ${slotCode} is missing XY mapping, reliable stock/capacity, or exceeds its capacity.` }, { status: 409 });
    }
    prepared.push({
      route_id: routeId, route_stop_id: stopId, machine_id: stop.machine_id,
      vms_machine_id: String(machine.vms_machine_id), slot_code: slotCode,
      expected_vms_product_id: vmsProductId,
      expected_xy_qty: baselineQty, target_qty: finalQty, max_capacity: capacity,
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
