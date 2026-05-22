"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { resolveProductSku } from "@/lib/product-sku";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const movementTypes = ["storage_to_operator_bag", "operator_bag_to_storage", "storage_adjustment", "damaged", "expired", "manual_correction", "product_substitution"] as const;
type MovementType = (typeof movementTypes)[number];
type EntityType = "storage" | "operator_bag" | "waste" | "adjustment";

function parseLocation(value: FormDataEntryValue | null): { type: EntityType; id: string | null } | null {
  const raw = String(value || "");
  const [type, id = ""] = raw.split(":");
  if (!["storage", "operator_bag", "waste", "adjustment"].includes(type)) return null;
  return { type: type as EntityType, id: id || null };
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
  if (!profile || !["owner", "admin", "supervisor"].includes(profile.role)) {
    throw new Error("You are not authorized to add products.");
  }

  const supabase = getSupabaseServerClient();
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
  return type;
}

export async function createStockMovement(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/inventory/movements/new")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
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
  if (!isOwnerAdminRole(profile.role) && adminOverride) fail("Only owner/admin can override available storage.");
  if (movementType === "manual_correction" && !isOwnerAdminRole(profile.role)) fail("Only owner/admin can create manual correction movements.");

  const fromLocation = from as { type: EntityType; id: string | null };
  const toLocation = to as { type: EntityType; id: string | null };

  if (movementType === "storage_to_operator_bag" && (fromLocation.type !== "storage" || toLocation.type !== "operator_bag")) {
    fail("Storage to operator bag movements must move from storage to an operator bag.");
  }
  if (movementType === "operator_bag_to_storage" && (fromLocation.type !== "operator_bag" || toLocation.type !== "storage")) {
    fail("Operator bag returns must move from an operator bag to storage.");
  }
  if (movementType === "storage_adjustment" && fromLocation.type !== "storage" && toLocation.type !== "storage") {
    fail("Storage adjustments must include a storage location.");
  }
  if ((movementType === "damaged" || movementType === "expired") && toLocation.type !== "waste") {
    fail("Damaged and expired stock must move to waste.");
  }
  if (movementType === "product_substitution" && !relatedRouteId) {
    fail("Product substitution movements must be linked to a route.");
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
      .eq("product_id", productId)
      .in("routes.status", ["draft", "assigned"]);

    if (reservedError) fail("Could not verify route reservations.");

    const reservedQty = (reservedRows ?? []).reduce((sum: number, row: any) => sum + Math.max(0, Number(row.planned_qty ?? 0) - Number(row.picked_qty ?? 0)), 0);
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
    reason: movementReason(movementType),
    related_route_id: relatedRouteId,
    created_by: profile.team_member_id,
    notes,
  });

  if (error) {
    console.error("[inventory:movement] Failed to create movement", error);
    fail("Could not create stock movement.");
  }

  if (movementType === "storage_to_operator_bag" && relatedRouteId) {
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

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements/new");
  if (relatedRouteId) revalidatePath(`/routes/${relatedRouteId}`);
  redirect("/inventory");
}

export async function createInventoryMovementCorrection(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile.role)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) fail("/inventory/movements", "Supabase is not configured.");

  const id = clean(formData.get("id"));
  if (!id) redirect("/inventory/movements");
  const reason = requireConfirmedReason(formData, "/inventory/movements");

  const { data: movement, error: movementError } = await supabase.from("inventory_movements").select("*").eq("id", id).maybeSingle();
  if (movementError || !movement) fail("/inventory/movements", "Inventory movement not found.");

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
    created_by: profile.team_member_id,
    notes: `Correction for movement ${id.slice(0, 8)}: ${reason}`,
  };

  const { data: correction, error } = await supabase.from("inventory_movements").insert(payload).select("*").single();
  if (error) {
    console.error("[inventory:movement] Failed to create correction", error);
    fail("/inventory/movements", "Could not create correction movement.");
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
  if (movement.related_route_id) revalidatePath(`/routes/${movement.related_route_id}`);
  if (movement.related_purchase_id) revalidatePath(`/purchases/${movement.related_purchase_id}`);
  revalidatePath(`/products/${movement.product_id}/history`);
  redirect(`/inventory/movements?corrected=${id.slice(0, 8)}`);
}
