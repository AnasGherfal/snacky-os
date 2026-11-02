import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { validatePath } from "@/lib/private-blob-originals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// This is a branch-scoped ONE-TIME maintenance endpoint, NOT a public API,
// background scheduler, or change to Snacky's ordinary photo policies.
// The owner explicitly requested permanent Storage deletion of machine
// overviews and compressor/safety proof photos older than 30 full days.
const BRANCH = "maintenance/purge-old-machine-compressor-20261102";
const BUCKET = "refill-photos";
const AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 12;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type Kind = "machine" | "compressor";
type Job = {
  kind: Kind;
  path: string;
  expectedSize: number;
  expectedUpdatedAt: string;
  expectedEtag: string;
};
type Result = { kind: Kind; path: string; status: string; bytes?: number };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, {status, headers: {"Cache-Control": "no-store"}});
}
function tokenOkay(header: string) {
  const secret = process.env.SNACKY_OLD_PHOTO_PURGE_TOKEN ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.VERCEL_GIT_COMMIT_REF !== BRANCH ||
      process.env.SNACKY_OLD_PHOTO_PURGE_ENABLED !== "true" ||
      secret.length < 48 || bearer.length !== secret.length) return false;
  return timingSafeEqual(
    createHash("sha256").update(bearer).digest(),
    createHash("sha256").update(secret).digest(),
  );
}
function exactSourceVersion(info: any, job: Job) {
  const size = Number(info?.size);
  const etag = String(info?.eTag ?? info?.metadata?.eTag ?? "").replaceAll('"', "").trim();
  const updated = Date.parse(String(info?.updatedAt ?? ""));
  return size === job.expectedSize &&
    etag.toLowerCase() === job.expectedEtag.toLowerCase() &&
    Number.isFinite(updated) &&
    updated === Date.parse(job.expectedUpdatedAt);
}
function oldEnough(info: any) {
  const created = Date.parse(String(info?.createdAt ?? ""));
  const updated = Date.parse(String(info?.updatedAt ?? ""));
  const cutoff = Date.now() - AGE_MS;
  return Number.isFinite(created) && Number.isFinite(updated) &&
    created < cutoff && updated < cutoff;
}
function validJob(v: any): v is Job {
  if (!v || typeof v !== "object" || (v.kind !== "machine" && v.kind !== "compressor") ||
      !Number.isSafeInteger(v.expectedSize) || v.expectedSize < 1 || v.expectedSize > MAX_FILE_BYTES ||
      typeof v.expectedUpdatedAt !== "string" ||
      !Number.isFinite(Date.parse(v.expectedUpdatedAt)) ||
      !/^[a-f0-9]{32,64}$/i.test(String(v.expectedEtag ?? ""))) return false;
  try {
    validatePath(v.path);
  } catch { return false; }
  return /\.(?:jpg|jpeg|png|webp)$/i.test(v.path) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i.test(v.path);
}

async function check(supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, job: Job) {
  const proxy = `/api/storage/${BUCKET}/${job.path}`;
  const bucket = supabase.storage.from(BUCKET);
  const [machine, safety, quantityPath, quantityUrl, info] = await Promise.all([
    supabase.from("machine_refill_history").select("id,machine_photo_path").eq("machine_photo_path", job.path).limit(2),
    supabase.from("route_stop_safety_checks").select("id,proof_photo_path").eq("proof_photo_path", job.path).limit(2),
    supabase.from("route_stop_quantity_confirmations").select("id").contains("evidence_files", JSON.stringify([{photoPath:job.path}])).limit(1),
    supabase.from("route_stop_quantity_confirmations").select("id").contains("evidence_files", JSON.stringify([{photoUrl:proxy}])).limit(1),
    bucket.info(job.path),
  ]);
  if (machine.error || safety.error || quantityPath.error || quantityUrl.error) throw Error("reference_lookup_failed");
  if (info.error || !info.data) return {eligible:false,reason:"source_unavailable"};
  if (quantityPath.data?.length || quantityUrl.data?.length) return {eligible:false,reason:"quantity_evidence_protected"};
  if (job.kind === "machine" && (!(machine.data?.length) || safety.data?.length)) return {eligible:false,reason:"not_exclusive_machine_overview"};
  if (job.kind === "compressor" && !(safety.data?.length)) return {eligible:false,reason:"not_compressor_safety_proof"};
  if (!oldEnough(info.data)) return {eligible:false,reason:"not_older_than_30_days"};
  if (!exactSourceVersion(info.data,job)) return {eligible:false,reason:"source_metadata_changed"};
  return {eligible:true,reason:"eligible"};
}

export async function POST(request: Request) {
  if (!tokenOkay(request.headers.get("authorization") ?? "")) return json(401,{ok:false,error:"not_authorized"});
  let jobs: Job[], action: "inspect" | "delete";
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 15000) throw Error();
    const body = await request.json();
    action = body.action;
    jobs = body.jobs;
    if ((action !== "inspect" && action !== "delete") || !Array.isArray(jobs) ||
        jobs.length < 1 || jobs.length > MAX_JOBS || jobs.some(j => !validJob(j)) ||
        new Set(jobs.map(j => j.path)).size !== jobs.length ||
        (action === "delete" && body.confirmed !== true)) throw Error();
  } catch { return json(400,{ok:false,error:"invalid_or_unconfirmed_batch"}); }
  const supabase = getSupabaseAdminClient();
  if (!supabase) return json(503,{ok:false,error:"storage_not_available"});
  const results: Result[] = [];
  let deleted = 0, reclaimedBytes = 0;
  for (const job of jobs) {
    try {
      const first = await check(supabase,job);
      if (!first.eligible) {
        results.push({kind:job.kind,path:job.path,status:first.reason});
        continue;
      }
      if (action === "inspect") {
        results.push({kind:job.kind,path:job.path,status:"eligible_not_deleted",bytes:job.expectedSize});
        continue;
      }
      // Recheck immediately before removal; do not delete newer or edited files.
      const second = await check(supabase,job);
      if (!second.eligible) {
        results.push({kind:job.kind,path:job.path,status:second.reason});
        continue;
      }
      const bucket = supabase.storage.from(BUCKET);
      const {error} = await bucket.remove([job.path]); // Supabase Storage API, never SQL DELETE
      if (error) throw Error("storage_remove_failed");
      const verified = await bucket.exists(job.path);
      if (verified.error || verified.data !== false) throw Error("deletion_not_verified");
      deleted += 1;
      reclaimedBytes += job.expectedSize;
      results.push({kind:job.kind,path:job.path,status:"deleted_and_verified",bytes:job.expectedSize});
    } catch (e) {
      results.push({kind:job.kind,path:job.path,status:e instanceof Error?e.message:"unknown_error"});
    }
  }
  return json(200,{ok:true,action,deleted,reclaimedBytes,results});
}
