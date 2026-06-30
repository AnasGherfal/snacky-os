"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { actionFailure, actionSuccess, type ActionResult } from "@/lib/action-result";
import { inventoryMovementIdempotencyKey } from "@/lib/inventory-movement";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canExecuteRoutes, getEffectivePermissions } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import {
  ROUTE_COMPLETED_STATUS,
  ROUTE_IN_PROGRESS_STATUS,
  ROUTE_PICKUP_CONFIRMED_STATUS,
  ROUTE_STOP_COMPLETED_STATUS,
  ROUTE_STOP_IN_PROGRESS_STATUS,
  ROUTE_STOP_PENDING_STATUS,
  ROUTE_STOP_PICKED_STATUS,
  ROUTE_STOP_SKIPPED_STATUS,
  fallbackRouteStatusForEnumMismatch,
  isActiveRouteStatus,
  isAvailableRouteStatus,
  isCompletedRouteStatus,
  isRouteStatusEnumMismatch,
  isRouteStopDoneStatus,
  isTerminalRouteStatus,
  type RouteStatus,
} from "@/lib/route-workflow";
import { ISSUE_PHOTO_BUCKET, REFILL_PHOTO_BUCKET } from "@/lib/storage-buckets";

const REFILL_PHOTO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const REFILL_PHOTO_MAX_SIZE = 10 * 1024 * 1024;
const PICKUP_CONFIRMATION_FALLBACK_ERROR = "Pickup confirmation failed before a specific database reason was returned.";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

function isMissingOnConflictConstraint(error: unknown) {
  const info = serializeActionError(error);
  const code = String(info.code ?? "");
  const text = [code, info.message, info.details, info.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return code === "42P10"
    || text.includes("there is no unique or exclusion constraint matching the on conflict specification")
    || text.includes("missing unique constraint");
}

function getErrorMessage(error: unknown, fallback = "Something went wrong.") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown; error?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? row.error ?? fallback);
  }
  return fallback;
}

class ActionDatabaseError extends Error {
  code?: string;
  details?: unknown;
  hint?: unknown;
  cause?: unknown;

  constructor(error: unknown, fallback?: string) {
    super(getErrorMessage(error, fallback));
    this.name = "ActionDatabaseError";
    this.cause = error;
    if (error && typeof error === "object") {
      const row = error as { code?: unknown; details?: unknown; hint?: unknown };
      if (row.code) this.code = String(row.code);
      if (row.details) this.details = row.details;
      if (row.hint) this.hint = row.hint;
    }
  }
}

function throwActionError(error: unknown, fallback?: string): never {
  throw new ActionDatabaseError(error, fallback);
}

function errorField(error: unknown, field: "code" | "details" | "hint" | "message" | "stack" | "name"): unknown {
  if (error && typeof error === "object") {
    const direct = (error as Record<string, unknown>)[field];
    if (direct) return direct;
    const cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) return errorField(cause, field);
  }
  return null;
}

function serializeActionError(error: unknown): Record<string, unknown> {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : null;
  return {
    name: errorField(error, "name") ?? (error instanceof Error ? error.name : null),
    code: errorField(error, "code"),
    message: getErrorMessage(error, "Unknown error"),
    details: errorField(error, "details"),
    hint: errorField(error, "hint"),
    stack: errorField(error, "stack") ?? (error instanceof Error ? error.stack : null),
    cause: cause && cause !== error ? serializeActionError(cause) : undefined,
  };
}

