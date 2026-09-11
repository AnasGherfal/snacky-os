import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, isOwnerAdminRole } from "@/lib/authz";
import {
  buildMachineQuantityRows,
  buildMachineQuantitySourcesFromPlan,
  machineQuantityEvidenceReady,
  machineQuantityConfirmationKey,
  type MachineQuantityEvidenceFile,
  type MachineQuantityFilledItem,
  type MachineQuantityPlanRow,
} from "@/lib/machine-quantity-confirmation";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  const message = String(row?.message ?? "").toLowerCase();
  return row?.code === "PGRST205" || (message.includes("route_stop_quantity_confirmations") && message.includes("does not exist"));
}

function isMissingSlotAllocations(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "42703" || row?.code === "PGRST204" || String(row?.message ?? "").includes("slot_allocations");
}

function isMissingEvidenceSchema(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  const message = String(row?.message ?? "");
  return (row?.code === "42703" || row?.code === "PGRST204")
    && ["verification_status", "evidence_files", "offline_reason", "submitted_at"].some((column) => message.includes(column));
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown database error";
}

async function loadContext(routeId: string, stopId: string) {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const client = getSupabaseServerClient(accessToken);
  const admin = getSupabaseAdminClient();
  if (!accessToken || !profile) return { error: NextResponse.json({ success: false, code: "SESSION_EXPIRED", error: "Session expired. Please sign in again." }, { status: 401 }) };
  if (!client || !admin) return { error: NextResponse.json({ success: false, code: "NO_SUPABASE", error: "The protected database workflow is not available." }, { status: 500 }) };

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    client.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    client.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) return { error: NextResponse.json({ success: false, code: "CONTEXT_LOAD_FAILED", error: errorMessage(routeError ?? stopError) }, { status: 500 }) };
  if (!route || !stop || stop.route_id !== routeId) return { error: NextResponse.json({ success: false, code: "STOP_NOT_FOUND", error: "Route stop was not found." }, { status: 404 }) };

  const routeAccessProfile = await buildOperatorRouteAccessContext(client, profile);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return { error: NextResponse.json({ success: false, code: "UNAUTHORIZED", error: "This route is not assigned to you." }, { status: 403 }) };
  }
  return { profile, client, admin, route, stop };
}

async function loadPlanRows(client: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, stopId: string) {
  const result = await client
    .from("route_stop_items")
    .select("product_id, machine_slot_id, slot_code, planned_quantity, slot_allocations, product:products(name)")
    .eq("route_stop_id", stopId);
  if (result.error && isMissingSlotAllocations(result.error)) {
    const fallback = await client
      .from("route_stop_items")
      .select("product_id, machine_slot_id, slot_code, planned_quantity, product:products(name)")
      .eq("route_stop_id", stopId);
    if (fallback.error) throw fallback.error;
    return (fallback.data ?? []) as MachineQuantityPlanRow[];
  }
  if (result.error) throw result.error;
  return (result.data ?? []) as MachineQuantityPlanRow[];
}

const CONFIRMATION_SELECT = "id, confirmation_key, quantity_rows, verification_status, evidence_files, offline_reason, submitted_at, confirmed_at, resolved_at";

function normalizeEvidenceFiles(value: unknown, routeId: string, stopId: string, now: string): MachineQuantityEvidenceFile[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const files: MachineQuantityEvidenceFile[] = [];
  for (const rawFile of value) {
    const file = rawFile && typeof rawFile === "object" ? rawFile as Record<string, unknown> : {};
    const photoPath = clean(file.photoPath);
    const photoUrl = clean(file.photoUrl);
    if (!photoPath.startsWith(`${routeId}/${stopId}-`) || photoPath.includes("..") || photoPath.startsWith("storage-unavailable/")) return null;
    if (photoUrl && !photoUrl.startsWith("/api/storage/refill-photos/")) return null;
    files.push({
      photoUrl: photoUrl || null,
      photoPath,
      originalName: clean(file.originalName).slice(0, 200) || null,
      uploadedAt: now,
    });
  }
  return files;
}

