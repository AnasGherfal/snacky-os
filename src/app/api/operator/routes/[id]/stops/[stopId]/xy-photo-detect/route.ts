import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { readXyMachineLayout } from "@/lib/xy-vms-control";
import { groupMachineLayoutRows } from "@/lib/xy-machine-layout-groups";
import {
  PHOTO_ANALYSIS_SCHEMA, selectPhotoSuggestions, type PhotoCandidate, type PhotoSlot,
} from "@/lib/xy-photo-recognition";

export const runtime = "nodejs";
export const maxDuration = 60;

const clean = (value: unknown) => String(value ?? "").trim();
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function outputText(payload: unknown) {
  const value = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
  };
  if (typeof value?.output_text === "string") return value.output_text;
  return (value?.output ?? []).flatMap((part) => (part.content ?? [])
    .filter((content) => content.type === "output_text" && typeof content.text === "string")
    .map((content) => String(content.text))).join("\n");
}

/**
 * Photo => advisory product/selection suggestions ONLY.
 * There are NO XY stock/product writes in this endpoint.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!uuid(routeId) || !uuid(stopId)) return NextResponse.json({ error: "Invalid route stop." }, { status: 400 });
  const token = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(token);
  if (!token || !profile || !client || profile.active_status !== "active") {
    return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  }
  const [{ data: route }, { data: stop }] = await Promise.all([
    client.from("routes").select("id,operator_id,status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id,route_id,machine_id,status").eq("id", stopId).maybeSingle(),
  ]);
  if (!route || !stop || stop.route_id !== routeId) return NextResponse.json({ error: "Stop not found." }, { status: 404 });
  const access = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(access, route.operator_id)) {
    return NextResponse.json({ error: "This route is not assigned to you." }, { status: 403 });
  }
  if (["completed", "reviewed", "skipped", "cancelled", "canceled"].includes(clean(stop.status).toLowerCase())) {
    return NextResponse.json({ error: "This stop is already closed." }, { status: 409 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Protected image recognition is unavailable." }, { status: 503 });
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "Image detection is not configured. An administrator must set the server-only OPENAI_API_KEY." }, { status: 503 });
  }

  const [{ data: photo }, { data: machine }, { data: mappings }] = await Promise.all([
    admin.from("machine_refill_history").select("machine_photo_path,route_stop_id,machine_id")
      .eq("legacy_refill_id", `route_stop:${stopId}`).maybeSingle(),
    admin.from("machines").select("id,vms_machine_id").eq("id", stop.machine_id).maybeSingle(),
    admin.from("vms_product_mappings").select("vms_product_id,product_id,snacky_product_id,match_status,last_seen_at")
      .eq("match_status", "confirmed").not("vms_product_id", "is", null).order("last_seen_at", { ascending: false, nullsFirst: false }).limit(350),
  ]);
  if (!machine?.vms_machine_id) return NextResponse.json({ error: "Machine is not connected to XY." }, { status: 409 });
  const photoPath = clean(photo?.machine_photo_path);
  if (!photo || photo.machine_id !== stop.machine_id || photo.route_stop_id !== stopId
    || !photoPath.startsWith(`${routeId}/${stopId}-`) || photoPath.includes("..")) {
    return NextResponse.json({ error: "Save a fresh completion photo for this machine stop before scanning." }, { status: 409 });
  }
  const { data: imageFile, error: imageError } = await admin.storage.from("refill-photos").download(photoPath);
  if (imageError || !imageFile) return NextResponse.json({ error: "Could not read the saved machine photo." }, { status: 503 });
  if (!["image/jpeg", "image/png", "image/webp"].includes(imageFile.type) || imageFile.size <= 0 || imageFile.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "Machine photo must be a PNG, JPG or WEBP under 8MB." }, { status: 400 });
  }

  const productMap = new Map<string, string>();
  const preferredVendorByProduct = new Map<string, string>();
  for (const row of mappings ?? []) {
    const vmsId = clean(row.vms_product_id);
    const id = clean(row.product_id || row.snacky_product_id);
    if (!vmsId || !uuid(id)) continue;
    if (!preferredVendorByProduct.has(id)) preferredVendorByProduct.set(id, vmsId);
    productMap.set(vmsId, id);
  }
  if (!productMap.size) return NextResponse.json({ error: "No confirmed XY product mappings are available." }, { status: 409 });
  const ids = [...preferredVendorByProduct.keys()];
  const { data: productRows, error: productError } = await admin.from("products")
    .select("id,name,active").in("id", ids).eq("active", true);
  if (productError) return NextResponse.json({ error: "Could not load the authorized product catalog." }, { status: 503 });
  const candidates: PhotoCandidate[] = (productRows ?? [])
    .filter((row) => preferredVendorByProduct.has(row.id))
    .map((row) => ({ id: row.id, name: clean(row.name), vmsProductId: preferredVendorByProduct.get(row.id)! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!candidates.length) return NextResponse.json({ error: "No confirmed active products available for image matching." }, { status: 409 });

  let layout: Awaited<ReturnType<typeof readXyMachineLayout>>;
  try {
    layout = await readXyMachineLayout(String(machine.vms_machine_id));
  } catch {
    return NextResponse.json({ error: "Could not refresh XY machine selections. Retry after XY reconnects." }, { status: 503 });
  }
  if (!layout.length || layout.length > 120) return NextResponse.json({ error: "XY machine layout is missing or too large to scan safely." }, { status: 409 });
  const { data: hidden } = await admin.from("xy_hidden_machine_selections")
    .select("slot_code").eq("machine_id", machine.id);
  const hiddenCodes = new Set((hidden ?? []).map((row) => clean(row.slot_code)));
  const slots: PhotoSlot[] = layout.filter((lane) => !hiddenCodes.has(lane.slotCode))
    .map((lane) => ({
      slotCode: lane.slotCode,
      currentProductId: productMap.get(clean(lane.vmsProductId)) ?? null,
      currentVmsProductId: lane.vmsProductId,
      currentQty: lane.currentQty,
      capacity: lane.capacity,
    }));
  const grouped = groupMachineLayoutRows(slots);
  const prompt = [
    "You are reading ONE real vending machine photograph. Match the visible FRONT-FACING product packaging to the correct XY selection code.",
    "NEVER infer products or quantities hidden behind the first visible item. Never infer sellable stock count, price, expiry or old inventory custody from this photo.",
    "Do not assume the existing XY product assignment is correct: a physical operator may have swapped products.",
    "Only return a selection if the product PACKAGE and its row/column position are visibly identifiable. Omit ambiguous, obscured, empty, reflections and unreadable selections.",
    "Use ONLY exact slotCode and productId from the allowed lists. Never invent a code or product ID. The same product may appear in several different selections.",
    "If the image is cropped, report only actually visible selections. For each observation, give brief visual evidence identifying packaging/color/label and conservative high/medium/low confidence.",
    "Slot layout is left-to-right within each listed row as viewed from the machine FRONT, not mirrored or from the operator's open door.",
    "Allowed slot row order: " + JSON.stringify(grouped.map((group) => group.slots.map((slot) => slot.slotCode))),
    "Allowed products (id/name): " + JSON.stringify(candidates.map((product) => [product.id, product.name])),
    "Return structured output only. Empty observations is correct for unreadable imagery.",
  ].join("\n");

  const model = process.env.XY_PHOTO_VISION_MODEL || "gpt-4.1-mini";
  let payload: unknown;
  try {
    const bytes = Buffer.from(await imageFile.arrayBuffer()).toString("base64");
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model, store: false, max_output_tokens: 7500,
        input: [{ role: "user", content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:${imageFile.type};base64,${bytes}`, detail: "high" },
        ] }],
        text: { format: { type: "json_schema", name: "snacky_photo_selections", schema: PHOTO_ANALYSIS_SCHEMA, strict: true } },
      }),
    });
    payload = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn("[xy-photo-detect] Model request failed", { status: res.status });
      return NextResponse.json({ error: "Image recognition is temporarily unavailable. Review the machine manually." }, { status: 503 });
    }
  } catch (error) {
    console.warn("[xy-photo-detect] Model request timed out or failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not analyze photo. Retake a clearer image or review manually." }, { status: 503 });
  }

  let raw: { observations?: unknown; photoQuality?: unknown };
  try {
    raw = JSON.parse(outputText(payload)) as { observations?: unknown; photoQuality?: unknown };
  } catch {
    return NextResponse.json({ error: "Image recognition returned an invalid result. No XY changes were made." }, { status: 502 });
  }
  const result = selectPhotoSuggestions(raw.observations, slots, candidates);
  return NextResponse.json({
    ok: true,
    source: "ai_photo_review",
    analyzedAt: new Date().toISOString(),
    photoQuality: ["good", "partial", "unreadable"].includes(clean(raw.photoQuality)) ? raw.photoQuality : "unreadable",
    suggestions: result.suggestions,
    unreadableSlots: result.unreadableSlots,
    rejectedObservations: result.rejectedObservations,
    message: "Suggestions only. Verify each physical selection and actual count before sending any XY change.",
  }, { headers: { "Cache-Control": "no-store" } });
}
