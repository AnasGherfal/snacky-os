"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canAddProducts, hasPermission, isOwnerAdminRole } from "@/lib/authz";
import { INVENTORY_MOVEMENT_FORM_OPTIONS, inventoryMovementIdempotencyKey, normalizeInventoryEntityType, normalizeInventoryMovementReason } from "@/lib/inventory-movement";
import { resolveProductSku } from "@/lib/product-sku";
import { isRouteReservationStatus } from "@/lib/route-workflow";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const movementTypes = Array.from(new Set([
  ...INVENTORY_MOVEMENT_FORM_OPTIONS.map((option) => option.value),
  "storage_to_operator_bag",
  "operator_bag_to_machine",
  "operator_bag_to_storage",
  "machine_to_storage",
  "storage_adjustment",
  "manual_correction",
  "stock_count_adjustment",
  "damaged",
  "expired",
  "product_substitution",
  "returned_from_machine",
  "historical_route_deduction",
  "purchase_received",
]));
type MovementType = (typeof movementTypes)[number];
type EntityType = "storage" | "operator_bag" | "machine" | "waste" | "adjustment";
type SimpleAdjustmentType = "set_exact" | "add" | "remove";

const simpleAdjustmentReasons = new Map([
  ["stock_count_correction", "Stock count correction"],
  ["damaged_expired_item", "Damaged/expired item"],
  ["missing_item", "Missing item"],
  ["found_item", "Found item"],
  ["manual_correction", "Manual correction"],
  ["other", "Other"],
]);

function parseLocation(value: FormDataEntryValue | null): { type: EntityType; id: string | null } | null {
  const raw = String(value || "");
  const [type, id = ""] = raw.split(":");
  const normalizedType = normalizeInventoryEntityType(type);
  return { type: normalizedType, id: id || null };
}

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function requireConfirmedReason(formData: FormData, path: string) {
  if (clean(formData.get("confirm_action")) !== "yes") fail(path, "Confirmation is required.");
  const reason = clean(formData.get("reason"));
  if (!reason) fail(path, "Reason is required.");
  return reason;
}

export async function createQuickProduct(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canAddProducts(profile)) {
    throw new Error("You are not authorized to add products.");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const name = String(formData.get("name") || "").trim();
  if (!name) throw new Error("Product name is required.");
  const sku = await resolveProductSku({ supabase, manualSku: formData.get("sku") });

  const { data, error } = await supabase.from("products").insert({
    sku,
    barcode: String(formData.get("barcode") || "").trim() || null,
    name,
    category: String(formData.get("category") || "snack").trim() || "snack",
    brand: String(formData.get("brand") || "").trim() || null,
    selling_price: Number(formData.get("selling_price") || 0),
    current_selling_price_lyd: Number(formData.get("selling_price") || 0),
    selling_price_source: Number(formData.get("selling_price") || 0) > 0 ? "manual" : "initial_import",
    cost_price: 0,
    current_cost_price_lyd: 0,
    cost_price_source: "initial_import",
    import_source: "manual",
    active: true,
  }).select("id, sku, name, category, brand, active").single();

  if (error) throw error;
  if (data) {
    await logActivity({
      profile,
      action: "create",
      entityType: "product",
      entityId: data.id,
      entityLabel: data.name,
      afterData: data,
      summary: `Quick-created product ${data.name}`,
    });
  }
  revalidatePath("/inventory/movements/new");
}

function movementReason(type: MovementType) {
  if (type === "storage_adjustment") return "stock_count_adjustment";
  return normalizeInventoryMovementReason(type);
}

function userContext(profile: NonNullable<Awaited<ReturnType<typeof getCurrentProfile>>>) {
  return {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  };
}

async function getDefaultStorageId(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const { data: mainStorage, error: mainStorageError } = await supabase
    .from("storage_locations")
    .select("id")
    .eq("active", true)
    .eq("location_type", "main_storage")
    .order("name")
    .limit(1)
    .maybeSingle();
  if (mainStorageError) throw mainStorageError;
  if (mainStorage?.id) return mainStorage.id;

  const { data: storage, error } = await supabase
    .from("storage_locations")
    .select("id")
    .eq("active", true)
    .in("location_type", ["vehicle", "temporary", "other"])
    .order("name")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return storage?.id ?? null;
}

