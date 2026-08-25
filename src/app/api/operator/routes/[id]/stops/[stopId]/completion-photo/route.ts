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

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown database error";
}

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
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return { error: NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 }) };
  }

  const { data: machine, error: machineError } = await client
    .from("machines")
    .select("id, name, machine_code")
    .eq("id", stop.machine_id)
    .maybeSingle();
  if (machineError || !machine) return { error: NextResponse.json({ success: false, error: errorMessage(machineError) || "Machine not found." }, { status: 500 }) };

  return { profile, client, writeClient: getSupabaseAdminClient() ?? client, route, stop, machine };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  // Persisted completion proof must be read with the same server client used to write it.
  // Operators can have narrower RLS access than the server-side persistence path.
  const { data, error } = await context.writeClient
    .from("machine_refill_history")
    .select("machine_photo_url, machine_photo_path, updated_at")
    .eq("legacy_refill_id", `route_stop:${stopId}`)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  return NextResponse.json({
    success: true,
    machineId: context.stop.machine_id,
    machineName: context.machine.name,
    saved: Boolean(data?.machine_photo_url || data?.machine_photo_path),
    photoUrl: data?.machine_photo_url ?? null,
    photoPath: data?.machine_photo_path ?? null,
    savedAt: data?.updated_at ?? null,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ success: false, error: "Invalid machine photo payload." }, { status: 400 }); }

  const photoUrl = clean(payload.photoUrl) || null;
  const photoPath = clean(payload.photoPath) || null;
  if (!photoUrl && !photoPath) return NextResponse.json({ success: false, error: "Take or upload a machine photo first." }, { status: 400 });

  const key = `route_stop:${stopId}`;
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await context.writeClient
    .from("machine_refill_history")
    .select("id")
    .eq("legacy_refill_id", key)
    .maybeSingle();
  if (existingError) return NextResponse.json({ success: false, error: errorMessage(existingError) }, { status: 500 });

  const operatorId = context.route.operator_id ?? context.profile.team_member_id ?? null;
  const mutation = existing?.id
    ? context.writeClient.from("machine_refill_history").update({ machine_photo_url: photoUrl, machine_photo_path: photoPath, updated_at: now }).eq("id", existing.id)
    : context.writeClient.from("machine_refill_history").insert({
        legacy_refill_id: key,
        refill_at: now,
        machine_id: context.machine.id,
        machine_name: context.machine.name || context.machine.machine_code || "Machine",
        operator_id: operatorId,
        machine_photo_url: photoUrl,
        machine_photo_path: photoPath,
        source_file: "Snacky OS route stop",
        import_status: "imported",
        route_id: routeId,
        route_stop_id: stopId,
        raw_record: { precompletion_photo_saved: true },
      });
  const { error } = await mutation;
  if (error) return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });

  revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
  revalidatePath(`/routes/${routeId}`);
  return NextResponse.json({ success: true, saved: true, photoUrl, photoPath, savedAt: now });
}
