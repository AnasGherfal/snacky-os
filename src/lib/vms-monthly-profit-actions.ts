"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports } from "@/lib/authz";
import { ensureMonthlyProfitBatchActivated } from "@/lib/vms-monthly-profit-activation";

function resultErrorMessage(result: Extract<Awaited<ReturnType<typeof ensureMonthlyProfitBatchActivated>>, { ok: false }>) {
  const detail = result.details ? ` ${result.details}` : "";
  return `${result.message}${detail}`.trim();
}

function revalidateMonthlyProfitPaths(batchId: string) {
  revalidatePath("/vms-import");
  revalidatePath(`/vms-import/${batchId}`);
  revalidatePath("/product-planning");
  revalidatePath("/dashboard");
  revalidatePath("/sales");
  revalidatePath("/products-dashboard");
  revalidatePath("/machines-dashboard");
  revalidatePath("/finance");
  revalidatePath("/finance/operations");
  revalidatePath("/reports");
}

export async function activateMonthlyProfitImportBatch(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");

  const batchId = String(formData.get("batch_id") ?? "").trim();
  if (!batchId) redirect("/vms-import?error=Missing%20VMS%20import%20batch.");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect(`/vms-import/${batchId}?error=${encodeURIComponent("Supabase is not configured.")}`);

  const result = await ensureMonthlyProfitBatchActivated({
    supabase,
    batchId,
    actorId: profile.team_member_id ?? profile.id ?? null,
  });

  revalidateMonthlyProfitPaths(batchId);

  if (!result.ok) {
    console.error("[vms-import] Monthly Product Profit activation repair failed", {
      batchId,
      code: result.code,
      message: result.message,
      details: result.details,
    });
    redirect(`/vms-import/${batchId}?error=${encodeURIComponent(resultErrorMessage(result))}`);
  }

  const replacedMessage = result.deactivatedBatchIds.length
    ? ` Replaced ${result.deactivatedBatchIds.length} older partial upload(s) for ${result.businessMonth.slice(0, 7)}.`
    : "";
  redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Activated ${result.rowCount} Monthly Product Profit row(s) through ${result.reportEndDate}.${replacedMessage}`)}`);
}
