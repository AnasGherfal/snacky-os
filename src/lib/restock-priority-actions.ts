"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { supabaseQueryErrorMessage } from "@/lib/safe-supabase-query";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function safeReturnTo(value: FormDataEntryValue | null) {
  const path = clean(value);
  return path.startsWith("/") && !path.startsWith("//") ? path : "/restock-priority";
}

function wholeNumber(value: FormDataEntryValue | null) {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function priorityValue(value: FormDataEntryValue | null) {
  const priority = clean(value);
  return priority === "high" || priority === "low" ? priority : "normal";
}

function redirectWithMessage(path: string, key: "error" | "updated", message: string): never {
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}${key}=${encodeURIComponent(message)}`);
}

export async function updateRestockSettings(formData: FormData) {
  const productId = clean(formData.get("product_id"));
  const returnTo = safeReturnTo(formData.get("return_to"));
  if (!productId) redirectWithMessage(returnTo, "error", "Product is required.");

  const profile = await getCurrentProfile();
  if (!profile || !hasPermission(profile, "products.edit")) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirectWithMessage(returnTo, "error", "Supabase is not configured.");

  const payload = {
    restock_priority: priorityValue(formData.get("restock_priority")),
    min_storage_qty: wholeNumber(formData.get("min_storage_qty")),
    target_storage_qty: wholeNumber(formData.get("target_storage_qty")),
    reorder_point: wholeNumber(formData.get("reorder_point")),
    reorder_qty: wholeNumber(formData.get("reorder_qty")),
    updated_at: new Date().toISOString(),
  };

  const { data: before } = await supabase.from("products").select("*").eq("id", productId).maybeSingle();
  const { data: after, error } = await supabase
    .from("products")
    .update(payload)
    .eq("id", productId)
    .select("id, sku, name, restock_priority, min_storage_qty, target_storage_qty, reorder_point, reorder_qty")
    .maybeSingle();

  if (error || !after) {
    const message = supabaseQueryErrorMessage(error);
    console.error("[restock-priority] Failed to update restock settings", {
      product_id: productId,
      payload,
      supabase_error: error,
    });
    const text = message.toLowerCase();
    if (text.includes("schema cache") || text.includes("restock_priority") || text.includes("min_storage_qty")) {
      redirectWithMessage(returnTo, "error", "Restock fields are not migrated yet. Run the latest Supabase migrations, then retry.");
    }
    redirectWithMessage(returnTo, "error", "Could not update restock settings. Admin logs include the exact Supabase error.");
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    beforeData: before,
    afterData: after,
    metadata: { source: "restock_priority" },
    summary: `Updated restock settings for ${after.name}`,
  });

  revalidatePath("/restock-priority");
  revalidatePath("/dashboard");
  revalidatePath("/products");
  revalidatePath(`/products/${productId}/edit`);
  redirectWithMessage(returnTo, "updated", "Restock settings saved.");
}
