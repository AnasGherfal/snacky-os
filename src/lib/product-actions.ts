"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import type { AppPermission } from "@/lib/authz";
import { hasPermission } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type SupabaseServer = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

export type ProductHistoryCounts = {
  purchaseLines: number;
  inventoryMovements: number;
  routeStockLines: number;
  routeStopItems: number;
  routePickListItems: number;
  routeStopFillLines: number;
  refillOrderLines: number;
  machineSlots: number;
  vmsMappings: number;
  vmsSalesSnapshots: number;
  vmsStockSnapshots: number;
};

function canManageProducts(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return hasPermission(profile, "products.edit") || hasPermission(profile, "products.delete");
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

async function requireProductAccess(path: string, permission: AppPermission = "products.edit") {
  const profile = await getCurrentProfile();
  if (!profile || !canManageProducts(profile) || !hasPermission(profile, permission)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

async function countRows(supabase: SupabaseServer, table: string, column: string, productId: string) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true }).eq(column, productId);
  if (error) throw error;
  return count ?? 0;
}

async function countImportedVmsRows(supabase: SupabaseServer, table: "vms_sales_snapshots" | "vms_stock_snapshots", productId: string) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("import_row_status", "imported");
  if (error) throw error;
  return count ?? 0;
}

async function countRowsOr(supabase: SupabaseServer, table: string, clause: string) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true }).or(clause);
  if (error) throw error;
  return count ?? 0;
}

export async function getProductHistoryCounts(supabase: SupabaseServer, productId: string): Promise<ProductHistoryCounts> {
  const [
    purchaseLines,
    inventoryMovements,
    routeStockLines,
    routeStopItems,
    routePickListItems,
    routeStopFillLines,
    refillOrderLines,
    machineSlots,
    vmsMappings,
    vmsSalesSnapshots,
    vmsStockSnapshots,
  ] = await Promise.all([
    countRows(supabase, "purchase_order_lines", "product_id", productId),
    countRows(supabase, "inventory_movements", "product_id", productId),
    countRows(supabase, "route_stock_lines", "product_id", productId),
    countRows(supabase, "route_stop_items", "product_id", productId),
    countRowsOr(supabase, "route_pick_list_items", `product_id.eq.${productId},substituted_for_product_id.eq.${productId}`),
    countRowsOr(supabase, "route_stop_fill_lines", `assigned_product_id.eq.${productId},product_id.eq.${productId},substitute_product_id.eq.${productId}`),
    countRows(supabase, "refill_order_lines", "product_id", productId),
    countRows(supabase, "machine_slots", "product_id", productId),
    countRows(supabase, "vms_product_mappings", "product_id", productId),
    countImportedVmsRows(supabase, "vms_sales_snapshots", productId),
    countImportedVmsRows(supabase, "vms_stock_snapshots", productId),
  ]);

  return {
    purchaseLines,
    inventoryMovements,
    routeStockLines,
    routeStopItems,
    routePickListItems,
    routeStopFillLines,
    refillOrderLines,
    machineSlots,
    vmsMappings,
    vmsSalesSnapshots,
    vmsStockSnapshots,
  };
}

export async function productHasBusinessHistory(counts: ProductHistoryCounts) {
  return Object.values(counts).some((count) => count > 0);
}

function revalidateProductPaths(id: string) {
  revalidatePath("/products");
  revalidatePath(`/products/${id}/edit`);
  revalidatePath(`/products/${id}/history`);
  revalidatePath("/purchases/new");
  revalidatePath("/inventory/movements/new");
  revalidatePath("/routes/new");
}

export async function archiveProduct(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/products");
  const path = `/products/${id}/history`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireProductAccess(path, "products.edit");

  const { data: before, error: beforeError } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  if (beforeError || !before) fail("/products", "Product not found.");

  const { data: after, error } = await supabase
    .from("products")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, sku, name, active, updated_at")
    .single();
  if (error) {
    console.error("[products] Failed to archive product", error);
    fail(path, "Could not archive product.");
  }

  await logActivity({
    profile,
    action: "archive",
    entityType: "product",
    entityId: id,
    entityLabel: before.name,
    beforeData: before,
    afterData: after,
    metadata: { reason },
    summary: `Archived product ${before.name}`,
  });

  revalidateProductPaths(id);
  redirect(path);
}

export async function activateProduct(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/products");
  const path = `/products/${id}/history`;
  const { profile, supabase } = await requireProductAccess(path, "products.edit");

  const { data: before } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  const { data: after, error } = await supabase
    .from("products")
    .update({ active: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, sku, name, active, updated_at")
    .single();
  if (error) {
    console.error("[products] Failed to activate product", error);
    fail(path, "Could not activate product.");
  }

  await logActivity({
    profile,
    action: "activate",
    entityType: "product",
    entityId: id,
    entityLabel: after.name,
    beforeData: before,
    afterData: after,
    summary: `Activated product ${after.name}`,
  });

  revalidateProductPaths(id);
  redirect(path);
}

export async function deleteProduct(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/products");
  const path = `/products/${id}/history`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireProductAccess(path, "products.delete");

  const { data: product, error: productError } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  if (productError || !product) fail("/products", "Product not found.");

  let counts: ProductHistoryCounts;
  try {
    counts = await getProductHistoryCounts(supabase, id);
  } catch (error) {
    console.error("[products] Failed to check product history", error);
    fail(path, "Could not verify product history.");
  }

  if (await productHasBusinessHistory(counts)) {
    fail(path, "This product has business history. Archive it instead of deleting it.");
  }

  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) {
    console.error("[products] Failed to delete product", error);
    fail(path, "Could not delete product.");
  }

  await logActivity({
    profile,
    action: "delete",
    entityType: "product",
    entityId: id,
    entityLabel: product.name,
    beforeData: product,
    metadata: { reason, history_counts: counts },
    summary: `Hard-deleted product ${product.name}`,
  });

  revalidatePath("/products");
  revalidatePath("/purchases/new");
  revalidatePath("/inventory/movements/new");
  revalidatePath("/routes/new");
  redirect("/products");
}
