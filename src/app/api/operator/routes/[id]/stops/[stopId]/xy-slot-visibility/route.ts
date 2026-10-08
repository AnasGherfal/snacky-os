import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  const admin = getSupabaseAdminClient();
  if (!accessToken || !profile || !client) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!admin) return NextResponse.json({ error: "Protected machine selection configuration unavailable." }, { status: 500 });

  let payload: { slotCode?: unknown; hidden?: unknown };
  try { payload = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const slotCode = String(payload.slotCode ?? "").trim();
  const hidden = payload.hidden;
  if (!/^\d{3,4}$/.test(slotCode) || typeof hidden !== "boolean") {
    return NextResponse.json({ error: "A valid selection code and visibility are required." }, { status: 400 });
  }

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id,operator_id").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id,route_id,machine_id").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError || !route || !stop || stop.route_id !== routeId) {
    return NextResponse.json({ error: "Could not verify this route." }, { status: 404 });
  }
  const access = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(access, route.operator_id)) {
    return NextResponse.json({ error: "This machine is not assigned to you." }, { status: 403 });
  }

  if (hidden) {
    const [{ data: stock }, { data: queuedStock }, { data: queuedRelabel }] = await Promise.all([
      admin.from("latest_vms_stock_by_slot").select("slot_code").eq("machine_id", stop.machine_id).eq("slot_code", slotCode).maybeSingle(),
      admin.from("xy_stop_quantity_syncs").select("id").eq("machine_id", stop.machine_id).eq("slot_code", slotCode).eq("status", "pending").limit(1),
      admin.from("xy_pending_slot_changes").select("id").eq("machine_id", stop.machine_id).eq("slot_code", slotCode).eq("status", "pending").limit(1),
    ]);
    if (!stock) return NextResponse.json({ error: "This selection is not in the imported machine layout." }, { status: 409 });
    if (queuedStock?.length || queuedRelabel?.length) {
      return NextResponse.json({ error: "This selection has a pending XY update; resolve it before hiding the lane." }, { status: 409 });
    }
    const { error } = await admin.from("xy_hidden_machine_selections").upsert({
      machine_id: stop.machine_id, slot_code: slotCode,
      reason: "Marked physically absent from machine by operator",
      updated_by_user_id: profile.id, updated_at: new Date().toISOString(),
    }, { onConflict: "machine_id,slot_code" });
    if (error) return NextResponse.json({ error: "Could not hide this selection." }, { status: 500 });
  } else {
    const { error } = await admin.from("xy_hidden_machine_selections")
      .delete().eq("machine_id", stop.machine_id).eq("slot_code", slotCode);
    if (error) return NextResponse.json({ error: "Could not restore this selection." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, slotCode, hidden });
}
