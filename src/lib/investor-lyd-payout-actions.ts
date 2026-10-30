"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const value=(fd:FormData,key:string)=>String(fd.get(key)??"").trim();
const month=/^\d{4}-(0[1-9]|1[0-2])-01$/;
const todayInTripoli=()=>{
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 const get=(part:string)=>parts.find(p=>p.type===part)?.value;
 return [get("year"),get("month"),get("day")].join("-");
};
const url=(id:string,type:"error"|"success",message:string)=>"/finance/investors?"+new URLSearchParams({agreement:id,tab:"payment",[type]:message}).toString();
const safeError=(message:string)=>{
 if(/exceeds verified unpaid LYD/i.test(message))return "One or more monthly allocations exceed the confirmed LYD remaining. Refresh the balances and review the payment.";
 if(/exceed remaining agreed USD/i.test(message))return "This payment would exceed the remaining USD payout goal. Reduce the payment or check the agreement.";
 if(/Only finalized LYD|not confirmed/i.test(message))return "Only confirmed historical or finalized monthly profits can be paid.";
 if(/previously posted|Saved payment request/i.test(message))return "This request was already posted with different details. Check payment history before trying again.";
 if(/Reconcile legacy LYD/i.test(message))return "Older LYD investor payouts need accounting review before this new settlement.";
 return "Could not verify or post the payment. Check payment history before attempting another request.";
};

export async function recordActualInvestorLydBatch(fd:FormData){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
 const id=value(fd,"agreement_id"),command=value(fd,"client_submission_id");
 if(!uuid.test(id)||!uuid.test(command))redirect("/finance/investors?error=Invalid%20investor%20payment%20request");
 const fail=(message:string):never=>redirect(url(id,"error",message));
 const date=value(fd,"payout_date"),rate=Number(value(fd,"lyd_per_usd")),reference=value(fd,"payment_reference");
 const account=value(fd,"payment_account"),method=value(fd,"payment_method"),notes=value(fd,"notes");
 if(value(fd,"confirm_actual_paid")!=="yes")fail("Confirm that the LYD payment already happened. This action does not transfer money.");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>todayInTripoli()||date<"2026-01-01"
    ||!Number.isFinite(rate)||rate<=0||rate>=100000
    ||!["snacky_lyd","owner_lyd"].includes(account)||!["cash","bank_transfer","other"].includes(method)
    ||reference.length<3||reference.length>200||notes.length>2000)fail("Check the actual LYD payment date, exchange rate, account and receipt reference.");
 let allocations:Array<{month_start:string;amount_lyd:number}>=[];
 try{
  const parsed:unknown=JSON.parse(value(fd,"allocations_json"));
  if(!Array.isArray(parsed)||parsed.length<1||parsed.length>24)throw Error("Invalid allocations");
  allocations=parsed.map(row=>{
   if(!row||typeof row!=="object")throw Error("Invalid allocation");
   const obj=row as Record<string,unknown>,period=String(obj.month_start??""),amount=Number(obj.amount_lyd);
   if(!month.test(period)||!Number.isFinite(amount)||amount<=0||amount>=1e9||Math.abs(amount*100-Math.round(amount*100))>1e-6)
    throw Error("Invalid period or amount");
   return {month_start:period,amount_lyd:amount};
  });
  if(new Set(allocations.map(a=>a.month_start)).size!==allocations.length)throw Error("Duplicate month");
 }catch{fail("Select at least one payable month and enter valid amounts in LYD.");}
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return fail("Database session unavailable. Check the payout history before retrying the same payment request.");
 const {data,error}=await db.rpc("snacky_record_investor_lyd_payout_batch_v1",{
  p_agreement_id:id,p_allocations:allocations,p_payout_date:date,p_lyd_per_usd:rate,
  p_account_id:account,p_method:method,p_reference:reference,p_notes:notes,p_command_id:command
 });
 if(error)fail(safeError(String(error.message??"")));
 if(!data||data.client_submission_id!==command||data.agreement_id!==id||!data.finance_transaction_id)
  fail("Payment result could not be verified. Check Finance and the investor payout history before retrying.");
 try{
  await logActivity({profile,action:"investor_lyd_payout_batch",entityType:"investor_agreement",entityId:id,
   summary:"Actual LYD investor profit payout posted to Finance and allocated to confirmed months",
   afterData:data,idempotencyKey:"investor-lyd-batch:"+command});
 }catch(err){console.error("[investor-lyd] Audit follow-up needed",err);}
 for(const path of ["/finance/investors","/investor","/finance","/finance/transactions"])revalidatePath(path);
 redirect(url(id,"success","LYD payout recorded once, allocated to the selected months and credited toward the USD goal at the documented payment-day rate."));
}
