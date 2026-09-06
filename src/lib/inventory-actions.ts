"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAddProducts, isOwnerAdminRole } from "@/lib/authz";
import { resolveProductSku } from "@/lib/product-sku";

type SimpleAdjustmentType = "set_exact" | "add" | "remove";

const simpleAdjustmentReasons = new Map([
  ["stock_count_correction", "Stock count correction"],
  ["damaged_expired_item", "Damaged/expired item"],
  ["missing_item", "Missing item"],
  ["found_item", "Found item"],
  ["manual_correction", "Manual correction"],
  ["other", "Other"],
]);

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function simpleReason(value: FormDataEntryValue | null) {
  const key = clean(value) || "stock_count_correction";
  return simpleAdjustmentReasons.has(key) ? key : "stock_count_correction";
}

function createdAtFromDate(value: FormDataEntryValue | null) {
  const date = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return `${date}T12:00:00+02:00`;
}

export async function createStorageAdjustment(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/inventory/movements/new?error=Supabase%20is%20not%20configured.");

  const productId = clean(formData.get("product_id"));
  const adjustmentType = clean(formData.get("adjustment_type")) as SimpleAdjustmentType;
  const quantity = Number(formData.get("quantity") || 0);
  const storageId = clean(formData.get("storage_location_id"));
  const reasonKey = simpleReason(formData.get("adjustment_reason"));
  const note = clean(formData.get("notes"));
  const createdAt = createdAtFromDate(formData.get("adjustment_date"));
  const clientSubmissionId = clean(formData.get("client_submission_id"));
  const path = "/inventory/movements/new";

  const fail = (message: string): never => redirect(`${path}?error=${encodeURIComponent(message)}&mode=simple`);

  if (!productId) fail("Product is required.");
  if (!isUuid(storageId)) fail("Choose a valid storage location.");
  if (!["set_exact", "add", "remove"].includes(adjustmentType)) fail("Adjustment type is required.");
  if (!Number.isFinite(quantity) || quantity < 0 || (adjustmentType !== "set_exact" && quantity <= 0)) fail("Quantity must be valid.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientSubmissionId)) {
    fail("Refresh this form before creating the storage adjustment.");
  }

  const { data: adjustmentRows, error } = await supabase.rpc("snacky_create_storage_adjustment_v1", {
    p_client_submission_id: clientSubmissionId,
    p_product_id: productId,
    p_storage_location_id: storageId,
    p_adjustment_type: adjustmentType,
    p_quantity: Math.round(quantity),
    p_reason_key: reasonKey,
    p_note: note || null,
    p_created_at: createdAt ?? null,
  });
  if (error) {
    console.error("[inventory:adjustment] Failed to create storage adjustment", error);
    if (String(error.code ?? "") === "PGRST202") {
      fail("The atomic storage adjustment database update is not active yet. No inventory was changed.");
    }
    fail(error.message || "Could not create storage adjustment.");
  }

  const adjustment = (Array.isArray(adjustmentRows) ? adjustmentRows[0] : adjustmentRows) as {
    movement_id?: unknown;
    already_applied?: unknown;
    quantity_before?: unknown;
    quantity_after?: unknown;
    quantity_delta?: unknown;
  } | null;
  const movementId = String(adjustment?.movement_id ?? "").trim();
  const quantityBefore = Number(adjustment?.quantity_before);
  const quantityAfter = Number(adjustment?.quantity_after);
  const difference = Number(adjustment?.quantity_delta);
  if (
    !movementId
    || !Number.isSafeInteger(quantityBefore)
    || !Number.isSafeInteger(quantityAfter)
    || !Number.isSafeInteger(difference)
    || quantityAfter - quantityBefore !== difference
    || difference === 0
  ) {
    console.error("[inventory:adjustment] Atomic adjustment returned an invalid receipt", { adjustment });
    fail("The adjustment response could not be verified. Refresh inventory and retry the saved form.");
  }

  await logActivity({
    profile,
    action: "storage_adjustment",
    entityType: "inventory_movement",
    entityId: movementId,
    entityLabel: `Storage adjustment ${movementId.slice(0, 8)}`,
    beforeData: { product_id: productId, storage_location_id: storageId, storage_quantity: quantityBefore },
    afterData: {
      product_id: productId,
      storage_location_id: storageId,
      storage_quantity: quantityAfter,
      difference,
      movement_id: movementId,
      adjustment_type: adjustmentType,
      already_applied: Boolean(adjustment?.already_applied),
    },
    metadata: {
      product_id: productId,
      storage_location_id: storageId,
      reason: reasonKey,
      note: note || null,
    },
    summary: `Adjusted storage by ${difference > 0 ? "+" : ""}${difference} units`,
    idempotencyKey: `storage-adjustment:${clientSubmissionId}`,
  });

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/inventory/movements/new");
  revalidatePath(`/products/${productId}/history`);
  redirect(`/inventory?adjusted=${movementId.slice(0, 8)}`);
}

