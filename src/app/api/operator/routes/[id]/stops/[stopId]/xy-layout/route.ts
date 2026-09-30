import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { getXyVmsConfig } from "@/lib/xy-vms-api";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot, type XySlotState } from "@/lib/xy-vms-control";

type LayoutAction =
  | { action: "change_product"; slotCode: string; productId: string }
  | { action: "swap_slots"; slotCodeA: string; slotCodeB: string }
  | { action: "change_price"; slotCode: string; priceLyd: number };

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanSlot(value: unknown) {
  return String(value ?? "").trim();
}

function isAdmin(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  if (!profile) return false;
  return profile.role === "owner" || profile.role === "admin" || profile.roles?.includes("owner") || profile.roles?.includes("admin");
}

function safeNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function loadContext(routeId: string, stopId: string) {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const supabase = getSupabaseServerClient(accessToken);
  if (!accessToken || !profile || !supabase) {
    return { error: NextResponse.json({ success: false, error: "Session expired." }, { status: 401 }) } as const;
  }

  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  const [{ data: route, error: routeError }, { data: stop, error: stopError }] = await Promise.all([
    supabase.from("routes").select("id, operator_id, status").eq("id", routeId).maybeSingle(),
    supabase.from("route_stops").select("id, route_id, machine_id, status").eq("id", stopId).maybeSingle(),
  ]);
  if (routeError || stopError) {
    return { error: NextResponse.json({ success: false, error: "Could not load route stop." }, { status: 500 }) } as const;
  }
  if (!route || !stop || stop.route_id !== routeId) {
    return { error: NextResponse.json({ success: false, error: "Route stop not found." }, { status: 404 }) } as const;
  }
  if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
    return { error: NextResponse.json({ success: false, error: "This route is not assigned to you." }, { status: 403 }) } as const;
  }
  if (["completed", "cancelled"].includes(String(stop.status ?? "").toLowerCase())) {
    return { error: NextResponse.json({ success: false, error: "This stop is already closed." }, { status: 409 }) } as const;
  }

  const admin = getSupabaseAdminClient() ?? supabase;
  const { data: machine, error: machineError } = await admin
    .from("machines")
    .select("id, name, machine_code, vms_machine_id")
    .eq("id", stop.machine_id)
    .maybeSingle();
  if (machineError || !machine?.vms_machine_id) {
    return { error: NextResponse.json({ success: false, error: "This machine is not linked to XY." }, { status: 409 }) } as const;
  }

  return { supabase, admin, profile, route, stop, machine, vmsMachineId: String(machine.vms_machine_id) } as const;
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

