"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeStorageLocationType, StorageLocationRow } from "@/lib/storage-locations";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

async function requireStorageLocationAccess(path = "/storage-locations") {
  const { supabase } = await requireStorageLocationContext(path);
  return supabase;
}

async function requireStorageLocationContext(path = "/storage-locations") {
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile.role)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

function requireConfirmedReason(formData: FormData, path: string) {
  if (clean(formData.get("confirm_action")) !== "yes") fail(path, "Confirmation is required.");
  const reason = clean(formData.get("reason"));
  if (!reason) fail(path, "Reason is required.");
  return reason;
}

function buildPayload(formData: FormData) {
  const name = clean(formData.get("name"));
  const address = clean(formData.get("address")) || null;
  const locationType = normalizeStorageLocationType(formData.get("location_type"));
  const relatedOperatorId = clean(formData.get("related_operator_id")) || null;
  const active = clean(formData.get("active") || "true") !== "false";

  if (!name) throw new Error("Location name is required.");
  if (locationType === "operator_bag" && !relatedOperatorId) {
    throw new Error("Operator bag locations must be linked to an operator.");
  }

  return {
    name,
    address,
    location_type: locationType,
    related_operator_id: locationType === "operator_bag" ? relatedOperatorId : null,
    active,
    updated_at: new Date().toISOString(),
  };
}

