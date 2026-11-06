import { NextResponse } from "next/server";
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { cashSameOrigin, cashReceiptMatches, cashUuid, isUnnumberedCashReference, type CashCommand, type CashWorkspace } from "@/lib/cash-handover";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { uploadCashEvidence } from "@/lib/cash-evidence";
import { CASH_PHOTO_UPLOAD_LIMIT } from "@/lib/cash-photo";
import { CASH_EVIDENCE_BUCKET } from "@/lib/storage-buckets";
import { readCompanyBody } from "@/lib/company-request";

export const dynamic = "force-dynamic";
const respond = (data: unknown,status=200) => NextResponse.json(data,{
  status,headers:{ "Cache-Control":"private,no-store","X-Content-Type-Options":"nosniff" },
});

export async function POST(request: Request) {
  if (!cashSameOrigin(request)) return respond({ok:false,code:"denied"},403);
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status!=="active" || !profile.team_member_id ||
      !hasAnyRole(profile, ["owner","admin","operator","supervisor","warehouse","purchasing","finance"]))
    return respond({ok:false,code:"denied"},403);
  const db = await getAuthenticatedSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  if (!db || !admin) return respond({ok:false,code:"unavailable",retryable:true},503);

  let body: FormData;
  try {
    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data")) throw Error("invalid");
    const raw = await readCompanyBody(request,CASH_PHOTO_UPLOAD_LIMIT+16000);
    body = await new Request(request.url,{method:"POST",
      headers:{"content-type":type},body:new Uint8Array(raw).buffer}).formData();
    const allowed=new Set(["request_id","collection_id","revision","bag_id","reference_mode","assigned_to","storage_location","photo","notes"]);
    if ([...body.keys()].some(key=>!allowed.has(key))) throw Error("invalid");
  } catch {
    return respond({ok:false,code:"invalid",message:"Deposit photo missing or exceeds 3 MB."},400);
  }
  const read=(key:string)=>String(body.get(key)??"").trim();
  const id=read("collection_id"),requestId=read("request_id"),bag=read("bag_id").toUpperCase();
  const recipient=read("assigned_to"),safe=read("storage_location"),notes=read("notes");
  const referenceMode=read("reference_mode") || "printed"; // compatible with earlier saved mobile retries
  const unnumbered=referenceMode==="unnumbered";
  const revision=Number(read("revision")),photo=body.get("photo");
  if (!cashUuid.test(id)||!cashUuid.test(requestId)||!cashUuid.test(recipient)||
      !["unnumbered","printed"].includes(referenceMode)||
      !/^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(bag)||
      !Number.isSafeInteger(revision)||revision<0||revision>999999999||
      safe.length<2||safe.length>180||notes.length>300||
      (photo!==null&&(!(photo instanceof File)||photo.size===0||photo.size>CASH_PHOTO_UPLOAD_LIMIT||
      !["image/jpeg","image/png","image/webp"].includes(photo.type)))) {
    return respond({ok:false,code:"invalid",message:"Confirm the selected cash pickup, safe, recipient and a current photo."},400);
  }
  // A system-generated (or historically operator-invented) reference is NOT
  // a physical seal. Preserve that limitation as a mandatory custody exception.
  // The operator still needs a photo, a specific cash collection and a receiver.
  const payload={
    assigned_to:recipient,storage_location:safe,
    seal_condition: unnumbered ? "mismatch" : "intact",
    notes:unnumbered
      ? ("UNNUMBERED CASH BAG. No physical printed number or independently verifiable seal. " +
         "Deposit claim matched to the machine, pickup time, collection record and photo. " +
         "Receiver must compare removal/deposit photographs before physical counting. " + notes).trim()
      : (notes || "Collector confirms numbered bag placed in the deposit safe. Independent receipt pending."),
  };
  const command:CashCommand={request_id:requestId,collection_id:id,revision,action:"dropoff",payload};
  try {
    // Exact replay is resolved before checking mutable stage or uploading
    // a second photo; a lost response must never create two custody events.
    const prior=await db.rpc("snacky_cash_handover_receipt_v1",{p_command:command});
    if (prior.error) return respond({ok:false,code:"unavailable",retryable:true},503);
    if (prior.data) return cashReceiptMatches(command,prior.data)
      ? respond({...prior.data,deposit_claimed:true,independent_receipt:false})
      : respond({ok:false,code:"conflict",message:"The saved request differs. Reload the bag."},409);

    const workspace=await db.rpc("snacky_cash_handover_workspace_v1",{p_id:id,p_status:"open",p_offset:0});
    if (workspace.error||!workspace.data) return respond({ok:false,code:"unavailable",retryable:true},503);
    const view=workspace.data as CashWorkspace;
    const box=view.rows.find(row=>row.id===id);
    if (!box||box.revision!==revision||!box.actions.includes("dropoff")||
       box.bag?.trim().toUpperCase()!==bag||
       (isUnnumberedCashReference(box.bag) && !unnumbered)||
       !view.counters.some(person=>person.id===recipient)) {
      return respond({ok:false,code:"conflict",
        message:"This bag, collector or receiver does not match the current cash record. Refresh before retrying."},409);
    }
    const scopeId=`cash-handover-${profile.id}-${requestId}`;
    let evidencePath:string|null=null;
    // A lost response after uploading evidence must be recoverable without
    // asking the operator to retrieve the deposited physical bag for a photo.
    const earlier=await admin.storage.from(CASH_EVIDENCE_BUCKET).list(scopeId,{
      limit:30,sortBy:{column:"created_at",order:"desc"},
    });
    if(!earlier.error){
      const existing=earlier.data?.find(file=>file.name.startsWith("stored-")&&
        /\\.(jpg|jpeg|png|webp)$/i.test(file.name));
      if(existing)evidencePath=`${scopeId}/${existing.name}`;
    }
    if(!evidencePath&&photo instanceof File){
      const uploaded=await uploadCashEvidence(photo,{
        scopeId,stage:"stored",required:true,
      });
      evidencePath=uploaded?.path??null;
    }
    if(!evidencePath)return respond({ok:false,code:"photo",retryable:true,
      message:"No saved photo was found for this attempt. Reattach a safe-slot photo or contact the owner if the bag is already deposited."},400);
    const result=await db.rpc("snacky_cash_handover_command_v1",{
      p_command:command,p_evidence_path:evidencePath,
    });
    // Never delete uploaded evidence if transport outcome is uncertain:
    // a committed command may already reference it.
    if (result.error) {
      const code=result.error.code==="42501"?"denied":
        ["23505","40001"].includes(result.error.code??"")?"conflict":
        ["22023","23514"].includes(result.error.code??"")?"invalid":"uncertain";
      return respond({ok:false,code,retryable:code==="uncertain",
        message:code==="uncertain"?"Deposit save not confirmed. Retry the SAME bag and request; do not deposit twice.":"Could not confirm this deposit. Refresh the cash record."},
        code==="denied"?403:code==="conflict"?409:code==="invalid"?400:503);
    }
    return cashReceiptMatches(command,result.data)
      ? respond({...result.data,deposit_claimed:true,independent_receipt:false})
      : respond({ok:false,code:"uncertain",retryable:true,
        message:"Deposit may be saved. Retry the same request to verify."},503);
  } catch {
    return respond({ok:false,code:"uncertain",retryable:true,
      message:"Connection uncertain. Retry the same bag and request ID. Do not deposit cash a second time."},503);
  }
}
