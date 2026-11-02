import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { CashReceiveWorkspace } from "@/components/cash/CashReceiveWorkspace";

export const dynamic="force-dynamic";
export default async function ReceiveCashPage() {
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
  const db=getSupabaseAdminClient();
  const policy=db?await db.from("cash_refill_policy").select("safe_label").eq("id",1).maybeSingle():null;
  return <CashReceiveWorkspace defaultSafeLabel={policy?.data?.safe_label?.trim()||"Safe A"}/>;
}
