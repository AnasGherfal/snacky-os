"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import { actionFailure, actionSuccess, type ActionResult } from "@/lib/action-result";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canExecuteRoutes } from "@/lib/authz";
import { activeRouteStatuses, availableRouteStatuses, isTerminalRouteStatus } from "@/lib/route-workflow";
import { REFILL_PHOTO_BUCKET } from "@/lib/storage-buckets";

const REFILL_PHOTO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const REFILL_PHOTO_MAX_SIZE = 10 * 1024 * 1024;

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
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

function throwActionError(error: unknown, fallback?: string): never {
  throw new Error(getErrorMessage(error, fallback));
}

function profileContext(profile: NonNullable<Awaited<ReturnType<typeof getCurrentProfile>>>) {
  return {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  };
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

function machineFillDelta(movement: any) {
  const qty = unitQuantity(movement?.quantity);
  if (movement?.reason === "manual_correction" && movement?.from_entity_type === "machine" && movement?.to_entity_type === "operator_bag") {
    return -qty;
  }
  return qty;
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
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, operator_id")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) throwActionError(routeError, "Could not load this route for the refill photo.");
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(profile ? profileContext(profile) : null, route.operator_id)) {
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

export async function startRoute(routeId: string) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");
  if (!routeId) throw new Error("Route id is required");

  const profile = await getCurrentProfile();
  if (!profile || !canExecuteRoutes(profile)) throw new Error("You are not authorized to start routes.");
  if (!profile.team_member_id) throw new Error("Your account is not linked to a team member, so it cannot claim a route.");
  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status, started_at")
    .eq("id", routeId)
    .maybeSingle();

  if (routeError) throwActionError(routeError, "Could not load this route.");
  if (!route) throw new Error("Route not found");
  if (!canAccessOperatorRoute(profileContext(profile), route.operator_id)) {
    throw new Error("You are not authorized to start this route");
  }
  if (![...availableRouteStatuses, ...activeRouteStatuses].includes(String(route.status) as any)) {
    throw new Error("Only available or assigned routes can be started.");
  }
  if (activeRouteStatuses.includes(String(route.status) as any)) {
    return { success: true };
  }

  const now = new Date().toISOString();
  const startUpdate = route.operator_id
    ? await supabase
        .from("routes")
        .update({ status: "started", started_at: route.started_at ?? now })
        .eq("id", routeId)
        .eq("operator_id", route.operator_id)
        .in("status", [...availableRouteStatuses])
        .select("id, route_date, operator_id, status, started_at")
        .maybeSingle()
    : await supabase
        .from("routes")
        .update({ operator_id: profile.team_member_id, status: "started", started_at: now })
        .eq("id", routeId)
        .is("operator_id", null)
        .in("status", [...availableRouteStatuses])
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
  pickedItems: { productId: string; quantity: number; plannedQty?: number; reason?: string; notes?: string }[],
  extras: { productId: string; quantity: number; reason: string; notes?: string }[] = [],
) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");
  const readClient = getSupabaseAdminClient() ?? supabase;
  let logProfile: Awaited<ReturnType<typeof getCurrentProfile>> | null = null;
  let logRouteOperatorId: string | null = null;

  try {
    const profile = await getCurrentProfile();
    logProfile = profile;
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();

    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    logRouteOperatorId = route.operator_id ?? null;
    if (!canAccessOperatorRoute(profile ? profileContext(profile) : null, route.operator_id)) {
      throw new Error("You are not authorized to pick stock for this route");
    }
    if (isTerminalRouteStatus(route.status)) {
      throw new Error("Completed or cancelled routes cannot be edited.");
    }

    let { data: routeStopItems, error: stopItemsError }: { data: any[] | null; error: any } = await supabase
      .from("route_stop_items")
      .select("product_id, planned_quantity")
      .eq("route_id", routeId);

    if (stopItemsError) {
      if (!isMissingTable(stopItemsError, "route_stop_items")) throwActionError(stopItemsError, "Could not load the route plan.");
      const fallback = await supabase
        .from("refill_orders")
        .select("id, refill_order_lines(product_id, final_qty_to_take, suggested_qty)")
        .eq("route_id", routeId);
      if (fallback.error) throwActionError(fallback.error, "Could not load the route plan.");
      routeStopItems = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
        })),
      );
    }

    const plannedByProduct = new Map<string, number>();
    (routeStopItems ?? []).forEach((line: any) => {
      const productId = String(line.product_id ?? "").trim();
      if (!productId) return;
      plannedByProduct.set(productId, (plannedByProduct.get(productId) ?? 0) + unitQuantity(line.planned_quantity));
    });

    const normalizedPickedItems = new Map<string, { productId: string; quantity: number; plannedQty: number; reason?: string; notes?: string }>();
    pickedItems.forEach((item) => {
      const productId = String(item.productId ?? "").trim();
      if (!productId) return;
      const current = normalizedPickedItems.get(productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      const plannedQty = Math.max(0, Number(item.plannedQty ?? plannedByProduct.get(productId) ?? 0));
      normalizedPickedItems.set(productId, {
        productId,
        quantity: (current?.quantity ?? 0) + quantity,
        plannedQty: current ? current.plannedQty : plannedQty,
        reason: item.reason || current?.reason,
        notes: mergeNotes(current?.notes, item.notes),
      });
    });

    const normalizedExtras = new Map<string, { productId: string; quantity: number; reason: string; notes?: string }>();
    extras.forEach((item) => {
      const productId = String(item.productId ?? "").trim();
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (!productId || quantity <= 0) return;

      if (plannedByProduct.has(productId)) {
        const current = normalizedPickedItems.get(productId) ?? {
          productId,
          quantity: 0,
          plannedQty: plannedByProduct.get(productId) ?? 0,
          reason: item.reason,
          notes: undefined,
        };
        normalizedPickedItems.set(productId, {
          ...current,
          quantity: current.quantity + quantity,
          reason: item.reason || current.reason,
          notes: mergeNotes(current.notes, item.notes),
        });
        return;
      }

      const current = normalizedExtras.get(productId);
      normalizedExtras.set(productId, {
        productId,
        quantity: (current?.quantity ?? 0) + quantity,
        reason: item.reason || current?.reason || "Other",
        notes: mergeNotes(current?.notes, item.notes),
      });
    });

    const pickedItemRows = Array.from(normalizedPickedItems.values());
    const extraRows = Array.from(normalizedExtras.values());
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
    const { data: productRows, error: productError } = productIds.length
      ? await readClient
          .from("products")
          .select("id, name, active")
          .in("id", productIds)
      : { data: [], error: null };
    if (productError) throwActionError(productError, "Could not verify selected products.");

    const productById = new Map((productRows ?? []).map((product: any) => [String(product.id), product]));
    const manualProductIds = new Set(extraRows.map((item) => item.productId));
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

    const productIdsForDelta = new Set([...pickedByProduct.keys(), ...existingPickedByProduct.keys()]);
    const increaseByProduct = new Map<string, number>();
    const decreaseByProduct = new Map<string, number>();

    productIdsForDelta.forEach((productId) => {
      const nextPicked = pickedByProduct.get(productId) ?? 0;
      const alreadyConsumed = (filledByProduct.get(productId) ?? 0) + (returnedByProduct.get(productId) ?? 0);
      if (nextPicked < alreadyConsumed) {
        throw new Error("Picked quantity cannot be reduced below stock already filled into machines or returned to storage.");
      }

      const previousPicked = existingPickedByProduct.get(productId) ?? 0;
      const delta = nextPicked - previousPicked;
      if (delta > 0) increaseByProduct.set(productId, delta);
      if (delta < 0) decreaseByProduct.set(productId, Math.abs(delta));
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
      console.info("[operator:pick-list] Pickup validation", {
        route_id: routeId,
        product_id: productId,
        product_name: product?.name ?? "Unknown product",
        user_id: profile?.id ?? null,
        user_roles: profile?.roles ?? [],
        route_operator_id: route.operator_id ?? null,
        original_route_product: plannedByProduct.has(productId),
        manually_added: isManual,
        available_warehouse_stock: available,
        entered_quantity: pickedByProduct.get(productId) ?? 0,
        additional_quantity_needed: quantity,
        calculated_shortage: shortage,
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
        created_by: route.operator_id,
        notes: `Picked for route ${routeId}`,
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
            created_by: route.operator_id,
            notes: `Pickup quantity reduced for route ${routeId}`,
          });
          remaining -= returnedQty;
        }
        return returnRows;
      }),
    ];

    if (movements.length) {
      const { error: movementError } = await supabase
        .from("inventory_movements")
        .insert(movements);

      if (movementError) throwActionError(movementError, "Could not create pickup adjustment inventory movements.");
    }

    const pickListRows = [
      ...pickedItemRows.map((item) => {
        const plannedQty = plannedByProduct.get(String(item.productId)) ?? Number(item.plannedQty ?? 0);
        const pickedQty = Math.max(0, Number(item.quantity ?? 0));
        return {
          route_id: routeId,
          product_id: item.productId,
          planned_qty: plannedQty,
          picked_qty: pickedQty,
          action_type: "planned_pick",
          reason: pickedQty !== plannedQty ? item.reason || "Other" : null,
          notes: item.notes || null,
          needs_review: pickedQty !== plannedQty,
          created_by: route.operator_id,
        };
      }),
      ...extraRows.map((item) => ({
        route_id: routeId,
        product_id: item.productId,
        planned_qty: 0,
        picked_qty: Math.max(0, Number(item.quantity ?? 0)),
        action_type: "extra_product",
        reason: item.reason || "Other",
        notes: item.notes || null,
        needs_review: true,
        created_by: route.operator_id,
      })),
    ].filter((item) => Number(item.picked_qty ?? 0) > 0 || Number(item.planned_qty ?? 0) > 0);

    const { error: pickListDeleteError } = await supabase.from("route_pick_list_items").delete().eq("route_id", routeId);
    if (pickListDeleteError && !isMissingTable(pickListDeleteError, "route_pick_list_items")) throwActionError(pickListDeleteError, "Could not update the confirmed pick list.");

    if (pickListRows.length) {
      const { error: pickListError } = await supabase.from("route_pick_list_items").insert(pickListRows);
      if (pickListError && !isMissingTable(pickListError, "route_pick_list_items")) throwActionError(pickListError, "Could not save the confirmed pick list.");
    }

    const { data: routeOrders, error: routeOrdersError } = await supabase
      .from("refill_orders")
      .select("id, refill_order_lines(id, product_id, final_qty_to_take, suggested_qty)")
      .eq("route_id", routeId);
    if (routeOrdersError) throwActionError(routeOrdersError, "Could not load refill order lines.");
    const linesByProduct = new Map<string, any[]>();
    routeOrders?.forEach((order: any) => {
      order.refill_order_lines?.forEach((line: any) => {
        const key = String(line.product_id);
        linesByProduct.set(key, [...(linesByProduct.get(key) ?? []), line]);
      });
    });

    const stockLineRows = Array.from(new Set([...Array.from(plannedByProduct.keys()), ...Array.from(pickedByProduct.keys())])).map((productId) => ({
      route_id: routeId,
      product_id: productId,
      planned_qty: plannedByProduct.get(productId) ?? 0,
      picked_qty: pickedByProduct.get(productId) ?? 0,
      updated_at: new Date().toISOString(),
    }));

    if (stockLineRows.length) {
      const { error: stockLineError } = await supabase
        .from("route_stock_lines")
        .upsert(stockLineRows, { onConflict: "route_id,product_id" });

      if (stockLineError) throwActionError(stockLineError, "Could not update route stock totals.");
    }

    for (const item of pickedItemRows.filter((entry) => Number(entry.quantity) >= 0)) {
      let remaining = Number(item.quantity);
      const lines = linesByProduct.get(String(item.productId)) ?? [];

      for (const line of lines) {
        const plannedQty = Number(line.final_qty_to_take ?? line.suggested_qty ?? 0);
        const pickedQty = Math.max(0, Math.min(remaining, plannedQty));
        remaining -= pickedQty;

        const { error: lineError } = await supabase
          .from("refill_order_lines")
          .update({ picked_qty: pickedQty })
          .eq("id", line.id);

        if (lineError) throwActionError(lineError, "Could not update refill line picked quantities.");
      }
    }

    // Pickup confirmed: the operator bag now reflects the saved pick list.
    const { error: statusError } = await supabase
      .from("routes")
      .update({ status: "pickup_confirmed", started_at: new Date().toISOString() })
      .eq("id", routeId)
      .in("status", [...availableRouteStatuses, ...activeRouteStatuses]);

    if (statusError) throwActionError(statusError, "Could not start this route after picking stock.");

    // Update all refill orders for this route to picked
    const { error: refillError } = await supabase
      .from("refill_orders")
      .update({ status: "picked" })
      .eq("route_id", routeId)
      .in("status", ["assigned", "in_progress", "picked"]);

    if (refillError) throwActionError(refillError, "Could not update refill order status.");

    await logActivity({
      profile,
      action: "confirm_pick_list",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      afterData: {
        picked_items: pickedItems,
        extras,
        movement_count: movements.length,
        pick_list_count: pickListRows.length,
      },
      metadata: { operator_id: route.operator_id },
      summary: `Confirmed pick list with ${movements.length} inventory movement rows`,
    });

    revalidateRouteWorkflow(routeId);
    return { success: true };
  } catch (error) {
    console.error("[operator:pick-list] Error confirming pick list", {
      route_id: routeId,
      user_id: logProfile?.id ?? null,
      user_roles: logProfile?.roles ?? [],
      route_operator_id: logRouteOperatorId,
      picked_items: pickedItems,
      extras,
      error,
    });
    return { success: false, error: getErrorMessage(error, "Could not confirm the pick list.") };
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
  const quantity = Number(value);
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
    const completedAt = new Date().toISOString();
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
    if (!canAccessOperatorRoute(profile ? profileContext(profile) : null, route.operator_id)) {
      throw new Error("You are not authorized to complete this stop");
    }
    if (isTerminalRouteStatus(route.status)) {
      throw new Error("Completed or cancelled routes cannot be edited.");
    }
    if (!activeRouteStatuses.includes(String(route.status) as any)) {
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
          created_by: route.operator_id,
          notes: `Reduced filled quantity at machine ${machineId}`,
        }];
      }
      return [];
    });

    if (movements.length) {
      const { error: movementError } = await supabase
        .from("inventory_movements")
        .insert(movements);

      if (movementError) throwActionError(movementError, "Could not create machine fill inventory movements.");
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
      .select("id")
      .eq("route_id", routeId)
      .eq("machine_id", machineId)
      .maybeSingle();
    if (existingCashError) throwActionError(existingCashError, "Could not verify the cash collection record.");

    const cashPayload = {
      route_id: routeId,
      machine_id: machineId,
      operator_id: route.operator_id,
      vms_expected_cash: expectedCash,
      review_status: cashCollected ? "collected_pending_count" : "pending_collection",
      cash_bag_id: cashBagId?.trim() || null,
      notes,
    };
    const { data: cashCollection, error: cashError } = existingCashCollection?.id
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
    const { data: refillHistory, error: refillHistoryError } = await supabase
      .from("machine_refill_history")
      .upsert({
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
      }, { onConflict: "legacy_refill_id" })
      .select("id, legacy_refill_id, refill_at, machine_id, machine_name, operator_id, fill_status, issues_found, machine_photo_url, machine_photo_path, linked_issue_id")
      .single();

    if (refillHistoryError) throwActionError(refillHistoryError, "Could not save the machine refill proof.");

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

    const { error: routeStatusError } = await supabase
      .from("routes")
      .update({ status: "machine_filling" })
      .eq("id", routeId)
      .in("status", [...availableRouteStatuses, ...activeRouteStatuses]);
    if (routeStatusError) throwActionError(routeStatusError, "Could not update route progress.");

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
    return actionFailure(completeStopPublicError(error), { expectedCash: null, routeId, stopId });
  }
}