export async function createInventoryMovementCorrection(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail("/inventory/movements", "Supabase is not configured.");

  const id = clean(formData.get("id"));
  if (!isUuid(id)) fail("/inventory/movements", "A valid inventory movement is required.");
  const reason = requireConfirmedReason(formData, "/inventory/movements");

  const { data, error } = await supabase.rpc("snacky_create_inventory_movement_correction_v1", {
    p_original_movement_id: id,
    p_reason: reason,
  });
  if (error) {
    console.error("[inventory:movement] Atomic correction failed", error);
    const code = String(error.code ?? "");
    if (code === "PGRST202" || code === "42883") {
      fail("/inventory/movements", "The atomic inventory correction database update is not active yet. No inventory was changed.");
    }
    fail("/inventory/movements", error.message || "Could not create correction movement.");
  }

  const result = (Array.isArray(data) ? data[0] : data) as {
    correction_movement_id?: string | null;
    already_applied?: boolean | null;
    review_required?: boolean | null;
    review_discrepancy_id?: string | null;
    related_route_id?: string | null;
    related_purchase_id?: string | null;
    product_id?: string | null;
  } | null;
  const correctionId = String(result?.correction_movement_id ?? "").trim();
  const reviewId = String(result?.review_discrepancy_id ?? "").trim();
  const routeId = String(result?.related_route_id ?? "").trim();
  const purchaseId = String(result?.related_purchase_id ?? "").trim();
  const productId = String(result?.product_id ?? "").trim();

  if (result?.review_required) {
    if (!isUuid(reviewId) || !isUuid(routeId)) {
      console.error("[inventory:movement] Atomic correction returned an invalid review result", result);
      fail("/inventory/movements", "The correction review was saved, but its result could not be verified. Refresh before trying again.");
    }

    await logActivity({
      profile,
      action: "request_inventory_correction_review",
      entityType: "route_inventory_discrepancy",
      entityId: reviewId,
      entityLabel: `Correction review ${reviewId.slice(0, 8)}`,
      afterData: result,
      metadata: { reason, original_movement_id: id, inventory_changed: false },
      summary: `Sent terminal-route inventory movement ${id.slice(0, 8)} to review without changing stock`,
      idempotencyKey: `inventory-correction-review-activity:${reviewId}`,
    });

    revalidatePath("/inventory");
    revalidatePath("/inventory/movements");
    revalidatePath("/routes");
    revalidatePath(`/routes/${routeId}`);
    revalidatePath("/routes/inventory-review");
    redirect(
      `/routes/inventory-review?route=${routeId}&success=${encodeURIComponent(
        "This route is closed, so stock was not changed. The correction request was saved for inventory review.",
      )}`,
    );
  }

  if (!isUuid(correctionId)) {
    console.error("[inventory:movement] Atomic correction returned an invalid movement result", result);
    fail("/inventory/movements", "The correction result could not be verified. Refresh before trying again.");
  }

  await logActivity({
    profile,
    action: "correction",
    entityType: "inventory_movement",
    entityId: correctionId,
    entityLabel: `Correction ${correctionId.slice(0, 8)}`,
    afterData: result,
    metadata: { reason, reversed_movement_id: id, already_applied: Boolean(result?.already_applied) },
    summary: `Created correction movement for ${id.slice(0, 8)}`,
    idempotencyKey: `inventory-correction-activity:${correctionId}`,
  });

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  if (isUuid(routeId)) revalidatePath(`/routes/${routeId}`);
  if (isUuid(purchaseId)) revalidatePath(`/purchases/${purchaseId}`);
  if (isUuid(productId)) revalidatePath(`/products/${productId}/history`);
  redirect("/inventory/movements?corrected=" + id.slice(0, 8));
}
