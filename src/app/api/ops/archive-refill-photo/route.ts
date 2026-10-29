import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { authorizedSchedulerToken, createPrivateBlobStore, photoArchiveReceiptKey, readVerifiedOriginal, sha256, storeVerifiedOriginal, validatePath } from "@/lib/private-blob-originals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Job = {path:string;expectedSize:number;expectedUpdatedAt:string;expectedEtag:string;release?:boolean;includeSafety?:boolean};
const maxBytes=7*1024*1024;
const minAgeMs=30*24*60*60*1000;
function matchesTime(value:unknown,original:string){
  return typeof value==="string" && Number.isFinite(Date.parse(value)) &&
    Date.parse(value)===Date.parse(original);
}
function response(status:number,body:Record<string,unknown>){
  return NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
}
function infoEtag(info: { eTag?: string | null; metadata?: {eTag?:string|null} | null }) {
  return String(info.eTag??info.metadata?.eTag??"").replaceAll('"',"").trim();
}
function fileAgeEligible(info: {updatedAt?:string|null;createdAt?:string|null}, now=Date.now()) {
  const last=Date.parse(String(info.updatedAt??""));
  const first=Date.parse(String(info.createdAt??""));
  return Number.isFinite(last)&&Number.isFinite(first)&&
    last<now-minAgeMs&&first<now-minAgeMs;
}
async function ensureEligible(supabase:NonNullable<ReturnType<typeof getSupabaseAdminClient>>, job:Job) {
  const path=validatePath(job.path);
  if(!/\.(jpg|jpeg|png|webp)$/i.test(path)) throw Error("not_supported_image");
  const [history,safety,quantity]=await Promise.all([
    supabase.from("machine_refill_history").select("id,route_id,route_stop_id,machine_id,machine_photo_url,issues_found,linked_issue_id").eq("machine_photo_path",path).limit(10),
    supabase.from("route_stop_safety_checks").select("id,route_id,route_stop_id,machine_id,proof_photo_url").eq("proof_photo_path",path).limit(10),
    supabase.from("route_stop_quantity_confirmations").select("id").filter("evidence_files::text","like",`%${path}%`).limit(1),
  ]);
  if(history.error||safety.error||quantity.error){
    console.warn("[photo-storage] Reference lookup failed",{
      history:history.error?.code??null,
      safety:safety.error?.code??null,
      quantity:quantity.error?.code??null,
    });
    throw Error("photo_reference_check_failed");
  }
  const h=history.data??[],s=safety.data??[];
  if(h.length+s.length<1||h.length+s.length>=10)throw Error("photo_reference_ambiguous");
  if(quantity.data?.length)throw Error("quantity_screenshot_protected");
  if(s.length&&!job.includeSafety)throw Error("safety_proof_not_enabled");
  const proxy=`/api/storage/refill-photos/${path}`;
  if(h.some(row=>row.issues_found||row.linked_issue_id||row.machine_photo_url!==proxy) ||
     s.some(row=>row.proof_photo_url!==proxy))throw Error("protected_or_nonproxy_reference");
  const routeIds=[...new Set([...h,...s].map(row=>String(row.route_id??"")).filter(Boolean))];
  const stopIds=[...new Set([...h,...s].map(row=>String(row.route_stop_id??"")).filter(Boolean))];
  const machineIds=[...new Set([...h,...s].map(row=>String(row.machine_id??"")).filter(Boolean))];
  if(routeIds.length===0||stopIds.length===0||machineIds.length===0)throw Error("incomplete_route_reference");
  const [routes,stops,issues]=await Promise.all([
    supabase.from("routes").select("id,status").in("id",routeIds),
    supabase.from("route_stops").select("id,status").in("id",stopIds),
    supabase.from("issues").select("id").in("machine_id",machineIds).is("resolved_at",null).is("archived_at",null).limit(1),
  ]);
  if(routes.error||stops.error||issues.error)throw Error("operational_hold_check_failed");
  if(routes.data?.length!==routeIds.length||stops.data?.length!==stopIds.length||
     routes.data.some(row=>row.status!=="completed")||
     stops.data.some(row=>row.status!=="completed")||
     issues.data?.length)throw Error("open_route_or_issue_hold");
}
export async function POST(request: Request){
  if(!authorizedSchedulerToken(String(request.headers.get("authorization")??"")))return response(401,{ok:false,error:"unauthorized"});
  if(process.env.SNACKY_PHOTO_ARCHIVE_MIGRATION_ENABLED!=="true")return response(409,{ok:false,error:"migration_disabled"});
  let job:Job;
  try{
    if(Number(request.headers.get("content-length")??0)>4096)throw Error("too_large");
    job=await request.json() as Job;
    validatePath(job.path);
    if(!Number.isSafeInteger(job.expectedSize)||job.expectedSize<200000||job.expectedSize>maxBytes||
       !matchesTime(job.expectedUpdatedAt,job.expectedUpdatedAt)||
       !/^[a-fA-F0-9]{32,64}$/.test(String(job.expectedEtag??"").replaceAll('"',"")))
       throw Error("invalid_job");
    if(job.release!==true&&job.release!==false&&job.release!==undefined)throw Error("invalid_job");
  }catch{return response(400,{ok:false,error:"invalid_job"});}
  const supabase=getSupabaseAdminClient();
  if(!supabase)return response(503,{ok:false,error:"storage_client_unavailable"});
  try{
    await ensureEligible(supabase,job);
    const bucket=supabase.storage.from("refill-photos");
    const {data:oldInfo,error:infoError}=await bucket.info(job.path);
    if(infoError||!oldInfo)throw Error("source_file_missing");
    const expectedEtag=String(job.expectedEtag).replaceAll('"',"");
    if(!fileAgeEligible(oldInfo)||oldInfo.size!==job.expectedSize||
       infoEtag(oldInfo)!==expectedEtag||
       !matchesTime(oldInfo.updatedAt,job.expectedUpdatedAt))
       throw Error("source_metadata_changed");
    const {data:download,error:downloadError}=await bucket.download(job.path);
    if(downloadError||!download)throw Error("source_download_failed");
    const source=new Uint8Array(await download.arrayBuffer());
    if(source.byteLength!==oldInfo.size||source.length>maxBytes)throw Error("source_download_size_mismatch");
    const store=createPrivateBlobStore();
    const receipt=await storeVerifiedOriginal(job.path,source,{
      size:source.length,updatedAt:String(oldInfo.updatedAt),etag:expectedEtag
    },store);
    const check=await readVerifiedOriginal(job.path,store);
    if(!check||check.receipt.sha256!==sha256(source))throw Error("archive_verification_failed");
    if(!job.release) return response(200,{ok:true,status:"copy_verified_source_retained",bytes:source.length,verified:true});
    await ensureEligible(supabase,job);
    const {data:checkInfo,error:checkErr}=await bucket.info(job.path);
    if(checkErr||!checkInfo||checkInfo.size!==job.expectedSize ||
       infoEtag(checkInfo)!==expectedEtag||
       !matchesTime(checkInfo.updatedAt,job.expectedUpdatedAt))throw Error("source_version_conflict_before_release");
    const {error:removeError}=await bucket.remove([job.path]);
    if(removeError)throw Error("supabase_delete_failed");
    const {data:exists,error:existError}=await bucket.exists(job.path);
    if(existError||exists)throw Error("deletion_not_verified");
    const archived=await readVerifiedOriginal(job.path,store);
    if(!archived||archived.receipt.sha256!==receipt.sha256)throw Error("post_delete_archive_integrity_error");
    return response(200,{ok:true,status:"original_preserved_in_private_blob_source_removed",reclaimedBytes:source.length});
  }catch(e){
    console.error("[photo-storage] Archive step failed",e instanceof Error?e.message:"unknown_error");
    return response(409,{ok:false,error:e instanceof Error?e.message:"archive_step_failed"});
  }
}
