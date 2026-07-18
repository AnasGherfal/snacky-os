"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";

const clean = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();
const optionalNumber = (formData: FormData, key: string) => {
  const raw = clean(formData, key);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function updateInvestorAgreement(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");
  const agreementId = clean(formData, "agreement_id");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase || !agreementId) redirect("/finance/investors?error=Missing%20investor%20agreement.");

  const startDate = clean(formData, "start_date");
  const endDate = clean(formData, "end_date") || null;
  if (!startDate || (endDate && endDate < startDate)) {
    redirect(`/finance/investors?agreement=${agreementId}&error=Agreement%20dates%20are%20invalid.`);
  }

  const { error } = await supabase.from("investor_agreements").update({
    investor_name: clean(formData, "investor_name"),
    investment_amount_lyd: Math.max(0, Number(optionalNumber(formData, "investment_amount_lyd") ?? 0)),
    profit_share_percent: Math.min(100, Math.max(0, Number(optionalNumber(formData, "profit_share_percent") ?? 30))),
    start_date: startDate,
    end_date: endDate,
    payout_cap_lyd: optionalNumber(formData, "payout_cap_lyd"),
    status: clean(formData, "status") || "active",
    notes: clean(formData, "notes") || null,
    updated_at: new Date().toISOString(),
  }).eq("id", agreementId);

  if (error) redirect(`/finance/investors?agreement=${agreementId}&error=${encodeURIComponent(error.message)}`);
  revalidatePath("/finance/investors");
  revalidatePath("/investor");
  redirect(`/finance/investors?agreement=${agreementId}&success=Investor%20agreement%20updated.`);
}
