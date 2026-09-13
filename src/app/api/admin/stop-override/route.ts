import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { completeStop, markStopInProgress } from "@/lib/operator-actions";
import {
  buildMachineQuantityRows,
  buildMachineQuantitySourcesFromPlan,
  enrichMachineQuantityPlanRows,
  machineQuantityConfirmationKey,
  type MachineQuantityFilledItem,
  type MachineQuantityPlanRow,
} from "@/lib/machine-quantity-confirmation";
import {
  ROUTE_STOP_IN_PROGRESS_STATUS,
  ROUTE_STOP_PENDING_STATUS,
  ROUTE_STOP_PICKED_STATUS,
  isRouteStopDoneStatus,
} from "@/lib/route-workflow";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown error";
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

async function requireOwnerAdmin() {
  const profile = await getCurrentProfile();
  if (!profile) return { error: NextResponse.json({ success: false, error: "Session expired. Please sign in again." }, { status: 401 }) };
  if (!isOwnerAdminRole(profile)) return { error: NextResponse.json({ success: false, error: "Only an owner or admin can use the stop override." }, { status: 403 }) };
  const admin = getSupabaseAdminClient();
  if (!admin) return { error: NextResponse.json({ success: false, error: "Database is not available." }, { status: 500 }) };
  return { profile, admin };
}

async function loadQuantityPlan(admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, stopId: string, machineId: string) {
  const planResult = await admin
    .from("route_stop_items")
    .select("product_id, machine_slot_id, slot_code, planned_quantity, slot_allocations, product:products(name)")
    .eq("route_stop_id", stopId);

  let planRows: MachineQuantityPlanRow[] = [];
  if (planResult.error && ["42703", "PGRST204"].includes(String(planResult.error.code ?? ""))) {
    const fallback = await admin
      .from("route_stop_items")
      .select("product_id, machine_slot_id, slot_code, planned_quantity, product:products(name)")
      .eq("route_stop_id", stopId);
    if (fallback.error) throw fallback.error;
    planRows = (fallback.data ?? []) as MachineQuantityPlanRow[];
  } else {
    if (planResult.error) throw planResult.error;
    planRows = (planResult.data ?? []) as MachineQuantityPlanRow[];
  }

  const { data: slots, error: slotsError } = await admin
    .from("machine_slots")
    .select("id, product_id, slot_code")
    .eq("machine_id", machineId);
  if (slotsError) throw slotsError;
  return enrichMachineQuantityPlanRows(planRows, slots ?? []);
}

