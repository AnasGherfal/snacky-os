"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function reviewCashCollection(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();

  if (!id) throw new Error("Cash collection ID is required");

  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured");

  const { error } = await supabase
    .from("cash_collections")
    .update({
      review_status: "resolved",
      notes: notes || null,
    })
    .eq("id", id);

  if (error) throw error;

  revalidatePath("/cash-collections");
  revalidatePath(`/cash-collections/${id}`);
  redirect(`/cash-collections/${id}`);
}
