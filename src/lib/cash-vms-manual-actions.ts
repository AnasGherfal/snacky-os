"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { logActivity } from "@/lib/activity-log";
import { loadCashVmsWindow } from "@/lib/cash-vms-server";
import type { CashVmsComparisonSnapshot } from "@/lib/cash-vms-window";

function fail(id:string,message:string):never {
  redirect("/cash-collections/compare?collection="+encodeURIComponent(id)+"&error="+encodeURIComponent(message));
}

export async function saveOwnerXyCashWindow(formData:FormData) {
  const id=String(formData.get("collection_id")??"").trim();
  if(!/^[0-9a-f-]{36}$/i.test(id))redirect("/cash-collections");
  const profile=await getCurrentProfile();
  if(!profile || profile.active_status!=="active" ||
      !hasAnyRole(profile,["owner","admin"]) || !profile.team_member_id)redirect("/unauthorized");

  const raw=String(formData.get("xy_cash_lyd")??"").trim();
  const vmsNumber=Number(raw.replace(/,/g,""));
  if(!raw || !/^\d{1,9}(?:\.\d{1,2})?$/.test(raw) ||
      !Number.isFinite(vmsNumber) || vmsNumber<0)
    fail(id,"Enter the successful CASH-only sales amount in LYD. Do not include card payments.");
  if(String(formData.get("confirmed_cash_scope")??"")!=="yes")
    fail(id,"Confirm that the XY total contains only successful cash payments for the exact displayed period.");
  const note=String(formData.get("report_reference")??"").trim();
  if(note.length<6 || note.length>500)
    fail(id,"Name the XY report or dashboard source so this comparison can be audited.");
  const originalFingerprint=String(formData.get("window_fingerprint")??"");
  const submissionId=String(formData.get("submission_id")??"");
  if(!/^[0-9a-f-]{36}$/i.test(submissionId))fail(id,"Invalid comparison submission. Refresh and retry.");

  const window=await loadCashVmsWindow(id);
  if(!window.canSave || window.physicalCashTotal===null || !window.startPickup || !window.startAt)
    fail(id,"This machine period is not ready. Review the previous pickup and count every intervening removal first.");
  if(originalFingerprint!==window.fingerprint)
    fail(id,"The removal history changed since this comparison was opened. Refresh to see the updated exact period.");
  if(window.included.length>1000)fail(id,"Comparison period is too large for safe review.");
  const db=getSupabaseAdminClient();
  if(!db)fail(id,"Cash comparison storage is not configured.");

  const {data:line,error:lineError}=await db.from("cash_collection_machines")
    .select("cash_collection_id,machine_id,expectation_metadata")
    .eq("cash_collection_id",id).eq("machine_id",window.target.machineId).maybeSingle();
  if(lineError || !line)fail(id,"Could not verify the selected machine cash record.");
  const previous=(line.expectation_metadata ?? {}) as Record<string,unknown>;
  const amount=Math.round(vmsNumber*100)/100;
  const physical=window.physicalCashTotal;
  const saved:CashVmsComparisonSnapshot={
    start_collection_id:window.startPickup.id,
    end_collection_id:id,
    start_at:window.startAt,
    end_at:window.endAt,
    included_collection_ids:window.included.map((row)=>row.id),
    physical_cash_lyd:physical,
    vms_cash_lyd:amount,
    difference_lyd:Math.round((physical-amount)*100)/100,
    quality:window.quality,
    payment_scope:"cash_successful_only",
    source:"owner_entered_xy_vms",
    source_note:note,
    saved_at:new Date().toISOString(),
    saved_by:profile.id,
    submission_id:submissionId,
  };
  const old=previous.manual_vms_group_comparison ?? null;
  // Replayed form submission: do not duplicate financial or activity entries.
  if(old && typeof old==="object" && !Array.isArray(old) &&
      (old as Record<string,unknown>).submission_id===submissionId)
    redirect("/cash-collections/compare?collection="+id+"&success=already_saved");
  // Metadata only. NEVER modify physical count, Finance or formal reconciliation.
  // The grouped window cannot be forced into a single cash-bag reconciliation.
  const {data:changed,error}=await db.from("cash_collection_machines")
    .update({expectation_metadata:{...previous,manual_vms_group_comparison:saved}})
    .eq("cash_collection_id",id).eq("machine_id",window.target.machineId)
    .select("cash_collection_id").maybeSingle();
  if(error || !changed)fail(id,"XY comparison could not be saved. No cash amounts were modified.");
  await logActivity({
    profile,action:"manual_vms_group_cash_comparison",entityType:"cash_collection",
    entityId:id,entityLabel:window.target.machineName,
    beforeData:old,afterData:saved,
    metadata:{owner_entered:true,not_an_xy_api_sync:true,no_finance_posting:true,
      period_quality:window.quality},
    summary:"Owner-entered XY cash comparison "+amount+" LYD versus "+physical+
      " LYD across "+window.included.length+" recorded pickup(s); "+window.quality,
    idempotencyKey:"manual-xy-cash-comparison-"+submissionId,
  });
  revalidatePath("/cash-collections");
  revalidatePath("/cash-collections/"+id);
  revalidatePath("/cash-collections/compare");
  redirect("/cash-collections/compare?collection="+id+"&success=saved");
}
