import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { validatePath } from "@/lib/private-blob-originals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bucketName = "refill-photos";
const minAgeMs = 30 * 24 * 60 * 60 * 1000;
const batchLimit = 10;
type Kind = "machine" | "compressor";
type Candidate = { path: string; kind: Kind };
type Result = { kind: Kind; status: string; bytes?: number };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: {
    "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff",
  } });
}
function owner(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return !!profile && profile.active_status === "active" &&
    (profile.role === "owner" || profile.roles?.includes("owner"));
}
function originValid(request: Request) {
  try {
    return request.headers.get("origin") === new URL(request.url).origin &&
      request.headers.get("sec-fetch-site") !== "cross-site";
  } catch { return false; }
}
function photoPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  try { validatePath(path); } catch { return false; }
  return /^[0-9a-f]{8}-[0-9a-f-]{27}\/[a-zA-Z0-9._/-]+\.(?:jpg|jpeg|png|webp)$/i.test(path);
}
async function fetchPaths(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  table: "machine_refill_history" | "route_stop_safety_checks",
  column: "machine_photo_path" | "proof_photo_path",
) {
  const results: string[] = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const { data, error } = await supabase.from(table)
      .select(column).not(column, "is", null).order(column, {ascending:true}).range(offset,offset+999);
    if (error) throw Error("photo_reference_list_unavailable");
    const rows = (data ?? []) as unknown as Record<string,unknown>[];
    for (const row of rows) if (photoPath(row[column])) results.push(row[column]);
    if (rows.length < 1000) return results;
  }
  throw Error("photo_reference_limit_exceeded");
}
async function candidates(supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>) {
  const [machine, safety] = await Promise.all([
    fetchPaths(supabase,"machine_refill_history","machine_photo_path"),
    fetchPaths(supabase,"route_stop_safety_checks","proof_photo_path"),
  ]);
  const list = new Map<string,Kind>();
  machine.forEach(path=>list.set(path,"machine"));
  // Safety proof takes precedence if a path has multiple kinds of references.
  safety.forEach(path=>list.set(path,"compressor"));
  return Array.from(list.entries())
    .map(([path,kind])=>({path,kind})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
// Supabase Storage .info() returns camel-cased createdAt / lastModified and
// a LOWERCASE etag. Some server versions additionally return updatedAt/eTag.
// Do not silently classify every real Storage file as too new when updatedAt
// is absent. If both modification timestamps exist, the newer one controls.
function fileEtag(info: any) {
  return String(info?.etag ?? info?.eTag ?? info?.metadata?.etag ??
    info?.metadata?.eTag ?? "").replaceAll('"', "").trim();
}
function fileModificationTime(info: any) {
  const observed=[info?.lastModified,info?.updatedAt]
    .filter(value=>value!==null&&value!==undefined&&value!=="")
    .map(value=>Date.parse(String(value)));
  if(!observed.length||observed.some(value=>!Number.isFinite(value)))return NaN;
  return Math.max(...observed);
}
function version(info: any) {
  return [Number(info?.size),fileEtag(info),Date.parse(String(info?.createdAt??"")),
    fileModificationTime(info),String(info?.version??""),String(info?.id??"")].join(":");
}
function oldPhoto(info: any) {
  const created=Date.parse(String(info?.createdAt??""));
  const modified=fileModificationTime(info);
  return Number.isFinite(created)&&Number.isFinite(modified)&&
    created<Date.now()-minAgeMs && modified<Date.now()-minAgeMs;
}
async function checkPhoto(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  entry: Candidate,
  protectedPaths: Set<string>,
) {
  if (protectedPaths.has(entry.path)) return {ok:false,status:"quantity_evidence_protected"};
  const proxy=`/api/storage/${bucketName}/${entry.path}`;
  const [h,s,qPath,qUrl,file]=await Promise.all([
    supabase.from("machine_refill_history").select("id").eq("machine_photo_path",entry.path).limit(1),
    supabase.from("route_stop_safety_checks").select("id,compressor_confirmed").eq("proof_photo_path",entry.path).limit(1),
    supabase.from("route_stop_quantity_confirmations").select("id").contains("evidence_files",JSON.stringify([{photoPath:entry.path}])).limit(1),
    supabase.from("route_stop_quantity_confirmations").select("id").contains("evidence_files",JSON.stringify([{photoUrl:proxy}])).limit(1),
    supabase.storage.from(bucketName).info(entry.path),
  ]);
  if(h.error||s.error||qPath.error||qUrl.error) throw Error("reference_check_failed");
  if(qPath.data?.length||qUrl.data?.length) return {ok:false,status:"quantity_evidence_protected"};
  if(entry.kind==="compressor" && (!s.data?.length||s.data[0].compressor_confirmed!==true))
    return {ok:false,status:"not_compressor_proof"};
  if(entry.kind==="machine" && (!h.data?.length||s.data?.length))
    return {ok:false,status:"not_exclusive_machine_photo"};
  if(file.error||!file.data) return {ok:false,status:"already_missing"};
  if(!oldPhoto(file.data)) return {ok:false,status:"photo_not_old_enough"};
  const size=Number(file.data.size);
  if(!Number.isSafeInteger(size)||size<1||size>10*1024*1024)
    return {ok:false,status:"invalid_file_metadata"};
  // Require a concrete source version before any irreversible Storage deletion.
  if(fileEtag(file.data).length<8)
    return {ok:false,status:"unverifiable_source_version"};
  return {ok:true,status:"eligible",info:{...file.data,size}};
}
async function quantityPaths(supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, list: Candidate[]) {
  const found = new Set<string>();
  for(let offset=0;offset<20000;offset+=1000){
    const {data,error}=await supabase.from("route_stop_quantity_confirmations")
      .select("evidence_files").range(offset,offset+999);
    if(error)throw Error("quantity_evidence_list_unavailable");
    const rows=(data??[]) as {evidence_files?:unknown}[];
    const text=JSON.stringify(rows);
    for(const {path} of list) if(text.includes(path)) found.add(path);
    if(rows.length<1000)return found;
  }
  throw Error("quantity_evidence_limit_exceeded");
}
export async function POST(request: Request) {
  if (!originValid(request)) {
    console.warn("[photo-cleanup] request_rejected",{reason:"invalid_origin"});
    return json(403,{ok:false,error:"cross_origin_request_blocked"});
  }
  const profile = await getCurrentProfile();
  if (!owner(profile)) {
    console.warn("[photo-cleanup] request_rejected",{reason:"owner_only"});
    return json(403,{ok:false,error:"owner_only"});
  }
  let body: {action?:unknown;cursor?:unknown;acknowledgement?:unknown};
  try {
    if(Number(request.headers.get("content-length")??0)>1000)throw Error();
    body=await request.json();
    if(!body || (body.action!=="inspect"&&body.action!=="delete") ||
       (body.cursor!==null&&body.cursor!==undefined&&
        (typeof body.cursor!=="string"||!photoPath(body.cursor))) ||
       (body.action==="delete"&&body.acknowledgement!=="DELETE OLD PHOTOS"))throw Error();
  }catch{return json(400,{ok:false,error:"invalid_or_unconfirmed_request"});}
  const supabase=getSupabaseAdminClient();
  if(!supabase)return json(503,{ok:false,error:"storage_unavailable"});
  try{
    const list=await candidates(supabase);
    const cursor=typeof body.cursor==="string"?body.cursor:null;
    const start=cursor===null?0:list.findIndex(item=>item.path>cursor);
    const offset=start<0?list.length:start;
    const page=list.slice(offset,offset+batchLimit);
    const protectedPaths=await quantityPaths(supabase,page);
    const results: Result[]=[];
    let eligible=0,deleted=0,reclaimedBytes=0;
    for(const entry of page){
      try {
        const first=await checkPhoto(supabase,entry,protectedPaths);
        if(!first.ok||!first.info){
          results.push({kind:entry.kind,status:first.status});
          continue;
        }
        eligible++;
        if(body.action==="inspect"){
          results.push({kind:entry.kind,status:"eligible",bytes:first.info.size});
          continue;
        }
        const again=await checkPhoto(supabase,entry,protectedPaths);
        if(!again.ok||!again.info||version(again.info)!==version(first.info)){
          results.push({kind:entry.kind,status:"source_changed_or_protected"});
          continue;
        }
        const bucket=supabase.storage.from(bucketName);
        const removal=await bucket.remove([entry.path]);
        if(removal.error)throw Error("storage_delete_failed");
        const exists=await bucket.exists(entry.path);
        if(exists.error||exists.data!==false)throw Error("storage_delete_not_verified");
        deleted++;
        reclaimedBytes+=first.info.size;
        results.push({kind:entry.kind,status:"deleted",bytes:first.info.size});
      }catch(error){
        console.warn("[photo-cleanup] candidate_failed",{
          action:body.action,reason:error instanceof Error?error.message:"unknown_error",
        });
        results.push({kind:entry.kind,status:"failed_closed_no_confirmation"});
      }
    }
    const nextCursor=offset+page.length<list.length && page.length?page.at(-1)!.path:null;
    const statusCounts: Record<string,number> = {};
    for(const result of results) statusCounts[result.status]=(statusCounts[result.status]??0)+1;
    // No paths, credentials or personal data in operational diagnostics.
    console.info("[photo-cleanup] batch_completed",{
      action:body.action,processed:page.length,eligible,deleted,reclaimedBytes,statusCounts,
    });
    return json(200,{ok:true,action:body.action,candidates:list.length,
      processed:page.length,eligible,deleted,reclaimedBytes,statusCounts,
      nextCursor,done:nextCursor===null,results});
  }catch(e){
    console.error("[photo-cleanup] Scan failed",e instanceof Error?e.message:"unknown");
    return json(503,{ok:false,error:"cleanup_scan_unavailable"});
  }
}
