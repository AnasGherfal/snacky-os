import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canExecuteRoutes } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { uploadCashEvidence, removeCashEvidence } from "@/lib/cash-evidence";
import { readCompanyBody } from "@/lib/company-request";

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
  if (!profile?.team_member_id || profile.active_status !== "active" || !db || !admin || !canExecuteRoutes(profile)) return null;
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
  const required = Boolean(policyResult.data?.enabled) && pilot.length > 0 && pilot.includes(stop.machine_id);
  return { profile, db, admin, stop, required };
}

export async function GET(_request: Request, { params }: Params) {
  const { id, stopId } = await params;
  const ctx = await scope(id, stopId);
  if (!ctx) return respond(403, { ok: false, error: "Access denied or cash settings unavailable." });
  const { data, error } = await ctx.admin.from("route_stop_cash_receipts")
    .select("state, bag_id, collection_id, exception_reason, request_id").eq("route_stop_id", stopId).maybeSingle();
  if (error) return respond(503, { ok: false, error: "Could not load cash collection status." });
  return respond(200, {
    ok: true, required: ctx.required, status: data?.state ?? null,
    bagId: data?.bag_id ?? null, collectionId: data?.collection_id ?? null,
    requestId: data?.state === "pending" ? data.request_id : null,
    exceptionReason: data?.exception_reason ?? null,
    completed: ctx.stop.status === "completed",
  });
}

const bagIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const validCompartments = new Set(["notes", "coins", "recycler", "change_float"]);
const validReasons = new Set(["unsafe", "machine_offline", "cash_access_blocked", "other"]);

export async function POST(request: Request, { params }: Params) {
  const { id, stopId } = await params;
  try {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== new URL(request.url).host) return respond(403, { ok: false, error: "Invalid origin." });
  } catch { return respond(403, { ok: false, error: "Invalid origin." }); }
  const ctx = await scope(id, stopId);
  if (!ctx) return respond(403, { ok: false, error: "Not authorized." });
  if (["completed", "skipped", "canceled"].includes(ctx.stop.status)) return respond(409, { ok: false, error: "Stop already closed." });
  let form: FormData;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) throw Error("Invalid content type");
    const bytes = await readCompanyBody(request, 3 * 1024 * 1024 + 18000);
    form = await new Request(request.url, {
      method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(bytes).buffer,
    }).formData();
  } catch { return respond(400, { ok: false, error: "Invalid form or photo exceeds 3 MB." }); }
  const decision = String(form.get("decision") ?? "");
  const requestId = String(form.get("request_id") ?? "");
  if (!uuid.test(requestId) || !["collected", "exception"].includes(decision)) return respond(400, { ok: false, error: "Invalid cash request." });

  const prev = await ctx.admin.from("route_stop_cash_receipts").select("*").eq("route_stop_id", stopId).maybeSingle();
  if (prev.error) return respond(503, { ok: false, error: "Cash record unavailable." });
  if (prev.data && (prev.data.request_id !== requestId || prev.data.route_id !== id || prev.data.machine_id !== ctx.stop.machine_id))
    return respond(409, { ok: false, error: "Another record is already linked to this stop." });
  if (prev.data && ["collected", "exception"].includes(prev.data.state))
    return respond(200, { ok: true, state: prev.data.state, bagId: prev.data.bag_id, collectionId: prev.data.collection_id, replayed: true });

  if (decision === "exception") {
    const reason = String(form.get("reason") ?? "");
    const notes = String(form.get("notes") ?? "").trim();
    if (!validReasons.has(reason) || notes.length < 5 || notes.length > 800)
      return respond(400, { ok: false, error: "Explain why cash could not be removed." });
    if (prev.data) return respond(409, { ok: false, error: "An earlier collection is pending; retry it." });
    const { error } = await ctx.admin.from("route_stop_cash_receipts").insert({
      route_stop_id: stopId, route_id: id, machine_id: ctx.stop.machine_id,
      operator_id: ctx.profile.team_member_id, request_id: requestId,
      state: "exception", exception_reason: reason, exception_notes: notes,
    });
    return error ? respond(error.code === "23505" ? 409 : 503, { ok: false, error: "Could not record exception." })
      : respond(200, { ok: true, state: "exception" });
  }

  const bagId = String(form.get("bag_id") ?? "").trim().toUpperCase();
  const photo = form.get("photo");
  const compartments = Array.from(new Set(form.getAll("compartments").map(x => String(x)).filter(Boolean)));
  const removalType = String(form.get("removal_type") ?? "");
  const notes = String(form.get("notes") ?? "").trim();
  if (!bagIdPattern.test(bagId) || !compartments.length || compartments.some(x => !validCompartments.has(x))
    || !["full", "partial"].includes(removalType) || (removalType === "partial" && notes.length < 5))
    return respond(400, { ok: false, error: "Check the bag ID, compartments and partial-removal reason." });
  if (!(photo instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(photo.type)
    || photo.size < 1 || photo.size > 3 * 1024 * 1024)
    return respond(400, { ok: false, error: "A sealed-bag photo under 3 MB is required." });

  if (!prev.data) {
    const { error } = await ctx.admin.from("route_stop_cash_receipts").insert({
      route_stop_id: stopId, route_id: id, machine_id: ctx.stop.machine_id,
      operator_id: ctx.profile.team_member_id, request_id: requestId,
      bag_id: bagId, state: "pending",
    });
    if (error) return respond(error.code === "23505" ? 409 : 503, { ok: false, error: "Cash entry already in progress." });
  } else if (prev.data.state !== "pending" || prev.data.bag_id !== bagId
    || prev.data.operator_id !== ctx.profile.team_member_id) {
    return respond(409, { ok: false, error: "Retry the original bag and operator record." });
  }
  return savePhysicalCollection({ ctx, requestId, bagId, photo, compartments, removalType, notes, routeId: id, stopId });
}

