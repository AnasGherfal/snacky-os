"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";

const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const val=(fd:FormData,k:string)=>String(fd.get(k)??"").trim();
const validMonth=(month:string)=>/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month);
const back=(id:string,message:string,isError=false)=>{
 const params=new URLSearchParams({agreement:id,[isError?'error':'success']:message});
 return "/finance/investors?"+params.toString();
};

export async function saveInvestorMonthlyFxRate(formData:FormData) {
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile)) redirect("/unauthorized");
 const agreementId=val(formData,"agreement_id"),month=val(formData,"month_start");
 if(!validUuid.test(agreementId)||!validMonth(month)) redirect("/finance/investors?error=Invalid%20investor%20month");
 const rate=Number(val(formData,"lyd_per_usd"));
 const source=val(formData,"rate_source");
 if(!Number.isFinite(rate)||rate<=0||rate>=100000 || (source&&source.length>500)){
  redirect(back(agreementId,"Use a positive LYD amount per one US dollar; source must be under 500 characters.",true));
 }
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)redirect(back(agreementId,"Investor database session unavailable.",true));
 const {data:agreement,error:agreementError}=await db.from("investor_agreements").select("id,start_date,end_date").eq("id",agreementId).maybeSingle();
 if(agreementError||!agreement||month<agreement.start_date||(agreement.end_date&&month>agreement.end_date))redirect(back(agreementId,"Rate date is outside the investment agreement.",true));
 const {data:oldRate,error:oldError}=await db.from("investor_monthly_fx_rates").select("*").eq("agreement_id",agreementId).eq("month_start",month).maybeSingle();
 if(oldError)redirect(back(agreementId,"Cannot verify previous investor FX rate.",true));
 const {data:after,error}=await db.from("investor_monthly_fx_rates").upsert({
  agreement_id:agreementId,month_start:month,lyd_per_usd:rate,rate_source:source||null,updated_by:profile.id,updated_at:new Date().toISOString(),
 },{onConflict:"agreement_id,month_start"}).select("*").single();
 if(error||!after)redirect(back(agreementId,error?.message??"Could not save FX rate.",true));
 try {await logActivity({profile,action:"save_investor_fx_rate",entityType:"investor_agreement",entityId:agreementId,
  summary:`Saved ${month} FX planning rate ${rate} LYD per USD; not a payout`,
  beforeData:oldRate,afterData:after});} catch(e){console.error("[investor-fx] Audit log unavailable",e);}
 revalidatePath("/finance/investors");revalidatePath("/investor");
 redirect(back(agreementId,`Saved exchange rate for ${month.slice(0,7)}. No money was paid.`));
}

export async function recordActualInvestorUsdPayout(formData:FormData) {
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
 const agreementId=val(formData,"agreement_id"),month=val(formData,"month_start");
 if(!validUuid.test(agreementId)||!validMonth(month))redirect("/finance/investors?error=Invalid%20investor%20payment");
 if(val(formData,"confirm_actual_paid")!=="yes")redirect(back(agreementId,"Confirm the USD was already paid. This is not a money transfer.",true));
 const amount=Number(val(formData,"amount_usd")),rate=Number(val(formData,"lyd_per_usd"));
 const date=val(formData,"payout_date"),reference=val(formData,"payment_reference"),notes=val(formData,"notes");
 const account=val(formData,"payment_account"),method=val(formData,"payment_method");
 const cmd=val(formData,"client_submission_id");
 if(!validUuid.test(cmd)||!Number.isFinite(amount)||amount<=0||Math.abs(Math.round(amount*100)-amount*100)>1e-6||
  !Number.isFinite(rate)||rate<=0||rate>=100000 || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
  reference.length<3||reference.length>200||notes.length>2000)redirect(back(agreementId,"Invalid amount, FX rate, date or actual payment reference.",true));
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)redirect(back(agreementId,"Database unavailable. Do not submit a new payment if a previous request may have succeeded.",true));
 const {data,error}=await db.rpc("snacky_record_investor_usd_payout_v1",{
  p_agreement_id:agreementId,p_month_start:month,p_amount_usd:amount,p_payout_date:date,
  p_lyd_per_usd:rate,p_account_id:account,p_method:method,p_reference:reference,p_notes:notes,p_command_id:cmd,
 });
 if(error)redirect(back(agreementId,error.message,true));
 if(!data||data.client_submission_id!==cmd||data.agreement_id!==agreementId||!data.finance_transaction_id)
  redirect(back(agreementId,"Could not verify payment receipt. Check the ledger before retrying.",true));
 try{await logActivity({profile,action:"investor_usd_payout",entityType:"investor_agreement",entityId:agreementId,
  summary:`Verified already-paid USD investor distribution for ${month}; posted Finance cash-out.`,afterData:data,
  idempotencyKey:`investor-usd-payment:${cmd}`});}catch(e){console.error("[investor-usd] Audit follow-up needed",e);}
 revalidatePath("/finance/investors");revalidatePath("/investor");revalidatePath("/finance");
 redirect(back(agreementId,`Recorded actual USD payment against ${month.slice(0,7)} and Finance.`));
}
