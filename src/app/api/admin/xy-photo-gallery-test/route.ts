import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  GALLERY_PHOTO_MAX_BYTES,
  GALLERY_PHOTO_MIME_TYPES,
  GALLERY_PHOTO_SCHEMA,
  validateGalleryObservations,
} from "@/lib/xy-photo-gallery-test";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const json = (payload: Record<string, unknown>, status = 200) => NextResponse.json(payload, {
  status, headers: { "Cache-Control": "private, no-store, max-age=0" },
});

function outputText(payload: unknown): string {
  const body = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }> };
  if (typeof body?.output_text === "string") return body.output_text;
  return (body?.output ?? []).flatMap((item) => (item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => String(part.text))).join("\n");
}

export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !isOwnerAdminRole(profile)) {
    return json({ available: false }, 403);
  }
  return json({ available: true, configured: Boolean(process.env.OPENAI_API_KEY) });
}

/**
 * Owner-only AI photo test: an uploaded library photo is processed in memory
 * and sent to the vision provider, but NOT stored in Supabase, routes, or XY.
 * Visual positions are approximate row / column indexes, NOT actual XY codes.
 */
export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active") {
    return json({ ok: false, error: "Sign in again to run the photo test." }, 401);
  }
  if (!isOwnerAdminRole(profile)) {
    return json({ ok: false, error: "This photo-library AI test is available to Snacky owners/admins only." }, 403);
  }
  const db = getSupabaseAdminClient();
  if (!db) return json({ ok: false, error: "Snacky database is not available." }, 503);
  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "Photo AI is not configured. Set the server-only OPENAI_API_KEY before testing recognition." }, 503);
  }

  let file: FormDataEntryValue | null;
  try {
    const form = await request.formData();
    file = form.get("photo");
  } catch {
    return json({ ok: false, error: "Could not read the selected photo." }, 400);
  }
  if (!(file instanceof File) || !GALLERY_PHOTO_MIME_TYPES.has(file.type)
    || file.size < 1 || file.size > GALLERY_PHOTO_MAX_BYTES) {
    return json({
      ok: false,
      error: "Choose a JPEG, PNG or WEBP photo smaller than 4MB. If your iPhone photo is HEIC, export/share it as JPEG first.",
    }, 400);
  }

  const { data: products, error: productError } = await db
    .from("products").select("id,name,active").eq("active", true).order("name").limit(350);
  if (productError || !products?.length) {
    return json({ ok: false, error: "Snacky products could not be loaded for image recognition." }, 503);
  }
  const allowed = new Map<string, string>();
  for (const product of products) {
    const name = String(product.name ?? "").trim();
    if (name) allowed.set(product.id, name);
  }
  const instructions = [
    "You are testing Snacky vending machine product recognition from an OLD gallery photo.",
    "This is IMAGE-ONLY QA. Do NOT infer XY slot codes, counts behind the front package, price or sellable inventory.",
    "Identify visible FRONT-facing snack and drink packaging from top row to bottom row, left to right as seen in the image.",
    "Return rowNumber starting at 1 for the top VISIBLE product row and positionNumber starting at 1 for the leftmost VISIBLE distinct selection in that row.",
    "These are approximate visual row/column positions, NOT real XY machine selection codes. Never hallucinate hidden rows, products, or quantities.",
    "Use ONLY exact productId values from Snacky's active product catalog below. The same product can occur in many distinct positions.",
    "Ignore machine buttons, touchscreen product images, stickers, reflections, people and unrelated background items.",
    "Only return observations with visibly supported brand/label/packaging. When a product is not in the catalog or ambiguous, OMIT it.",
    "Confidence high requires clear visible distinguishing labels/branding; medium if visible but small; low if uncertain, preferably omit.",
    "photoQuality=unreadable if no vending product can be identified reliably; partial if the machine is cropped, angled, blurry, dark or obscured.",
    "If this is not a vending machine photograph, return observations=[] and photoQuality=unreadable.",
    "Catalog (productId, name): " + JSON.stringify(Array.from(allowed, ([id, name]) => [id, name])),
  ].join("\n");

  try {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const result = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.XY_PHOTO_VISION_MODEL || "gpt-4.1-mini",
        store: false,
        max_output_tokens: 6500,
        input: [{ role: "user", content: [
          { type: "input_text", text: instructions },
          { type: "input_image", image_url: `data:${file.type};base64,${base64}`, detail: "high" },
        ] }],
        text: {
          format: { type: "json_schema", name: "snacky_gallery_photo_test", schema: GALLERY_PHOTO_SCHEMA, strict: true },
        },
      }),
    });
    const raw = await result.json().catch(() => null);
    if (!result.ok) {
      console.warn("[snacky:photo-gallery-test] Vision model unavailable", { status: result.status });
      return json({ ok: false, error: "AI could not analyze this photo. Confirm the model key is configured or try another JPEG." }, 503);
    }
    let parsed: { photoQuality?: unknown; observations?: unknown };
    try {
      parsed = JSON.parse(outputText(raw)) as { photoQuality?: unknown; observations?: unknown };
    } catch {
      return json({ ok: false, error: "AI returned an unreadable result. Try the photo again." }, 502);
    }
    const validated = validateGalleryObservations(parsed.observations, allowed);
    const photoQuality = ["good", "partial", "unreadable"].includes(String(parsed.photoQuality))
      ? parsed.photoQuality : "unreadable";

    return json({
      ok: true,
      testOnly: true,
      photoQuality,
      observations: validated.observations,
      rejectedObservations: validated.rejected,
      analyzedAt: new Date().toISOString(),
      disclaimer: "Visual row/column estimates only; nothing saved and no XY inventory updated.",
    });
  } catch (cause) {
    console.warn("[snacky:photo-gallery-test] Scan failed", cause instanceof Error ? cause.message : "unknown");
    return json({ ok: false, error: "Photo AI is unavailable. Try a smaller, clearer JPEG or retry." }, 503);
  }
}
