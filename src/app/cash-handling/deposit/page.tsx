import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { CashDepositWorkspace } from "@/components/cash/CashDepositWorkspace";

export const dynamic="force-dynamic";
export default async function CashDepositPage() {
  const profile=await getCurrentProfile();
  if (!profile || profile.active_status!=="active" || !profile.team_member_id ||
      !hasAnyRole(profile,["owner","admin","operator","supervisor","warehouse","purchasing","finance"]))
    redirect("/unauthorized");
  const db=getSupabaseAdminClient();
  const [policy,owner] = db ? await Promise.all([
    db.from("cash_refill_policy").select("safe_label").eq("id",1).maybeSingle(),
    db.from("profiles").select("id").eq("role","owner").eq("active_status","active").limit(1).maybeSingle(),
  ]) : [{data:null,error:{message:"Database unavailable"}},{data:null,error:{message:"Database unavailable"}}];
  const safe=policy.data?.safe_label?.trim() || "Safe A";
  return <CashDepositWorkspace safeLabel={safe} suggestedReceiverId={owner.data?.id??null} />;
}