async function getStorageQty(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, productId: string) {
  const { data, error } = await supabase
    .from("current_inventory_by_location")
    .select("quantity_on_hand")
    .eq("location_type", "storage")
    .eq("product_id", productId);
  if (error) throw error;
  return (data ?? []).reduce((sum: number, row: any) => sum + Number(row.quantity_on_hand ?? 0), 0);
}

function simpleReason(value: FormDataEntryValue | null) {
  const key = clean(value) || "stock_count_correction";
  return simpleAdjustmentReasons.has(key) ? key : "stock_count_correction";
}

function movementReasonForSimple(reasonKey: string): "stock_count_adjustment" | "damaged" | "expired" | "theft_or_missing" {
  if (reasonKey === "damaged_expired_item") return "damaged";
  if (reasonKey === "missing_item") return "theft_or_missing";
  return "stock_count_adjustment";
}

function createdAtFromDate(value: FormDataEntryValue | null) {
  const date = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return `${date}T12:00:00+02:00`;
}

export async function createStorageAdjustment(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !hasPermission(profile, "storage.adjust")) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/inventory/movements/new?error=Supabase%20is%20not%20configured.");

  const productId = clean(formData.get("product_id"));
  const adjustmentType = clean(formData.get("adjustment_type")) as SimpleAdjustmentType;
  const quantity = Number(formData.get("quantity") || 0);
  const reasonKey = simpleReason(formData.get("adjustment_reason"));
  const note = clean(formData.get("notes"));
  const createdAt = createdAtFromDate(formData.get("adjustment_date"));
  const path = "/inventory/movements/new";

  const fail = (message: string): never => redirect(`${path}?error=${encodeURIComponent(message)}&mode=simple`);

  if (!productId) fail("Product is required.");
  if (!["set_exact", "add", "remove"].includes(adjustmentType)) fail("Adjustment type is required.");
  if (!Number.isFinite(quantity) || quantity < 0 || (adjustmentType !== "set_exact" && quantity <= 0)) fail("Quantity must be valid.");

  const [storageId, currentQty] = await Promise.all([getDefaultStorageId(supabase), getStorageQty(supabase, productId)]);
  if (!storageId) fail("No active storage location found.");

  const difference =
    adjustmentType === "set_exact"
      ? Math.round(quantity) - currentQty
      : adjustmentType === "add"
        ? Math.round(quantity)
        : -Math.round(quantity);

  if (difference === 0) fail("Storage already matches this quantity. No movement was created.");

  const movementReason = movementReasonForSimple(reasonKey);
  const movementQuantity = Math.abs(difference);
  const removing = difference < 0;
  const toWaste = removing && movementReason === "damaged";
  const payload = {
    product_id: productId,
    quantity: movementQuantity,
    from_entity_type: removing ? "storage" : "adjustment",
    from_entity_id: removing ? storageId : null,
    to_entity_type: removing ? (toWaste ? "waste" : "adjustment") : "storage",
    to_entity_id: removing ? null : storageId,
    reason: movementReason,
    created_by: profile.team_member_id,
    notes: [
      simpleAdjustmentReasons.get(reasonKey),
      adjustmentType === "set_exact" ? `Set exact count from ${currentQty} to ${Math.round(quantity)} (${difference > 0 ? "+" : ""}${difference})` : `${adjustmentType === "add" ? "Added" : "Removed"} ${movementQuantity}`,
      note,
    ].filter(Boolean).join(" - "),
    ...(createdAt ? { created_at: createdAt } : {}),
  };

  const { data: movement, error } = await supabase.from("inventory_movements").insert(payload).select("*").single();
  if (error) {
    console.error("[inventory:adjustment] Failed to create storage adjustment", error);
    fail("Could not create storage adjustment.");
  }

  await logActivity({
    profile,
    action: "storage_adjustment",
    entityType: "inventory_movement",
    entityId: movement.id,
    entityLabel: `Storage adjustment ${movement.id.slice(0, 8)}`,
    beforeData: { product_id: productId, storage_quantity: currentQty },
    afterData: {
      product_id: productId,
      storage_quantity: currentQty + difference,
      difference,
      movement_id: movement.id,
      adjustment_type: adjustmentType,
    },
    metadata: {
      product_id: productId,
      storage_location_id: storageId,
      reason: reasonKey,
      note: note || null,
    },
    summary: `Adjusted storage by ${difference > 0 ? "+" : ""}${difference} units`,
  });

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/inventory/movements/new");
  revalidatePath(`/products/${productId}/history`);
  redirect(`/inventory?adjusted=${movement.id.slice(0, 8)}`);
}

