import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canExecuteRoutes } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ id: string; stopId: string }> };
const respond = (status: number, value: Record<string, unknown>) =>
  NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function scope(routeId: string, stopId: string) {
  if (!uuid.test(routeId) || !uuid.test(stopId)) return null;
  const profile = await getCurrentProfile();
  const db = await getAuthenticatedSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  if (!profile?.team_member_id || !db || !admin || !canExecuteRoutes(profile)) return null;
  const access = await buildOperatorRouteAccessContext(db, profile);
  const routeResult = await db.from("routes").select("id, operator_id").eq("id", routeId).maybeSingle();
  if (routeResult.error || !routeResult.data || !canAccessOperatorRoute(access, routeResult.data.operator_id)) return null;
  const stopResult = await db.from("route_stops").select("id, route_id, machine_id, status")
    .eq("id", stopId).maybeSingle();
  const stop = stopResult.data;
  if (stopResult.error || !stop || stop.route_id !== routeId || !stop.machine_id) return null;
  const policyResult = await admin.from("cash_refill_policy")
    .select("enabled, pilot_machine_ids").eq("id", 1).maybeSingle();
  if (policyResult.error) return null;
  const pilot = Array.isArray(policyResult.data?.pilot_machine_ids) ? policyResult.data.pilot_machine_ids : [];
  const required = Boolean(policyResult.data?.enabled) && (pilot.length === 0 || pilot.includes(stop.machine_id));
  return { profile, db, admin, stop, required };
}

export async function GET(_request: Request, { params }: Params) {
  const { id, stopId } = await params;
  const ctx = await scope(id, stopId);
  if (!ctx) return respond(403, { ok: false, error: "Access denied or cash settings unavailable." });
  const { data, error } = await ctx.admin.from("route_stop_cash_receipts")
    .select("state, bag_id, collection_id, exception_reason").eq("route_stop_id", stopId).maybeSingle();
  if (error) return respond(503, { ok: false, error: "Could not load cash collection status." });
  return respond(200, {
    ok: true, required: ctx.required, status: data?.state ?? null,
    bagId: data?.bag_id ?? null, collectionId: data?.collection_id ?? null,
    exceptionReason: data?.exception_reason ?? null,
    completed: ctx.stop.status === "completed",
  });
}
