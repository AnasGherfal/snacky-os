import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, isOwnerAdminRole, isOperatorRole, isSupervisorRole } from "@/lib/authz";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import {
  ISSUE_PHOTO_BUCKET,
  MACHINE_PHOTO_BUCKET,
  PRIVATE_STORAGE_BUCKETS,
  RECEIPT_IMAGE_BUCKET,
  REFILL_PHOTO_BUCKET,
} from "@/lib/storage-buckets";

const receiptReaderRoles = new Set(["owner", "admin", "supervisor", "warehouse", "finance"]);
const routePhotoPathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function canReadRoutePhoto(bucket: string, objectPath: string) {
  if (bucket !== REFILL_PHOTO_BUCKET && bucket !== ISSUE_PHOTO_BUCKET) return false;

  const routeId = objectPath.split("/")[0];
  if (!routePhotoPathPattern.test(routeId)) return false;

  const profile = await getCurrentProfile();
  if (!profile) return false;
  if (isOwnerAdminRole(profile.role) || isSupervisorRole(profile.role)) return true;
  if (!isOperatorRole(profile.role)) return false;

  const supabase = getSupabaseServerClient();
  if (!supabase) return false;

  const { data: route } = await supabase
    .from("routes")
    .select("operator_id")
    .eq("id", routeId)
    .maybeSingle();

  return canAccessOperatorRoute(
    {
      id: profile.id,
      role: profile.role,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    },
    route?.operator_id,
  );
}

async function canReadPrivateObject(bucket: string, objectPath: string) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active") return false;

  if (bucket === RECEIPT_IMAGE_BUCKET) return receiptReaderRoles.has(profile.role);
  if (bucket === MACHINE_PHOTO_BUCKET) return true;
  if (bucket === REFILL_PHOTO_BUCKET || bucket === ISSUE_PHOTO_BUCKET) return canReadRoutePhoto(bucket, objectPath);
  return false;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const { bucket, path } = await params;
  const objectPath = path.join("/");

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

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, 60);
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "Storage object not found" }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl);
}