export async function createStockMovement(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath(userContext(profile), "/inventory/movements/new")) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/inventory/movements/new?error=Supabase%20is%20not%20configured.");

  const productId = String(formData.get("product_id") || "");
  const quantity = Number(formData.get("quantity") || 0);
  const movementType = String(formData.get("movement_type") || "") as MovementType;
  const from = parseLocation(formData.get("from_location"));
  const to = parseLocation(formData.get("to_location"));
  const relatedRouteId = String(formData.get("related_route_id") || "") || null;
  const notes = String(formData.get("notes") || "").trim() || null;
  const adminOverride = String(formData.get("admin_override") || "") === "on";

  const params = new URLSearchParams();
  const fail = (message: string): never => {
    params.set("error", message);
    redirect(`/inventory/movements/new?${params.toString()}`);
  };

  if (!productId) fail("Product is required.");
  if (!Number.isFinite(quantity) || quantity <= 0) fail("Quantity must be greater than 0.");
  if (!movementTypes.includes(movementType)) fail("Movement type is required.");
  if (!from || !to) {
    params.set("error", "From and to locations are required.");
    redirect(`/inventory/movements/new?${params.toString()}`);
  }
  if (!isOwnerAdminRole(profile) && adminOverride) fail("Only owner/admin can override available storage.");
  if (movementType === "manual_correction" && !isOwnerAdminRole(profile)) fail("Only owner/admin can create manual correction movements.");

  const fromLocation = from as { type: EntityType; id: string | null };
  const toLocation = to as { type: EntityType; id: string | null };
  const normalizedMovementType = movementType === "storage_adjustment" ? "stock_count_correction" : movementType;
  const dbReason = movementReason(movementType as MovementType);

  switch (normalizedMovementType) {
    case "storage_to_route":
    case "storage_to_operator_bag":
      if (fromLocation.type !== "storage" || toLocation.type !== "operator_bag") {
        fail("Storage to route bag movements must move from storage to a route bag.");
      }
      break;
    case "route_to_machine":
    case "operator_bag_to_machine":
      if (fromLocation.type !== "operator_bag" || toLocation.type !== "machine") {
        fail("Route bag to machine movements must move from a route bag to a machine.");
      }
      break;
    case "route_to_storage_return":
    case "operator_bag_to_storage":
      if (fromLocation.type !== "operator_bag" || toLocation.type !== "storage") {
        fail("Route bag returns must move from a route bag to storage.");
      }
      break;
    case "machine_to_storage_return":
    case "machine_to_storage":
      if (fromLocation.type !== "machine" || toLocation.type !== "storage") {
        fail("Machine returns must move from a machine to storage.");
      }
      break;
    case "route_to_damaged":
    case "machine_to_damaged":
    case "damaged":
    case "expired":
      if (toLocation.type !== "waste") {
        fail("Damaged and expired stock must move to waste.");
      }
      break;
    case "manual_adjustment_in":
    case "manual_adjustment_out":
    case "stock_count_correction":
    case "manual_correction":
    case "stock_count_adjustment":
      if (fromLocation.type !== "adjustment" && toLocation.type !== "adjustment") {
        fail("Manual adjustments must involve the adjustment account.");
      }
      break;
    case "product_substitution":
      if (!relatedRouteId) {
        fail("Product substitution movements must be linked to a route.");
      }
      break;
    default:
      break;
  }

  if (fromLocation.type === "storage" && !adminOverride) {
    const { data: storageRows, error: storageError } = await supabase
      .from("current_inventory_by_location")
      .select("quantity_on_hand")
      .eq("location_type", "storage")
      .eq("location_id", fromLocation.id)
      .eq("product_id", productId);

    if (storageError) fail("Could not verify available storage.");

    const currentStorageQty = (storageRows ?? []).reduce((sum: number, row: any) => sum + Number(row.quantity_on_hand ?? 0), 0);
    const { data: reservedRows, error: reservedError } = await supabase
      .from("route_stock_lines")
      .select("planned_qty, picked_qty, routes!inner(status)")
      .eq("product_id", productId);

    if (reservedError) fail("Could not verify route reservations.");

    const reservedQty = (reservedRows ?? [])
      .filter((row: any) => isRouteReservationStatus(row.routes?.status))
      .reduce((sum: number, row: any) => sum + Math.max(0, Number(row.planned_qty ?? 0) - Number(row.picked_qty ?? 0)), 0);
    const availableQty = Math.max(0, currentStorageQty - reservedQty);

    if (quantity > availableQty) {
      fail("Cannot take more than available storage unless owner/admin override is enabled.");
    }
  }

  const { error } = await supabase.from("inventory_movements").insert({
    product_id: productId,
    quantity,
    from_entity_type: fromLocation.type,
    from_entity_id: fromLocation.id,
    to_entity_type: toLocation.type,
    to_entity_id: toLocation.id,
    reason: dbReason,
    idempotency_key: inventoryMovementIdempotencyKey(
      "inventory-movement",
      dbReason,
      productId,
      fromLocation.type,
      fromLocation.id ?? "",
      toLocation.type,
      toLocation.id ?? "",
      relatedRouteId ?? "",
      quantity,
    ),
    related_route_id: relatedRouteId,
    created_by: profile.team_member_id,
    notes,
  });

  if (error) {
    console.error("[inventory:movement] Failed to create movement", error);
    fail("Could not create stock movement.");
  }

  if ((normalizedMovementType === "storage_to_route" || normalizedMovementType === "storage_to_operator_bag") && relatedRouteId) {
    const { data: stockLine } = await supabase
      .from("route_stock_lines")
      .select("id, planned_qty, picked_qty")
      .eq("route_id", relatedRouteId)
      .eq("product_id", productId)
      .maybeSingle();

    if (stockLine) {
      await supabase
        .from("route_stock_lines")
        .update({
          picked_qty: Number(stockLine.picked_qty ?? 0) + quantity,
          planned_qty: Math.max(Number(stockLine.planned_qty ?? 0), Number(stockLine.picked_qty ?? 0) + quantity),
          updated_at: new Date().toISOString(),
        })
        .eq("id", stockLine.id);
    } else {
      await supabase.from("route_stock_lines").insert({
        route_id: relatedRouteId,
        product_id: productId,
        planned_qty: quantity,
        picked_qty: quantity,
      });
    }
  }
  if ((normalizedMovementType === "route_to_storage_return" || normalizedMovementType === "operator_bag_to_storage") && relatedRouteId) {
    const { data: stockLine } = await supabase
      .from("route_stock_lines")
      .select("id, planned_qty, returned_qty")
      .eq("route_id", relatedRouteId)
      .eq("product_id", productId)
      .maybeSingle();

    if (stockLine) {
      await supabase
        .from("route_stock_lines")
        .update({
          returned_qty: Number(stockLine.returned_qty ?? 0) + quantity,
          updated_at: new Date().toISOString(),
        })
        .eq("id", stockLine.id);
    } else {
      await supabase.from("route_stock_lines").insert({
        route_id: relatedRouteId,
        product_id: productId,
        planned_qty: quantity,
        returned_qty: quantity,
      });
    }
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements/new");
  if (relatedRouteId) revalidatePath(`/routes/${relatedRouteId}`);
  redirect("/inventory");
}

