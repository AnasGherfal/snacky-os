"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthenticatedSupabaseServerClient,getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { loadOwnerReportedCountRows } from "@/lib/cash-owner-reported";
import { logActivity } from "@/lib/activity-log";
import { validateCashCommand, cashReceiptMatches, type CashCommand,type CashWorkspace } from "@/lib/cash-handover";

function redirectBack(message:string):never {
  redirect("/cash-collections/owner-reported?message="+encodeURIComponent(message));
}

function receiptCommand(id:string, revision:number, action:"pickup"|"direct_pickup", bag:string):CashCommand {
  return validateCashCommand({
    request_id:crypto.randomUUID(), collection_id:id,action,revision,
    payload:{
      // An electronic UNNUMBERED reference is NOT a physical printed seal;
      // "mismatch" records missing seal verification without claiming damage.
      confirm_bag_id:bag,seal_condition:"mismatch",
      notes:"OWNER CONFIRMATION OF EARLIER PHYSICAL RECEIPT: Anas reports this existing unnumbered cash bag was taken from storage, identified by machine and photos, and physically counted before this digital confirmation. No printed seal number; no damage alleged. Pickup event timestamp is confirmation time, not original historical pickup time.",
    },
  });
}

function countCommand(id:string,revision:number,amount:number):CashCommand {
  return validateCashCommand({
    request_id:crypto.randomUUID(),collection_id:id,action:"count",revision,
    payload:{
      amount:amount.toFixed(2),
      cash_location:"Received by Anas from storage; final physical holding location not reported",
    },
  });
}

export async function confirmOwnerReportedCashCounts(formData:FormData) {
  const profile=await getCurrentProfile();
  if(!profile || profile.active_status!=="active" || !profile.team_member_id ||
     !hasAnyRole(profile,["owner","admin"]))redirect("/unauthorized");
  if(String(formData.get("owner_attestation")??"")!=="yes")
    redirectBack("Please confirm the eight owner-reported physical cash counts first.");
  const ids=[...new Set(formData.getAll("collection_ids").map(v=>String(v)))];
  if(!ids.length || ids.length>20 || ids.some(id=>!/^[0-9a-f-]{36}$/i.test(id)))
    redirectBack("Select the original cash collections to confirm.");
  const expected=await loadOwnerReportedCountRows();
  const byId=new Map(expected.map(row=>[row.id,row]));
  if(ids.some(id=>!byId.has(id)))redirectBack("The owner-reported cash records changed. Refresh the page and review.");
  const db=await getAuthenticatedSupabaseServerClient();
  if(!db)redirectBack("Signed-in cash session is unavailable.");
  let saved=0,already=0;
  const errors:string[]=[];

  // Each box is processed through the *existing authorized Cash Handling*
  // pickup-then-count RPC, not a direct SQL UPDATE or a fake user session.
  // Counts and Finance sync are idempotent and shared with normal cash flow.
  for(const id of ids) {
    const expectedRow=byId.get(id)!;
    try {
      const {data:latest,error:readError}=await db.from("cash_collections")
        .select("actual_cash_collected,custody_status,voided_at")
        .eq("id",id).maybeSingle();
      if(readError || !latest || latest.voided_at)throw Error("Original cash removal could not be verified.");
      if(latest.actual_cash_collected!==null) {
        const alreadyAmount=Number(latest.actual_cash_collected);
        if(Math.abs(alreadyAmount-expectedRow.amount)>0.005)
          throw Error("This box has a different confirmed amount. Use owner correction instead.");
        already++;
        continue;
      }
      const {data:state,error:stateError}=await db.rpc("snacky_cash_handover_workspace_v1",{
        p_id:id,p_status:"open",p_offset:0,
      });
      if(stateError || !state)throw Error("Cash handover state unavailable.");
      const rows=(state as CashWorkspace).rows??[];
      const box=rows.find(row=>row.id===id);
      if(!box || box.bag!==expectedRow.bag)throw Error("Cash bag reference mismatch.");
      if(!box.actions.includes("count")) {
        // For an already-deposited box assigned to Anas, physically confirmed
        // owner pickup is recorded before count. For his own Nov 13 HTMall
        // removal, the existing "direct_pickup" path applies.
        const action=box.actions.includes("pickup")?"pickup":
          box.actions.includes("direct_pickup")?"direct_pickup":null;
        if(!action)throw Error("The box needs a custody action that cannot be skipped.");
        const command=receiptCommand(id,box.revision,action,box.bag);
        const {data:ack,error:ackError}=await db.rpc("snacky_cash_handover_command_v1",{p_command:command,p_evidence_path:null});
        if(ackError || !cashReceiptMatches(command,ack))
          throw Error("Owner receipt could not be confirmed.");
      }
      // Always reload the actual DB revision after receipt, even if this is
      // recovering a prior incomplete attempt.
      const {data:newState,error:newError}=await db.rpc("snacky_cash_handover_workspace_v1",{
        p_id:id,p_status:"open",p_offset:0,
      });
      if(newError || !newState)throw Error("Unable to verify the cash box after pickup.");
      const current=(newState as CashWorkspace).rows.find(row=>row.id===id);
      if(!current || !current.actions.includes("count"))
        throw Error("Physical count is not authorized for the current custodian.");
      const command=countCommand(id,current.revision,expectedRow.amount);
      const {data:count,error:countError}=await db.rpc("snacky_cash_handover_command_v1",{p_command:command,p_evidence_path:null});
      if(countError || !cashReceiptMatches(command,count) || count.finance_posted!==true ||
        Math.abs(Number(count.amount)-expectedRow.amount)>0.005)
        throw Error("Finance posting could not be verified. Review this box before retry.");
      saved++;
      await logActivity({
        profile,action:"confirm_owner_reported_existing_cash_count",
        entityType:"cash_collection",entityId:id,entityLabel:expectedRow.machineName,
        afterData:{actual_cash_collected:expectedRow.amount,posted_to_finance:true,
          owner_report_source:expectedRow.source,original_removal_at:expectedRow.removedAt,
          receipt_and_count_confirmed_at:new Date().toISOString()},
        metadata:{historical_owner_report:true,physical_count_clock_time:"not_provided",
          no_physical_printed_seal_claimed:true,no_vms_match_claimed:true},
        summary:"Authenticated owner confirmed previously physically counted cash on original operator removal, with one verified Finance posting.",
        idempotencyKey:"owner-report-cash-count-confirm-"+id,
      });
    } catch(error) {
      errors.push(expectedRow.machineName+" ("+expectedRow.removedAt.slice(0,10)+"): "+
        (error instanceof Error?error.message:"Failed verification"));
    }
  }
  revalidatePath("/cash-collections");
  revalidatePath("/cash-collections/count");
  revalidatePath("/cash-collections/owner-reported");
  const result=saved+" counted and posted to Finance; "+already+" previously counted; "+errors.length+" still need review.";
  const err=errors.length?" First issue: "+errors[0].slice(0,180):"";
  redirectBack(result+err);
}