type CollectionInput = {
  ctx: NonNullable<Awaited<ReturnType<typeof scope>>>;
  requestId: string;
  bagId: string;
  photo: File;
  compartments: string[];
  removalType: string;
  notes: string;
  routeId: string;
  stopId: string;
};

async function savePhysicalCollection(input: CollectionInput) {
  const { ctx, requestId, bagId, photo, compartments, removalType, notes, routeId, stopId } = input;
  let evidence: Awaited<ReturnType<typeof uploadCashEvidence>> = null;
  try {
    evidence = await uploadCashEvidence(photo, { scopeId: requestId, stage: "removed", required: true });
  } catch {
    return respond(400, { ok: false, error: "Could not upload seal photo. Retry this collection." });
  }

  let result: { collection_ids?: string[]; replayed?: boolean } | null = null;
  try {
    const response = await ctx.db.rpc("record_standalone_cash_removal_group_v1", {
      p_boxes: [{
        box_key: "box-1", cash_bag_id: bagId,
        removal_evidence_path: evidence?.path,
        removal_evidence_file_name: evidence?.fileName,
        machines: [{ machine_id: ctx.stop.machine_id, removed_amount_lyd: null }],
      }],
      p_removed_at: (await ctx.admin.from("route_stop_cash_receipts")
        .select("created_at").eq("route_stop_id", stopId).single()).data?.created_at ?? new Date().toISOString(),
      p_removal_type: removalType,
      p_compartments: compartments,
      p_notes: notes || null,
      p_client_submission_id: requestId,
    });
    if (response.error) throw response.error;
    result = response.data as { collection_ids?: string[]; replayed?: boolean } | null;
  } catch (failure) {
    const code = failure && typeof failure === "object" && "code" in failure
      ? String((failure as { code?: unknown }).code ?? "") : "";
    if (code === "23505") {
      // Unique-bag rejections are definitive, but only release the pending
      // stop after checking that no original collection committed for this
      // submission. Ambiguous network failures always remain retryable.
      const committed = await ctx.admin.from("cash_collections")
        .select("id").eq("removal_group_id", requestId).limit(1);
      if (!committed.error && !committed.data?.length) {
        const released = await ctx.admin.from("route_stop_cash_receipts")
          .delete()
          .eq("route_stop_id", stopId)
          .eq("request_id", requestId)
          .eq("state", "pending")
          .select("route_stop_id");
        if (!released.error && released.data?.length === 1) {
          if (evidence) await removeCashEvidence(evidence);
          return respond(409, {
            ok: false, code: "BAG_ALREADY_USED", retryable: false,
            error: "رقم الكيس مستخدم من قبل. استخدم كيساً جديداً برقم مختلف وسجل السحب.",
          });
        }
      }
    }
    // The existing cash RPC is idempotent by request ID. Even if a response is
    // lost, reuse the SAME ID and bag; never create a replacement cash record.
    return respond(503, {
      ok: false, retryable: true,
      error: "Collection not confirmed. Do not take cash a second time. Retry this entry.",
    });
  }
  const collectionId = result?.collection_ids?.[0];
  if (!collectionId || !uuid.test(collectionId) || result?.collection_ids?.length !== 1) {
    return respond(503, { ok: false, retryable: true, error: "Collection receipt unavailable. Retry the same entry." });
  }

  try {
    const source = await ctx.admin.from("cash_collections")
      .select("id, machine_id, operator_id, cash_bag_id, route_id").eq("id", collectionId).maybeSingle();
    const saved = source.data;
    if (source.error || !saved || saved.machine_id !== ctx.stop.machine_id
      || saved.operator_id !== ctx.profile.team_member_id
      || saved.cash_bag_id !== bagId || (saved.route_id && saved.route_id !== routeId)) {
      return respond(409, { ok: false, error: "Cash ledger mismatch. Contact the owner for reconciliation." });
    }
    if (!saved.route_id) {
      const link = await ctx.admin.from("cash_collections")
        .update({ route_id: routeId }).eq("id", collectionId).is("route_id", null);
      if (link.error) throw link.error;
    }
    const linked = await ctx.admin.from("route_stop_cash_receipts")
      .update({ state: "collected", collection_id: collectionId, bag_id: bagId, updated_at: new Date().toISOString() })
      .eq("route_stop_id", stopId).eq("request_id", requestId).eq("state", "pending")
      .select("route_stop_id").maybeSingle();
    if (linked.error || !linked.data) throw linked.error ?? new Error("Cash link not saved.");
  } catch {
    return respond(503, { ok: false, retryable: true, error: "Collection saved; retry to finish linking it to the route." });
  }

  if (result?.replayed && evidence) {
    // A retry's uploaded photo is not used by the already-committed collection.
    await removeCashEvidence(evidence);
  }
  return respond(200, {
    ok: true, state: "collected", collectionId, bagId,
    replayed: Boolean(result?.replayed),
  });
}