export async function createInventoryMovementCorrection(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail("/inventory/movements", "Supabase is not configured.");

  const id = clean(formData.get("id"));
  if (!id) redirect("/inventory/movements");
  const reason = requireConfirmedReason(formData, "/inventory/movements");

  const { data: movement, error: movementError } = await supabase.from("inventory_movements").select("*").eq("id", id).maybeSingle();
  if (movementError || !movement) fail("/inventory/movements", "Inventory movement not found.");

  const correctionIdempotencyKey = inventoryMovementIdempotencyKey(
    "inventory-correction",
    id,
    reason,
    movement.product_id ?? "",
    movement.quantity ?? 0,
    movement.related_route_id ?? "",
    movement.related_purchase_id ?? "",
    movement.related_machine_id ?? "",
  );

  const { data: existingCorrection, error: existingCorrectionError } = await supabase
    .from("inventory_movements")
    .select("*")
    .eq("idempotency_key", correctionIdempotencyKey)
    .maybeSingle();
  if (existingCorrectionError) {
    console.error("[inventory:movement] Failed to load existing correction", existingCorrectionError);
    fail("/inventory/movements", "Could not verify correction status.");
  }
  if (existingCorrection) {
    revalidatePath("/inventory");
    revalidatePath("/inventory/movements");
    if (movement.related_route_id) revalidatePath("/routes/" + movement.related_route_id);
    if (movement.related_purchase_id) revalidatePath("/purchases/" + movement.related_purchase_id);
    revalidatePath("/products/" + movement.product_id + "/history");
    redirect("/inventory/movements?corrected=" + id.slice(0, 8));
  }

  const { count: existingCorrectionCount, error: correctionCheckError } = await supabase
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("reversed_movement_id", id);
  if (correctionCheckError) {
    console.error("[inventory:movement] Failed to verify correction status", correctionCheckError);
    fail("/inventory/movements", "Could not verify correction status.");
  }
  if (Number(existingCorrectionCount ?? 0) > 0) {
    fail("/inventory/movements", "This movement already has a correction. Correct the latest correction movement instead.");
  }

  const payload = {
    product_id: movement.product_id,
    quantity: Number(movement.quantity ?? 0),
    from_entity_type: movement.to_entity_type,
    from_entity_id: movement.to_entity_id,
    to_entity_type: movement.from_entity_type,
    to_entity_id: movement.from_entity_id,
    reason: "manual_correction",
    related_route_id: movement.related_route_id ?? null,
    related_route_stop_id: movement.related_route_stop_id ?? null,
    related_purchase_id: movement.related_purchase_id ?? null,
    related_purchase_line_id: movement.related_purchase_line_id ?? null,
    related_machine_id: movement.related_machine_id ?? null,
    unit_cost_lyd: movement.unit_cost_lyd ?? null,
    line_total_lyd: movement.line_total_lyd === null || movement.line_total_lyd === undefined ? null : -Math.abs(Number(movement.line_total_lyd)),
    reversed_movement_id: id,
    correction_reason: reason,
    source_type: "inventory_movement_correction",
    source_id: id,
    idempotency_key: correctionIdempotencyKey,
    created_by: profile.team_member_id,
    notes: "Correction for movement " + id.slice(0, 8) + ": " + reason,
  };

  const { error } = await supabase.from("inventory_movements").upsert(payload, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) {
    console.error("[inventory:movement] Failed to create correction", error);
    fail("/inventory/movements", "Could not create correction movement.");
  }

  const { data: correction, error: correctionLoadError } = await supabase
    .from("inventory_movements")
    .select("*")
    .eq("idempotency_key", correctionIdempotencyKey)
    .maybeSingle();
  if (correctionLoadError || !correction) {
    console.error("[inventory:movement] Failed to reload correction", correctionLoadError);
    fail("/inventory/movements", "Could not load correction movement.");
  }

  await logActivity({
    profile,
    action: "correction",
    entityType: "inventory_movement",
    entityId: correction.id,
    entityLabel: `Correction ${correction.id.slice(0, 8)}`,
    beforeData: movement,
    afterData: correction,
    metadata: { reason, reversed_movement_id: id },
    summary: `Created correction movement for ${id.slice(0, 8)}`,
  });

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  if (movement.related_route_id) revalidatePath("/routes/" + movement.related_route_id);
  if (movement.related_purchase_id) revalidatePath("/purchases/" + movement.related_purchase_id);
  revalidatePath("/products/" + movement.product_id + "/history");
  redirect("/inventory/movements?corrected=" + id.slice(0, 8));
}