export async function GET() {
  const context = await requireOwnerAdmin();
  if ("error" in context) return context.error;
  const { admin } = context;

  try {
    const { data: stops, error: stopsError } = await admin
      .from("route_stops")
      .select("id, route_id, machine_id, stop_order, status")
      .in("status", [ROUTE_STOP_PENDING_STATUS, ROUTE_STOP_PICKED_STATUS, ROUTE_STOP_IN_PROGRESS_STATUS])
      .order("created_at", { ascending: false })
      .limit(150);
    if (stopsError) throw stopsError;

    const routeIds = Array.from(new Set((stops ?? []).map((row) => clean(row.route_id)).filter(Boolean)));
    const machineIds = Array.from(new Set((stops ?? []).map((row) => clean(row.machine_id)).filter(Boolean)));

    const [routesResult, machinesResult] = await Promise.all([
      routeIds.length
        ? admin.from("routes").select("id, operator_id, status, route_date").in("id", routeIds)
        : Promise.resolve({ data: [], error: null }),
      machineIds.length
        ? admin.from("machines").select("id, name, machine_display_name, machine_code").in("id", machineIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (routesResult.error) throw routesResult.error;
    if (machinesResult.error) throw machinesResult.error;

    const routeById = new Map((routesResult.data ?? []).map((row) => [clean(row.id), row]));
    const machineById = new Map((machinesResult.data ?? []).map((row) => [clean(row.id), row]));

    return NextResponse.json({
      success: true,
      stops: (stops ?? []).map((stop) => {
        const route = routeById.get(clean(stop.route_id));
        const machine = machineById.get(clean(stop.machine_id));
        return {
          stopId: stop.id,
          routeId: stop.route_id,
          machineId: stop.machine_id,
          stopOrder: stop.stop_order,
          stopStatus: stop.status,
          routeStatus: route?.status ?? null,
          routeDate: route?.route_date ?? null,
          operatorId: route?.operator_id ?? null,
          machineName: machine?.machine_display_name || machine?.name || machine?.machine_code || "Machine",
          machineCode: machine?.machine_code ?? null,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const context = await requireOwnerAdmin();
  if ("error" in context) return context.error;
  const { admin, profile } = context;

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid stop override payload." }, { status: 400 });
  }

  const routeId = clean(payload.routeId);
  const stopId = clean(payload.stopId);
  if (!isUuid(routeId) || !isUuid(stopId)) return NextResponse.json({ success: false, error: "Invalid route or stop." }, { status: 400 });

  const rawFilledItems = Array.isArray(payload.filledItems) ? payload.filledItems : [];
  if (rawFilledItems.length > 500) return NextResponse.json({ success: false, error: "Too many product rows." }, { status: 400 });
  const filledItems = rawFilledItems.map((value, index) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const productId = clean(row.productId);
    const quantity = Number(row.quantity ?? 0);
    const assignedQty = Number(row.assignedQty ?? quantity);
    if (!isUuid(productId)) throw new Error(`Product row ${index + 1} is invalid.`);
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error(`Product row ${index + 1} quantity must be zero or more.`);
    return {
      refillOrderLineId: isUuid(row.refillOrderLineId) ? clean(row.refillOrderLineId) : null,
      productId,
      quantity,
      assignedQty: Number.isFinite(assignedQty) ? Math.max(0, Math.floor(assignedQty)) : quantity,
      reason: clean(row.reason) || undefined,
      notes: clean(row.notes) || undefined,
    };
  });

  try {
    const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
      admin.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
      admin.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
    ]);
    if (routeError || stopError) throw routeError ?? stopError;
    if (!route || !stop || clean(stop.route_id) !== routeId) return NextResponse.json({ success: false, error: "Route stop was not found." }, { status: 404 });
    if (isRouteStopDoneStatus(stop.status)) return NextResponse.json({ success: false, error: "This stop is already finished." }, { status: 409 });

    if (stop.status !== ROUTE_STOP_IN_PROGRESS_STATUS) {
      const started = await markStopInProgress(routeId, stopId);
      if (!started.success) return NextResponse.json({ success: false, error: started.error || "Could not start this stop for the override." }, { status: 409 });
    }

    const now = new Date().toISOString();
    const planRows = await loadQuantityPlan(admin, stopId, stop.machine_id);
    const quantitySources = buildMachineQuantitySourcesFromPlan(planRows, filledItems as MachineQuantityFilledItem[]);
    const quantityRows = buildMachineQuantityRows(quantitySources);
    const confirmationKey = machineQuantityConfirmationKey(quantityRows);

    const quantityRecord = {
      route_id: routeId,
      route_stop_id: stopId,
      machine_id: stop.machine_id,
      operator_id: route.operator_id ?? profile.team_member_id ?? null,
      quantity_rows: quantityRows,
      confirmation_key: confirmationKey,
      verification_status: "owner_completed",
      evidence_files: [],
      offline_reason: "Admin/owner stop override — no XY screenshot required.",
      submitted_at: now,
      confirmed_at: now,
      created_by_user_id: profile.id,
      resolved_at: now,
      resolved_by_user_id: profile.id,
      updated_at: now,
    };
    const quantitySave = await admin
      .from("route_stop_quantity_confirmations")
      .upsert(quantityRecord, { onConflict: "route_stop_id" });
    if (quantitySave.error && !["PGRST205", "42P01"].includes(String(quantitySave.error.code ?? ""))) throw quantitySave.error;

    const safetySave = await admin
      .from("route_stop_safety_checks")
      .upsert({
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: stop.machine_id,
        operator_id: route.operator_id ?? profile.team_member_id ?? null,
        compressor_confirmed: true,
        proof_photo_url: null,
        proof_photo_path: `admin-override/${stopId}`,
        proof_photo_original_name: "Admin override — no photo uploaded",
        confirmed_at: now,
        created_by_user_id: profile.id,
        updated_at: now,
      }, { onConflict: "route_stop_id" });
    if (safetySave.error && !["PGRST205", "42P01"].includes(String(safetySave.error.code ?? ""))) throw safetySave.error;

    const result = await completeStop({
      stopId,
      routeId,
      machineId: stop.machine_id,
      filledItems,
      extraItems: [],
      missingProducts: [],
      cashCollected: 0,
      notes: clean(payload.notes) || "Admin/owner override: stop completed without proof photos because the operator app/workflow was unavailable.",
      completionPhotoUrl: undefined,
      completionPhotoPath: `admin-override/${profile.id}/${stopId}`,
      completionPhotoOriginalName: "Admin override — no photo uploaded",
      completionPhotoUploadUnavailable: false,
      issue: undefined,
      clientSubmissionId: `admin-stop-override:${stopId}:${Date.now()}`,
    });

    if (!result.success) return NextResponse.json({ success: false, error: result.error || "Could not finish the stop." }, { status: 400 });
    return NextResponse.json({ success: true, stopId, routeId, completedBy: profile.id, adminOverride: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
