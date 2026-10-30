import { NextResponse } from "next/server";
import { archivedPhotoResponse } from "@/lib/photo-archive-server";
import { compactCompressorIndicator } from "@/lib/compressor-proof-preview";
import { readVerifiedOriginal } from "@/lib/private-blob-originals";
import { isMissingStorageObject } from "@/lib/photo-archive-core";

import { getCurrentProfile } from "@/lib/auth";
import { AppRole, canAccessOperatorRoute, canViewVmsImports, hasAnyRole, isOperatorRole, isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  CASH_EVIDENCE_BUCKET,
  ISSUE_PHOTO_BUCKET,
  MACHINE_PHOTO_BUCKET,
  PRIVATE_STORAGE_BUCKETS,
  RECEIPT_IMAGE_BUCKET,
  REFILL_PHOTO_BUCKET,
  VMS_IMPORT_BUCKET,
} from "@/lib/storage-buckets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const receiptReaderRoles = new Set<AppRole>(["owner", "admin", "supervisor", "warehouse", "purchasing", "finance"]);
const cashEvidenceManagerRoles = new Set<AppRole>(["owner", "admin", "supervisor", "finance"]);
const routePhotoPathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function canReadRoutePhoto(bucket: string, objectPath: string) {
  if (bucket !== REFILL_PHOTO_BUCKET && bucket !== ISSUE_PHOTO_BUCKET) return false;

  const routeId = objectPath.split("/")[0];
  if (!routePhotoPathPattern.test(routeId)) return false;

  const profile = await getCurrentProfile();
  if (!profile) return false;
  if (isOwnerAdminRole(profile) || isSupervisorRole(profile)) return true;
  if (!isOperatorRole(profile)) return false;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return false;
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);

  const { data: route } = await supabase
    .from("routes")
    .select("operator_id")
    .eq("id", routeId)
    .maybeSingle();

  return canAccessOperatorRoute(routeAccessProfile, route?.operator_id);
}

