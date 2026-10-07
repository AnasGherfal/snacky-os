import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot, type XySlotState } from "@/lib/xy-vms-control";

export const dynamic = "force-dynamic";

const SCHEDULER_TOKEN_SHA256 = "6a8316c2ea6b58c928921ca0c141ff9f683d279eb8e2abbe682c1d7d52167d89";
const RUN_KEY = "xy-live-roundtrip-20261007";
const ALLOWED_VMS_MACHINE_IDS = ["2609000196", "2404120076"] as const;

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function authorized(request: Request) {
  const auth = String(request.headers.get("authorization") ?? "");
  if (!auth.startsWith("Bearer ")) return false;
  return safeEqual(sha256(auth.slice("Bearer ".length).trim()), SCHEDULER_TOKEN_SHA256);
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function occupiedLane(row: XySlotState) {
  return Boolean(
    clean(row.slotCode)
    && clean(row.vmsProductId)
    && row.priceLyd !== null
    && Number.isFinite(Number(row.priceLyd))
    && Number(row.priceLyd) > 0
    && row.currentQty !== null
    && Number.isSafeInteger(Number(row.currentQty))
    && Number(row.currentQty) >= 0
  );
}

function sameState(left: XySlotState | null, right: XySlotState) {
  if (!left) return false;
  return left.slotCode === right.slotCode
    && clean(left.vmsProductId) === clean(right.vmsProductId)
    && left.currentQty === right.currentQty
    && left.priceLyd !== null
    && right.priceLyd !== null
    && Math.abs(left.priceLyd - right.priceLyd) < 0.001;
}

async function writeAndVerify(args: {
  vmsMachineId: string;
  slotCode: string;
  vmsProductId: string;
  priceLyd: number;
  stockQty: number;
}) {
  const write = await setXySlotProduct(args);
  if (!write.accepted) {
    throw new Error(write.message ? `XY rejected the write: ${write.message}` : "XY rejected the write.");
  }
  const verification = await verifyXySlot({
    vmsMachineId: args.vmsMachineId,
    slotCode: args.slotCode,
    expectedVmsProductId: args.vmsProductId,
    expectedPriceLyd: args.priceLyd,
    expectedStockQty: args.stockQty,
  });
  if (!verification.verified) {
    throw new Error("XY accepted the write but read-back verification did not match.");
  }
  return {
    accepted: write.accepted,
    verified: verification.verified,
    state: verification.state,
  };
}

async function restoreBaseline(vmsMachineId: string, baseline: XySlotState) {
  if (!baseline.vmsProductId || baseline.priceLyd === null || baseline.currentQty === null) {
    throw new Error("Baseline lane is incomplete and cannot be restored safely.");
  }
  const restored = await writeAndVerify({
    vmsMachineId,
    slotCode: baseline.slotCode,
    vmsProductId: baselineProductId,
    priceLyd: baselinePriceLyd,
    stockQty: baselineStockQty,
  });
  return restored.state;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (clean(body.run) !== RUN_KEY) {
    return NextResponse.json({ ok: false, error: "Invalid run key" }, { status: 404 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Supabase admin client unavailable" }, { status: 503 });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: priorSuccess } = await admin
    .from("system_activity_logs")
    .select("id", { count: "exact", head: true })
    .eq("action", "xy_live_roundtrip_verified")
    .gte("created_at", since);
  if ((priorSuccess ?? 0) > 0) {
    return NextResponse.json({ ok: false, error: "A successful live XY round-trip test already ran in the last 24 hours." }, { status: 409 });
  }

  const { data: machines, error: machineError } = await admin
    .from("machines")
    .select("id, name, machine_code, vms_machine_id, location_id, status")
    .in("vms_machine_id", [...ALLOWED_VMS_MACHINE_IDS]);
  if (machineError) {
    return NextResponse.json({ ok: false, error: machineError.message }, { status: 500 });
  }

  const diagnostics: Array<Record<string, unknown>> = [];

  for (const machine of machines ?? []) {
    const vmsMachineId = clean(machine.vms_machine_id);
    if (!ALLOWED_VMS_MACHINE_IDS.includes(vmsMachineId as (typeof ALLOWED_VMS_MACHINE_IDS)[number])) continue;
    if (machine.location_id) {
      diagnostics.push({ machine: machine.machine_code, skipped: "Machine has a location." });
      continue;
    }

    const { count: recentSales, error: salesError } = await admin
      .from("vms_sales_dashboard_clean")
      .select("id", { count: "exact", head: true })
      .eq("machine_id", machine.id)
      .gte("created_at", since);
    if (salesError) {
      diagnostics.push({ machine: machine.machine_code, skipped: "Could not verify recent sales safety." });
      continue;
    }
    if ((recentSales ?? 0) > 0) {
      diagnostics.push({ machine: machine.machine_code, skipped: "Machine has sales in the last 24 hours." });
      continue;
    }

    let layout: XySlotState[];
    try {
      layout = await readXyMachineLayout(vmsMachineId);
    } catch (error) {
      diagnostics.push({ machine: machine.machine_code, skipped: error instanceof Error ? error.message : "XY read failed." });
      continue;
    }

    const occupied = layout.filter(occupiedLane);
    const target = occupied.find((lane) => {
      const qty = Number(lane.currentQty);
      const capacity = lane.capacity === null ? null : Number(lane.capacity);
      const canQuantityRoundTrip = qty > 0 || (capacity !== null && Number.isFinite(capacity) && capacity > qty);
      const hasDonor = occupied.some((donor) => donor.slotCode !== lane.slotCode && clean(donor.vmsProductId) !== clean(lane.vmsProductId));
      return canQuantityRoundTrip && hasDonor;
    }) ?? null;

    if (!target || !target.vmsProductId || target.priceLyd === null || target.currentQty === null) {
      diagnostics.push({ machine: machine.machine_code, skipped: "No safe lane/donor pair is available." });
      continue;
    }

    const donor = occupied.find((lane) => lane.slotCode !== target.slotCode && clean(lane.vmsProductId) !== clean(target.vmsProductId))!;
    const baselineProductId = clean(target.vmsProductId);
    const baselinePriceLyd = Number(target.priceLyd);
    const baselineStockQty = Number(target.currentQty);
    if (!baselineProductId || !Number.isFinite(baselinePriceLyd) || baselinePriceLyd <= 0 || !Number.isSafeInteger(baselineStockQty) || baselineStockQty < 0) {
      diagnostics.push({ machine: machine.machine_code, skipped: "Selected baseline lane is not safe to mutate." });
      continue;
    }

    const baseline: XySlotState = {
      ...target,
      vmsProductId: baselineProductId,
      priceLyd: baselinePriceLyd,
      currentQty: baselineStockQty,
    };
    const qty = baselineStockQty;
    const capacity = baseline.capacity === null ? null : Number(baseline.capacity);
    const quantityTarget = qty > 0 ? qty - 1 : capacity !== null && capacity > qty ? qty + 1 : null;
    if (quantityTarget === null) {
      diagnostics.push({ machine: machine.machine_code, skipped: "No reversible quantity target is available." });
      continue;
    }

    const results: Record<string, unknown> = {
      machine: machine.machine_code,
      vmsMachineId,
      slotCode: baseline.slotCode,
      donorSlotCode: donor.slotCode,
      baseline: {
        productId: baseline.vmsProductId,
        priceLyd: baselinePriceLyd,
        stockQty: baselineStockQty,
      },
    };

    let finalRestored = false;
    try {
      results.quantity = await writeAndVerify({
        vmsMachineId,
        slotCode: baseline.slotCode,
        vmsProductId: baselineProductId,
        priceLyd: baselinePriceLyd,
        stockQty: quantityTarget,
      });
      results.quantityRestore = await restoreBaseline(vmsMachineId, baseline);

      const priceTarget = Number((baselinePriceLyd + 0.01).toFixed(2));
      results.price = await writeAndVerify({
        vmsMachineId,
        slotCode: baseline.slotCode,
        vmsProductId: baselineProductId,
        priceLyd: priceTarget,
        stockQty: baselineStockQty,
      });
      results.priceRestore = await restoreBaseline(vmsMachineId, baseline);

      if (!donor.vmsProductId) throw new Error("Donor lane has no XY product id.");
      results.product = await writeAndVerify({
        vmsMachineId,
        slotCode: baseline.slotCode,
        vmsProductId: donor.vmsProductId,
        priceLyd: baselinePriceLyd,
        stockQty: baselineStockQty,
      });
      results.productRestore = await restoreBaseline(vmsMachineId, baseline);

      const finalLayout = await readXyMachineLayout(vmsMachineId);
      const finalLane = finalLayout.find((lane) => lane.slotCode === baseline.slotCode) ?? null;
      finalRestored = sameState(finalLane, baseline);
      if (!finalRestored) throw new Error("Final XY lane state does not match the original baseline.");

      await admin.from("system_activity_logs").insert({
        action: "xy_live_roundtrip_verified",
        entity_type: "machine_xy_layout",
        entity_id: machine.id,
        entity_label: machine.name ?? machine.machine_code ?? machine.id,
        before_data: baseline,
        after_data: finalLane,
        metadata: {
          vms_machine_id: vmsMachineId,
          slot_code: baseline.slotCode,
          quantity_verified: true,
          price_verified: true,
          product_verified: true,
          final_restore_verified: true,
          test_key: RUN_KEY,
        },
        summary: "Verified live XY product, price, and quantity round-trip and restored the original lane",
      });

      return NextResponse.json({
        ok: true,
        machine: machine.machine_code,
        slotCode: baseline.slotCode,
        quantityVerified: true,
        priceVerified: true,
        productVerified: true,
        restoredVerified: true,
      });
    } catch (error) {
      let recoveryError: string | null = null;
      try {
        const restored = await restoreBaseline(vmsMachineId, baseline);
        finalRestored = sameState(restored, baseline);
      } catch (restoreError) {
        recoveryError = restoreError instanceof Error ? restoreError.message : "Unknown restore failure";
      }

      await admin.from("system_activity_logs").insert({
        action: "xy_live_roundtrip_failed",
        entity_type: "machine_xy_layout",
        entity_id: machine.id,
        entity_label: machine.name ?? machine.machine_code ?? machine.id,
        before_data: baseline,
        after_data: results,
        metadata: {
          vms_machine_id: vmsMachineId,
          slot_code: baseline.slotCode,
          final_restore_verified: finalRestored,
          recovery_error: recoveryError,
          test_key: RUN_KEY,
        },
        summary: "Live XY round-trip test failed; restoration was attempted immediately",
      });

      return NextResponse.json({
        ok: false,
        machine: machine.machine_code,
        slotCode: baseline.slotCode,
        error: error instanceof Error ? error.message : "Live XY round-trip failed.",
        restoredVerified: finalRestored,
        recoveryError,
      }, { status: recoveryError || !finalRestored ? 500 : 409 });
    }
  }

  return NextResponse.json({
    ok: false,
    error: "No whitelisted unlocated/no-sales machine had a safe live XY lane available.",
    diagnostics,
  }, { status: 409 });
}
