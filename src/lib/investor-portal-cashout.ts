import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
 auditInvestorFinanceMoneyOut,
 type InvestorCashOutAudit,
 type InvestorFinanceOutflow
} from "@/lib/investor-finance-outflow";

/** Scoped, aggregated Finance read only. Never hand raw company entries to
 * the investor page or use a service role before checking the agreement owner.
 */
export async function loadAuthorizedInvestorCashOutAudit({
 agreementId,investorUserId,startDate,endDate
}:{agreementId:string;investorUserId:string;startDate:string;endDate?:string|null}):Promise<InvestorCashOutAudit>{
 const profile=await getCurrentProfile();
 const session=await getAuthenticatedSupabaseServerClient();
 if(!profile||profile.active_status!=="active"||!session)
  throw new Error("Investor session unavailable.");
 const {data:agreement,error}=await session.from("investor_agreements")
  .select("id,investor_user_id").eq("id",agreementId).maybeSingle();
 if(error||!agreement||agreement.investor_user_id!==investorUserId)
  throw new Error("Investor agreement not accessible.");
 if(!isOwnerAdminRole(profile)&&agreement.investor_user_id!==profile.id)
  throw new Error("Investor finance summary not authorized.");
 const reader=getSupabaseAdminClient();
 if(!reader)throw new Error("Verified Finance reader unavailable.");
 const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Tripoli",
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const from=startDate>"2026-04-01"?startDate:"2026-04-01";
 const to=endDate && endDate<today?endDate:today;
 const rows:InvestorFinanceOutflow[]=[];
 if(from>to)return auditInvestorFinanceMoneyOut([]);
 for(let offset=0;offset<25000;offset+=500){
  const result=await reader.from("financial_transactions")
   .select("id,transaction_date,direction,transaction_status,transaction_effect,amount,signed_amount,currency,exchange_rate_usd_to_lyd,category,description,source_type,source_sheet,source_row,review_status,needs_review,is_void,voided_at,transaction_kind,transaction_type,final_bucket,bucket,linked_purchase_id,related_purchase_id")
   .eq("direction","money_out").gte("transaction_date",from).lte("transaction_date",to)
   .order("transaction_date").order("id").range(offset,offset+499);
  if(result.error)throw new Error("Finance money-out register unreadable.");
  const page=(result.data??[]) as InvestorFinanceOutflow[];
  rows.push(...page);
  if(page.length<500)return auditInvestorFinanceMoneyOut(rows);
 }
 throw new Error("Finance money-out register exceeded verified audit limit.");
}