async function getMappedProduct(admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>> | ReturnType<typeof getSupabaseServerClient>, productId: string) {
  if (!admin) return null;
  const [{ data: product }, { data: mapping }] = await Promise.all([
    admin
      .from("products")
      .select("id, name, active, vms_selling_price_lyd, current_selling_price_lyd")
      .eq("id", productId)
      .maybeSingle(),
    admin
      .from("vms_product_mappings")
      .select("vms_product_id, vms_product_name, match_status, last_seen_at")
      .eq("product_id", productId)
      .eq("match_status", "confirmed")
      .not("vms_product_id", "is", null)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!product?.active || !mapping?.vms_product_id) return null;

  let price = safeNumber(product.vms_selling_price_lyd) ?? safeNumber(product.current_selling_price_lyd);
  if (!price || price <= 0) {
    const { data: catalog } = await admin
      .from("vms_product_catalog_snapshots")
      .select("selling_price_lyd")
      .eq("vms_product_id", String(mapping.vms_product_id))
      .not("selling_price_lyd", "is", null)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    price = safeNumber(catalog?.selling_price_lyd);
  }
  if (!price || price <= 0) return null;

  return {
    productId: String(product.id),
    productName: String(product.name),
    vmsProductId: String(mapping.vms_product_id),
    vmsProductName: String(mapping.vms_product_name ?? product.name),
    priceLyd: price,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; stopId: string }> }) {
  const { id: routeId, stopId } = await params;
  if (!isUuid(routeId) || !isUuid(stopId)) {
    return NextResponse.json({ success: false, error: "Invalid route scope." }, { status: 400 });
  }

  const context = await loadContext(routeId, stopId);
  if ("error" in context) return context.error;

  let body: LayoutAction;
  try {
    body = await request.json() as LayoutAction;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  const config = getXyVmsConfig();
  const beforeLayout = await readXyMachineLayout(context.vmsMachineId);
  const findSlot = (slotCode: string) => beforeLayout.find((row) => row.slotCode === slotCode) ?? null;

  if (body.action === "change_product") {
    const slotCode = cleanSlot(body.slotCode);
    if (!slotCode || !isUuid(String(body.productId ?? ""))) {
      return NextResponse.json({ success: false, error: "Choose a valid slot and product." }, { status: 400 });
    }
    const before = findSlot(slotCode);
    if (!before) {
      return NextResponse.json({ success: false, error: "That XY slot could not be found. Refresh the machine map." }, { status: 409 });
    }
    const target = await getMappedProduct(context.admin, body.productId);
    if (!target) {
      return NextResponse.json({ success: false, error: "This product is not ready for XY or has no XY selling price." }, { status: 409 });
    }

    const write = await setXySlotProduct({
      merchantId: config.merchantId,
      vmsMachineId: context.vmsMachineId,
      slotCode,
      vmsProductId: target.vmsProductId,
      productName: target.vmsProductName,
      priceLyd: target.priceLyd,
    });
    const verification = await verifyXySlot({
      vmsMachineId: context.vmsMachineId,
      slotCode,
      expectedVmsProductId: target.vmsProductId,
      expectedPriceLyd: target.priceLyd,
    });

    await writeAudit({
      admin: context.admin,
      profile: context.profile,
      machine: context.machine,
      routeId,
      stopId,
      action: "xy_slot_product_change",
      before,
      after: verification.state ?? { slotCode, vmsProductId: target.vmsProductId, productName: target.productName, priceLyd: target.priceLyd },
      metadata: { verified: verification.verified, xy_response_code: write.code, xy_response_message: write.message },
      summary: `XY slot ${slotCode}: ${before.productName ?? before.vmsProductId ?? "empty"} → ${target.productName}`,
    });

    return NextResponse.json({
      success: verification.verified,
      verified: verification.verified,
      writeAccepted: write.ok,
      xyCode: write.code,
      xyMessage: write.message,
      slot: verification.state,
      error: verification.verified ? null : "Change was sent to XY but could not be verified yet. Do not assume it changed; refresh and check the slot.",
    }, { status: verification.verified ? 200 : 202 });
  }

  if (body.action === "swap_slots") {
    const slotCodeA = cleanSlot(body.slotCodeA);
    const slotCodeB = cleanSlot(body.slotCodeB);
    if (!slotCodeA || !slotCodeB || slotCodeA === slotCodeB) {
      return NextResponse.json({ success: false, error: "Choose two different slots." }, { status: 400 });
    }
    const a = findSlot(slotCodeA);
    const b = findSlot(slotCodeB);
    if (!a?.vmsProductId || !b?.vmsProductId || !a.priceLyd || !b.priceLyd) {
      return NextResponse.json({ success: false, error: "Both slots need an XY product and price before they can be swapped." }, { status: 409 });
    }

    const writeA = await setXySlotProduct({
      merchantId: config.merchantId,
      vmsMachineId: context.vmsMachineId,
      slotCode: slotCodeA,
      vmsProductId: b.vmsProductId,
      productName: b.productName,
      priceLyd: b.priceLyd,
    });
    const verifyA = await verifyXySlot({
      vmsMachineId: context.vmsMachineId,
      slotCode: slotCodeA,
      expectedVmsProductId: b.vmsProductId,
      expectedPriceLyd: b.priceLyd,
    });

    if (!verifyA.verified) {
      await writeAudit({
        admin: context.admin,
        profile: context.profile,
        machine: context.machine,
        routeId,
        stopId,
        action: "xy_slot_swap_failed",
        before: { a, b },
        after: { a: verifyA.state, b },
        metadata: { verified: false, stage: "first_slot", xy_response_code: writeA.code, xy_response_message: writeA.message },
        summary: `XY swap ${slotCodeA} ↔ ${slotCodeB} failed verification on first slot`,
      });
      return NextResponse.json({ success: false, verified: false, error: "XY did not verify the first slot change. Swap stopped before changing the second slot." }, { status: 409 });
    }

    const writeB = await setXySlotProduct({
      merchantId: config.merchantId,
      vmsMachineId: context.vmsMachineId,
      slotCode: slotCodeB,
      vmsProductId: a.vmsProductId,
      productName: a.productName,
      priceLyd: a.priceLyd,
    });
    const verifyB = await verifyXySlot({
      vmsMachineId: context.vmsMachineId,
      slotCode: slotCodeB,
      expectedVmsProductId: a.vmsProductId,
      expectedPriceLyd: a.priceLyd,
    });

    if (!verifyB.verified) {
      await setXySlotProduct({
        merchantId: config.merchantId,
        vmsMachineId: context.vmsMachineId,
        slotCode: slotCodeA,
        vmsProductId: a.vmsProductId,
        productName: a.productName,
        priceLyd: a.priceLyd,
      }).catch(() => null);
      const rollback = await verifyXySlot({
        vmsMachineId: context.vmsMachineId,
        slotCode: slotCodeA,
        expectedVmsProductId: a.vmsProductId,
        expectedPriceLyd: a.priceLyd,
      }).catch(() => ({ verified: false, state: null as XySlotState | null }));

      await writeAudit({
        admin: context.admin,
        profile: context.profile,
        machine: context.machine,
        routeId,
        stopId,
        action: "xy_slot_swap_failed",
        before: { a, b },
        after: { a: rollback.state, b: verifyB.state },
        metadata: { verified: false, stage: "second_slot", rollback_verified: rollback.verified, xy_response_code: writeB.code, xy_response_message: writeB.message },
        summary: `XY swap ${slotCodeA} ↔ ${slotCodeB} failed verification and rollback was attempted`,
      });
      return NextResponse.json({ success: false, verified: false, rollbackVerified: rollback.verified, error: "Second slot did not verify. Snacky attempted to restore the first slot. Refresh the map and inspect both slots." }, { status: 409 });
    }

    await writeAudit({
      admin: context.admin,
      profile: context.profile,
      machine: context.machine,
      routeId,
      stopId,
      action: "xy_slot_swap",
      before: { a, b },
      after: { a: verifyA.state, b: verifyB.state },
      metadata: { verified: true },
      summary: `XY slots ${slotCodeA} and ${slotCodeB} swapped`,
    });
    return NextResponse.json({ success: true, verified: true, slots: [verifyA.state, verifyB.state] });
  }

  if (body.action === "change_price") {
    if (!isAdmin(context.profile)) {
      return NextResponse.json({ success: false, error: "Only owner/admin can change XY selling prices." }, { status: 403 });
    }
    const slotCode = cleanSlot(body.slotCode);
    const priceLyd = safeNumber(body.priceLyd);
    const before = findSlot(slotCode);
    if (!before?.vmsProductId || !before.productName || !priceLyd || priceLyd <= 0 || priceLyd > 500) {
      return NextResponse.json({ success: false, error: "Choose a valid slot and price." }, { status: 400 });
    }

    const write = await setXySlotProduct({
      merchantId: config.merchantId,
      vmsMachineId: context.vmsMachineId,
      slotCode,
      vmsProductId: before.vmsProductId,
      productName: before.productName,
      priceLyd,
    });
    const verification = await verifyXySlot({
      vmsMachineId: context.vmsMachineId,
      slotCode,
      expectedVmsProductId: before.vmsProductId,
      expectedPriceLyd: priceLyd,
    });

    await writeAudit({
      admin: context.admin,
      profile: context.profile,
      machine: context.machine,
      routeId,
      stopId,
      action: "xy_slot_price_change",
      before,
      after: verification.state ?? { ...before, priceLyd },
      metadata: { verified: verification.verified, xy_response_code: write.code, xy_response_message: write.message },
      summary: `XY slot ${slotCode} price: ${before.priceLyd ?? "?"} → ${priceLyd} LYD`,
    });

    return NextResponse.json({
      success: verification.verified,
      verified: verification.verified,
      slot: verification.state,
      error: verification.verified ? null : "Price command was sent but not verified yet. Refresh and confirm the XY price.",
    }, { status: verification.verified ? 200 : 202 });
  }

  return NextResponse.json({ success: false, error: "Unsupported XY layout action." }, { status: 400 });
}
