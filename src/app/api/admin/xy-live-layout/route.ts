import { NextRequest, NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { readXyMachineLayout } from "@/lib/xy-vms-control";

export const dynamic = "force-dynamic";

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function GET(request: NextRequest) {
  const profile = await getCurrentProfile();
  if (!profile) return response({ ok: false, error: "Sign in again." }, 401);
  if (!isOwnerAdminRole(profile)) {
    return response({ ok: false, error: "Only a Snacky owner or admin can test a live XY machine." }, 403);
  }

  const machineId = request.nextUrl.searchParams.get("machineId")?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(machineId)) {
    return response({ ok: false, error: "Choose a valid Snacky machine." }, 400);
  }
  const db = getSupabaseAdminClient();
  if (!db) return response({ ok: false, error: "Snacky database unavailable." }, 503);

  const { data: machine, error } = await db.from("machines")
    .select("id,name,machine_code,vms_machine_id")
    .eq("id", machineId).maybeSingle();
  if (error) return response({ ok: false, error: "Could not look up the machine." }, 503);
  if (!machine?.vms_machine_id) {
    return response({ ok: false, error: "This machine has no XY vendor mapping." }, 404);
  }

  const started = Date.now();
  try {
    // Vendor read only. Never send a product/price/stock write in a probe.
    const slots = await readXyMachineLayout(machine.vms_machine_id);
    if (!slots.length) {
      return response({ ok: false, error: "XY responded but provided no live selections." }, 503);
    }
    const selections = slots.map((slot) => {
      const reasons: string[] = [];
      if (!slot.vmsProductId) reasons.push("No XY product assigned");
      if (slot.currentQty === null || !Number.isSafeInteger(slot.currentQty) || slot.currentQty < 0) {
        reasons.push("Unknown stock");
      }
      if (slot.capacity === null || !Number.isSafeInteger(slot.capacity) || slot.capacity < 1) {
        reasons.push("Unknown capacity");
      }
      if (slot.currentQty !== null && slot.capacity !== null && slot.currentQty > slot.capacity) {
        reasons.push("Quantity exceeds capacity");
      }
      return {
        slotCode: slot.slotCode,
        vmsProductId: slot.vmsProductId,
        productName: slot.productName,
        priceLyd: slot.priceLyd,
        currentQty: slot.currentQty,
        capacity: slot.capacity,
        issues: reasons,
      };
    });
    return response({
      ok: true,
      source: "xy_live_direct",
      fetchedAt: new Date().toISOString(),
      responseMs: Date.now() - started,
      machine: { id: machine.id, name: machine.name, machineCode: machine.machine_code },
      totalSelections: selections.length,
      problematicSelections: selections.filter((slot) => slot.issues.length).length,
      selections,
    });
  } catch (cause) {
    console.warn("[xy-admin-live-probe] Vendor read failed", {
      machineId,
      reason: cause instanceof Error ? cause.message : "Unknown vendor error",
    });
    return response({
      ok: false,
      source: "xy_live_direct",
      error: "The XY vendor did not provide a live layout. Old imported stock must not be labelled live.",
      responseMs: Date.now() - started,
    }, 503);
  }
}
