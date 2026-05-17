"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { createCashCollectionFinancialTransaction } from "@/lib/finance-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function reviewCashCollection(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();

  if (!id) throw new Error("Cash collection ID is required");

  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured");

  const profile = await getCurrentProfile();
  const { data: cash, error } = await supabase
    .from("cash_collections")
    .update({
      review_status: "resolved",
      notes: notes || null,
    })
    .eq("id", id)
    .select("id, route_id, machine_id, operator_id, actual_cash_collected, collected_at")
    .single();

  if (error) throw error;
  await createCashCollectionFinancialTransaction(supabase, profile, cash);

  revalidatePath("/cash-collections");
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  revalidatePath(`/cash-collections/${id}`);
  redirect(`/cash-collections/${id}`);
}
