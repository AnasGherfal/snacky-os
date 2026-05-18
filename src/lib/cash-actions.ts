"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { createCashCollectionFinancialTransaction } from "@/lib/finance-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function reviewCashCollection(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();

  if (!id) redirect("/cash-collections?error=Cash%20collection%20ID%20is%20required.");

  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/cash-collections?error=Supabase%20is%20not%20configured.");

  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }

  const { data: before } = await supabase
    .from("cash_collections")
    .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, notes, collected_at")
    .eq("id", id)
    .maybeSingle();
  if (!before) redirect("/cash-collections?error=Cash%20collection%20not%20found.");

  const { data: cash, error } = await supabase
    .from("cash_collections")
    .update({
      review_status: "resolved",
      notes: notes || null,
    })
    .eq("id", id)
    .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, notes, collected_at")
    .single();

  if (error) redirect(`/cash-collections/${id}?error=${encodeURIComponent(error.message)}`);
  await createCashCollectionFinancialTransaction(supabase, profile, cash);
  await logActivity({
    profile,
    action: "review_cash_collection",
    entityType: "cash_collection",
    entityId: id,
    entityLabel: `Cash ${id.slice(0, 8)}`,
    beforeData: before,
    afterData: cash,
    metadata: { route_id: cash.route_id, machine_id: cash.machine_id, operator_id: cash.operator_id },
    summary: "Confirmed cash collection and posted finance transaction",
  });

  revalidatePath("/cash-collections");
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  revalidatePath(`/cash-collections/${id}`);
  redirect(`/cash-collections/${id}`);
}
