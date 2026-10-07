import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot } from "@/lib/xy-vms-control";

type PendingChange = {
  id: string;
  route_id: string;
  route_stop_id: string;
  machine_id: string;
  vms_machine_id: string;
  slot_code: string;
  previous_vms_product_id: string;
  previous_stock_qty: number;
  target_product_id: string;
  target_vms_product_id: string;
  target_price_lyd: number;
  target_stock_qty: number;
  smart_route_swap: boolean;
  physical_change_confirmed: boolean;
  lane_disabled_confirmed: boolean;
  zero_stock_relabel: boolean;
  status: string;
  created_at: string;
  attempt_count: number;
};

function offlineError(message: string) {
  return /设备不在线|device\s*(?:is\s*)?offline|machine\s*(?:is\s*)?offline|not\s+online/i.test(message);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown XY error");
}

export async function retryPendingXySlotChanges() {
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("Protected XY queue database is unavailable.");

  const { data: due, error } = await db.from("xy_pending_slot_changes")
    .select("id,route_id,route_stop_id,machine_id,vms_machine_id,slot_code,previous_vms_product_id,previous_stock_qty,target_product_id,target_vms_product_id,target_price_lyd,target_stock_qty,smart_route_swap,physical_change_confirmed,lane_disabled_confirmed,zero_stock_relabel,status,created_at,attempt_count")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(2);
  if (error) throw error;

  const report = { checked: 0, verified: 0, offline: 0, conflicts: 0, waiting: 0, errors: 0 };
  for (const item of (due ?? []) as PendingChange[]) {
    report.checked++;
    const now = new Date();
    const { data: claimed, error: claimError } = await db.from("xy_pending_slot_changes")
      .update({
        attempt_count: item.attempt_count + 1,
        last_attempt_at: now.toISOString(),
        next_attempt_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
      })
      .eq("id", item.id).eq("status", "pending").eq("attempt_count", item.attempt_count)
      .select("id").maybeSingle();
    if (claimError || !claimed) { report.waiting++; continue; }

    const setState = async (status: "verified" | "conflict" | "pending", lastError: string | null) => {
      await db.from("xy_pending_slot_changes").update({
        status,
        last_error: lastError?.slice(0, 1000) ?? null,
        updated_at: new Date().toISOString(),
        ...(status === "verified" ? { verified_at: new Date().toISOString() } : {}),
      }).eq("id", item.id).eq("status", "pending");
    };

    try {
      const { data: stop, error: stopError } = await db.from("route_stops")
        .select("status, route_id, machine_id").eq("id", item.route_stop_id).maybeSingle();
      if (stopError || !stop) throw stopError ?? new Error("Route stop missing.");
      const safeZeroStockRelabel = item.zero_stock_relabel === true
        && item.target_stock_qty === 0
        && item.smart_route_swap === false
        && item.physical_change_confirmed === false
        && item.lane_disabled_confirmed === false;
      if (stop.route_id !== item.route_id || stop.machine_id !== item.machine_id
        || (!safeZeroStockRelabel && (!item.physical_change_confirmed || !item.lane_disabled_confirmed))) {
        await setState("conflict", "Queue ownership or physical safety confirmation changed.");
        report.conflicts++;
        continue;
      }
      if (["skipped", "canceled", "cancelled"].includes(String(stop.status))) {
        await setState("conflict", "Stop was cancelled or skipped. Admin review required.");
        report.conflicts++;
        continue;
      }
      if (!safeZeroStockRelabel && stop.status !== "completed") {
        if (["skipped", "canceled", "cancelled"].includes(String(stop.status))) {
          await setState("conflict", "Stop was not completed. Manual review required.");
          report.conflicts++;
        } else {
          report.waiting++;
        }
        continue;
      }
      if (!safeZeroStockRelabel && now.getTime() - Date.parse(item.created_at) > 48 * 3_600_000) {
        await setState("conflict", "Queued XY change is older than 48 hours; manual verification required.");
        report.conflicts++;
        continue;
      }

      const layout = await readXyMachineLayout(item.vms_machine_id);
      const before = layout.find((row) => row.slotCode === item.slot_code);
      if (!before || before.currentQty === null || !before.vmsProductId) {
        await setState("conflict", "XY no longer provides reliable lane data.");
        report.conflicts++;
        continue;
      }
      if (before.vmsProductId === item.target_vms_product_id) {
        if (before.currentQty === item.target_stock_qty
          && before.priceLyd !== null
          && Math.abs(before.priceLyd - Number(item.target_price_lyd)) < 0.001) {
          await setState("verified", null);
          report.verified++;
          continue;
        }
        await setState("conflict", "XY reports the target product but stock/price differs. Do not overwrite.");
        report.conflicts++;
        continue;
      }
      if (before.vmsProductId !== item.previous_vms_product_id
        || (safeZeroStockRelabel
            ? before.currentQty > item.previous_stock_qty
            : before.currentQty !== item.previous_stock_qty)) {
        await setState("conflict", "XY product or stock increased since queueing; manual review required.");
        report.conflicts++;
        continue;
      }

      const write = await setXySlotProduct({
        vmsMachineId: item.vms_machine_id,
        slotCode: item.slot_code,
        vmsProductId: item.target_vms_product_id,
        priceLyd: Number(item.target_price_lyd),
        stockQty: item.target_stock_qty,
      });
      if (!write.accepted) {
        if (offlineError(String(write.message ?? ""))) {
          await setState("pending", "Machine offline. Automatic retry scheduled.");
          report.offline++;
        } else {
          await setState("conflict", `XY rejected queued change: ${write.message ?? write.code ?? "unknown"}`);
          report.conflicts++;
        }
        continue;
      }
      const verified = await verifyXySlot({
        vmsMachineId: item.vms_machine_id,
        slotCode: item.slot_code,
        expectedVmsProductId: item.target_vms_product_id,
        expectedPriceLyd: Number(item.target_price_lyd),
        expectedStockQty: item.target_stock_qty,
      });
      if (!verified.verified) {
        // Vendor accepted; retry is idempotent if XY subsequently reports the exact target.
        await setState("pending", "XY accepted the update but readback has not verified it yet.");
        report.waiting++;
        continue;
      }
      await setState("verified", null);
      report.verified++;
      await db.from("system_activity_logs").insert({
        action: "xy_slot_product_change",
        entity_type: "machine_xy_layout",
        entity_id: item.machine_id,
        entity_label: item.vms_machine_id,
        summary: `Queued XY change for lane ${item.slot_code} verified after reconnect`,
        metadata: {
          route_id: item.route_id,
          route_stop_id: item.route_stop_id,
          slot_code: item.slot_code,
          selected_product_id: item.target_product_id,
          vms_machine_id: item.vms_machine_id,
          queued: true,
          smart_route_swap: item.smart_route_swap,
          verified: true,
        },
      });
    } catch (cause) {
      await setState("pending", errorText(cause));
      report.errors++;
    }
  }
  return report;
}