function pickupPublicError(error: unknown) {
  const info = serializeActionError(error);
  const message = String(info.message ?? "");
  const code = String(info.code ?? "");
  const text = [code, message, info.details, info.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();

  if (text.includes("not enough warehouse stock") || text.includes("not enough storage stock")) return message;
  if (text.includes("missing from inventory") || text.includes("product not found")) return message;
  if (text.includes("route status") || text.includes("start the route")) return message;
  if (text.includes("stop status") || text.includes("only pending stops")) return message;
  if (text.includes("selected pickup stop") || text.includes("selected batch stops")) return message;
  if (text.includes("picked quantity cannot be reduced")) return message;
  if (text.includes("route must be assigned")) return message;

  if (code === "42501" || text.includes("row-level security") || text.includes("permission")) {
    return "User does not have permission to confirm pickup.";
  }
  if (code === "42883" || code === "PGRST202" || (text.includes("function") && (text.includes("confirm_route_pickup_batch") || text.includes("validate_route_workflow_schema")))) {
    return "Pickup confirmation could not be saved. Please contact admin.";
  }
  if (code === "42703" || code === "PGRST204" || text.includes("schema cache") || text.includes("column")) {
    return "Pickup confirmation could not be saved. Please contact admin.";
  }
  if (text.includes("invalid input value for enum route_status")) {
    return "Pickup confirmation could not be saved. Please contact admin.";
  }
  if (text.includes("invalid input value for enum route_stop_status")) {
    return "Pickup confirmation could not be saved. Please contact admin.";
  }
  if (code === "23503") {
    return "Pickup confirmation could not be saved because some linked data is missing.";
  }
  if (code === "23514" || text.includes("movement_quantity_positive")) {
    return "Pickup confirmation could not be saved because one quantity or status is invalid.";
  }
  if (text.includes("inventory movement")) return message;

  return "Could not confirm pickup. Please contact admin.";
}

function isMissingOptionalPickupChecklistColumn(error: unknown) {
  const info = serializeActionError(error);
  const code = String(info.code ?? "");
  const text = [code, info.message, info.details, info.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    text.includes("schema cache") ||
    text.includes("column")
  ) && ["is_checked", "checked_at", "checked_by"].some((column) => text.includes(column));
}

function operatorRouteDetailPath(routeId: string) {
  return `/operator/routes/${routeId}`;
}

function revalidateRouteWorkflow(routeId: string) {
  revalidatePath("/operator");
  revalidatePath("/operator/routes");
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}/pick-list`);
  revalidatePath(`/operator/routes/${routeId}/leftovers`);
  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/cash-collections");
  revalidatePath("/refills");
  revalidatePath("/machines-dashboard");
}

function mergeNotes(existing: string | undefined, next: string | undefined) {
  const parts = [existing, next].map((part) => String(part ?? "").trim()).filter(Boolean);
  return parts.length ? Array.from(new Set(parts)).join(" | ") : undefined;
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function stableUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function routeSourceUuid(value: unknown, fallbackSeed: string) {
  const text = String(value ?? "").trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return text;
  }
  return stableUuid(fallbackSeed);
}

function machineFillDelta(movement: any) {
  const qty = unitQuantity(movement?.quantity);
  if (movement?.reason === "manual_correction" && movement?.from_entity_type === "machine" && movement?.to_entity_type === "operator_bag") {
    return -qty;
  }
  return qty;
}

async function upsertInventoryMovementsWithFallback({
  supabase,
  rows,
  routeId,
  operationLabel,
}: {
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
  rows: any[];
  routeId: string;
  operationLabel: string;
}) {
  const upsertResult = await supabase.from("inventory_movements").upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (!upsertResult.error) return;
  if (!isMissingOnConflictConstraint(upsertResult.error)) throwActionError(upsertResult.error, `Could not ${operationLabel}.`);

  console.warn("[operator] inventory_movements upsert missing unique conflict target; falling back to insert", {
    routeId,
    operationLabel,
    row_count: rows.length,
    error: upsertResult.error,
  });

  const idempotencyKeys = Array.from(new Set(rows.map((row) => String(row.idempotency_key ?? "")).filter(Boolean)));
  let existingKeys = new Set<string>();
  if (idempotencyKeys.length) {
    const existingResult = await supabase
      .from("inventory_movements")
      .select("idempotency_key")
      .in("idempotency_key", idempotencyKeys);
    if (existingResult.error) throwActionError(existingResult.error, `Could not verify existing ${operationLabel}.`);
    existingKeys = new Set((existingResult.data ?? []).map((row: any) => String(row.idempotency_key ?? "")));
  }

  const rowsToInsert = rows.filter((row) => {
    const key = String(row.idempotency_key ?? "");
    return !key || !existingKeys.has(key);
  });

  if (rowsToInsert.length) {
    const insertResult = await supabase.from("inventory_movements").insert(rowsToInsert);
    if (insertResult.error) throwActionError(insertResult.error, `Could not create ${operationLabel}.`);
  }
}

function addProductQuantity(map: Map<string, number>, productId: unknown, quantity: unknown) {
  const key = String(productId ?? "");
  const qty = unitQuantity(quantity);
  if (!key || qty <= 0) return;
  map.set(key, (map.get(key) ?? 0) + qty);
}

function productQuantitiesFromMovements(movements: any[] | null | undefined, delta: (movement: any) => number = (movement) => unitQuantity(movement?.quantity)) {
  const totals = new Map<string, number>();
  (movements ?? []).forEach((movement) => addProductQuantity(totals, movement?.product_id, delta(movement)));
  return totals;
}

function routeBagMovementDelta(movement: any) {
  const qty = unitQuantity(movement?.quantity);
  if (qty <= 0) return 0;
  const intoBag = movement?.to_entity_type === "operator_bag";
  const outOfBag = movement?.from_entity_type === "operator_bag";
  if (intoBag && !outOfBag) return qty;
  if (outOfBag && !intoBag) return -qty;
  return 0;
}

function routeBagBalanceFromMovements(movements: any[] | null | undefined) {
  const balances = new Map<string, number>();
  (movements ?? []).forEach((movement) => {
    const productId = String(movement?.product_id ?? "");
    const delta = routeBagMovementDelta(movement);
    if (!productId || delta === 0) return;
    balances.set(productId, (balances.get(productId) ?? 0) + delta);
  });
  return balances;
}

function positiveRouteBagBalances(movements: any[] | null | undefined) {
  return Array.from(routeBagBalanceFromMovements(movements).entries())
    .map(([productId, quantity]) => ({ productId, quantity: Math.max(0, quantity) }))
    .filter((item) => item.quantity > 0);
}

function routeCompletionPublicError(error: unknown) {
  const info = serializeActionError(error);
  const message = String(info.message ?? "");
  const code = String(info.code ?? "");
  const text = [code, message, info.details, info.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();

  if (text.includes("complete or skip every machine stop")) return message;
  if (text.includes("return all leftover")) return message;
  if (text.includes("not authorized")) return message;
  if (text.includes("route not found")) return message;
  if (text.includes("already cancelled") || text.includes("cancelled route")) return message;
  if (code === "42501" || text.includes("row-level security") || text.includes("permission")) return "You do not have permission to complete this route.";
  if (code === "42703" || code === "PGRST204" || text.includes("schema cache") || text.includes("column")) return "Route completion could not be saved. Please contact admin.";
  if (code === "23503") return "Route completion could not save because some linked data is missing.";
  if (code === "23514") return "Route completion could not save because one route status or quantity is invalid.";
  return message || "Could not complete this route.";
}

function isMissingCompletionAuditColumn(error: unknown) {
  const info = serializeActionError(error);
  const text = [info.code, info.message, info.details, info.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return text.includes("completed_by") || text.includes("completion_attempts") || text.includes("last_completion_error") || text.includes("schema cache");
}

function safeFileSegment(value: string, fallback: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-") || fallback;
}

async function ensureRefillPhotoBucket() {
  const storageClient = getSupabaseAdminClient();
  if (!storageClient) return null;

  const config = {
    public: false,
    fileSizeLimit: "10MB",
    allowedMimeTypes: REFILL_PHOTO_MIME_TYPES,
  };

  const { error: getError } = await storageClient.storage.getBucket(REFILL_PHOTO_BUCKET);
  if (!getError) {
    const { error: updateError } = await storageClient.storage.updateBucket(REFILL_PHOTO_BUCKET, config);
    if (updateError) console.warn("[operator] Could not update refill photo bucket settings", updateError);
    return storageClient;
  }

  const { error: createError } = await storageClient.storage.createBucket(REFILL_PHOTO_BUCKET, config);
  if (createError && !createError.message.toLowerCase().includes("already exists")) throw createError;
  return storageClient;
}

async function ensureAdjustmentPhotoBucket() {
  const storageClient = getSupabaseAdminClient();
  if (!storageClient) return null;

  const config = {
    public: false,
    fileSizeLimit: "10MB",
    allowedMimeTypes: REFILL_PHOTO_MIME_TYPES,
  };

  const { error: getError } = await storageClient.storage.getBucket(ISSUE_PHOTO_BUCKET);
  if (!getError) {
    const { error: updateError } = await storageClient.storage.updateBucket(ISSUE_PHOTO_BUCKET, config);
    if (updateError) console.warn("[operator] Could not update adjustment photo bucket settings", updateError);
    return storageClient;
  }

  const { error: createError } = await storageClient.storage.createBucket(ISSUE_PHOTO_BUCKET, config);
  if (createError && !createError.message.toLowerCase().includes("already exists")) throw createError;
  return storageClient;
}

export async function uploadRefillProofPhoto(formData: FormData) {
  const routeId = String(formData.get("routeId") || "").trim();
  const stopId = String(formData.get("stopId") || "").trim();
  const machineId = String(formData.get("machineId") || "").trim();
  const file = formData.get("photo");

  if (!routeId || !stopId || !machineId) throw new Error("Route, stop, and machine are required for the refill photo.");
  if (!(file instanceof File) || file.size === 0) throw new Error("Take or upload the final machine photo before completing the stop.");
  if (!REFILL_PHOTO_MIME_TYPES.includes(file.type) || file.size > REFILL_PHOTO_MAX_SIZE) {
    throw new Error("Final photo must be PNG, JPG, or WEBP and under 10MB.");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, operator_id")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) throwActionError(routeError, "Could not load this route for the refill photo.");
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    throw new Error("You are not authorized to upload a photo for this route.");
  }

  const { data: stop, error: stopError } = await supabase
    .from("route_stops")
    .select("id, route_id, machine_id")
    .eq("id", stopId)
    .maybeSingle();
  if (stopError) throwActionError(stopError, "Could not load this stop for the refill photo.");
  if (!stop || stop.route_id !== routeId || stop.machine_id !== machineId) {
    throw new Error("This stop does not belong to the selected route.");
  }

  const originalName = file.name || "refill-photo";
  const extension = safeFileSegment(originalName.split(".").pop() || "jpg", "jpg");
  const objectName = `${safeFileSegment(stopId, "stop")}-${Date.now()}.${extension}`;
  const objectPath = `${routeId}/${objectName}`;

  try {
    const storageClient = await ensureRefillPhotoBucket();
    if (!storageClient) {
      return {
        photoUrl: null,
        photoPath: `storage-unavailable/${routeId}/${safeFileSegment(stopId, "stop")}/${safeFileSegment(originalName, "refill-photo")}`,
        originalName,
        uploadUnavailable: true,
      };
    }

    const { error } = await storageClient.storage.from(REFILL_PHOTO_BUCKET).upload(objectPath, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: true,
    });

    if (error) throw error;

    return {
      photoUrl: `/api/storage/${REFILL_PHOTO_BUCKET}/${encodeURIComponent(routeId)}/${encodeURIComponent(objectName)}`,
      photoPath: objectPath,
      originalName,
      uploadUnavailable: false,
    };
  } catch (error) {
    console.warn("[operator] Refill photo upload unavailable", error);
    return {
      photoUrl: null,
      photoPath: `storage-unavailable/${routeId}/${safeFileSegment(stopId, "stop")}/${safeFileSegment(originalName, "refill-photo")}`,
      originalName,
      uploadUnavailable: true,
    };
  }
}

export async function uploadInventoryAdjustmentPhoto(formData: FormData) {
  const routeId = String(formData.get("routeId") || "").trim();
  const stopId = String(formData.get("stopId") || "").trim();
  const machineId = String(formData.get("machineId") || "").trim();
  const adjustmentType = safeFileSegment(String(formData.get("adjustmentType") || "inventory-adjustment"), "inventory-adjustment");
  const file = formData.get("photo");

  if (!routeId || !stopId || !machineId) throw new Error("Route, stop, and machine are required for the adjustment photo.");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a photo before uploading.");
  if (!REFILL_PHOTO_MIME_TYPES.includes(file.type) || file.size > REFILL_PHOTO_MAX_SIZE) {
    throw new Error("Adjustment photo must be PNG, JPG, or WEBP and under 10MB.");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, operator_id")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) throwActionError(routeError, "Could not load this route for the adjustment photo.");
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    throw new Error("You are not authorized to upload a photo for this route.");
  }

  const { data: stop, error: stopError } = await supabase
    .from("route_stops")
    .select("id, route_id, machine_id")
    .eq("id", stopId)
    .maybeSingle();
  if (stopError) throwActionError(stopError, "Could not load this stop for the adjustment photo.");
  if (!stop || stop.route_id !== routeId || stop.machine_id !== machineId) {
    throw new Error("This stop does not belong to the selected route.");
  }

  const originalName = file.name || "adjustment-photo";
  const extension = safeFileSegment(originalName.split(".").pop() || "jpg", "jpg");
  const objectName = `${safeFileSegment(stopId, "stop")}-${adjustmentType}-${Date.now()}.${extension}`;
  const objectPath = `${routeId}/adjustments/${objectName}`;

  try {
    const storageClient = await ensureAdjustmentPhotoBucket();
    if (!storageClient) {
      return {
        photoUrl: null,
        photoPath: `storage-unavailable/${routeId}/${safeFileSegment(stopId, "stop")}/${safeFileSegment(originalName, "adjustment-photo")}`,
        originalName,
        uploadUnavailable: true,
      };
    }

    const { error } = await storageClient.storage.from(ISSUE_PHOTO_BUCKET).upload(objectPath, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: true,
    });

    if (error) throw error;

    return {
      photoUrl: `/api/storage/${ISSUE_PHOTO_BUCKET}/${encodeURIComponent(routeId)}/adjustments/${encodeURIComponent(objectName)}`,
      photoPath: objectPath,
      originalName,
      uploadUnavailable: false,
    };
  } catch (error) {
    console.warn("[operator] Adjustment photo upload unavailable", error);
    return {
      photoUrl: null,
      photoPath: `storage-unavailable/${routeId}/${safeFileSegment(stopId, "stop")}/${safeFileSegment(originalName, "adjustment-photo")}`,
      originalName,
      uploadUnavailable: true,
    };
  }
}

export async function startRoute(routeId: string) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");
  if (!routeId) throw new Error("Route id is required");

  const profile = await getCurrentProfile();
  if (!profile || !canExecuteRoutes(profile)) throw new Error("You are not authorized to start routes.");
  if (!profile.team_member_id) throw new Error("Your account is not linked to a team member, so it cannot claim a route.");
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status, started_at")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) throwActionError(routeError, "Could not load this route.");
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    throw new Error("You are not authorized to start this route");
  }
  if (!isAvailableRouteStatus(route.status) && !isActiveRouteStatus(route.status)) {
    throw new Error("Only available or assigned routes can be started.");
  }
  if (isActiveRouteStatus(route.status)) {
    return { success: true };
  }

  const now = new Date().toISOString();
  const startUpdate = route.operator_id
    ? await supabase
        .from("routes")
        .update({ status: ROUTE_IN_PROGRESS_STATUS, started_at: route.started_at ?? now })
        .eq("id", routeId)
        .eq("operator_id", route.operator_id)
        .eq("status", route.status)
        .select("id, route_date, operator_id, status, started_at")
        .maybeSingle()
    : await supabase
        .from("routes")
        .update({ operator_id: profile.team_member_id, status: ROUTE_IN_PROGRESS_STATUS, started_at: now })
        .eq("id", routeId)
        .is("operator_id", null)
        .eq("status", route.status)
        .select("id, route_date, operator_id, status, started_at")
        .maybeSingle();

  if (startUpdate.error) throwActionError(startUpdate.error, "Could not start this route.");
  if (!startUpdate.data) {
    if (!route.operator_id) throw new Error("This route was already claimed by another user.");
    throw new Error("This route could not be started because its status changed.");
  }
  revalidateRouteWorkflow(routeId);
  await logActivity({
    profile,
    action: route.operator_id ? "start_route" : "claim_route",
    entityType: "route",
    entityId: routeId,
    entityLabel: `Route ${route.route_date ?? routeId.slice(0, 8)}`,
    beforeData: route,
    afterData: startUpdate.data,
    metadata: { operator_id: startUpdate.data.operator_id },
    summary: route.operator_id ? "Started route" : "Claimed and started available route",
  });
  return { success: true };
}

/**
 * Creates inventory movements from storage to operator bag
 * Called when operator confirms pick list
 */
export async function confirmPickList(
  routeId: string,
  pickedItems: { routeStopItemId?: string | null; routeStopId?: string | null; machineId?: string | null; productId: string; quantity: number; plannedQty?: number; reason?: string; notes?: string; isChecked?: boolean }[],
  extras: { routeStopId?: string | null; machineId?: string | null; productId: string; quantity: number; reason: string; notes?: string }[] = [],
  options: { stopIds?: string[]; clientSubmissionId?: string | null } = {},
): Promise<ActionResult> {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");
  const readClient = getSupabaseAdminClient() ?? supabase;
  let logProfile: Awaited<ReturnType<typeof getCurrentProfile>> | null = null;
  let logRouteOperatorId: string | null = null;
  let logRouteStatus: string | null = null;
  let logPickupBatchId: string | null = null;
  let logSelectedStopIds: string[] = [];
  let logProductIds: string[] = [];
  let logStopStatusesBeforePickup: Record<string, unknown>[] = [];
  let logSubmittedPickupItems: Record<string, unknown>[] = [];
  const logStorageAvailability: Record<string, unknown>[] = [];
  let logInventoryMovementPayload: Record<string, unknown>[] = [];
  let logPayload: Record<string, unknown> = {};

  try {
    const profile = await getCurrentProfile();
    logProfile = profile;
    const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();

    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    logRouteOperatorId = route.operator_id ?? null;
    logRouteStatus = route.status ?? null;
    if (!profile) {
      throw new Error("You must be signed in to pick stock for this route");
    }
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      throw new Error("You are not authorized to pick stock for this route");
    }
    if (isTerminalRouteStatus(route.status)) {
      throw new Error("Completed or cancelled routes cannot be edited.");
    }

    const cleanId = (value: unknown) => {
      const cleaned = String(value ?? "").trim();
      return cleaned || null;
    };
    const selectedStopIds = Array.from(new Set((options.stopIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
    const batchMode = selectedStopIds.length > 0;
    const clientSubmissionId = String(options.clientSubmissionId ?? "").trim() || null;
    const pickupSubmissionScope = clientSubmissionId || routeId;
    const selectedStopIdSet = new Set(selectedStopIds);
    logSelectedStopIds = selectedStopIds;

    const { data: routeStops, error: routeStopsError } = await supabase
      .from("route_stops")
      .select("id, machine_id, status")
      .eq("route_id", routeId);
    if (routeStopsError) throwActionError(routeStopsError, "Could not load route stops.");
    logStopStatusesBeforePickup = (routeStops ?? []).map((stop: any) => ({
      route_stop_id: String(stop.id ?? ""),
      machine_id: stop.machine_id ?? null,
      status: stop.status ?? null,
    }));
    const stopById = new Map((routeStops ?? []).map((stop: any) => [String(stop.id), stop]));
    const stopByMachine = new Map((routeStops ?? []).map((stop: any) => [String(stop.machine_id), stop]));
    if (batchMode) {
      for (const stopId of selectedStopIds) {
        const stop = stopById.get(stopId);
        if (!stop) throw new Error("Selected pickup stop does not belong to this route.");
        if (isRouteStopDoneStatus(stop.status)) throw new Error("Completed or skipped stops cannot be picked again.");
        if (String(stop.status ?? "") !== ROUTE_STOP_PENDING_STATUS) throw new Error("Only pending stops can be picked in a new batch.");
      }
    }

    let { data: routeStopItems, error: stopItemsError }: { data: any[] | null; error: any } = await supabase
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, planned_quantity")
      .eq("route_id", routeId);

    if (stopItemsError) {
      if (!isMissingTable(stopItemsError, "route_stop_items")) throwActionError(stopItemsError, "Could not load the route plan.");
      const fallback = await supabase
        .from("refill_orders")
        .select("id, machine_id, refill_order_lines(id, product_id, final_qty_to_take, suggested_qty)")
        .eq("route_id", routeId);
      if (fallback.error) throwActionError(fallback.error, "Could not load the route plan.");
      routeStopItems = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          id: line.id,
          route_stop_id: stopByMachine.get(String(order.machine_id ?? ""))?.id ?? null,
          machine_id: order.machine_id,
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
        })),
      );
    }

    type PlannedStopItem = {
      id: string;
      routeStopId: string | null;
      machineId: string | null;
      productId: string;
      plannedQty: number;
    };
    type PickedStopItem = PlannedStopItem & {
      quantity: number;
      reason?: string;
      notes?: string;
      isChecked?: boolean;
      actionType?: "planned_pick" | "extra_product";
    };

    const plannedStopItems: PlannedStopItem[] = [];
    const routeStopItemById = new Map<string, PlannedStopItem>();
    const routeStopProductToItem = new Map<string, PlannedStopItem>();
    const routeStopProductKey = (routeStopId: string | null | undefined, productId: string | null | undefined) => `${routeStopId ?? ""}:${productId ?? ""}`;

    (routeStopItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id ?? "").trim();
      if (!productId) return;
      const planned: PlannedStopItem = {
        id: String(line.id ?? ""),
        routeStopId: cleanId(line.route_stop_id),
        machineId: cleanId(line.machine_id),
        productId,
        plannedQty: unitQuantity(line.planned_quantity),
      };
      plannedStopItems.push(planned);
      if (planned.id) routeStopItemById.set(planned.id, planned);
      if (planned.routeStopId) routeStopProductToItem.set(routeStopProductKey(planned.routeStopId, productId), planned);
    });

    const pickedStopItems = new Map<string, PickedStopItem>();
    const legacyPickedByProduct = new Map<string, { productId: string; quantity: number; plannedQty?: number; reason?: string; notes?: string }>();
    const addPickedStopItem = (item: Omit<PickedStopItem, "quantity"> & { quantity: number }) => {
      const key = item.id || routeStopProductKey(item.routeStopId, item.productId);
      const current = pickedStopItems.get(key);
      pickedStopItems.set(key, {
        id: item.id,
        routeStopId: item.routeStopId,
        machineId: item.machineId,
        productId: item.productId,
        plannedQty: item.plannedQty,
        quantity: (current?.quantity ?? 0) + item.quantity,
        reason: item.reason || current?.reason,
        notes: mergeNotes(current?.notes, item.notes),
        isChecked: current?.isChecked || item.isChecked,
        actionType: current?.actionType === "extra_product" ? "extra_product" : item.actionType,
      });
    };

    pickedItems.forEach((item) => {
      const productId = String(item.productId ?? "").trim();
      if (!productId) return;
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      const routeStopItemId = cleanId(item.routeStopItemId);
      const planned = routeStopItemId ? routeStopItemById.get(routeStopItemId) : undefined;
      const routeStopId = cleanId(item.routeStopId) ?? planned?.routeStopId ?? null;
      const machineId = cleanId(item.machineId) ?? planned?.machineId ?? (routeStopId ? cleanId(stopById.get(routeStopId)?.machine_id) : null);
      const plannedQty = Math.max(0, Number(item.plannedQty ?? planned?.plannedQty ?? 0));
      if (batchMode && routeStopId && !selectedStopIdSet.has(routeStopId)) {
        throw new Error("Pickup items must belong to the selected batch stops.");
      }

      if (routeStopItemId || routeStopId) {
        addPickedStopItem({
          id: routeStopItemId ?? "",
          routeStopId,
          machineId,
          productId,
          plannedQty,
          quantity,
          reason: item.reason,
          notes: item.notes,
          isChecked: item.isChecked,
          actionType: "planned_pick",
        });
        return;
      }

      const current = legacyPickedByProduct.get(productId);
      legacyPickedByProduct.set(productId, {
        productId,
        quantity: (current?.quantity ?? 0) + quantity,
        plannedQty: current?.plannedQty ?? plannedQty,
        reason: item.reason || current?.reason,
        notes: mergeNotes(current?.notes, item.notes),
      });
    });

    const unassignedExtras = new Map<string, { productId: string; quantity: number; reason: string; notes?: string }>();
    const newAssignedExtras = new Map<string, { routeStopId: string; machineId: string; productId: string; quantity: number; reason: string; notes?: string }>();
    extras.forEach((item) => {
      const productId = String(item.productId ?? "").trim();
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (!productId || quantity <= 0) return;

      const routeStopId = cleanId(item.routeStopId);
      const stop = routeStopId ? stopById.get(routeStopId) : null;
      const machineId = cleanId(item.machineId) ?? cleanId(stop?.machine_id);

      if (routeStopId) {
        if (batchMode && !selectedStopIdSet.has(routeStopId)) {
          throw new Error("Added products must belong to one of the selected batch stops.");
        }
        const planned = routeStopProductToItem.get(routeStopProductKey(routeStopId, productId));
        if (planned) {
          addPickedStopItem({
            ...planned,
            quantity,
            reason: item.reason,
            notes: item.notes,
            actionType: "planned_pick",
          });
          return;
        }
        if (!machineId) throw new Error("Added products must be assigned to a valid route stop.");
        const key = routeStopProductKey(routeStopId, productId);
        const current = newAssignedExtras.get(key);
        newAssignedExtras.set(key, {
          routeStopId,
          machineId,
          productId,
          quantity: (current?.quantity ?? 0) + quantity,
          reason: item.reason || current?.reason || "Other",
          notes: mergeNotes(current?.notes, item.notes),
        });
        return;
      }

      const current = unassignedExtras.get(productId);
      unassignedExtras.set(productId, {
        productId,
        quantity: (current?.quantity ?? 0) + quantity,
        reason: item.reason || current?.reason || "Other",
        notes: mergeNotes(current?.notes, item.notes),
      });
    });

    const newRouteStopItemRows: Record<string, unknown>[] = [];
    if (newAssignedExtras.size) {
      Array.from(newAssignedExtras.values()).forEach((extra) => {
        const stopItemId = stableUuid(`pickup-stop-item:${pickupSubmissionScope}:${extra.routeStopId ?? "unassigned"}:${extra.productId}:${unitQuantity(extra.quantity)}:${extra.machineId ?? ""}:${extra.reason ?? ""}:${extra.notes ?? ""}`);
        const planned: PlannedStopItem = {
          id: stopItemId,
          routeStopId: extra.routeStopId,
          machineId: extra.machineId,
          productId: extra.productId,
          plannedQty: unitQuantity(extra.quantity),
        };
        newRouteStopItemRows.push({
          id: stopItemId,
          route_stop_id: extra.routeStopId,
          machine_id: extra.machineId,
          product_id: extra.productId,
          machine_slot_id: null,
          slot_code: null,
          planned_quantity: extra.quantity,
          picked_quantity: extra.quantity,
          source: "manual_admin_assignment",
          notes: "Added during storage pickup",
        });
        plannedStopItems.push(planned);
        routeStopItemById.set(planned.id, planned);
        routeStopProductToItem.set(routeStopProductKey(extra.routeStopId, extra.productId), planned);
        addPickedStopItem({
          ...planned,
          quantity: extra.quantity,
          reason: extra.reason,
          notes: extra.notes,
          actionType: "extra_product",
        });
      });
    }

    const plannedByProduct = new Map<string, number>();
    plannedStopItems.forEach((line) => {
      if (!line.productId) return;
      plannedByProduct.set(line.productId, (plannedByProduct.get(line.productId) ?? 0) + unitQuantity(line.plannedQty));
    });

    const legacyPickedRows = Array.from(legacyPickedByProduct.values()).map((item) => ({
      ...item,
      plannedQty: Math.max(0, Number(item.plannedQty ?? plannedByProduct.get(item.productId) ?? 0)),
    }));
    const pickedStopItemRows = Array.from(pickedStopItems.values());
    const pickedItemRows = [...pickedStopItemRows, ...legacyPickedRows];
    const extraRows = Array.from(unassignedExtras.values());
    logSubmittedPickupItems = [
      ...pickedStopItemRows.map((item) => ({
        route_stop_item_id: item.id || null,
        route_stop_id: item.routeStopId,
        machine_id: item.machineId,
        product_id: item.productId,
        planned_qty: unitQuantity(item.plannedQty),
        operator_pickup_qty: unitQuantity(item.quantity),
        action_type: item.actionType ?? "planned_pick",
        is_checked: Boolean(item.isChecked),
      })),
      ...legacyPickedRows.map((item) => ({
        route_stop_item_id: null,
        route_stop_id: null,
        machine_id: null,
        product_id: item.productId,
        planned_qty: unitQuantity(item.plannedQty),
        operator_pickup_qty: unitQuantity(item.quantity),
        action_type: "planned_pick",
        is_checked: true,
      })),
      ...extraRows.map((item) => ({
        route_stop_item_id: null,
        route_stop_id: null,
        machine_id: null,
        product_id: item.productId,
        planned_qty: 0,
        operator_pickup_qty: unitQuantity(item.quantity),
        action_type: "extra_product",
        is_checked: true,
      })),
    ];
    const actualPickLines = [
      ...pickedItemRows.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...extraRows.map((item) => ({ productId: item.productId, quantity: item.quantity })),
    ];
    const pickedByProduct = new Map<string, number>();
    actualPickLines.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
    });
    if (!pickedByProduct.size) throw new Error("No stock quantities were picked.");

    const productIds = Array.from(pickedByProduct.keys());
    logProductIds = productIds;
    const { data: productRows, error: productError } = productIds.length
      ? await readClient
          .from("products")
          .select("id, name, active")
          .in("id", productIds)
      : { data: [], error: null };
    if (productError) throwActionError(productError, "Could not verify selected products.");

    const productById = new Map((productRows ?? []).map((product: any) => [String(product.id), product]));
    const manualProductIds = new Set(extras.map((item) => String(item.productId ?? "").trim()).filter(Boolean));
    for (const productId of productIds) {
      const product = productById.get(productId);
      if (!product) throw new Error("Product not found. Remove it from the pickup list and add it again.");
      if (manualProductIds.has(productId) && product.active === false) {
        throw new Error(`${product.name ?? "Selected product"} is inactive and cannot be added to this route.`);
      }
    }

    const [{ data: existingPickMovements, error: existingPickError }, { data: existingFillMovements, error: existingFillError }, { data: existingRouteStockLines, error: existingRouteStockError }] = await Promise.all([
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, from_entity_id, to_entity_id")
        .eq("related_route_id", routeId)
        .eq("reason", "storage_to_operator_bag"),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, reason, from_entity_type, to_entity_type")
        .eq("related_route_id", routeId)
        .in("reason", ["operator_bag_to_machine", "manual_correction"]),
      supabase
        .from("route_stock_lines")
        .select("product_id, returned_qty")
        .eq("route_id", routeId),
    ]);
    if (existingPickError) throwActionError(existingPickError, "Could not load current route pickup movements.");
    if (existingFillError) throwActionError(existingFillError, "Could not verify route fills before updating pickup.");
    if (existingRouteStockError) throwActionError(existingRouteStockError, "Could not verify route returns before updating pickup.");

    const existingPickedByProduct = new Map<string, number>();
    const pickedLocationsByProduct = new Map<string, { storageId: string; operatorId: string | null; quantity: number }[]>();
    (existingPickMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id ?? "");
      const quantity = unitQuantity(movement.quantity);
      const storageId = String(movement.from_entity_id ?? "");
      if (!productId || quantity <= 0) return;
      existingPickedByProduct.set(productId, (existingPickedByProduct.get(productId) ?? 0) + quantity);
      if (storageId) {
        pickedLocationsByProduct.set(productId, [
          ...(pickedLocationsByProduct.get(productId) ?? []),
          { storageId, operatorId: movement.to_entity_id ? String(movement.to_entity_id) : null, quantity },
        ]);
      }
    });

    const filledByProduct = new Map<string, number>();
    (existingFillMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id ?? "");
      if (!productId) return;
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + machineFillDelta(movement));
    });

    const returnedByProduct = new Map<string, number>();
    (existingRouteStockLines ?? []).forEach((line: any) => {
      const productId = String(line.product_id ?? "");
      if (!productId) return;
      returnedByProduct.set(productId, (returnedByProduct.get(productId) ?? 0) + unitQuantity(line.returned_qty));
    });

    const productIdsForDelta = batchMode
      ? new Set([...pickedByProduct.keys()])
      : new Set([...pickedByProduct.keys(), ...existingPickedByProduct.keys()]);
    const increaseByProduct = new Map<string, number>();
    const decreaseByProduct = new Map<string, number>();

    productIdsForDelta.forEach((productId) => {
      const previousPicked = existingPickedByProduct.get(productId) ?? 0;
      const nextPicked = batchMode ? previousPicked + (pickedByProduct.get(productId) ?? 0) : pickedByProduct.get(productId) ?? 0;
      const alreadyConsumed = (filledByProduct.get(productId) ?? 0) + (returnedByProduct.get(productId) ?? 0);
      if (nextPicked < alreadyConsumed) {
        throw new Error("Picked quantity cannot be reduced below stock already filled into machines or returned to storage.");
      }

      const delta = nextPicked - previousPicked;
      if (delta > 0) increaseByProduct.set(productId, delta);
      if (!batchMode && delta < 0) decreaseByProduct.set(productId, Math.abs(delta));
    });

    const storageByProduct = new Map<string, { locationId: string; quantity: number }[]>();
    if (increaseByProduct.size) {
      const { data: storages, error: storagesError } = await readClient
        .from("storage_locations")
        .select("id")
        .eq("active", true)
        .in("location_type", ["main_storage", "vehicle", "temporary", "other"])
        .order("location_type")
        .order("name");
      if (storagesError) throwActionError(storagesError, "Could not load active storage locations.");

      const activeStorageIds = (storages ?? []).map((storage: any) => storage.id).filter(Boolean);
      if (!activeStorageIds.length) throw new Error("No active storage location found");

      const { data: storageRows, error: storageError } = await readClient
        .from("current_inventory_by_location")
        .select("product_id, location_id, quantity_on_hand")
        .eq("location_type", "storage")
        .in("location_id", activeStorageIds)
        .in("product_id", Array.from(increaseByProduct.keys()));

      if (storageError) throwActionError(storageError, "Could not verify storage stock.");
      (storageRows ?? []).forEach((row: any) => {
        const productId = String(row.product_id);
        const locationId = String(row.location_id ?? "");
        const quantity = Math.max(0, Number(row.quantity_on_hand ?? 0));
        if (!productId || !locationId || quantity <= 0) return;
        storageByProduct.set(productId, [...(storageByProduct.get(productId) ?? []), { locationId, quantity }]);
      });
    }

    const shortageMessages: string[] = [];
    increaseByProduct.forEach((quantity, productId) => {
      const available = (storageByProduct.get(productId) ?? []).reduce((sum, row) => sum + row.quantity, 0);
      const shortage = Math.max(0, quantity - available);
      const product = productById.get(productId);
      const isManual = manualProductIds.has(productId);
      const availabilityLogRow = {
        route_id: routeId,
        product_id: productId,
        product_name: product?.name ?? "Unknown product",
        user_id: profile?.id ?? null,
        user_roles: profile?.roles ?? [],
        route_status: route.status ?? null,
        route_operator_id: route.operator_id ?? null,
        original_route_product: plannedByProduct.has(productId),
        manually_added: isManual,
        planned_qty: plannedByProduct.get(productId) ?? 0,
        operator_pickup_qty: pickedByProduct.get(productId) ?? 0,
        warehouse_storage_available: available,
        storage_locations: storageByProduct.get(productId) ?? [],
        additional_quantity_needed: quantity,
        calculated_shortage: shortage,
      };
      logStorageAvailability.push(availabilityLogRow);
      console.info("[operator:pick-list] Pickup validation", {
        ...availabilityLogRow,
        available_warehouse_stock: available,
        entered_quantity: pickedByProduct.get(productId) ?? 0,
      });
      if (shortage > 0) {
        shortageMessages.push(`${product?.name ?? "Selected product"}: entered ${pickedByProduct.get(productId) ?? quantity}, available ${available}, shortage ${shortage}`);
      }
    });
    if (shortageMessages.length) {
      throw new Error(`Not enough warehouse stock for:\n- ${shortageMessages.join("\n- ")}`);
    }

    const stockAllocations: { productId: string; locationId: string; quantity: number }[] = [];
    for (const [productId, quantity] of increaseByProduct) {
      let remaining = quantity;
      const locations = [...(storageByProduct.get(productId) ?? [])].sort((a, b) => b.quantity - a.quantity);

      for (const location of locations) {
        if (remaining <= 0) break;
        const allocated = Math.min(remaining, location.quantity);
        if (allocated > 0) {
          stockAllocations.push({ productId, locationId: location.locationId, quantity: allocated });
          remaining -= allocated;
        }
      }

      if (remaining > 0) {
        const product = productById.get(productId);
        throw new Error(`Not enough warehouse stock for ${product?.name ?? "selected product"}. Shortage ${remaining}.`);
      }
    }

    const confirmedAt = new Date().toISOString();
    let pickupBatchId: string | null = batchMode ? pickupSubmissionScope : clientSubmissionId || null;
    logPickupBatchId = pickupBatchId;
    const productSummary = Array.from(pickedByProduct.entries()).map(([productId, quantity]) => ({
      product_id: productId,
      product_name: productById.get(productId)?.name ?? null,
      quantity,
    }));
    const pickupBatchPayload = batchMode
      ? {
          id: pickupBatchId,
          route_id: routeId,
          operator_id: route.operator_id,
          status: "confirmed",
          selected_stop_ids: selectedStopIds,
          product_summary: productSummary,
          storage_deducted: stockAllocations.length > 0,
          confirmed_at: confirmedAt,
        }
      : null;

    // Create inventory movements for each picked item
    const movements = [
      ...stockAllocations.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        from_entity_type: "storage" as const,
        from_entity_id: item.locationId,
        to_entity_type: "operator_bag" as const,
        to_entity_id: route.operator_id,
        reason: "storage_to_operator_bag" as const,
        related_route_id: routeId,
        related_pickup_batch_id: pickupBatchId,
        idempotency_key: inventoryMovementIdempotencyKey("route-pickup", routeId, pickupSubmissionScope, item.productId, item.locationId, route.operator_id ?? "", item.quantity),
        source_type: "route_pickup_batch",
        source_id: routeSourceUuid(pickupBatchId, `route-pickup:${routeId}:${pickupSubmissionScope}`),
        created_by: route.operator_id,
        notes: pickupBatchId ? `Picked for route ${routeId} batch ${pickupBatchId}` : `Picked for route ${routeId}`,
      })),
      ...Array.from(decreaseByProduct.entries()).flatMap(([productId, quantity]) => {
        let remaining = quantity;
        const returnRows: any[] = [];
        for (const pickedLocation of pickedLocationsByProduct.get(productId) ?? []) {
          if (remaining <= 0) break;
          const returnedQty = Math.min(remaining, pickedLocation.quantity);
          if (returnedQty <= 0) continue;
          returnRows.push({
            product_id: productId,
            quantity: returnedQty,
            from_entity_type: "operator_bag" as const,
            from_entity_id: pickedLocation.operatorId ?? route.operator_id,
            to_entity_type: "storage" as const,
            to_entity_id: pickedLocation.storageId,
            reason: "operator_bag_to_storage" as const,
            related_route_id: routeId,
            related_pickup_batch_id: pickupBatchId,
            idempotency_key: inventoryMovementIdempotencyKey("route-pickup-return", routeId, pickupSubmissionScope, productId, pickedLocation.storageId, pickedLocation.operatorId ?? route.operator_id ?? "", returnedQty),
            source_type: "route_pickup_batch",
            source_id: routeSourceUuid(pickupBatchId, `route-pickup:${routeId}:${pickupSubmissionScope}`),
            created_by: route.operator_id,
            notes: `Pickup quantity reduced for route ${routeId}`,
          });
          remaining -= returnedQty;
        }
        return returnRows;
      }),
    ];
    logInventoryMovementPayload = movements;

    const pickListRows = [
      ...pickedStopItemRows.map((item) => {
        const plannedQty = Number(item.plannedQty ?? 0);
        const pickedQty = Math.max(0, Number(item.quantity ?? 0));
        const actionType = item.actionType ?? "planned_pick";
        return {
          id: stableUuid(`pickup-list-row:${pickupSubmissionScope}:planned:${item.routeStopItemId ?? item.productId}:${item.productId}:${pickedQty}:${actionType}:${item.routeStopId ?? ""}:${item.reason ?? ""}:${item.notes ?? ""}`),
          route_id: routeId,
          route_stop_id: item.routeStopId,
          route_stop_item_id: item.id || null,
          machine_id: item.machineId,
          product_id: item.productId,
          planned_qty: actionType === "extra_product" ? 0 : plannedQty,
          picked_qty: pickedQty,
          action_type: actionType,
          pickup_batch_id: pickupBatchId,
          reason: actionType === "extra_product" || pickedQty !== plannedQty ? item.reason || "Other" : null,
          notes: item.notes || null,
          needs_review: actionType === "extra_product" || pickedQty !== plannedQty,
          is_checked: Boolean(item.isChecked),
          checked_at: item.isChecked ? confirmedAt : null,
          checked_by: item.isChecked ? profile.id : null,
          created_by: route.operator_id,
        };
      }),
      ...legacyPickedRows.map((item) => {
        const plannedQty = plannedByProduct.get(String(item.productId)) ?? Number(item.plannedQty ?? 0);
        const pickedQty = Math.max(0, Number(item.quantity ?? 0));
        return {
          id: stableUuid(`pickup-list-row:${pickupSubmissionScope}:legacy:${item.productId}:${pickedQty}:${plannedQty}:${item.reason ?? ""}:${item.notes ?? ""}`),
          route_id: routeId,
          route_stop_id: null,
          route_stop_item_id: null,
          machine_id: null,
          product_id: item.productId,
          planned_qty: plannedQty,
          picked_qty: pickedQty,
          action_type: "planned_pick",
          pickup_batch_id: pickupBatchId,
          reason: pickedQty !== plannedQty ? item.reason || "Other" : null,
          notes: item.notes || null,
          needs_review: pickedQty !== plannedQty,
          is_checked: true,
          checked_at: confirmedAt,
          checked_by: profile.id,
          created_by: route.operator_id,
        };
      }),
      ...extraRows.map((item) => ({
        id: stableUuid(`pickup-list-row:${pickupSubmissionScope}:extra:${item.productId}:${Math.max(0, Number(item.quantity ?? 0))}:${item.reason ?? ""}:${item.notes ?? ""}`),
        route_id: routeId,
        route_stop_id: null,
        route_stop_item_id: null,
        machine_id: null,
        product_id: item.productId,
        planned_qty: 0,
        picked_qty: Math.max(0, Number(item.quantity ?? 0)),
        action_type: "extra_product",
        pickup_batch_id: pickupBatchId,
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        is_checked: true,
        checked_at: confirmedAt,
        checked_by: profile.id,
        created_by: route.operator_id,
      })),
    ].filter((item) => Number(item.picked_qty ?? 0) > 0 || Number(item.planned_qty ?? 0) > 0);

    const { data: routeOrders, error: routeOrdersError } = await supabase
      .from("refill_orders")
      .select("id, machine_id, refill_order_lines(id, product_id, final_qty_to_take, suggested_qty)")
      .eq("route_id", routeId);
    if (routeOrdersError) throwActionError(routeOrdersError, "Could not load refill order lines.");
    const linesByMachineProduct = new Map<string, any[]>();
    const linesByProduct = new Map<string, any[]>();
    routeOrders?.forEach((order: any) => {
      order.refill_order_lines?.forEach((line: any) => {
        const productKey = String(line.product_id);
        const machineKey = `${String(order.machine_id ?? "")}:${productKey}`;
        linesByProduct.set(productKey, [...(linesByProduct.get(productKey) ?? []), line]);
        linesByMachineProduct.set(machineKey, [...(linesByMachineProduct.get(machineKey) ?? []), line]);
      });
    });

    const stopItemPickRows = pickedStopItemRows
      .filter((entry) => Number(entry.quantity) >= 0 && entry.id)
      .map((item) => ({
        id: item.id,
        picked_quantity: Math.max(0, Number(item.quantity ?? 0)),
      }));

    const refillLinePickRows: { id: string; picked_qty: number }[] = [];
    for (const item of pickedStopItemRows.filter((entry) => Number(entry.quantity) >= 0)) {
      let remaining = Number(item.quantity);
      const lines = item.machineId ? (linesByMachineProduct.get(`${item.machineId}:${String(item.productId)}`) ?? []) : [];

      for (const line of lines) {
        const plannedQty = Number(line.final_qty_to_take ?? line.suggested_qty ?? 0);
        const pickedQty = Math.max(0, Math.min(remaining, plannedQty));
        remaining -= pickedQty;
        refillLinePickRows.push({ id: line.id, picked_qty: pickedQty });
      }
    }

    for (const item of legacyPickedRows.filter((entry) => Number(entry.quantity) >= 0)) {
      let remaining = Number(item.quantity);
      const lines = linesByProduct.get(String(item.productId)) ?? [];

      for (const line of lines) {
        const plannedQty = Number(line.final_qty_to_take ?? line.suggested_qty ?? 0);
        const pickedQty = Math.max(0, Math.min(remaining, plannedQty));
        remaining -= pickedQty;
        refillLinePickRows.push({ id: line.id, picked_qty: pickedQty });
      }
    }

    const stockLineRows = Array.from(new Set([...Array.from(plannedByProduct.keys()), ...Array.from(pickedByProduct.keys())])).map((productId) => ({
      route_id: routeId,
      product_id: productId,
      planned_qty: plannedByProduct.get(productId) ?? 0,
      picked_qty: batchMode
        ? (existingPickedByProduct.get(productId) ?? 0) + (pickedByProduct.get(productId) ?? 0)
        : pickedByProduct.get(productId) ?? 0,
      updated_at: confirmedAt,
    }));

    const selectedMachineIds = batchMode
      ? Array.from(new Set(selectedStopIds.map((stopId) => cleanId(stopById.get(stopId)?.machine_id)).filter((id): id is string => Boolean(id))))
      : [];
    const remainingPendingStopCount = batchMode
      ? (routeStops ?? []).filter((stop: any) => String(stop.status ?? "") === ROUTE_STOP_PENDING_STATUS && !selectedStopIdSet.has(String(stop.id ?? ""))).length
      : 0;
    const nextRouteStatus = batchMode && remainingPendingStopCount === 0 ? ROUTE_PICKUP_CONFIRMED_STATUS : ROUTE_IN_PROGRESS_STATUS;

    logPayload = {
      pickup_batch: pickupBatchPayload,
      batch_stop_ids: batchMode ? selectedStopIds : [],
      new_stop_item_rows: newRouteStopItemRows,
      inventory_movements: movements,
      pick_list_rows: pickListRows,
      stock_line_rows: stockLineRows,
      stop_item_picks: stopItemPickRows,
      refill_line_picks: refillLinePickRows,
      selected_stop_ids: selectedStopIds,
      selected_machine_ids: selectedMachineIds,
      next_route_status: nextRouteStatus,
      remaining_pending_stop_count: remainingPendingStopCount,
    };

    const { data: pickupRpcRows, error: pickupRpcError } = await supabase.rpc("confirm_route_pickup_batch", {
      p_route_id: routeId,
      p_expected_route_status: route.status,
      p_next_route_status: nextRouteStatus,
      p_started_at: confirmedAt,
      p_replace_pick_list: !batchMode,
      p_pickup_batch: pickupBatchPayload,
      p_batch_stop_ids: batchMode ? selectedStopIds : [],
      p_new_stop_item_rows: newRouteStopItemRows,
      p_inventory_movements: movements,
      p_pick_list_rows: pickListRows,
      p_stock_line_rows: stockLineRows,
      p_stop_item_picks: stopItemPickRows,
      p_refill_line_picks: refillLinePickRows,
      p_selected_stop_ids: selectedStopIds,
      p_selected_machine_ids: selectedMachineIds,
    });

    if (pickupRpcError) throwActionError(pickupRpcError, PICKUP_CONFIRMATION_FALLBACK_ERROR);
    const rpcPickupBatch = Array.isArray(pickupRpcRows) ? pickupRpcRows[0]?.pickup_batch_id : null;
    pickupBatchId = pickupBatchId ?? (rpcPickupBatch ? String(rpcPickupBatch) : null);
    logPickupBatchId = pickupBatchId;

    const checklistRows = pickListRows.filter((row) => row.route_stop_item_id);
    if (checklistRows.length) {
      const checklistResults = await Promise.all(checklistRows.map((row) => {
        let query = supabase
          .from("route_pick_list_items")
          .update({
            is_checked: Boolean(row.is_checked),
            checked_at: row.is_checked ? row.checked_at ?? confirmedAt : null,
            checked_by: row.is_checked ? row.checked_by ?? profile.id : null,
          })
          .eq("route_id", routeId)
          .eq("route_stop_item_id", row.route_stop_item_id);
        if (pickupBatchId) query = query.eq("pickup_batch_id", pickupBatchId);
        return query;
      }));
      const checklistError = checklistResults.find((result) => result.error)?.error;
      if (checklistError && !isMissingOptionalPickupChecklistColumn(checklistError)) {
        throwActionError(checklistError, "Pickup was confirmed, but checklist state could not be saved.");
      }
    }

    await logActivity({
      profile,
      action: "confirm_pick_list",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      afterData: {
        picked_items: pickedItems,
        extras,
        pickup_batch_id: pickupBatchId,
        selected_stop_ids: selectedStopIds,
        movement_count: movements.length,
        pick_list_count: pickListRows.length,
      },
      metadata: { operator_id: route.operator_id, pickup_batch_id: pickupBatchId, selected_stop_ids: selectedStopIds },
      summary: batchMode
        ? `Confirmed pickup batch for ${selectedStopIds.length} stops with ${movements.length} inventory movement rows`
        : `Confirmed pick list with ${movements.length} inventory movement rows`,
    });

    console.info("[operator:pick-list] Pickup confirmed", {
      action: "confirm_pick_list",
      route_id: routeId,
      user_id: profile?.id ?? null,
      route_status_before: route.status ?? null,
      route_status_after: nextRouteStatus,
      selected_stop_ids: selectedStopIds,
      pickup_batch_id: pickupBatchId,
      redirect_path: operatorRouteDetailPath(routeId),
    });

    revalidateRouteWorkflow(routeId);
    return actionSuccess();
  } catch (error) {
    const errorInfo = serializeActionError(error);
    console.error("[operator:pick-list] Error confirming pick list", {
      route_id: routeId,
      pickup_batch_id: logPickupBatchId,
      selected_stop_ids: logSelectedStopIds,
      product_ids: logProductIds,
      user_id: logProfile?.id ?? null,
      user_role: logProfile?.role ?? null,
      user_roles: logProfile?.roles ?? [],
      user_team_member_id: logProfile?.team_member_id ?? null,
      route_status: logRouteStatus,
      route_operator_id: logRouteOperatorId,
      stop_statuses_before_pickup: logStopStatusesBeforePickup,
      submitted_pickup_items: logSubmittedPickupItems,
      warehouse_storage_stock_available: logStorageAvailability,
      inventory_movement_payload: logInventoryMovementPayload,
      rpc_payload: logPayload,
      exact_supabase_postgres_error_code: errorInfo.code,
      exact_supabase_postgres_error_message: errorInfo.message,
      exact_supabase_postgres_error_details: errorInfo.details,
      exact_supabase_postgres_error_hint: errorInfo.hint,
      stack_trace: errorInfo.stack,
      raw_error: errorInfo,
      submitted_raw_picked_items: pickedItems,
      extras,
    });
    return actionFailure(pickupPublicError(error), { code: String(errorInfo.code ?? "") || undefined });
  }
}

/**
 * Updates a route stop status and creates inventory movements
 * Called when operator arrives at a machine
 */
export async function arrivedAtStop(stopId: string) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const { error } = await supabase
      .from("route_stops")
      .update({ status: "arrived", arrived_at: new Date().toISOString() })
      .eq("id", stopId);

    if (error) throwActionError(error, "Could not mark arrival at this stop.");
    return { success: true };
  } catch (error) {
    console.error("Error marking arrival:", error);
    throw new Error(getErrorMessage(error, "Could not mark arrival at this stop."));
  }
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type RefreshRecommendationRow = {
  recommendation_key?: string | null;
  machine_id?: string | null;
  machine_slot_id?: string | null;
  slot_code?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  current_qty?: unknown;
  capacity?: unknown;
  par_qty?: unknown;
  suggested_qty?: unknown;
  available_storage_qty?: unknown;
  final_qty_to_take?: unknown;
  priority?: string | null;
};

type RefreshSlotAllocation = {
  recommendation_key: string | null;
  machine_slot_id: string | null;
  slot_code: string | null;
  current_qty: number;
  target_qty: number;
  recommended_take_qty: number;
  final_take_qty: number;
  priority: string | null;
  allocation_kind?: "slot" | "extra";
  over_recommended?: boolean;
};

type RefreshPlannedLine = {
  routeId: string;
  routeStopId: string;
  machineId: string;
  productId: string;
  productName: string;
  plannedQty: number;
  recommendedTakeQty: number;
  finalTakeQty: number;
  availableStorageQty: number;
  machineSlotId: string | null;
  slotCode: string | null;
  slotAllocations: RefreshSlotAllocation[];
};

export type PendingStopRefreshComparison = {
  routeStopId: string;
  machineId: string;
  machineName: string;
  machineCode: string;
  stopOrder: number;
  changes: {
    productId: string;
    productName: string;
    oldQty: number;
    newQty: number;
    difference: number;
  }[];
};

type PendingStopRefreshPlan = {
  eligibleStops: any[];
  comparisons: PendingStopRefreshComparison[];
  plannedLines: RefreshPlannedLine[];
};

function refreshRecommendationQuantity(row: RefreshRecommendationRow) {
  return unitQuantity(row.final_qty_to_take ?? row.suggested_qty);
}

function refreshRecommendationTarget(row: RefreshRecommendationRow) {
  return unitQuantity(row.capacity ?? row.par_qty);
}

const refreshPriorityOrder = ["critical", "high", "medium", "low"];

function refreshPriorityScore(priority: string | null | undefined) {
  const index = refreshPriorityOrder.indexOf(String(priority ?? "low").toLowerCase());
  return index === -1 ? 0 : refreshPriorityOrder.length - index;
}

function refreshAllocationSort(a: RefreshRecommendationRow, b: RefreshRecommendationRow) {
  const priorityDifference = refreshPriorityScore(b.priority) - refreshPriorityScore(a.priority);
  if (priorityDifference) return priorityDifference;
  const quantityDifference = Math.max(0, Number(a.current_qty ?? 0)) - Math.max(0, Number(b.current_qty ?? 0));
  if (quantityDifference) return quantityDifference;
  return String(a.slot_code ?? "").localeCompare(String(b.slot_code ?? ""));
}

function allocateRefreshFinalTake(rows: RefreshRecommendationRow[], finalTakeQty: number): RefreshSlotAllocation[] {
  let remaining = unitQuantity(finalTakeQty);
  const allocations: RefreshSlotAllocation[] = [...rows].sort(refreshAllocationSort).map((row) => {
    const recommendedTakeQty = refreshRecommendationQuantity(row);
    const allocated = Math.min(remaining, recommendedTakeQty);
    remaining -= allocated;
    return {
      recommendation_key: row.recommendation_key ?? null,
      machine_slot_id: row.machine_slot_id ?? null,
      slot_code: row.slot_code ?? null,
      current_qty: unitQuantity(row.current_qty),
      target_qty: refreshRecommendationTarget(row),
      recommended_take_qty: recommendedTakeQty,
      final_take_qty: allocated,
      priority: row.priority ?? null,
      allocation_kind: "slot" as const,
    };
  });

  if (remaining > 0) {
    allocations.push({
      recommendation_key: null,
      machine_slot_id: null,
      slot_code: null,
      current_qty: 0,
      target_qty: 0,
      recommended_take_qty: 0,
      final_take_qty: remaining,
      priority: null,
      allocation_kind: "extra",
      over_recommended: true,
    });
  }

  return allocations.filter((allocation) => allocation.final_take_qty > 0 || allocation.recommended_take_qty > 0);
}

async function buildPendingStopRefreshPlan(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
  routeId: string,
): Promise<PendingStopRefreshPlan> {
  const { data: stops, error: stopsError } = await supabase
    .from("route_stops")
    .select("id, route_id, machine_id, stop_order, status, machine:machines(id, name, machine_code)")
    .eq("route_id", routeId)
    .order("stop_order", { ascending: true });
  if (stopsError) throwActionError(stopsError, "Could not load route stops.");

  const eligibleStops = (stops ?? []).filter((stop: any) => String(stop.status ?? "") === ROUTE_STOP_PENDING_STATUS);
  if (!eligibleStops.length) return { eligibleStops: [], comparisons: [], plannedLines: [] };

  const eligibleStopIds = eligibleStops.map((stop: any) => String(stop.id));
  const eligibleMachineIds = eligibleStops.map((stop: any) => String(stop.machine_id)).filter(Boolean);
  const stopByMachine = new Map(eligibleStops.map((stop: any) => [String(stop.machine_id), stop]));

  const [{ data: oldItems, error: oldItemsError }, { data: recommendations, error: recommendationsError }] = await Promise.all([
    supabase
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, planned_quantity, source, product:products(id, name)")
      .eq("route_id", routeId)
      .in("route_stop_id", eligibleStopIds),
    eligibleMachineIds.length
      ? supabase
          .from("refill_recommendations")
          .select("recommendation_key, machine_id, machine_slot_id, slot_code, product_id, product_name, current_qty, capacity, par_qty, suggested_qty, available_storage_qty, final_qty_to_take, priority")
          .in("machine_id", eligibleMachineIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (oldItemsError) throwActionError(oldItemsError, "Could not load current pending stop plan.");
  if (recommendationsError) throwActionError(recommendationsError, "Could not load latest refill recommendations.");

  const oldByStopProduct = new Map<string, { productId: string; productName: string; quantity: number }>();
  const productNames = new Map<string, string>();
  (oldItems ?? [])
    .filter((item: any) => String(item.source ?? "refill_recommendation") === "refill_recommendation")
    .forEach((item: any) => {
      const routeStopId = String(item.route_stop_id ?? "");
      const productId = String(item.product_id ?? "");
      if (!routeStopId || !productId) return;
      const product = firstRelation(item.product);
      const productName = (product as any)?.name ?? "Unknown product";
      productNames.set(productId, productName);
      const key = `${routeStopId}:${productId}`;
      const current = oldByStopProduct.get(key) ?? { productId, productName, quantity: 0 };
      current.quantity += unitQuantity(item.planned_quantity);
      oldByStopProduct.set(key, current);
    });

  const groupedRecommendations = new Map<string, RefreshRecommendationRow[]>();
  ((recommendations ?? []) as RefreshRecommendationRow[])
    .filter((row) => refreshRecommendationQuantity(row) > 0)
    .forEach((row) => {
      const machineId = String(row.machine_id ?? "");
      const productId = String(row.product_id ?? "");
      const stop = stopByMachine.get(machineId);
      if (!stop || !productId) return;
      productNames.set(productId, row.product_name ?? productNames.get(productId) ?? "Unknown product");
      const key = `${String(stop.id)}:${productId}`;
      groupedRecommendations.set(key, [...(groupedRecommendations.get(key) ?? []), row]);
    });

  const plannedLines: RefreshPlannedLine[] = [];
  groupedRecommendations.forEach((rows, key) => {
    const [routeStopId, productId] = key.split(":");
    const stop = eligibleStops.find((item: any) => String(item.id) === routeStopId);
    const machineId = String(stop?.machine_id ?? "");
    if (!stop || !machineId || !productId) return;
    const finalTakeQty = rows.reduce((sum, row) => sum + refreshRecommendationQuantity(row), 0);
    if (finalTakeQty <= 0) return;
    const slotAllocations = allocateRefreshFinalTake(rows, finalTakeQty);
    const slotCodes = Array.from(new Set(rows.map((row) => row.slot_code).filter(Boolean))) as string[];
    plannedLines.push({
      routeId,
      routeStopId,
      machineId,
      productId,
      productName: productNames.get(productId) ?? rows[0]?.product_name ?? "Unknown product",
      plannedQty: finalTakeQty,
      recommendedTakeQty: rows.reduce((sum, row) => sum + unitQuantity(row.suggested_qty), 0),
      finalTakeQty,
      availableStorageQty: Math.max(...rows.map((row) => unitQuantity(row.available_storage_qty)), 0),
      machineSlotId: rows.length === 1 ? rows[0].machine_slot_id ?? null : null,
      slotCode: rows.length === 1 ? rows[0].slot_code ?? null : slotCodes.length ? slotCodes.join(", ") : null,
      slotAllocations,
    });
  });

  const newByStopProduct = new Map(plannedLines.map((line) => [`${line.routeStopId}:${line.productId}`, line]));
  const comparisons: PendingStopRefreshComparison[] = eligibleStops
    .map((stop: any) => {
      const routeStopId = String(stop.id);
      const productIds = new Set<string>();
      oldByStopProduct.forEach((item, key) => {
        if (key.startsWith(`${routeStopId}:`)) productIds.add(item.productId);
      });
      newByStopProduct.forEach((item, key) => {
        if (key.startsWith(`${routeStopId}:`)) productIds.add(item.productId);
      });
      const changes = Array.from(productIds)
        .map((productId) => {
          const oldQty = oldByStopProduct.get(`${routeStopId}:${productId}`)?.quantity ?? 0;
          const newQty = newByStopProduct.get(`${routeStopId}:${productId}`)?.plannedQty ?? 0;
          return {
            productId,
            productName: productNames.get(productId) ?? newByStopProduct.get(`${routeStopId}:${productId}`)?.productName ?? oldByStopProduct.get(`${routeStopId}:${productId}`)?.productName ?? "Unknown product",
            oldQty,
            newQty,
            difference: newQty - oldQty,
          };
        })
        .filter((change) => change.oldQty !== change.newQty)
        .sort((a, b) => a.productName.localeCompare(b.productName));
      const machine = firstRelation(stop.machine);
      return {
        routeStopId,
        machineId: String(stop.machine_id ?? ""),
        machineName: (machine as any)?.name ?? "Unknown machine",
        machineCode: (machine as any)?.machine_code ?? "-",
        stopOrder: Number(stop.stop_order ?? 0),
        changes,
      };
    })
    .filter((comparison) => comparison.changes.length > 0);

  return { eligibleStops, comparisons, plannedLines };
}

async function refreshRouteStockPlan(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
  routeId: string,
) {
  const [{ data: allItems, error: allItemsError }, { data: stockLines, error: stockLinesError }] = await Promise.all([
    supabase.from("route_stop_items").select("product_id, planned_quantity").eq("route_id", routeId),
    supabase.from("route_stock_lines").select("id, product_id, picked_qty, returned_qty").eq("route_id", routeId),
  ]);
  if (allItemsError) throwActionError(allItemsError, "Could not recalculate route stock plan.");
  if (stockLinesError) throwActionError(stockLinesError, "Could not load route stock lines.");

  const plannedByProduct = new Map<string, number>();
  (allItems ?? []).forEach((item: any) => {
    const productId = String(item.product_id ?? "");
    if (!productId) return;
    plannedByProduct.set(productId, (plannedByProduct.get(productId) ?? 0) + unitQuantity(item.planned_quantity));
  });

  const existingProductIds = new Set((stockLines ?? []).map((line: any) => String(line.product_id)));
  for (const line of stockLines ?? []) {
    const productId = String((line as any).product_id ?? "");
    const plannedQty = plannedByProduct.get(productId) ?? 0;
    const hasHistory = unitQuantity((line as any).picked_qty) > 0 || unitQuantity((line as any).returned_qty) > 0;
    if (plannedQty <= 0 && !hasHistory) {
      const { error } = await supabase.from("route_stock_lines").delete().eq("id", (line as any).id);
      if (error) throwActionError(error, "Could not remove stale route stock line.");
      continue;
    }
    const { error } = await supabase
      .from("route_stock_lines")
      .update({ planned_qty: plannedQty, updated_at: new Date().toISOString() })
      .eq("id", (line as any).id);
    if (error) throwActionError(error, "Could not update route stock line.");
  }

  const newRows = Array.from(plannedByProduct.entries())
    .filter(([productId, quantity]) => quantity > 0 && !existingProductIds.has(productId))
    .map(([productId, quantity]) => ({ route_id: routeId, product_id: productId, planned_qty: quantity }));
  if (newRows.length) {
    const { error } = await supabase.from("route_stock_lines").insert(newRows);
    if (error) throwActionError(error, "Could not add refreshed route stock lines.");
  }
}

async function requireOperatorRouteAccess(routeId: string) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");
  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const { data: route, error: routeError } = await supabase.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle();
  if (routeError) throwActionError(routeError, "Could not load this route.");
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    throw new Error("You are not authorized to update this route.");
  }
  if (isTerminalRouteStatus(route.status)) throw new Error("Completed or cancelled routes cannot be edited.");
  return { supabase, profile, route };
}

export async function previewPendingStopRecommendationRefresh(routeId: string) {
  try {
    if (!routeId) throw new Error("Route id is required.");
    const { supabase } = await requireOperatorRouteAccess(routeId);
    const plan = await buildPendingStopRefreshPlan(supabase, routeId);
    return {
      success: true,
      eligibleStopCount: plan.eligibleStops.length,
      hasChanges: plan.comparisons.length > 0,
      comparisons: plan.comparisons,
    };
  } catch (error) {
    console.error("[operator:refresh-pending-stops] Preview failed", { route_id: routeId, error });
    return { success: false, error: getErrorMessage(error, "Could not refresh pending recommendations."), eligibleStopCount: 0, hasChanges: false, comparisons: [] };
  }
}

export async function applyPendingStopRecommendationRefresh(routeId: string) {
  try {
    if (!routeId) throw new Error("Route id is required.");
    const { supabase, profile, route } = await requireOperatorRouteAccess(routeId);
    const plan = await buildPendingStopRefreshPlan(supabase, routeId);
    const eligibleStopIds = plan.eligibleStops.map((stop: any) => String(stop.id));
    const eligibleMachineIds = plan.eligibleStops.map((stop: any) => String(stop.machine_id)).filter(Boolean);
    if (!eligibleStopIds.length) return { success: true, applied: false, comparisons: [], message: "No pending stops to refresh." };
    if (!plan.comparisons.length) return { success: true, applied: false, comparisons: [], message: "Pending recommendations are already current." };

    const { error: deleteStopItemsError } = await supabase
      .from("route_stop_items")
      .delete()
      .eq("route_id", routeId)
      .in("route_stop_id", eligibleStopIds)
      .eq("source", "refill_recommendation");
    if (deleteStopItemsError) throwActionError(deleteStopItemsError, "Could not remove old pending recommendation rows.");

    if (plan.plannedLines.length) {
      const { error: insertStopItemsError } = await supabase.from("route_stop_items").insert(plan.plannedLines.map((line) => ({
        route_id: routeId,
        route_stop_id: line.routeStopId,
        machine_id: line.machineId,
        product_id: line.productId,
        machine_slot_id: line.machineSlotId,
        slot_code: line.slotCode,
        planned_quantity: line.plannedQty,
        recommended_take_qty: line.recommendedTakeQty,
        final_take_qty: line.finalTakeQty,
        picked_quantity: null,
        filled_quantity: null,
        returned_quantity: null,
        source: "refill_recommendation",
        slot_allocations: line.slotAllocations,
      })));
      if (insertStopItemsError) throwActionError(insertStopItemsError, "Could not save refreshed pending recommendation rows.");
    }

    const { data: existingOrders, error: existingOrdersError } = await supabase
      .from("refill_orders")
      .select("id, machine_id")
      .eq("route_id", routeId)
      .in("machine_id", eligibleMachineIds);
    if (existingOrdersError) throwActionError(existingOrdersError, "Could not load refill orders for pending stops.");

    const orderByMachine = new Map((existingOrders ?? []).map((order: any) => [String(order.machine_id), String(order.id)]));
    const missingMachineIds = eligibleMachineIds.filter((machineId) => !orderByMachine.has(machineId));
    if (missingMachineIds.length) {
      const { data: createdOrders, error: createOrdersError } = await supabase
        .from("refill_orders")
        .insert(missingMachineIds.map((machineId) => ({ route_id: routeId, machine_id: machineId, status: route.operator_id ? "assigned" : "draft" })))
        .select("id, machine_id");
      if (createOrdersError) throwActionError(createOrdersError, "Could not create refill orders for refreshed stops.");
      (createdOrders ?? []).forEach((order: any) => orderByMachine.set(String(order.machine_id), String(order.id)));
    }

    const orderIds = Array.from(orderByMachine.values());
    if (orderIds.length) {
      const { error: deleteLinesError } = await supabase
        .from("refill_order_lines")
        .delete()
        .in("refill_order_id", orderIds)
        .eq("source", "refill_recommendation");
      if (deleteLinesError) throwActionError(deleteLinesError, "Could not remove old pending refill lines.");
    }

    const refillLines = plan.plannedLines
      .map((line) => ({
        refill_order_id: orderByMachine.get(line.machineId),
        machine_slot_id: line.machineSlotId,
        slot_code: line.slotCode,
        product_id: line.productId,
        current_qty_vms: 0,
        par_qty: line.plannedQty,
        suggested_qty: line.recommendedTakeQty,
        available_storage_qty: line.availableStorageQty,
        final_qty_to_take: line.finalTakeQty,
        recommended_take_qty: line.recommendedTakeQty,
        final_take_qty: line.finalTakeQty,
        source: "refill_recommendation",
        slot_allocations: line.slotAllocations,
      }))
      .filter((line) => Boolean(line.refill_order_id));
    if (refillLines.length) {
      const { error: insertLinesError } = await supabase.from("refill_order_lines").insert(refillLines);
      if (insertLinesError) throwActionError(insertLinesError, "Could not save refreshed refill lines.");
    }

    await refreshRouteStockPlan(supabase, routeId);

    await logActivity({
      profile,
      action: "refresh_pending_route_recommendations",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      afterData: { comparisons: plan.comparisons, refreshed_stop_ids: eligibleStopIds },
      metadata: { route_id: routeId, refreshed_stop_count: eligibleStopIds.length },
      summary: `Refreshed recommendations for ${eligibleStopIds.length} pending route stops`,
    });

    revalidateRouteWorkflow(routeId);
    return { success: true, applied: true, comparisons: plan.comparisons, message: "Pending stop recommendations refreshed." };
  } catch (error) {
    console.error("[operator:refresh-pending-stops] Apply failed", { route_id: routeId, error });
    return { success: false, applied: false, comparisons: [], error: getErrorMessage(error, "Could not apply pending recommendation updates.") };
  }
}

export async function markStopInProgress(routeId: string, stopId: string) {
  try {
    if (!routeId || !stopId) throw new Error("Route and stop are required.");
    const { supabase, profile, route } = await requireOperatorRouteAccess(routeId);
    if (!isActiveRouteStatus(route.status)) return { success: true };

    const { data: stop, error: stopError } = await supabase.from("route_stops").select("id, route_id, status").eq("id", stopId).maybeSingle();
    if (stopError) throwActionError(stopError, "Could not load this stop.");
    if (!stop || stop.route_id !== routeId) throw new Error("Stop not found on this route.");
    if (String(stop.status ?? "") !== ROUTE_STOP_PICKED_STATUS) return { success: true };

    const { error } = await supabase
      .from("route_stops")
      .update({ status: ROUTE_STOP_IN_PROGRESS_STATUS, arrived_at: new Date().toISOString() })
      .eq("id", stopId)
      .eq("status", ROUTE_STOP_PICKED_STATUS);
    if (error) throwActionError(error, "Could not mark this stop in progress.");

    await logActivity({
      profile,
      action: "start_stop",
      entityType: "route_stop",
      entityId: stopId,
      entityLabel: `Stop ${stopId.slice(0, 8)}`,
      beforeData: stop,
      afterData: { status: ROUTE_STOP_IN_PROGRESS_STATUS },
      metadata: { route_id: routeId },
      summary: "Started route stop execution",
    });
    revalidateRouteWorkflow(routeId);
    return { success: true };
  } catch (error) {
    console.error("[operator:start-stop] Failed", { route_id: routeId, stop_id: stopId, error });
    return { success: false, error: getErrorMessage(error, "Could not start this stop.") };
  }
}

export async function skipStop(formData: FormData) {
  const routeId = String(formData.get("route_id") ?? "").trim();
  const stopId = String(formData.get("stop_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!routeId || !stopId) return;

  try {
    if (!reason) throw new Error("Reason is required.");
    const { supabase, profile } = await requireOperatorRouteAccess(routeId);
    const { data: stop, error: stopError } = await supabase.from("route_stops").select("*").eq("id", stopId).maybeSingle();
    if (stopError) throwActionError(stopError, "Could not load this stop.");
    if (!stop || stop.route_id !== routeId) throw new Error("Stop not found on this route.");
    if (String(stop.status ?? "") === ROUTE_STOP_COMPLETED_STATUS) throw new Error("Completed stops cannot be skipped.");
    if (String(stop.status ?? "") === ROUTE_STOP_SKIPPED_STATUS) return;

    const { data: after, error } = await supabase
      .from("route_stops")
      .update({ status: ROUTE_STOP_SKIPPED_STATUS, completed_at: new Date().toISOString(), notes: reason })
      .eq("id", stopId)
      .select("*")
      .single();
    if (error) throwActionError(error, "Could not skip this stop.");

    await logActivity({
      profile,
      action: "skip_stop",
      entityType: "route_stop",
      entityId: stopId,
      entityLabel: `Stop ${stopId.slice(0, 8)}`,
      beforeData: stop,
      afterData: after,
      metadata: { route_id: routeId, reason },
      summary: "Skipped route stop",
    });
    revalidateRouteWorkflow(routeId);
  } catch (error) {
    console.error("[operator:skip-stop] Failed", { route_id: routeId, stop_id: stopId, error });
    throw new Error(getErrorMessage(error, "Could not skip this stop."));
  }
}

type CompleteStopResult = ActionResult<{ expectedCash: number | null; routeId: string; stopId: string }>;

type CompleteStopInputItem = {
  refillOrderLineId?: string | null;
  productId: string;
  quantity: number;
  assignedQty?: number;
  reason?: string;
  notes?: string;
  unavailable?: boolean;
};

type CompleteStopExtraItem = { productId: string; quantity: number; reason: string; notes?: string };
type CompleteStopMissingProduct = { productName: string; reason: string; notes?: string };

function mapEntriesForLog(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([productId, quantity]) => ({ product_id: productId, quantity }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
}

function normalizeSubmittedQuantity(value: unknown, label: string) {
  const quantity = Number(
    typeof value === "string"
      ? value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => {
          const code = digit.charCodeAt(0);
          if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
          if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
          return digit;
        })
      : value,
  );
  if (!Number.isFinite(quantity)) throw new Error(`${label} must be a valid number.`);
  if (quantity < 0) throw new Error(`${label} cannot be negative.`);
  return Math.floor(quantity);
}

function normalizeCompleteStopItems(
  filledItems: CompleteStopInputItem[],
  extraItems: CompleteStopExtraItem[],
  missingProducts: CompleteStopMissingProduct[],
) {
  const normalizedFilledItems = filledItems.map((item, index) => {
    const productId = String(item.productId ?? "").trim();
    if (!productId) throw new Error(`Assigned fill line ${index + 1} is missing a product.`);
    return {
      ...item,
      productId,
      refillOrderLineId: item.refillOrderLineId || null,
      quantity: normalizeSubmittedQuantity(item.quantity, `Filled quantity for assigned line ${index + 1}`),
      assignedQty: normalizeSubmittedQuantity(item.assignedQty ?? 0, `Assigned quantity for assigned line ${index + 1}`),
      reason: item.reason?.trim() || undefined,
      notes: item.notes?.trim() || undefined,
      unavailable: Boolean(item.unavailable),
    };
  });

  const normalizedExtraItems = extraItems
    .map((item, index) => {
      const productId = String(item.productId ?? "").trim();
      const quantity = normalizeSubmittedQuantity(item.quantity, `Extra product quantity ${index + 1}`);
      return {
        ...item,
        productId,
        quantity,
        reason: item.reason?.trim() || "Other",
        notes: item.notes?.trim() || undefined,
      };
    })
    .filter((item) => item.productId && item.quantity > 0);

  const normalizedMissingProducts = missingProducts
    .map((item) => ({
      productName: item.productName?.trim() || "",
      reason: item.reason?.trim() || "Other",
      notes: item.notes?.trim() || undefined,
    }))
    .filter((item) => item.productName);

  return { normalizedFilledItems, normalizedExtraItems, normalizedMissingProducts };
}

function completeStopPublicError(error: unknown) {
  const message = getErrorMessage(error, "Could not complete this stop.");
  if (message.includes("not authorized")) return "Could not complete stop because you do not have permission.";
  if (message.includes("Completed or cancelled routes") || message.includes("Completed or canceled routes")) {
    return "Could not complete stop because this route is already completed/canceled.";
  }
  if (message.includes("not in progress")) return "Could not complete stop because this route is not in progress.";
  if (message.includes("does not belong")) return "Could not complete stop because stop data is incomplete.";
  if (message.includes("stock is missing")) return "Could not complete stop because product stock is missing.";
  if (message.includes("cannot exceed")) return "Could not complete stop because filled quantity exceeds carried quantity.";
  if (message.includes("missing a product") || message.includes("not found")) return "Could not complete stop because stop data is incomplete.";
  return message;
}

/**
 * Completes a machine stop with refill data
 * Creates inventory movements: operator_bag -> machine
 * Creates cash collection record
 */
export async function completeStop({
  stopId,
  routeId,
  machineId,
  filledItems,
  extraItems = [],
  missingProducts = [],
  cashCollected,
  cashBagId,
  notes,
  completionPhotoUrl,
  completionPhotoPath,
  completionPhotoOriginalName,
  completionPhotoUploadUnavailable,
  issue,
  clientSubmissionId,
}: {
  stopId: string;
  routeId: string;
  machineId: string;
  filledItems: { refillOrderLineId?: string | null; productId: string; quantity: number; assignedQty?: number; reason?: string; notes?: string; unavailable?: boolean }[];
  extraItems?: { productId: string; quantity: number; reason: string; notes?: string }[];
  missingProducts?: { productName: string; reason: string; notes?: string }[];
  cashCollected: boolean;
  cashBagId?: string;
  notes?: string;
  completionPhotoUrl?: string | null;
  completionPhotoPath?: string | null;
  completionPhotoOriginalName?: string | null;
  completionPhotoUploadUnavailable?: boolean;
  issue?: {
    issueType: string;
    priority: "critical" | "high" | "normal" | "low";
    description: string;
  };
  clientSubmissionId?: string | null;
}): Promise<CompleteStopResult> {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return actionFailure("Database is not available.", { expectedCash: null, routeId, stopId });

  let logProfile: Awaited<ReturnType<typeof getCurrentProfile>> | null = null;
  let logRoute: any = null;
  let logStop: any = null;
  let logMachine: any = null;
  let logStopItemCount: number | null = null;
  let logSubmittedFilledItems: unknown = filledItems;
  let logCarriedBefore = new Map<string, number>();
  let logCarriedAfter = new Map<string, number>();
  let logMissingProductRelations: string[] = [];

  try {
    const profile = await getCurrentProfile();
    logProfile = profile;
    const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
    const completedAt = new Date().toISOString();
    const stopSubmissionId = String(clientSubmissionId ?? "").trim() || routeId;
    const hasNewCompletionPhoto = Boolean(
      completionPhotoUrl?.trim() ||
      completionPhotoPath?.trim() ||
      completionPhotoOriginalName?.trim(),
    );
    if (!routeId || !stopId || !machineId) throw new Error("Route, stop, and machine are required to complete a stop.");
    const { normalizedFilledItems, normalizedExtraItems, normalizedMissingProducts } = normalizeCompleteStopItems(filledItems, extraItems, missingProducts);
    logSubmittedFilledItems = normalizedFilledItems.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
      assigned_qty: item.assignedQty ?? 0,
      refill_order_line_id: item.refillOrderLineId ?? null,
      unavailable: item.unavailable,
    }));

    // Get route to find operator
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();

    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    logRoute = route;
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      throw new Error("You are not authorized to complete this stop");
    }
    if (isTerminalRouteStatus(route.status)) {
      throw new Error("Completed or cancelled routes cannot be edited.");
    }
    if (!isActiveRouteStatus(route.status)) {
      throw new Error("This route is not in progress.");
    }

    const { data: stop, error: stopError } = await supabase.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle();
    if (stopError) throwActionError(stopError, "Could not load this stop.");
    if (!stop || stop.route_id !== routeId || stop.machine_id !== machineId) {
      throw new Error("This stop does not belong to the selected route.");
    }
    logStop = stop;
    const { data: existingProof, error: existingProofError } = await supabase
      .from("machine_refill_history")
      .select("machine_photo_url, machine_photo_path")
      .eq("legacy_refill_id", `route_stop:${stopId}`)
      .maybeSingle();
    if (existingProofError) throwActionError(existingProofError, "Could not verify the existing refill proof.");

    const hasExistingCompletionPhoto = Boolean(existingProof?.machine_photo_url || existingProof?.machine_photo_path);
    if (!hasNewCompletionPhoto && !hasExistingCompletionPhoto) throw new Error("Take or upload a final machine photo before completing the stop.");

    const [{ data: machine, error: machineError }, { data: operatorMember, error: operatorError }] = await Promise.all([
      supabase
        .from("machines")
        .select("id, name, machine_code")
        .eq("id", machineId)
        .maybeSingle(),
      route.operator_id
        ? supabase
            .from("team_members")
            .select("id, full_name, email")
            .eq("id", route.operator_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (machineError) throwActionError(machineError, "Could not load this machine.");
    if (operatorError) throwActionError(operatorError, "Could not load the route operator.");
    logMachine = machine;

    const { data: stopItemsForLog, error: stopItemsForLogError } = await supabase
      .from("route_stop_items")
      .select("id, product_id, product:products(id)")
      .eq("route_stop_id", stopId);
    if (stopItemsForLogError && !isMissingTable(stopItemsForLogError, "route_stop_items")) {
      console.warn("[operator:complete-stop] Could not load planned stop items for diagnostics", { route_id: routeId, stop_id: stopId, error: stopItemsForLogError });
    } else {
      logStopItemCount = stopItemsForLog?.length ?? 0;
      logMissingProductRelations = (stopItemsForLog ?? [])
        .filter((item: any) => item.product_id && !(Array.isArray(item.product) ? item.product[0] : item.product))
        .map((item: any) => String(item.product_id));
    }

    const { data: routeStockLines, error: stockError } = await supabase
      .from("route_stock_lines")
      .select("product_id, picked_qty, returned_qty")
      .eq("route_id", routeId);
    if (stockError) throwActionError(stockError, "Could not load picked stock for this route.");

    const { data: existingRouteFills, error: fillsError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, related_route_stop_id, reason, from_entity_type, to_entity_type")
      .eq("related_route_id", routeId)
      .in("reason", ["operator_bag_to_machine", "manual_correction"]);
    if (fillsError) throwActionError(fillsError, "Could not verify previous machine fills.");

    const filledSoFar = new Map<string, number>();
    const currentStopFilled = new Map<string, number>();
    (existingRouteFills ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      const qty = machineFillDelta(movement);
      filledSoFar.set(productId, (filledSoFar.get(productId) ?? 0) + qty);
      if (movement.related_route_stop_id === stopId) currentStopFilled.set(productId, (currentStopFilled.get(productId) ?? 0) + qty);
    });

    const actualFillLines = [
      ...normalizedFilledItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...normalizedExtraItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
    ];

    const requestedFills = new Map<string, number>();
    actualFillLines.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) requestedFills.set(productId, (requestedFills.get(productId) ?? 0) + quantity);
    });

    const stockByProduct = new Map((routeStockLines ?? []).map((line: any) => [String(line.product_id), unitQuantity(line.picked_qty) - unitQuantity(line.returned_qty)]));
    const submittedProductIds = Array.from(new Set([...normalizedFilledItems.map((item) => item.productId), ...normalizedExtraItems.map((item) => item.productId)]));
    const { data: submittedProducts, error: submittedProductsError } = submittedProductIds.length
      ? await supabase.from("products").select("id, name").in("id", submittedProductIds)
      : { data: [], error: null };
    if (submittedProductsError) throwActionError(submittedProductsError, "Could not verify submitted products.");
    const submittedProductById = new Map((submittedProducts ?? []).map((product: any) => [String(product.id), product]));
    const missingSubmittedProductIds = submittedProductIds.filter((productId) => !submittedProductById.has(productId));
    if (missingSubmittedProductIds.length) {
      logMissingProductRelations = Array.from(new Set([...logMissingProductRelations, ...missingSubmittedProductIds]));
      throw new Error("Submitted product not found. Remove it from the stop and add it again.");
    }

    const routeProductIds = new Set([...Array.from(stockByProduct.keys()), ...Array.from(filledSoFar.keys()), ...submittedProductIds]);
    routeProductIds.forEach((productId) => {
      const stockQty = stockByProduct.get(productId) ?? 0;
      const beforeQty = stockQty - (filledSoFar.get(productId) ?? 0);
      const filledByOtherStops = (filledSoFar.get(productId) ?? 0) - (currentStopFilled.get(productId) ?? 0);
      const afterQty = stockQty - filledByOtherStops - (requestedFills.get(productId) ?? 0);
      logCarriedBefore.set(productId, beforeQty);
      logCarriedAfter.set(productId, afterQty);
    });

    for (const [productId, quantity] of requestedFills) {
      const filledByOtherStops = (filledSoFar.get(productId) ?? 0) - (currentStopFilled.get(productId) ?? 0);
      const available = (stockByProduct.get(productId) ?? 0) - filledByOtherStops;
      if (!stockByProduct.has(productId)) {
        const product = submittedProductById.get(productId);
        throw new Error(`Route stock is missing for ${product?.name ?? "selected product"}.`);
      }
      if (quantity > available) {
        const product = submittedProductById.get(productId);
        throw new Error(`Filled quantity cannot exceed carried quantity for ${product?.name ?? "selected product"}.`);
      }
    }

    const assignedProductIds = new Set(normalizedFilledItems.map((item) => String(item.productId)));
    const hasShortage = normalizedFilledItems.some((item) => {
      const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
      const actualQty = Math.max(0, Number(item.quantity ?? 0));
      return Boolean(item.unavailable) || actualQty < assignedQty;
    });
    const fillStatus = hasShortage || normalizedMissingProducts.some((item) => item.productName.trim()) ? "partial" : "full";
    const hasIssueReport = Boolean(issue?.issueType && issue.description);
    const fillAuditRows = [
      ...normalizedFilledItems.map((item) => {
        const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
        const actualQty = Math.max(0, Number(item.quantity ?? 0));
        return {
          route_id: routeId,
          route_stop_id: stopId,
          machine_id: machineId,
          refill_order_line_id: item.refillOrderLineId || null,
          assigned_product_id: item.productId,
          product_id: item.productId,
          action_type: "assigned_fill",
          assigned_qty: assignedQty,
          actual_qty: actualQty,
          difference_qty: actualQty - assignedQty,
          reason: item.unavailable ? (item.reason || "Product not in operator bag") : item.reason || null,
          notes: item.notes || null,
          needs_review: Boolean(item.unavailable) || actualQty !== assignedQty,
          created_by: route.operator_id,
        };
      }),
      ...normalizedExtraItems.map((item) => ({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        refill_order_line_id: null,
        assigned_product_id: null,
        product_id: item.productId,
        action_type: "extra_product",
        assigned_qty: 0,
        actual_qty: Math.max(0, Number(item.quantity ?? 0)),
        difference_qty: Math.max(0, Number(item.quantity ?? 0)),
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        created_by: route.operator_id,
      })),
      ...normalizedMissingProducts.map((item) => ({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        refill_order_line_id: null,
        assigned_product_id: null,
        product_id: null,
        action_type: "missing_product_report",
        assigned_qty: 0,
        actual_qty: 0,
        difference_qty: 0,
        reason: item.reason || "Other",
        notes: item.notes || null,
        missing_product_name: item.productName,
        needs_review: true,
        created_by: route.operator_id,
      })),
    ].filter((row) => row.action_type === "missing_product_report" || Number(row.actual_qty ?? 0) >= 0);

    const invalidExtra = normalizedExtraItems.find((item) => assignedProductIds.has(String(item.productId)));
    if (invalidExtra) {
      throw new Error("Use the assigned product row instead of adding the same product as extra.");
    }

    const fillProductIds = new Set([...requestedFills.keys(), ...currentStopFilled.keys()]);
    const movements: any[] = Array.from(fillProductIds).flatMap((productId): any[] => {
      const desiredQty = requestedFills.get(productId) ?? 0;
      const previousQty = currentStopFilled.get(productId) ?? 0;
      const delta = desiredQty - previousQty;
      if (delta > 0) {
        return [{
          product_id: productId,
          quantity: delta,
          from_entity_type: "operator_bag" as const,
          from_entity_id: route.operator_id,
          to_entity_type: "machine" as const,
          to_entity_id: machineId,
          reason: "operator_bag_to_machine" as const,
          related_route_id: routeId,
          related_route_stop_id: stopId,
          related_machine_id: machineId,
          idempotency_key: inventoryMovementIdempotencyKey("route-stop-fill", routeId, stopId, machineId, productId, delta, stopSubmissionId),
          source_type: "route_stop_completion",
          source_id: routeSourceUuid(stopSubmissionId, `route-stop-completion:${routeId}:${stopId}:${stopSubmissionId}`),
          created_by: route.operator_id,
          notes: `Filled at machine ${machineId}`,
        }];
      }
      if (delta < 0) {
        return [{
          product_id: productId,
          quantity: Math.abs(delta),
          from_entity_type: "machine" as const,
          from_entity_id: machineId,
          to_entity_type: "operator_bag" as const,
          to_entity_id: route.operator_id,
          reason: "manual_correction" as const,
          related_route_id: routeId,
          related_route_stop_id: stopId,
          related_machine_id: machineId,
          idempotency_key: inventoryMovementIdempotencyKey("route-stop-fill-correction", routeId, stopId, machineId, productId, Math.abs(delta), stopSubmissionId),
          source_type: "route_stop_completion",
          source_id: routeSourceUuid(stopSubmissionId, `route-stop-completion:${routeId}:${stopId}:${stopSubmissionId}`),
          created_by: route.operator_id,
          notes: `Reduced filled quantity at machine ${machineId}`,
        }];
      }
      return [];
    });

    if (movements.length) {
      await upsertInventoryMovementsWithFallback({
        supabase,
        rows: movements,
        routeId,
        operationLabel: 'create machine fill inventory movements',
      });
    }

    const { error: auditDeleteError } = await supabase.from("route_stop_fill_lines").delete().eq("route_stop_id", stopId);
    if (auditDeleteError && !isMissingTable(auditDeleteError, "route_stop_fill_lines")) throwActionError(auditDeleteError, "Could not update machine stop fill lines.");

    if (fillAuditRows.length) {
      const { error: auditError } = await supabase
        .from("route_stop_fill_lines")
        .insert(fillAuditRows);

      if (auditError) throwActionError(auditError, "Could not save machine stop fill lines.");
    }

    const { data: refillOrders } = await supabase
      .from("refill_orders")
      .select("id")
      .eq("route_id", routeId)
      .eq("machine_id", machineId);
    const refillOrderIds = refillOrders?.map((order: any) => order.id) ?? [];

    if (refillOrderIds.length) {
      for (const item of normalizedFilledItems.filter((entry) => Number(entry.quantity) >= 0)) {
        const { error: lineError } = await supabase
          .from("refill_order_lines")
          .update({ filled_qty: item.quantity })
          .eq("product_id", item.productId)
          .in("refill_order_id", refillOrderIds);

        if (lineError) throwActionError(lineError, "Could not update refill line filled quantities.");
      }
    }

    if (refillOrderIds.length) {
      const { error: refillStatusError } = await supabase
        .from("refill_orders")
        .update({ status: "completed", completed_at: completedAt })
        .in("id", refillOrderIds);

      if (refillStatusError) throwActionError(refillStatusError, "Could not update refill order status.");
    }

    // Get expected cash from latest VMS sales
    const { data: sales } = await supabase
      .from("vms_sales_snapshots")
      .select("cash_sales_amount")
      .eq("machine_id", machineId)
      .eq("import_row_status", "imported")
      .order("period_end", { ascending: false })
      .limit(1);

    const expectedCash = sales?.[0]?.cash_sales_amount === null || sales?.[0]?.cash_sales_amount === undefined
      ? null
      : Number(sales?.[0]?.cash_sales_amount ?? 0);

    const { data: existingCashCollection, error: existingCashError } = await supabase
      .from("cash_collections")
      .select("id, actual_cash_collected, review_status")
      .eq("route_id", routeId)
      .eq("machine_id", machineId)
      .maybeSingle();
    if (existingCashError) throwActionError(existingCashError, "Could not verify the cash collection record.");

    let cashCollection: {
      id: string;
      route_id: string | null;
      machine_id: string | null;
      operator_id: string | null;
      vms_expected_cash: number | null;
      actual_cash_collected: number | null;
      variance: number | null;
      review_status: string | null;
      cash_bag_id: string | null;
      collected_at: string | null;
    } | null = null;

    if (cashCollected) {
      const cashPayload = {
        route_id: routeId,
        machine_id: machineId,
        operator_id: route.operator_id,
        vms_expected_cash: expectedCash,
        review_status: "collected_pending_count",
        cash_bag_id: cashBagId?.trim() || null,
        notes,
      };
      const { data, error: cashError } = existingCashCollection?.id
        ? await supabase
            .from("cash_collections")
            .update(cashPayload)
            .eq("id", existingCashCollection.id)
            .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, collected_at")
            .single()
        : await supabase
            .from("cash_collections")
            .insert({ ...cashPayload, actual_cash_collected: null })
            .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, collected_at")
            .single();

      if (cashError) throwActionError(cashError, "Could not create the cash collection record.");
      cashCollection = data;
    }

    let linkedIssueId: string | null = null;
    if (issue?.issueType && issue.description) {
      const { data: createdIssue, error: issueError } = await supabase
        .from("issues")
        .insert({
          machine_id: machineId,
          issue_type: issue.issueType,
          priority: issue.priority,
          description: issue.description,
          reported_by: route.operator_id,
          status: "open",
        })
          .select("id, machine_id, issue_type, priority, status, description, created_at")
          .single();

      if (issueError) throwActionError(issueError, "Could not save the issue report.");
      if (createdIssue) {
        linkedIssueId = createdIssue.id;
        await logActivity({
          profile,
          action: "report_issue",
          entityType: "issue",
          entityId: createdIssue.id,
          entityLabel: issue.issueType,
          afterData: createdIssue,
          metadata: { route_id: routeId, machine_id: machineId, operator_id: route.operator_id },
          summary: `Reported ${issue.priority} machine issue during route stop`,
        });
      }
    }

    const machineLabel = machine?.name ?? machine?.machine_code ?? machineId;
    const savedPhotoUrl = completionPhotoUrl?.trim() || existingProof?.machine_photo_url || null;
    const savedPhotoPath = completionPhotoPath?.trim() || completionPhotoOriginalName?.trim() || existingProof?.machine_photo_path || null;
    const refillHistorySelect = "id, legacy_refill_id, refill_at, machine_id, machine_name, operator_id, fill_status, issues_found, machine_photo_url, machine_photo_path, linked_issue_id";
    const refillHistoryPayload = {
      legacy_refill_id: `route_stop:${stopId}`,
      refill_at: completedAt,
      machine_id: machineId,
      machine_name: machineLabel,
      operator_id: route.operator_id,
      operator_email: operatorMember?.email ?? profile?.email ?? null,
      machine_photo_url: savedPhotoUrl,
      machine_photo_path: savedPhotoPath,
      fill_status: fillStatus,
      issues_found: hasIssueReport,
      issue_notes: issue?.description?.trim() || null,
      linked_issue_id: linkedIssueId,
      route_id: routeId,
      route_stop_id: stopId,
      source_file: "Snacky OS operator completion",
      source_row: null,
      import_status: "imported",
      raw_record: {
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        machine_code: machine?.machine_code ?? null,
        machine_name: machineLabel,
        operator_id: route.operator_id,
        operator_name: operatorMember?.full_name ?? null,
        cash_collected: cashCollected,
        cash_bag_id: cashBagId?.trim() || null,
        notes: notes?.trim() || null,
        fill_status: fillStatus,
        filled_items: normalizedFilledItems,
        extra_items: normalizedExtraItems,
        missing_products: normalizedMissingProducts,
        completion_photo_original_name: completionPhotoOriginalName?.trim() || null,
        completion_photo_upload_unavailable: Boolean(completionPhotoUploadUnavailable),
        movement_count: movements.length,
      },
      updated_at: completedAt,
    };
    let refillHistoryResult = await supabase
      .from("machine_refill_history")
      .upsert(refillHistoryPayload, { onConflict: "legacy_refill_id" })
      .select(refillHistorySelect)
      .single();

    if (refillHistoryResult.error && isMissingOnConflictConstraint(refillHistoryResult.error)) {
      console.warn("[operator:complete-stop] machine_refill_history upsert missing unique conflict target; falling back to insert/update", {
        routeId,
        stopId,
        error: refillHistoryResult.error,
      });
      const existingRefillHistory = await supabase
        .from("machine_refill_history")
        .select("id")
        .eq("legacy_refill_id", `route_stop:${stopId}`)
        .maybeSingle();
      if (existingRefillHistory.error) throwActionError(existingRefillHistory.error, "Could not save the machine refill proof.");
      refillHistoryResult = existingRefillHistory.data?.id
        ? await supabase
            .from("machine_refill_history")
            .update(refillHistoryPayload)
            .eq("id", existingRefillHistory.data.id)
            .select(refillHistorySelect)
            .single()
        : await supabase
            .from("machine_refill_history")
            .insert(refillHistoryPayload)
            .select(refillHistorySelect)
            .single();
    }

    if (refillHistoryResult.error) throwActionError(refillHistoryResult.error, "Could not save the machine refill proof.");

    const refillHistory = refillHistoryResult.data ?? null;

    // Update stop status
    const { error: stopUpdateError } = await supabase
      .from("route_stops")
      .update({
        status: "completed",
        completed_at: completedAt,
        notes,
      })
      .eq("id", stopId);

    if (stopUpdateError) throwActionError(stopUpdateError, "Could not complete this stop.");

    let nextFillingStatus: RouteStatus = ROUTE_IN_PROGRESS_STATUS;
    let routeStatusUpdate = await supabase
      .from("routes")
      .update({ status: nextFillingStatus })
      .eq("id", routeId)
      .eq("status", route.status);
    if (routeStatusUpdate.error && isRouteStatusEnumMismatch(routeStatusUpdate.error, nextFillingStatus)) {
      const fallbackStatus = fallbackRouteStatusForEnumMismatch(nextFillingStatus);
      if (fallbackStatus) {
        nextFillingStatus = fallbackStatus;
        routeStatusUpdate = await supabase
          .from("routes")
          .update({ status: nextFillingStatus })
          .eq("id", routeId)
          .eq("status", route.status);
      }
    }
    if (routeStatusUpdate.error) throwActionError(routeStatusUpdate.error, "Could not update route progress.");

    await logActivity({
      profile,
      action: "complete_stop",
      entityType: "route_stop",
      entityId: stopId,
      entityLabel: `Stop ${stopId.slice(0, 8)}`,
      beforeData: stop,
      afterData: {
        status: "completed",
        route_id: routeId,
        machine_id: machineId,
        filled_items: normalizedFilledItems,
        extra_items: normalizedExtraItems,
        missing_products: normalizedMissingProducts,
        fill_status: fillStatus,
        refill_history_id: refillHistory?.id ?? null,
        movement_count: movements.length,
      },
      metadata: { route_id: routeId, machine_id: machineId, operator_id: route.operator_id },
      summary: `Completed route stop with ${movements.length} fill movement rows`,
    });

    if (refillHistory) {
      await logActivity({
        profile,
        action: "create_refill_proof",
        entityType: "machine_refill_history",
        entityId: refillHistory.id,
        entityLabel: machineLabel,
        afterData: refillHistory,
        metadata: { route_id: routeId, route_stop_id: stopId, machine_id: machineId, operator_id: route.operator_id },
        summary: `Saved ${fillStatus} machine refill proof`,
      });
    }

    if (cashCollection) {
      await logActivity({
        profile,
        action: "collect_cash",
        entityType: "cash_collection",
        entityId: cashCollection.id,
        entityLabel: `Cash ${cashCollection.id.slice(0, 8)}`,
        afterData: cashCollection,
        metadata: { route_id: routeId, machine_id: machineId, operator_id: route.operator_id },
        summary: cashCollected ? "Operator marked cash collected; pending count" : "Operator marked cash not collected",
      });
    }

    console.info("[operator:complete-stop] Stop saved", {
      action: "complete_stop",
      route_id: routeId,
      stop_id: stopId,
      machine_id: machineId,
      user_id: profile?.id ?? null,
      route_status_before: route.status ?? null,
      route_status_after: nextFillingStatus,
      stop_status_before: stop.status ?? null,
      stop_status_after: ROUTE_STOP_COMPLETED_STATUS,
      redirect_path: operatorRouteDetailPath(routeId),
    });

    revalidateRouteWorkflow(routeId);
    return actionSuccess({ expectedCash, routeId, stopId });
  } catch (error) {
    console.error("[operator:complete-stop] Error completing stop", {
      route_id: routeId,
      stop_id: stopId,
      machine_id: machineId,
      user_id: logProfile?.id ?? null,
      user_roles: logProfile?.roles ?? [],
      route_status: logRoute?.status ?? null,
      stop_status: logStop?.status ?? null,
      stop_item_count: logStopItemCount,
      submitted_filled_quantities: logSubmittedFilledItems,
      operator_carried_inventory_before_completion: mapEntriesForLog(logCarriedBefore),
      operator_carried_inventory_after_completion: mapEntriesForLog(logCarriedAfter),
      product_ids_with_null_product_relation: logMissingProductRelations,
      route_operator_id: logRoute?.operator_id ?? null,
      stop_route_id: logStop?.route_id ?? null,
      stop_machine_id: logStop?.machine_id ?? null,
      machine_found: Boolean(logMachine),
      error_message: getErrorMessage(error, "Could not complete this stop."),
      error_stack: error instanceof Error ? error.stack : null,
      error,
    });
    return actionFailure(completeStopPublicError(error), {
      expectedCash: null,
      routeId,
      stopId,
      code: String(errorField(error, "code") ?? "COMPLETE_STOP_FAILED"),
    });
  }
}

/**
 * Records leftovers and creates inventory movements
 * operator_bag -> storage
 */
export async function recordLeftovers({
  routeId,
  leftoverItems,
  clientSubmissionId,
}: {
  routeId: string;
  leftoverItems: { productId: string; quantity: number }[];
  clientSubmissionId?: string | null;
}) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return actionFailure("Supabase is not configured.", { code: "NO_SUPABASE" });

  try {
    const profile = await getCurrentProfile();
    const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
    // Get route to find operator
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();

    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    if (isCompletedRouteStatus(route.status)) return actionSuccess({ routeId, alreadyCompleted: true });
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      throw new Error("You are not authorized to return leftovers for this route");
    }
    // Get storage location
    const { data: storages } = await supabase
      .from("storage_locations")
      .select("id")
      .eq("active", true)
      .in("location_type", ["main_storage", "vehicle", "temporary", "other"])
      .order("location_type")
      .order("name")
      .limit(1);

    const storageId = storages?.[0]?.id;
    if (!storageId) throw new Error("No active storage location found");
    const leftoversSubmissionId = String(clientSubmissionId ?? "").trim() || routeId;

    // Create inventory movements: operator_bag -> storage
    const leftoversByProduct = new Map<string, number>();
    leftoverItems.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) leftoversByProduct.set(productId, (leftoversByProduct.get(productId) ?? 0) + quantity);
    });

    const { data: routeStockLines, error: routeStockError } = await supabase
      .from("route_stock_lines")
      .select("id, product_id, picked_qty, returned_qty")
      .eq("route_id", routeId);
    if (routeStockError) throwActionError(routeStockError, "Could not load route stock.");

    const [{ data: routeMovements, error: movementBalanceError }, { data: filledMovements, error: filledError }, { data: returnMovements, error: returnError }] = await Promise.all([
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, reason, from_entity_type, from_entity_id, to_entity_type, to_entity_id")
        .eq("related_route_id", routeId),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, reason, from_entity_type, to_entity_type")
        .eq("related_route_id", routeId)
        .in("reason", ["operator_bag_to_machine", "manual_correction"]),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity")
        .eq("related_route_id", routeId)
        .in("reason", ["operator_bag_to_storage", "route_to_storage_return"]),
    ]);
    if (movementBalanceError) throwActionError(movementBalanceError, "Could not calculate route operator bag inventory.");
    if (filledError) throwActionError(filledError, "Could not verify filled route stock.");
    if (returnError) throwActionError(returnError, "Could not verify returned route stock.");

    const filledByProduct = new Map<string, number>();
    (filledMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + machineFillDelta(movement));
    });
    const returnedByProduct = productQuantitiesFromMovements(returnMovements);
    const bagBalanceByProduct = routeBagBalanceFromMovements(routeMovements);

    const routeProductIds = new Set([
      ...(routeStockLines ?? []).map((line: any) => String(line.product_id)),
      ...bagBalanceByProduct.keys(),
    ]);
    for (const productId of leftoversByProduct.keys()) {
      if (!routeProductIds.has(productId)) throw new Error("Returned product is not part of this route stock.");
    }

    for (const productId of leftoversByProduct.keys()) {
      const returnQty = leftoversByProduct.get(productId) ?? 0;
      const available = Math.max(0, bagBalanceByProduct.get(productId) ?? 0);
      if (returnQty > available) throw new Error("Returned quantity cannot exceed remaining operator bag stock.");
    }

    const movements = Array.from(leftoversByProduct.entries())
      .map(([productId, desiredQuantity]) => {
        const remainingQuantity = Math.max(0, desiredQuantity - (returnedByProduct.get(productId) ?? 0));
        return {
          product_id: productId,
          quantity: remainingQuantity,
          from_entity_type: "operator_bag" as const,
          from_entity_id: route.operator_id,
          to_entity_type: "storage" as const,
          to_entity_id: storageId,
          reason: "operator_bag_to_storage" as const,
          related_route_id: routeId,
          related_pickup_batch_id: null,
          idempotency_key: inventoryMovementIdempotencyKey("route-leftovers", routeId, leftoversSubmissionId, productId, storageId, route.operator_id ?? "", remainingQuantity),
          source_type: "route_leftovers",
          source_id: routeSourceUuid(leftoversSubmissionId, `route-leftovers:${routeId}:${leftoversSubmissionId}`),
          created_by: route.operator_id,
          notes: `Leftovers returned from route ${routeId}`,
        };
      })
      .filter((movement) => movement.quantity > 0);

    if (movements.length > 0) {
      await upsertInventoryMovementsWithFallback({
        supabase,
        rows: movements,
        routeId,
        operationLabel: 'create leftover return movements',
      });
    }

    for (const line of routeStockLines ?? []) {
      const productId = String(line.product_id);
      const returnQty = Math.max(
        Number(line.returned_qty ?? 0),
        leftoversByProduct.get(productId) ?? 0,
        returnedByProduct.get(productId) ?? 0,
      );
      const { error: stockLineError } = await supabase
        .from("route_stock_lines")
        .update({ returned_qty: returnQty, updated_at: new Date().toISOString() })
        .eq("id", line.id);
      if (stockLineError) throwActionError(stockLineError, "Could not update route stock returns.");
    }

    const { data: routeOrders } = await supabase
      .from("refill_orders")
      .select("id, refill_order_lines(id, product_id, picked_qty, filled_qty, returned_qty)")
      .eq("route_id", routeId);
    const linesByProduct = new Map<string, any[]>();
    routeOrders?.forEach((order: any) => {
      order.refill_order_lines?.forEach((line: any) => {
        const key = String(line.product_id);
        linesByProduct.set(key, [...(linesByProduct.get(key) ?? []), line]);
      });
    });

    if (routeOrders?.length) {
      for (const [productId, desiredQuantity] of leftoversByProduct.entries()) {
        let remaining = desiredQuantity;
        const lines = linesByProduct.get(productId) ?? [];

        for (const line of lines) {
          const available = Math.max(0, Number(line.picked_qty ?? 0) - Number(line.filled_qty ?? 0));
          const returnedQty = Math.max(Number(line.returned_qty ?? 0), Math.min(remaining, available));
          remaining = Math.max(0, remaining - returnedQty);

          const { error: lineError } = await supabase
            .from("refill_order_lines")
            .update({ returned_qty: returnedQty })
            .eq("id", line.id);

          if (lineError) throwActionError(lineError, "Could not update refill line returns.");
        }
      }
    }

    await logActivity({
      profile,
      action: "return_leftovers",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      afterData: {
        returned_items: Array.from(leftoversByProduct.entries()).map(([productId, quantity]) => ({ product_id: productId, quantity })),
        movement_count: movements.length,
      },
      metadata: { operator_id: route.operator_id, storage_id: storageId },
      summary: movements.length ? `Returned leftovers with ${movements.length} inventory movement rows` : "Confirmed no leftover stock to return",
    });

    revalidateRouteWorkflow(routeId);
    return actionSuccess({ routeId, movementsCreated: movements.length });
  } catch (error) {
    console.error("[operator:route-leftovers] Error recording leftovers", {
      route_id: routeId,
      leftover_items: leftoverItems,
      error_message: getErrorMessage(error, "Could not record route leftovers."),
      error_stack: error instanceof Error ? error.stack : null,
      error,
    });
    return actionFailure(getErrorMessage(error, "Could not record route leftovers."), {
      routeId,
      code: String(errorField(error, "code") ?? "ROUTE_LEFTOVERS_FAILED"),
    });
  }
}

/**
 * Completes entire route
 * Updates route status to completed
 */
export async function completeRoute(routeId: string) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return actionFailure("Supabase is not configured.", { routeId, code: "NO_SUPABASE" });

  let logRoute: any = null;
  let logProfile: Awaited<ReturnType<typeof getCurrentProfile>> = null;
  let logStopCount = 0;
  let logRouteStockLineCount = 0;
  let logMovementCount = 0;
  let attemptedRouteUpdatePayload: Record<string, unknown> | null = null;

  try {
    const profile = await getCurrentProfile();
    logProfile = profile;
    const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status, completed_at")
      .eq("id", routeId)
      .maybeSingle();
    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    logRoute = route;
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      throw new Error("You are not authorized to complete this route");
    }
    if (isCompletedRouteStatus(route.status)) {
      console.info("[operator:complete-route] Route already completed", {
        action: "complete_route",
        route_id: routeId,
        user_id: profile?.id ?? null,
        route_status_before: route.status ?? null,
        route_status_after: route.status ?? null,
        redirect_path: operatorRouteDetailPath(routeId),
      });
      revalidateRouteWorkflow(routeId);
      return actionSuccess({ routeId, alreadyCompleted: true });
    }
    if (String(route.status ?? "") === "cancelled" || String(route.status ?? "") === "canceled") {
      throw new Error("A cancelled route cannot be completed.");
    }

    const { data: openStops, error: stopsError } = await supabase
      .from("route_stops")
      .select("id, status")
      .eq("route_id", routeId)
      .limit(500);
    if (stopsError) throwActionError(stopsError, "Could not verify route stop status.");
    logStopCount = openStops?.length ?? 0;
    const unfinishedStops = (openStops ?? []).filter((stop: any) => !isRouteStopDoneStatus(stop.status));
    if (unfinishedStops.length) throw new Error("Complete or skip every machine stop before closing the route.");

    const [
      { data: routeStockLines, error: stockError },
      { data: routeMovements, error: movementBalanceError },
      { data: returnMovements, error: returnError },
    ] = await Promise.all([
      supabase
        .from("route_stock_lines")
        .select("id, product_id, picked_qty, returned_qty")
        .eq("route_id", routeId),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, reason, from_entity_type, from_entity_id, to_entity_type, to_entity_id, related_route_stop_id, related_machine_id")
        .eq("related_route_id", routeId)
        .limit(5000),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity")
        .eq("related_route_id", routeId)
        .eq("reason", "operator_bag_to_storage"),
    ]);
    if (stockError) throwActionError(stockError, "Could not load route stock.");
    if (movementBalanceError) throwActionError(movementBalanceError, "Could not calculate route operator bag inventory.");
    if (returnError) throwActionError(returnError, "Could not verify returned route stock.");
    logRouteStockLineCount = routeStockLines?.length ?? 0;
    logMovementCount = routeMovements?.length ?? 0;
    const returnedByProduct = productQuantitiesFromMovements(returnMovements);
    const remainingBagStock = positiveRouteBagBalances(routeMovements);

    for (const line of routeStockLines ?? []) {
      const productId = String(line.product_id);
      const returnedFromMovements = returnedByProduct.get(productId) ?? 0;
      const savedReturnedQty = Number(line.returned_qty ?? 0);
      if (returnedFromMovements > savedReturnedQty) {
        const { error: repairLineError } = await supabase
          .from("route_stock_lines")
          .update({ returned_qty: returnedFromMovements, updated_at: new Date().toISOString() })
          .eq("id", line.id);
        if (repairLineError) throwActionError(repairLineError, "Could not repair returned route stock.");
      }
    }

    let completionWarning: string | null = null;
    if (remainingBagStock.length) {
      const productIds = remainingBagStock.map((item) => item.productId);
      const { data: products } = productIds.length
        ? await supabase.from("products").select("id, name").in("id", productIds)
        : { data: [] };
      const productById = new Map((products ?? []).map((product: any) => [String(product.id), product.name ?? "Unknown product"]));
      completionWarning = `Calculated remaining operator bag inventory: ${remainingBagStock.map((item) => `${productById.get(item.productId) ?? "Unknown product"} ${item.quantity}`).join(", ")}. Review leftovers and stock reconciliation.`;
      console.warn("[operator:complete-route] Completing route with calculated remaining operator bag stock", {
        route_id: routeId,
        remaining_bag_stock: remainingBagStock.map((item) => ({
          product_id: item.productId,
          product_name: productById.get(item.productId) ?? "Unknown product",
          quantity: item.quantity,
        })),
      });
    }

    const completedAt = new Date().toISOString();
    const actorTeamMemberId = profile?.team_member_id ?? null;
    attemptedRouteUpdatePayload = {
      status: ROUTE_COMPLETED_STATUS,
      completed_at: completedAt,
      completed_by: actorTeamMemberId,
      last_completion_error: null,
    };
    let updateResult = await supabase
      .from("routes")
      .update(attemptedRouteUpdatePayload)
      .eq("id", routeId);

    if (updateResult.error && isMissingCompletionAuditColumn(updateResult.error)) {
      attemptedRouteUpdatePayload = { status: ROUTE_COMPLETED_STATUS, completed_at: completedAt };
      updateResult = await supabase
        .from("routes")
        .update(attemptedRouteUpdatePayload)
        .eq("id", routeId);
    }

    if (updateResult.error) throwActionError(updateResult.error, "Could not complete this route.");
    await logActivity({
      profile,
      action: "update",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      beforeData: route,
      afterData: { status: ROUTE_COMPLETED_STATUS, completed_at: completedAt },
      metadata: {
        route_id: routeId,
        stop_count: logStopCount,
        route_stock_line_count: logRouteStockLineCount,
        inventory_movement_count_checked: logMovementCount,
      },
      summary: route.completed_at ? "Confirmed already completed route" : "Completed route",
    });
    console.info("[operator:complete-route] Route completed", {
      action: "complete_route",
      route_id: routeId,
      user_id: profile?.id ?? null,
      route_status_before: route.status ?? null,
      route_status_after: ROUTE_COMPLETED_STATUS,
      stop_count: logStopCount,
      redirect_path: operatorRouteDetailPath(routeId),
    });
    revalidateRouteWorkflow(routeId);
    return actionSuccess({ routeId, completedAt, warning: completionWarning });
  } catch (error) {
    const publicError = routeCompletionPublicError(error);
    console.error("[operator:complete-route] Error completing route", {
      route_id: routeId,
      current_route_status: logRoute?.status ?? null,
      stop_count: logStopCount,
      refill_lines_count: logRouteStockLineCount,
      inventory_movement_count_attempted: logMovementCount,
      failing_query_or_step: errorField(error, "code") ? "supabase" : "route_completion_validation",
      supabase_error_code: errorField(error, "code"),
      supabase_error_message: errorField(error, "message") ?? getErrorMessage(error, "Could not complete this route."),
      stack: error instanceof Error ? error.stack : errorField(error, "stack"),
      current_user_id: logProfile?.id ?? null,
      effective_permissions: logProfile ? getEffectivePermissions(logProfile) : [],
      route_update_payload: attemptedRouteUpdatePayload,
      error,
    });

    try {
      const profile = await getCurrentProfile();
      await supabase
        .from("routes")
        .update({ last_completion_error: publicError })
        .eq("id", routeId);
      await logActivity({
        profile,
        action: "route_completion_failed",
        entityType: "route",
        entityId: routeId,
        entityLabel: `Route ${routeId.slice(0, 8)}`,
        afterData: serializeActionError(error),
        metadata: { route_id: routeId },
        summary: publicError,
      });
    } catch {
      // Best-effort audit only; the user-facing failure should still return cleanly.
    }

    return actionFailure(publicError, {
      routeId,
      code: String(errorField(error, "code") ?? "ROUTE_COMPLETION_FAILED"),
    });
  }
}

export async function repairRouteCompletion(formData: FormData) {
  const routeId = String(formData.get("route_id") || "").trim();
  if (!routeId) redirect("/routes?error=Missing%20route%20id.");

  const result = await completeRoute(routeId);
  if (result.success) {
    const alreadyCompleted = "alreadyCompleted" in result && Boolean(result.alreadyCompleted);
    redirect(`/routes/${routeId}?success=${encodeURIComponent(alreadyCompleted ? "Route was already completed." : "Route completed successfully.")}`);
  }
  redirect(`/routes/${routeId}?error=${encodeURIComponent(result.error)}`);
}

/**
 * Reports an issue with photo upload
 */
export async function reportIssue({
  machineId,
  issueType,
  priority,
  description,
  reportedBy,
}: {
  machineId: string;
  issueType: string;
  priority: "critical" | "high" | "normal" | "low";
  description: string;
  reportedBy: string;
}) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const { error } = await supabase
      .from("issues")
      .insert({
        machine_id: machineId,
        issue_type: issueType,
        priority,
        description,
        reported_by: reportedBy,
        status: "open",
      });

    if (error) throwActionError(error, "Could not report this issue.");
    return { success: true };
  } catch (error) {
    console.error("Error reporting issue:", error);
    throw new Error(getErrorMessage(error, "Could not report this issue."));
  }
}