/**
 * Records leftovers and creates inventory movements
 * operator_bag -> storage
 */
export async function recordLeftovers({
  routeId,
  leftoverItems,
}: {
  routeId: string;
  leftoverItems: { productId: string; quantity: number }[];
}) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const profile = await getCurrentProfile();
    // Get route to find operator
    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id")
      .eq("id", routeId)
      .maybeSingle();

    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    if (!canAccessOperatorRoute(profile ? profileContext(profile) : null, route.operator_id)) {
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

    const { data: filledMovements, error: filledError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, reason, from_entity_type, to_entity_type")
      .eq("related_route_id", routeId)
      .in("reason", ["operator_bag_to_machine", "manual_correction"]);
    if (filledError) throwActionError(filledError, "Could not verify filled route stock.");

    const filledByProduct = new Map<string, number>();
    (filledMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + machineFillDelta(movement));
    });

    const routeProductIds = new Set((routeStockLines ?? []).map((line: any) => String(line.product_id)));
    for (const productId of leftoversByProduct.keys()) {
      if (!routeProductIds.has(productId)) throw new Error("Returned product is not part of this route stock.");
    }

    for (const line of routeStockLines ?? []) {
      const productId = String(line.product_id);
      const returnQty = leftoversByProduct.get(productId) ?? 0;
      const available = Math.max(0, Number(line.picked_qty ?? 0) - (filledByProduct.get(productId) ?? 0) - Number(line.returned_qty ?? 0));
      if (returnQty > available) throw new Error("Returned quantity cannot exceed remaining operator bag stock.");
    }

    const movements = Array.from(leftoversByProduct.entries())
      .map((item) => ({
        product_id: item[0],
        quantity: item[1],
        from_entity_type: "operator_bag" as const,
        from_entity_id: route.operator_id,
        to_entity_type: "storage" as const,
        to_entity_id: storageId,
        reason: "operator_bag_to_storage" as const,
        related_route_id: routeId,
        created_by: route.operator_id,
        notes: `Leftovers returned from route ${routeId}`,
      }));

    if (movements.length > 0) {
      const { error: movementError } = await supabase
        .from("inventory_movements")
        .insert(movements);

      if (movementError) throwActionError(movementError, "Could not create leftover return movements.");
    }

    for (const line of routeStockLines ?? []) {
      const productId = String(line.product_id);
      const returnQty = leftoversByProduct.get(productId) ?? 0;
      const { error: stockLineError } = await supabase
        .from("route_stock_lines")
        .update({ returned_qty: Number(line.returned_qty ?? 0) + returnQty, updated_at: new Date().toISOString() })
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
      for (const item of leftoverItems.filter((entry) => Number(entry.quantity) >= 0)) {
        let remaining = Number(item.quantity);
        const lines = linesByProduct.get(String(item.productId)) ?? [];

        for (const line of lines) {
          const available = Math.max(0, Number(line.picked_qty ?? 0) - Number(line.filled_qty ?? 0) - Number(line.returned_qty ?? 0));
          const returnedQty = Math.max(0, Math.min(remaining, available));
          remaining -= returnedQty;

          const { error: lineError } = await supabase
            .from("refill_order_lines")
            .update({ returned_qty: Number(line.returned_qty ?? 0) + returnedQty })
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
    return { success: true };
  } catch (error) {
    console.error("Error recording leftovers:", error);
    throw new Error(getErrorMessage(error, "Could not record route leftovers."));
  }
}

/**
 * Completes entire route
 * Updates route status to completed
 */
export async function completeRoute(routeId: string) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("No Supabase client");

  try {
    const profile = await getCurrentProfile();
    const { data: route, error: routeError } = await supabase.from("routes").select("id, operator_id").eq("id", routeId).maybeSingle();
    if (routeError) throwActionError(routeError, "Could not load this route.");
    if (!route) throw new Error("Route not found");
    if (!canAccessOperatorRoute(profile ? profileContext(profile) : null, route.operator_id)) {
      throw new Error("You are not authorized to complete this route");
    }
    const { data: openStops, error: stopsError } = await supabase
      .from("route_stops")
      .select("id")
      .eq("route_id", routeId)
      .neq("status", "completed")
      .limit(1);
    if (stopsError) throwActionError(stopsError, "Could not verify route stop status.");
    if (openStops?.length) throw new Error("Complete every machine stop before closing the route.");

    const [{ data: routeStockLines, error: stockError }, { data: filledMovements, error: filledError }] = await Promise.all([
      supabase
        .from("route_stock_lines")
        .select("product_id, picked_qty, returned_qty")
        .eq("route_id", routeId),
      supabase
        .from("inventory_movements")
        .select("product_id, quantity, reason, from_entity_type, to_entity_type")
        .eq("related_route_id", routeId)
        .in("reason", ["operator_bag_to_machine", "manual_correction"]),
    ]);
    if (stockError) throwActionError(stockError, "Could not load route stock.");
    if (filledError) throwActionError(filledError, "Could not verify filled route stock.");

    const filledByProduct = new Map<string, number>();
    (filledMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id);
      filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + machineFillDelta(movement));
    });
    const unreturnedStock = (routeStockLines ?? []).filter((line: any) => {
      const pickedQty = Number(line.picked_qty ?? 0);
      const returnedQty = Number(line.returned_qty ?? 0);
      const filledQty = filledByProduct.get(String(line.product_id)) ?? 0;
      return pickedQty - returnedQty - filledQty > 0;
    });
    if (unreturnedStock.length) throw new Error("Return all leftover operator bag stock before completing the route.");

    const { error } = await supabase
      .from("routes")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", routeId);

    if (error) throwActionError(error, "Could not complete this route.");
    await logActivity({
      profile,
      action: "update",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      beforeData: route,
      afterData: { status: "completed" },
      summary: "Completed route",
    });
    revalidateRouteWorkflow(routeId);
    return { success: true };
  } catch (error) {
    console.error("Error completing route:", error);
    throw new Error(getErrorMessage(error, "Could not complete this route."));
  }
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