async function canReadPrivateObject(bucket: string, objectPath: string) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active") return false;

  if (bucket === RECEIPT_IMAGE_BUCKET) return hasAnyRole(profile, receiptReaderRoles);
  if (bucket === MACHINE_PHOTO_BUCKET) return true;
  if (bucket === REFILL_PHOTO_BUCKET || bucket === ISSUE_PHOTO_BUCKET) return canReadRoutePhoto(bucket, objectPath);
  if (bucket === VMS_IMPORT_BUCKET) return canViewVmsImports(profile);
  if (bucket === CASH_EVIDENCE_BUCKET) {
    if (hasAnyRole(profile, cashEvidenceManagerRoles)) return true;
    const supabase = getSupabaseAdminClient();
    if (!supabase) return false;

    // Operators can reopen only the sealed-bag photo they submitted. This
    // proves their own handoff without exposing count sheets or cash amounts.
    if (isOperatorRole(profile) && profile.team_member_id) {
      const { data: ownRemovalReceipt } = await supabase
        .from("cash_removal_receipts")
        .select("cash_collection_id")
        .eq("operator_id", profile.team_member_id)
        .eq("removal_evidence_path", objectPath)
        .maybeSingle();
      if (ownRemovalReceipt) return true;
    }

    if (!hasAnyRole(profile, ["warehouse"])) return false;

    // Warehouse can verify removal/storage handoff photos, but cannot open
    // count sheets or bank receipts that may disclose financial amounts.
    const [{ data: removalReceipt }, { data: storageEvent }] = await Promise.all([
      supabase
        .from("cash_removal_receipts")
        .select("cash_collection_id")
        .eq("removal_evidence_path", objectPath)
        .maybeSingle(),
      supabase
        .from("cash_collection_events")
        .select("id")
        .eq("event_type", "stored")
        .eq("evidence_storage_path", objectPath)
        .maybeSingle(),
    ]);
    return Boolean(removalReceipt || storageEvent);
  }
  return false;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const { bucket, path } = await params;
  const objectPath = path.join("/");
  const isCompressor = bucket === REFILL_PHOTO_BUCKET && /^[0-9a-f-]{36}\/compressor\//i.test(objectPath);
  const url = new URL(request.url);
  const archiveCheck = url.searchParams.get("archive") === "verify";
  const compactPreview = url.searchParams.get("preview") === "compact";

  if (!PRIVATE_STORAGE_BUCKETS.has(bucket) || !objectPath) {
    return NextResponse.json({ error: "Storage object not found" }, { status: 404 });
  }

  if (!(await canReadPrivateObject(bucket, objectPath))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Private storage is not configured" }, { status: 503 });
  }

  // All calls pass the existing route-based photo authorization first.
  // A compact response is a *display derivative* of verified original bytes.
  // The full original remains unchanged in a private archive for audit review.
  async function displayCompressor(raw: Uint8Array) {
    const bytes = await compactCompressorIndicator(raw);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "Vary": "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Snacky-Photo-Preview": "low-resolution-webp",
      },
    });
  }

  // Owner/assigned-operator can compare the compact preview with the
  // original while it is still in Supabase. This never uploads or deletes.
  if (isCompressor && compactPreview) {
    try {
      const { data, error } = await supabase.storage.from(bucket).download(objectPath);
      if (error || !data || data.size > 7 * 1024 * 1024) {
        return NextResponse.json({error:"Original compressor photo unavailable for preview"}, {status:404});
      }
      return await displayCompressor(new Uint8Array(await data.arrayBuffer()));
    } catch {
      return NextResponse.json({error:"Compressor preview unavailable"}, {status:422});
    }
  }

  // A read-only rehearsal exercises the real access checks BEFORE any original is removed.
  // Only the private proxy can read archived images; never expose Blob URLs or credentials.
  async function blobArchive() {
    if (bucket !== REFILL_PHOTO_BUCKET || !process.env.BLOB_READ_WRITE_TOKEN) return null;
    const original = await readVerifiedOriginal(objectPath);
    if (!original) return null;
    if (isCompressor && !archiveCheck) return displayCompressor(new Uint8Array(original.bytes));
    return new Response(new Uint8Array(original.bytes), {
      headers: {
        "Content-Type": original.receipt.mime,
        "Content-Length": String(original.bytes.byteLength),
        "Cache-Control": "private, no-store",
        "Vary": "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Snacky-Photo-Source": "verified-private-blob",
      },
    });
  }
  // It cannot bypass authentication and has no write/delete behavior.
  if (archiveCheck && bucket === REFILL_PHOTO_BUCKET) {
    try {
      const archived = await blobArchive() ?? await archivedPhotoResponse(bucket, objectPath);
      return archived ?? NextResponse.json({ error: "Verified archive copy not found" }, { status: 404 });
    } catch {
      return NextResponse.json({ error: "Archive could not be verified" }, { status: 503 });
    }
  }

  // Supabase may sign a URL for a file that is already gone. Explicitly check
  // existence and serve verified immutable archive bytes for removed originals.
  if (bucket === REFILL_PHOTO_BUCKET) {
    const existence = await supabase.storage.from(bucket).exists(objectPath);
    if (existence.error) return NextResponse.json({ error: "Storage temporarily unavailable" }, { status: 503 });
    if (existence.data === false) {
      try {
        const archived = await blobArchive() ?? await archivedPhotoResponse(bucket, objectPath);
        return archived ?? NextResponse.json({ error: "Storage object not found" }, { status: 404 });
      } catch {
        return NextResponse.json({ error: "Archived photo failed verification" }, { status: 503 });
      }
    }
  }

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, 60);
  if (error && bucket === REFILL_PHOTO_BUCKET && isMissingStorageObject(error)) {
    try {
      const archived = await archivedPhotoResponse(bucket, objectPath);
      if (archived) return archived;
    } catch {
      // Missing/corrupt archive evidence must not be mislabeled as a successful read.
      return NextResponse.json({ error: "Archive is temporarily unavailable" }, { status: 503 });
    }
  }
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "Storage object not found" }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl);
}