function validateFilledItems(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) return "Refill quantities are missing or invalid.";
  for (const [index, item] of value.entries()) {
    const row = item as MachineQuantityFilledItem;
    if (!isUuid(row?.productId)) return `Filled row ${index + 1} has an invalid product.`;
    const quantity = Number(row?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) return `Filled row ${index + 1} must have a whole quantity of zero or more.`;
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  const { data, error } = await context.admin
    .from("route_stop_quantity_confirmations")
    .select(CONFIRMATION_SELECT)
    .eq("route_stop_id", stopId)
    .maybeSingle();
  if (error && isMissingTable(error)) return NextResponse.json({ success: true, installed: false, confirmed: false, confirmation: null });
  if (error && isMissingEvidenceSchema(error)) return NextResponse.json({ success: true, installed: false, confirmed: false, confirmation: null });
  if (error) return NextResponse.json({ success: false, installed: true, code: "QUANTITY_CONFIRMATION_LOAD_FAILED", error: errorMessage(error) }, { status: 500 });
  return NextResponse.json({ success: true, installed: true, confirmed: Boolean(data?.confirmation_key && machineQuantityEvidenceReady(data?.verification_status)), confirmation: data ?? null });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, code: "INVALID_ROUTE_SCOPE", error: "Invalid route or stop id." }, { status: 400 });
  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, code: "INVALID_JSON", error: "Invalid machine quantity confirmation payload." }, { status: 400 });
  }

  try {
    const mode = clean(payload.mode);
    const now = new Date().toISOString();

    if (mode === "owner_resolved") {
      if (!isOwnerAdminRole(context.profile)) {
        return NextResponse.json({ success: false, code: "OWNER_REQUIRED", error: "Only an owner or admin can close a power-off machine update." }, { status: 403 });
      }
      const evidenceFiles = normalizeEvidenceFiles(payload.evidenceFiles, routeId, stopId, now);
      if (!evidenceFiles) return NextResponse.json({ success: false, code: "XY_SCREENSHOT_REQUIRED", error: "Upload one to four current XY inventory screenshots." }, { status: 400 });

      const { data: existing, error: existingError } = await context.admin
        .from("route_stop_quantity_confirmations")
        .select("id, verification_status")
        .eq("route_stop_id", stopId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing || existing.verification_status !== "offline_pending") {
        return NextResponse.json({ success: false, code: "OFFLINE_UPDATE_NOT_PENDING", error: "This machine does not have a pending power-off quantity update." }, { status: 409 });
      }

      const { data, error } = await context.admin
        .from("route_stop_quantity_confirmations")
        .update({
          verification_status: "owner_completed",
          evidence_files: evidenceFiles,
          offline_reason: null,
          resolved_at: now,
          resolved_by_user_id: context.profile.id,
          updated_at: now,
        })
        .eq("id", existing.id)
        .eq("verification_status", "offline_pending")
        .select(CONFIRMATION_SELECT)
        .single();
      if (error) throw error;
      revalidatePath("/dashboard");
      revalidatePath("/routes/quantity-updates");
      revalidatePath(`/routes/${routeId}`);
      return NextResponse.json({ success: true, installed: true, confirmed: true, confirmation: data });
    }

    if (mode !== "xy_screenshot" && mode !== "machine_offline") {
      return NextResponse.json({ success: false, code: "INVALID_MODE", error: "Choose XY screenshots or machine power off." }, { status: 400 });
    }
    const filledItemsError = validateFilledItems(payload.filledItems);
    if (filledItemsError) return NextResponse.json({ success: false, code: "INVALID_FILLED_ITEMS", error: filledItemsError }, { status: 400 });

    const evidenceFiles = mode === "xy_screenshot" ? normalizeEvidenceFiles(payload.evidenceFiles, routeId, stopId, now) : [];
    if (mode === "xy_screenshot" && !evidenceFiles) {
      return NextResponse.json({ success: false, code: "XY_SCREENSHOT_REQUIRED", error: "Upload one to four current XY inventory screenshots." }, { status: 400 });
    }
    const offlineNote = clean(payload.offlineNote).slice(0, 500);
    const offlineReason = mode === "machine_offline" ? offlineNote || "Machine has no electricity." : null;
    const planRows = await loadPlanRows(context.admin, stopId);
    const sources = buildMachineQuantitySourcesFromPlan(planRows, payload.filledItems as MachineQuantityFilledItem[]);
    const rows = buildMachineQuantityRows(sources);
    const confirmationKey = machineQuantityConfirmationKey(rows);
    const record = {
      route_id: routeId,
      route_stop_id: stopId,
      machine_id: context.stop.machine_id,
      operator_id: context.route.operator_id ?? context.profile.team_member_id ?? null,
      quantity_rows: rows,
      confirmation_key: confirmationKey,
      verification_status: mode === "xy_screenshot" ? "xy_screenshot_saved" : "offline_pending",
      evidence_files: evidenceFiles,
      offline_reason: offlineReason,
      submitted_at: now,
      confirmed_at: now,
      created_by_user_id: context.profile.id,
      resolved_at: null,
      resolved_by_user_id: null,
      updated_at: now,
    };
    const { data, error } = await context.admin
      .from("route_stop_quantity_confirmations")
      .upsert(record, { onConflict: "route_stop_id" })
      .select(CONFIRMATION_SELECT)
      .single();
    if (error && isMissingTable(error)) return NextResponse.json({ success: false, installed: false, code: "QUANTITY_CONFIRMATION_SETUP_REQUIRED", error: "Apply the machine quantity confirmation migration before enforcing this check." }, { status: 503 });
    if (error && isMissingEvidenceSchema(error)) return NextResponse.json({ success: false, installed: false, code: "QUANTITY_CONFIRMATION_SETUP_REQUIRED", error: "Apply the machine quantity evidence migration before enforcing this check." }, { status: 503 });
    if (error) throw error;

    revalidatePath("/dashboard");
    revalidatePath("/routes/quantity-updates");
    revalidatePath(`/operator/routes/${routeId}`);
    revalidatePath(`/operator/routes/${routeId}/stops/${stopId}`);
    revalidatePath(`/routes/${routeId}`);
    return NextResponse.json({ success: true, installed: true, confirmed: machineQuantityEvidenceReady(data?.verification_status), confirmation: data });
  } catch (error) {
    return NextResponse.json({ success: false, installed: true, code: "QUANTITY_CONFIRMATION_SAVE_FAILED", error: errorMessage(error) }, { status: 500 });
  }
}
