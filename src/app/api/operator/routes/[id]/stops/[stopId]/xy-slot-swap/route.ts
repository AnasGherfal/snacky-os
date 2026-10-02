import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot, type XySlotState } from "@/lib/xy-vms-control";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function writeAudit(args: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>> | ReturnType<typeof getSupabaseServerClient>;
  profile: NonNullable<Awaited<ReturnType<typeof getCurrentProfile>>>;
  machine: { id: string; name?: string | null; machine_code?: string | null; vms_machine_id?: string | null };
  routeId: string;
  stopId: string;
  action: string;
  before: unknown;
  after: unknown;
  metadata?: Record<string, unknown>;
  summary: string;
}) {
  if (!args.admin) return;
  await args.admin.from("system_activity_logs").insert({
    actor_user_id: args.profile.id,
    actor_team_member_id: args.profile.team_member_id,
    actor_name: args.profile.full_name,
    actor_role: args.profile.role,
    action: args.action,
    entity_type: "machine_xy_layout",
    entity_id: args.machine.id,
    entity_label: args.machine.name ?? args.machine.machine_code ?? args.machine.id,
    before_data: args.before,
    after_data: args.after,
    metadata: {
      route_id: args.routeId,
      route_stop_id: args.stopId,
      vms_machine_id: args.machine.vms_machine_id,
      ...args.metadata,
    },
    summary: args.summary,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, error: "Invalid route or stop." }, { status: 400 });
  }

  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const supabase = getSupabaseServerClient(accessToken);
  if (!accessToken || !profile || !supabase) {
    return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  }

  let body: { slotCodeA?: unknown; slotCodeB?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  const slotCodeA = String(body.slotCodeA ?? "").trim();
  const slotCodeB = String(body.slotCodeB ?? "").trim();
  if (!slotCodeA || !slotCodeB || slotCodeA === slotCodeB) {
    return NextResponse.json({ success: false, error: "Choose two different slots." }, { status: 400 });
  }

  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    supabase.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    supabase.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) {
    return NextResponse.json({ success: false, error: "Could not load this route stop." }, { status: 500 });
  }
  if (!route || !stop || stop.route_id !== routeId) {
    return NextResponse.json({ success: false, error: "Route stop not found." }, { status: 404 });
  }

  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 });
  }
  if (["completed", "cancelled"].includes(String(stop.status ?? "").toLowerCase())) {
    return NextResponse.json({ success: false, error: "This stop is already closed." }, { status: 409 });
  }

  const admin = getSupabaseAdminClient() ?? supabase;
  const { data: machine, error: machineError } = await admin
    .from("machines")
    .select("id, name, machine_code, vms_machine_id")
    .eq("id", stop.machine_id)
    .maybeSingle();

  if (machineError || !machine?.vms_machine_id) {
    return NextResponse.json({ success: false, error: "This machine is not linked to XY." }, { status: 409 });
  }

  const vmsMachineId = String(machine.vms_machine_id);
  const beforeLayout = await readXyMachineLayout(vmsMachineId);
  const slotA = beforeLayout.find((slot) => slot.slotCode === slotCodeA) ?? null;
  const slotB = beforeLayout.find((slot) => slot.slotCode === slotCodeB) ?? null;

  if (!slotA || !slotB) {
    return NextResponse.json({ success: false, error: "One of those XY slots no longer exists. Refresh the machine layout." }, { status: 409 });
  }
  if (!slotA.vmsProductId || !slotB.vmsProductId) {
    return NextResponse.json({ success: false, error: "Step 3 only supports swapping two occupied XY slots." }, { status: 409 });
  }
  if (!slotA.priceLyd || !slotB.priceLyd) {
    return NextResponse.json({ success: false, error: "Both slots need a valid XY selling price before they can be swapped." }, { status: 409 });
  }
  if (
    slotA.currentQty === null || slotB.currentQty === null
    || !Number.isSafeInteger(Number(slotA.currentQty)) || Number(slotA.currentQty) < 0
    || !Number.isSafeInteger(Number(slotB.currentQty)) || Number(slotB.currentQty) < 0
  ) {
    return NextResponse.json({ success: false, error: "Both slots need a reliable current XY stock quantity before they can be swapped." }, { status: 409 });
  }

  const firstWrite = await setXySlotProduct({
    vmsMachineId,
    slotCode: slotCodeA,
    vmsProductId: slotB.vmsProductId,
    priceLyd: slotB.priceLyd,
    stockQty: Number(slotA.currentQty),
  });
  if (!firstWrite.accepted) {
    await writeAudit({
      admin,
      profile,
      machine,
      routeId,
      stopId,
      action: "xy_slot_swap_rejected",
      before: { slotA, slotB },
      after: { slotA, slotB },
      metadata: {
        failed_stage: "first_slot_write",
        slot_a: slotCodeA,
        slot_b: slotCodeB,
        xy_http_status: firstWrite.httpStatus,
        xy_code: firstWrite.code,
        xy_message: firstWrite.message,
        accepted: false,
      },
      summary: `XY rejected swap ${slotCodeA} ↔ ${slotCodeB} before the first slot changed`,
    });
    return NextResponse.json({
      success: false,
      verified: false,
      writeAccepted: false,
      code: "XY_WRITE_REJECTED",
      error: firstWrite.message
        ? `XY rejected the move: ${firstWrite.message} No slot was changed.`
        : "XY rejected the move before it reached the machine. No slot was changed.",
      slots: { slotA, slotB },
    }, { status: 502 });
  }

  const firstVerification = await verifyXySlot({
    vmsMachineId,
    slotCode: slotCodeA,
    expectedVmsProductId: slotB.vmsProductId,
    expectedPriceLyd: slotB.priceLyd,
    expectedStockQty: Number(slotA.currentQty),
  });

  if (!firstVerification.verified) {
    await writeAudit({
      admin,
      profile,
      machine,
      routeId,
      stopId,
      action: "xy_slot_swap_unverified",
      before: { slotA, slotB },
      after: { slotA: firstVerification.state, slotB },
      metadata: {
        failed_stage: "first_slot",
        slot_a: slotCodeA,
        slot_b: slotCodeB,
        xy_http_status: firstWrite.httpStatus,
        xy_code: firstWrite.code,
        xy_message: firstWrite.message,
      },
      summary: `XY swap ${slotCodeA} ↔ ${slotCodeB} stopped because the first slot did not verify`,
    });
    return NextResponse.json({
      success: false,
      verified: false,
      error: "XY did not verify the first slot. The second slot was not changed.",
      slots: { slotA: firstVerification.state, slotB },
    }, { status: 409 });
  }

  const secondWrite = await setXySlotProduct({
    vmsMachineId,
    slotCode: slotCodeB,
    vmsProductId: slotA.vmsProductId,
    priceLyd: slotA.priceLyd,
    stockQty: Number(slotB.currentQty),
  });
  const secondVerification = secondWrite.accepted
    ? await verifyXySlot({
        vmsMachineId,
        slotCode: slotCodeB,
        expectedVmsProductId: slotA.vmsProductId,
        expectedPriceLyd: slotA.priceLyd,
        expectedStockQty: Number(slotA.currentQty),
      })
    : { verified: false, state: slotB };

  if (!secondVerification.verified) {
    let rollbackVerified = false;
    let rollbackState: XySlotState | null = null;
    try {
      const rollbackWrite = await setXySlotProduct({
        vmsMachineId,
        slotCode: slotCodeA,
        vmsProductId: slotA.vmsProductId,
        productName: slotA.productName ?? slotA.vmsProductId,
        priceLyd: slotA.priceLyd,
      });
      if (!rollbackWrite.accepted) throw new Error("XY rejected rollback");
      const rollback = await verifyXySlot({
        vmsMachineId,
        slotCode: slotCodeA,
        expectedVmsProductId: slotA.vmsProductId,
        expectedPriceLyd: slotA.priceLyd,
      });
      rollbackVerified = rollback.verified;
      rollbackState = rollback.state;
    } catch {
      rollbackVerified = false;
    }

    await writeAudit({
      admin,
      profile,
      machine,
      routeId,
      stopId,
      action: "xy_slot_swap_failed",
      before: { slotA, slotB },
      after: {
        slotA: rollbackState ?? firstVerification.state,
        slotB: secondVerification.state,
      },
      metadata: {
        failed_stage: "second_slot",
        rollback_verified: rollbackVerified,
        slot_a: slotCodeA,
        slot_b: slotCodeB,
        xy_http_status: secondWrite.httpStatus,
        xy_code: secondWrite.code,
        xy_message: secondWrite.message,
      },
      summary: `XY swap ${slotCodeA} ↔ ${slotCodeB} failed on the second slot; rollback attempted`,
    });

    return NextResponse.json({
      success: false,
      verified: false,
      rollbackVerified,
      error: rollbackVerified
        ? "The second slot did not verify, so Snacky restored the first slot. No swap was completed."
        : "The second slot did not verify and the first-slot rollback could not be confirmed. Inspect both slots in XY before continuing.",
      slots: {
        slotA: rollbackState ?? firstVerification.state,
        slotB: secondVerification.state,
      },
    }, { status: 409 });
  }

  await writeAudit({
    admin,
    profile,
    machine,
    routeId,
    stopId,
    action: "xy_slot_swap",
    before: { slotA, slotB },
    after: {
      slotA: firstVerification.state,
      slotB: secondVerification.state,
    },
    metadata: {
      verified: true,
      slot_a: slotCodeA,
      slot_b: slotCodeB,
    },
    summary: `XY slots ${slotCodeA} and ${slotCodeB} swapped and verified`,
  });

  return NextResponse.json({
    success: true,
    verified: true,
    before: { slotA, slotB },
    slots: {
      slotA: firstVerification.state,
      slotB: secondVerification.state,
    },
  });
}
