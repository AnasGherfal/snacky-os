"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canManageVmsMappings } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const allowedStatuses = new Set(["confirmed", "needs_review", "ignored"]);

// TODO: Add create VMS mapping activity logging when manual VMS mapping creation is implemented.

export async function updateVmsProductMapping(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!canManageVmsMappings(profile)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  const id = String(formData.get("id") || "");
  if (!supabase) redirect(`/vms-mappings/${id}/edit?error=Supabase%20is%20not%20configured.`);
  if (!id) redirect("/vms-mappings?error=Missing%20mapping.");

  const status = String(formData.get("match_status") || "needs_review");
  if (!allowedStatuses.has(status)) redirect(`/vms-mappings/${id}/edit?error=Invalid%20mapping%20status.`);

  const productId = String(formData.get("product_id") || "") || null;
  if (status === "confirmed" && !productId) {
    redirect(`/vms-mappings/${id}/edit?error=Confirmed%20mappings%20must%20select%20a%20Snacky%20product.`);
  }

  const { data: beforeMapping } = await supabase.from("vms_product_mappings").select("*").eq("id", id).maybeSingle();
  const { data: afterMapping, error } = await supabase
    .from("vms_product_mappings")
    .update({
      product_id: status === "ignored" ? null : productId,
      match_status: status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[vms-mappings:update] Failed to update mapping", { id, error });
    redirect(`/vms-mappings/${id}/edit?error=Could%20not%20update%20mapping.`);
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "vms_mapping",
    entityId: id,
    entityLabel: afterMapping?.vms_product_name ?? beforeMapping?.vms_product_name ?? id.slice(0, 8),
    beforeData: beforeMapping,
    afterData: afterMapping ?? { product_id: status === "ignored" ? null : productId, match_status: status },
    summary: `Updated VMS product mapping to ${status.replaceAll("_", " ")}`,
  });

  revalidatePath("/vms-mappings");
  revalidatePath("/vms-import");
  revalidatePath(`/vms-mappings/${id}/edit`);
  redirect("/vms-mappings");
}
