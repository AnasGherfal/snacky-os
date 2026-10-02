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

function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || String(row?.message ?? "").includes("route_stop_safety_checks");
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
  if (!accessToken || !profile) return { error: NextResponse.json({ success: false, code: "SESSION_EXPIRED", error: "Session expired. Please sign in again." }, { status: 401 }) };
  if (!client) return { error: NextResponse.json({ success: false, code: "NO_SUPABASE", error: "Database is not available." }, { status: 500 }) };

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) return { error: NextResponse.json({ success: false, code: "CONTEXT_LOAD_FAILED", error: errorMessage(routeError ?? stopError) }, { status: 500 }) };
  if (!route || !stop || stop.route_id !== routeId) return { error: NextResponse.json({ success: false, code: "STOP_NOT_FOUND", error: "Route stop was not found." }, { status: 404 }) };

  const routeAccessProfile = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return { error: NextResponse.json({ success: false, code: "UNAUTHORIZED", error: "This route is not assigned to you." }, { status: 403 }) };
  }
  return { profile, client, writeClient: getSupabaseAdminClient() ?? client, route, stop };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  const { data, error } = await context.client
    .from("route_stop_safety_checks")
    .select("id, compressor_confirmed, proof_photo_url, proof_photo_path, proof_photo_original_name, confirmed_at")
    .eq("route_stop_id", stopId)
    .maybeSingle();
  if (error && isMissingTable(error)) return NextResponse.json({ success: true, installed: false, confirmed: false, proof: null });
  if (error) return NextResponse.json({ success: false, installed: true, code: "SAFETY_LOAD_FAILED", error: errorMessage(error) }, { status: 500 });
  return NextResponse.json({ success: true, installed: true, confirmed: Boolean(data?.compressor_confirmed && (data?.proof_photo_url || data?.proof_photo_path)), proof: data ?? null });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, code: "INVALID_JSON", error: "Invalid compressor proof payload." }, { status: 400 });
  }

  const compressorConfirmed = payload.compressorConfirmed === true;
  const proofPhotoUrl = clean(payload.proofPhotoUrl) || null;
  const proofPhotoPath = clean(payload.proofPhotoPath) || null;
  const proofPhotoOriginalName = clean(payload.proofPhotoOriginalName) || null;
  if (!compressorConfirmed) return NextResponse.json({ success: false, code: "COMPRESSOR_NOT_CONFIRMED", error: "Confirm that the compressor is switched on." }, { status: 400 });
  if (!proofPhotoUrl && !proofPhotoPath) return NextResponse.json({ success: false, code: "PROOF_REQUIRED", error: "Take a photo showing the compressor switch or running indicator on." }, { status: 400 });

  const now = new Date().toISOString();
  const row = {
    route_id: routeId,
    route_stop_id: stopId,
    machine_id: context.stop.machine_id,
    operator_id: context.route.operator_id ?? context.profile.team_member_id ?? null,
    compressor_confirmed: true,
    proof_photo_url: proofPhotoUrl,
    proof_photo_path: proofPhotoPath,
    proof_photo_original_name: proofPhotoOriginalName,
    confirmed_at: now,
    created_by_user_id: context.profile.id,
    updated_at: now,
  };
  const { data, error } = await context.writeClient
    .from("route_stop_safety_checks")
    .upsert(row, { onConflict: "route_stop_id" })
    .select("id, compressor_confirmed, proof_photo_url, proof_photo_path, proof_photo_original_name, confirmed_at")
    .single();
  if (error && isMissingTable(error)) return NextResponse.json({ success: false, installed: false, code: "SAFETY_SETUP_REQUIRED", error: "Apply the compressor safety migration before enforcing this check." }, { status: 503 });
  if (error) return NextResponse.json({ success: false, installed: true, code: "SAFETY_SAVE_FAILED", error: errorMessage(error) }, { status: 500 });

  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
  revalidatePath(`/routes/${routeId}`);
  revalidatePath("/reports/route-product-activity");
  return NextResponse.json({ success: true, installed: true, confirmed: true, proof: data });
}
