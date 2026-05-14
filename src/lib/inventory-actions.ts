"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const movementTypes = ["storage_to_operator_bag", "operator_bag_to_storage", "storage_adjustment", "damaged", "expired"] as const;
type MovementType = (typeof movementTypes)[number];
type EntityType = "storage" | "operator_bag" | "waste" | "adjustment";

function parseLocation(value: FormDataEntryValue | null): { type: EntityType; id: string | null } | null {
  const raw = String(value || "");
  const [type, id = ""] = raw.split(":");
  if (!["storage", "operator_bag", "waste", "adjustment"].includes(type)) return null;
  return { type: type as EntityType, id: id || null };
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
