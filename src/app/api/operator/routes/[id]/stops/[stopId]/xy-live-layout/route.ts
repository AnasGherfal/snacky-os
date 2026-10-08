import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { readXyMachineLayout } from "@/lib/xy-vms-control";

const clean = (value: unknown) => String(value ?? "").trim();

/** Fresh direct XY read, NOT the last imported VMS inventory snapshot.
 * Failure is reported explicitly so the phone never labels cached data "Live".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  const token = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(token);
  if (!client || !profile || !token) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id,operator_id").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id,route_id,machine_id").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) return NextResponse.json({ error: "Could not check route access." }, { status: 500 });
  if (!route || !stop || stop.route_id !== routeId) return NextResponse.json({ error: "Stop not found." }, { status: 404 });
  const access = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(access, route.operator_id)) {
    return NextResponse.json({ error: "This route is not assigned to you." }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Machine live-read service is unavailable." }, { status: 500 });
  const [{ data: machine, error: machineError }, { data: hidden, error: hiddenError }] = await Promise.all([
    admin.from("machines").select("id,vms_machine_id").eq("id", stop.machine_id).maybeSingle(),
    admin.from("xy_hidden_machine_selections").select("slot_code").eq("machine_id", stop.machine_id),
  ]);
  if (machineError || hiddenError || !machine?.vms_machine_id) {
    return NextResponse.json({ error: "XY machine mapping unavailable." }, { status: 503 });
  }

  try {
    const slots = await readXyMachineLayout(String(machine.vms_machine_id));
    if (!slots.length) throw new Error("XY returned no selections.");
    const hiddenCodes = new Set((hidden ?? []).map((row: any) => clean(row.slot_code)));
    const productIds = Array.from(new Set(slots.map((slot) => clean(slot.vmsProductId)).filter(Boolean)));
    const { data: mappings, error: mappingError } = await admin
      .from("vms_product_mappings")
      .select("vms_product_id,product_id,snacky_product_name")
      .in("vms_product_id", productIds);
    if (mappingError) {
      console.warn("[operator:live-xy] Product mapping unavailable", mappingError);
    }
    const mappingByCode = new Map(
      (mappings ?? []).map((row: any) => [clean(row.vms_product_id), row]),
    );

    return NextResponse.json({
      ok: true,
      source: "xy_live",
      fetchedAt: new Date().toISOString(),
      slots: slots.filter((slot) => !hiddenCodes.has(slot.slotCode)).map((slot) => {
        const mapping = mappingByCode.get(clean(slot.vmsProductId));
        return {
          slotCode: slot.slotCode,
          vmsProductId: slot.vmsProductId,
          productId: mapping?.product_id ?? null,
          productName: clean(slot.productName) || clean(mapping?.snacky_product_name) || clean(slot.vmsProductId) || "Unknown XY product",
          currentQty: slot.currentQty,
          capacity: slot.capacity,
          priceLyd: slot.priceLyd,
        };
      }),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.warn("[operator:live-xy] Vendor read failed", {
      routeId, stopId, error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({
      ok: false, source: "cached_import",
      error: "XY could not be reached right now. Shown values are from the last imported snapshot, NOT live XY.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