async function getStorageLocation(id: string): Promise<StorageLocationRow | null> {
  const supabase = await requireStorageLocationAccess(`/storage-locations/${id}`);
  const { data, error } = await supabase
    .from("storage_locations")
    .select("id, name, address, active, location_type, related_operator_id, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data as StorageLocationRow | null;
}

async function getCurrentInventoryTotal(location: StorageLocationRow) {
  const supabase = await requireStorageLocationAccess(`/storage-locations/${location.id}`);
  let query = supabase.from("current_inventory_by_location").select("quantity_on_hand");
  const type = normalizeStorageLocationType(location.location_type);

  if (type === "operator_bag") {
    if (!location.related_operator_id) return 0;
    query = query.eq("location_type", "operator_bag").eq("location_id", location.related_operator_id);
  } else if (type === "damaged" || type === "expired") {
    return 0;
  } else {
    query = query.eq("location_type", "storage").eq("location_id", location.id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).reduce((sum: number, row: any) => sum + Number(row.quantity_on_hand ?? 0), 0);
}

async function getMovementCount(location: StorageLocationRow) {
  const supabase = await requireStorageLocationAccess(`/storage-locations/${location.id}`);
  const type = normalizeStorageLocationType(location.location_type);
  let query = supabase.from("inventory_movements").select("id", { count: "exact", head: true });

  if (type === "operator_bag") {
    if (!location.related_operator_id) return 0;
    query = query.or(`and(from_entity_type.eq.operator_bag,from_entity_id.eq.${location.related_operator_id}),and(to_entity_type.eq.operator_bag,to_entity_id.eq.${location.related_operator_id})`);
  } else if (type === "damaged" || type === "expired") {
    query = query.eq("reason", type);
  } else {
    query = query.or(`and(from_entity_type.eq.storage,from_entity_id.eq.${location.id}),and(to_entity_type.eq.storage,to_entity_id.eq.${location.id})`);
  }

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

function revalidateStorageLocationPaths(id?: string) {
  revalidatePath("/storage-locations");
  revalidatePath("/inventory/movements/new");
  if (id) {
    revalidatePath(`/storage-locations/${id}`);
    revalidatePath(`/storage-locations/${id}/edit`);
  }
}

export async function createStorageLocation(formData: FormData) {
  const supabase = await requireStorageLocationAccess("/storage-locations/new");
  let payload: ReturnType<typeof buildPayload>;
  try {
    payload = buildPayload(formData);
  } catch (error) {
    fail("/storage-locations/new", error instanceof Error ? error.message : "Could not create storage location.");
  }

  const { data, error } = await supabase.from("storage_locations").insert(payload).select("id").single();
  if (error || !data) {
    console.error("[storage-locations] Failed to create location", error);
    fail("/storage-locations/new", "Could not create storage location.");
  }

  revalidateStorageLocationPaths(data.id);
  redirect(`/storage-locations/${data.id}`);
}

export async function updateStorageLocation(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/storage-locations");
  const supabase = await requireStorageLocationAccess(`/storage-locations/${id}/edit`);
  let payload: ReturnType<typeof buildPayload>;
  try {
    payload = buildPayload(formData);
  } catch (error) {
    fail(`/storage-locations/${id}/edit`, error instanceof Error ? error.message : "Could not update storage location.");
  }
  const { data: existing } = await supabase.from("storage_locations").select("active").eq("id", id).maybeSingle();
  if (existing?.active !== false && payload.active === false && clean(formData.get("confirm_action")) !== "yes") {
    fail(`/storage-locations/${id}`, "Use the archive action so a reason is logged.");
  }

  const { error } = await supabase.from("storage_locations").update(payload).eq("id", id);
  if (error) {
    console.error("[storage-locations] Failed to update location", error);
    fail(`/storage-locations/${id}/edit`, "Could not update storage location.");
  }

  revalidateStorageLocationPaths(id);
  redirect(`/storage-locations/${id}`);
}

export async function archiveStorageLocation(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/storage-locations");
  const path = `/storage-locations/${id}`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireStorageLocationContext(path);
  const { data: before } = await supabase.from("storage_locations").select("*").eq("id", id).maybeSingle();
  const { data: after, error } = await supabase.from("storage_locations").update({ active: false, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (error) {
    console.error("[storage-locations] Failed to archive location", error);
    fail(`/storage-locations/${id}`, "Could not archive storage location.");
  }
  await logActivity({
    profile,
    action: "archive",
    entityType: "storage_location",
    entityId: id,
    entityLabel: after.name,
    beforeData: before,
    afterData: after,
    metadata: { reason },
    summary: `Archived storage location ${after.name}`,
  });
  revalidateStorageLocationPaths(id);
  redirect(`/storage-locations/${id}`);
}

export async function activateStorageLocation(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/storage-locations");
  const { profile, supabase } = await requireStorageLocationContext(`/storage-locations/${id}`);
  const { data: before } = await supabase.from("storage_locations").select("*").eq("id", id).maybeSingle();
  const { data: after, error } = await supabase.from("storage_locations").update({ active: true, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (error) {
    console.error("[storage-locations] Failed to activate location", error);
    fail(`/storage-locations/${id}`, "Could not activate storage location.");
  }
  await logActivity({
    profile,
    action: "activate",
    entityType: "storage_location",
    entityId: id,
    entityLabel: after.name,
    beforeData: before,
    afterData: after,
    summary: `Activated storage location ${after.name}`,
  });
  revalidateStorageLocationPaths(id);
  redirect(`/storage-locations/${id}`);
}

export async function deleteStorageLocation(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/storage-locations");
  const path = `/storage-locations/${id}`;
  const reason = requireConfirmedReason(formData, path);
  const location = await getStorageLocation(id);
  if (!location) redirect("/storage-locations");

  const [movementCount, currentUnits] = await Promise.all([getMovementCount(location), getCurrentInventoryTotal(location)]);
  if (movementCount > 0 || currentUnits !== 0) {
    fail(`/storage-locations/${id}`, "This location has inventory or movement history. Archive it instead of deleting it.");
  }

  const { profile, supabase } = await requireStorageLocationContext(`/storage-locations/${id}`);
  const { error } = await supabase.from("storage_locations").delete().eq("id", id);
  if (error) {
    console.error("[storage-locations] Failed to delete location", error);
    fail(`/storage-locations/${id}`, "Could not delete storage location.");
  }

  await logActivity({
    profile,
    action: "delete",
    entityType: "storage_location",
    entityId: id,
    entityLabel: location.name,
    beforeData: location,
    metadata: { reason, movement_count: movementCount, current_units: currentUnits },
    summary: `Hard-deleted storage location ${location.name}`,
  });

  revalidateStorageLocationPaths(id);
  redirect("/storage-locations");
}
