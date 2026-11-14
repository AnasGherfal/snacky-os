"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function adminClient() {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("Supabase admin client is unavailable.");
  return db;
}

function finish(error: string | null) {
  revalidatePath("/reports/route-distances");
  if (error) redirect("/reports/route-distances?error=" + encodeURIComponent(error));
  redirect("/reports/route-distances?saved=1");
}

export async function saveRouteDistanceEdge(form: FormData) {
  const db = await adminClient();
  const kmText = String(form.get("distance_km") ?? "").trim();
  const km = Number(kmText);
  if (!kmText || !Number.isFinite(km) || km < 0 || km >= 10000) {
    finish("Distance must be a valid non-negative number of kilometers.");
  }
  const notes = String(form.get("notes") ?? "").trim().slice(0, 400) || null;
  const edgeId = String(form.get("edge_id") ?? "").trim();
  if (edgeId) {
    if (!uuidPattern.test(edgeId)) finish("Invalid distance record.");
    const { error } = await db.from("route_distance_edges").update({
      distance_km: Math.round(km * 100) / 100,
      notes,
      updated_at: new Date().toISOString(),
    }).eq("id", edgeId);
    finish(error?.message ?? null);
  }

  const origin = String(form.get("origin") ?? "").trim();
  const destination = String(form.get("to_machine_id") ?? "").trim();
  const [kind, originId] = origin.split(":");
  if (!uuidPattern.test(originId ?? "") || !uuidPattern.test(destination) ||
      !["storage", "machine"].includes(kind) ||
      (kind === "machine" && originId === destination)) {
    finish("Select two different, valid route locations.");
  }

  const { data: destinationRow, error: destinationError } = await db.from("machines")
    .select("id").eq("id", destination).maybeSingle();
  if (destinationError || !destinationRow) finish("Destination machine not found.");
  const sourceTable = kind === "storage" ? "storage_locations" : "machines";
  const { data: sourceRow, error: sourceError } = await db.from(sourceTable)
    .select("id").eq("id", originId).maybeSingle();
  if (sourceError || !sourceRow) finish("Starting location not found.");

  const sourceColumn = kind === "storage" ? "from_storage_location_id" : "from_machine_id";
  const { data: existing, error: findError } = await db.from("route_distance_edges")
    .select("id").eq(sourceColumn, originId).eq("to_machine_id", destination).maybeSingle();
  if (findError) finish(findError.message);
  const row = {
    from_storage_location_id: kind === "storage" ? originId : null,
    from_machine_id: kind === "machine" ? originId : null,
    to_machine_id: destination,
    distance_km: Math.round(km * 100) / 100,
    notes,
    updated_at: new Date().toISOString(),
  };
  const result = existing
    ? await db.from("route_distance_edges").update(row).eq("id", existing.id)
    : await db.from("route_distance_edges").insert(row);
  finish(result.error?.message ?? null);
}

export async function deleteRouteDistanceEdge(form: FormData) {
  const db = await adminClient();
  const edgeId = String(form.get("edge_id") ?? "").trim();
  if (!uuidPattern.test(edgeId)) finish("Invalid distance record.");
  const { error } = await db.from("route_distance_edges").delete().eq("id", edgeId);
  finish(error?.message ?? null);
}
