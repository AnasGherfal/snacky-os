import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { privateStorageObjectUrl, REFILL_PHOTO_BUCKET } from "@/lib/storage-buckets";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || clean(row?.message).includes("route_stop_safety_checks");
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Could not load compressor proofs.";
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: routeId } = await params;
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  if (!canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes")) {
    return NextResponse.json({ success: false, error: "Not authorized." }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ success: false, error: "Database is not configured." }, { status: 500 });

  const result = await admin
    .from("route_stop_safety_checks")
    .select("id, route_stop_id, machine_id, compressor_confirmed, proof_photo_url, proof_photo_path, confirmed_at, created_at, operator:team_members(full_name)")
    .eq("route_id", routeId)
    .order("confirmed_at", { ascending: false });

  if (result.error) {
    if (isMissingTable(result.error)) return NextResponse.json({ success: true, installed: false, proofs: [] });
    return NextResponse.json({ success: false, error: errorText(result.error) }, { status: 500 });
  }

  const proofs = (result.data ?? []).map((row: any) => {
    const savedUrl = clean(row.proof_photo_url);
    const savedPath = clean(row.proof_photo_path);
    const url = savedUrl && (savedUrl.startsWith("/") || savedUrl.startsWith("http://") || savedUrl.startsWith("https://"))
      ? savedUrl
      : privateStorageObjectUrl(REFILL_PHOTO_BUCKET, savedPath || savedUrl);
    const operator = firstRelation(row.operator) as { full_name?: string } | null;
    return {
      id: clean(row.id),
      routeStopId: clean(row.route_stop_id),
      machineId: clean(row.machine_id),
      confirmed: Boolean(row.compressor_confirmed),
      url,
      storagePath: savedPath || null,
      uploadedAt: row.confirmed_at ?? row.created_at ?? null,
      uploadedBy: operator?.full_name ?? null,
    };
  });

  return NextResponse.json({ success: true, installed: true, proofs });
}
