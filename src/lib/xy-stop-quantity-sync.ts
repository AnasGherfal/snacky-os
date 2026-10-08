import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot } from "@/lib/xy-vms-control";

type SyncRow = {
  id: string;
  route_id: string;
  route_stop_id: string;
  machine_id: string;
  vms_machine_id: string;
  slot_code: string;
  expected_vms_product_id: string;
  expected_xy_qty: number;
  target_qty: number;
  max_capacity: number;
  expected_price_lyd: number | null;
  target_price_lyd: number | null;
  update_stock: boolean;
  attempt_count: number;
  created_at: string;
};

function isOffline(message: string) {
  return /设备不在线|device\s*(?:is\s*)?offline|machine\s*(?:is\s*)?offline|not\s+online/i.test(message);
}

export async function retryPendingStopXyQuantities() {
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("Protected XY sync queue is not configured.");
  const { data, error } = await db.from("xy_stop_quantity_syncs")
    .select("id,route_id,route_stop_id,machine_id,vms_machine_id,slot_code,expected_vms_product_id,expected_xy_qty,target_qty,max_capacity,expected_price_lyd,target_price_lyd,update_stock,attempt_count,created_at")
    .eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true }).limit(5);
  if (error) throw error;
  const summary = { checked: 0, verified: 0, waiting: 0, offline: 0, conflict: 0, errors: 0 };

  for (const row of (data ?? []) as SyncRow[]) {
    summary.checked++;
    const time = new Date();
    const { data: claimed, error: claimError } = await db.from("xy_stop_quantity_syncs")
      .update({
        attempt_count: row.attempt_count + 1,
        last_attempt_at: time.toISOString(),
        next_attempt_at: new Date(time.getTime() + 2 * 60_000).toISOString(),
      })
      .eq("id", row.id).eq("status", "pending").eq("attempt_count", row.attempt_count)
      .select("id").maybeSingle();
    if (claimError || !claimed) { summary.waiting++; continue; }

    const settle = async (status: "pending" | "verified" | "conflict", details: string | null) => {
      const { error: updateError } = await db.from("xy_stop_quantity_syncs").update({
        status, last_error: details?.slice(0, 750) ?? null,
        updated_at: new Date().toISOString(),
        ...(status === "verified" ? { verified_at: new Date().toISOString() } : {}),
      }).eq("id", row.id).eq("status", "pending");
      if (updateError) console.error("[xy-stop-quantities] Failed updating queue status", updateError);
    };

    try {
      const { data: stop, error: stopError } = await db.from("route_stops")
        .select("id,status,route_id,machine_id").eq("id", row.route_stop_id).maybeSingle();
      if (stopError || !stop || stop.route_id !== row.route_id || stop.machine_id !== row.machine_id) {
        await settle("conflict", "Route stop identity changed. Admin review required.");
        summary.conflict++; continue;
      }
      if (["skipped", "canceled", "cancelled"].includes(String(stop.status))) {
        await settle("conflict", "Stop cancelled/skipped before machine stock confirmation.");
        summary.conflict++; continue;
      }
      if (stop.status !== "completed") { summary.waiting++; continue; }
      // Keep retrying through lengthy power/network outages. A pending request
      // can only be applied when XY still reports the exact original product
      // AND original stock baseline; any interim sale/change stops the write.
      const { data: relabel, error: relabelError } = await db.from("xy_pending_slot_changes")
        .select("id").eq("machine_id", row.machine_id).eq("slot_code", row.slot_code)
        .eq("status", "pending").limit(1);
      if (relabelError || (relabel ?? []).length) {
        // Product mapping changes take precedence. Never write stock for an uncertain SKU.
        summary.waiting++;
        continue;
      }

      const slots = await readXyMachineLayout(row.vms_machine_id);
      const current = slots.find((slot) => slot.slotCode === row.slot_code);
      if (!current || !current.vmsProductId || current.currentQty === null
          || current.priceLyd === null || current.priceLyd <= 0) {
        await settle("conflict", "XY did not report a reliable product, stock or selling price.");
        summary.conflict++; continue;
      }
      if (current.vmsProductId !== row.expected_vms_product_id
          || (row.update_stock && current.capacity !== null && row.target_qty > current.capacity)
          || (row.update_stock && row.target_qty > row.max_capacity)) {
        await settle("conflict", "XY product or lane capacity has changed; old quantity request was not sent.");
        summary.conflict++; continue;
      }
      const desiredPrice = row.target_price_lyd === null
        ? current.priceLyd : Number(row.target_price_lyd);
      const priceAlreadySet = Math.abs(current.priceLyd - desiredPrice) < 0.001;
      const qtyAlreadySet = !row.update_stock || current.currentQty === row.target_qty;

      if (priceAlreadySet && qtyAlreadySet) {
        await settle("verified", null);
        summary.verified++; continue;
      }
      if (row.target_price_lyd !== null
          && row.expected_price_lyd !== null
          && !priceAlreadySet
          && Math.abs(current.priceLyd - Number(row.expected_price_lyd)) > 0.001) {
        await settle("conflict", "XY selling price changed since this edit; manual review required.");
        summary.conflict++; continue;
      }
      if (row.update_stock && current.currentQty !== row.expected_xy_qty) {
        await settle("conflict", "XY stock changed since the operator saved the quantity. Recheck; no stale overwrite.");
        summary.conflict++; continue;
      }
      const desiredQty = row.update_stock ? row.target_qty : current.currentQty;

      const result = await setXySlotProduct({
        vmsMachineId: row.vms_machine_id,
        slotCode: row.slot_code,
        vmsProductId: row.expected_vms_product_id,
        priceLyd: desiredPrice,
        stockQty: desiredQty,
      });
      if (!result.accepted) {
        if (isOffline(String(result.message ?? ""))) {
          await settle("pending", "Machine is offline; will retry.");
          summary.offline++;
        } else {
          await settle("conflict", `XY rejected stock update: ${result.message ?? result.code ?? "unknown"}`);
          summary.conflict++;
        }
        continue;
      }

      const verified = await verifyXySlot({
        vmsMachineId: row.vms_machine_id,
        slotCode: row.slot_code,
        expectedVmsProductId: row.expected_vms_product_id,
        expectedPriceLyd: desiredPrice,
        expectedStockQty: desiredQty,
      });
      if (!verified.verified) {
        await settle("pending", "XY accepted the selection update; readback pending.");
        summary.waiting++; continue;
      }
      await settle("verified", null);
      summary.verified++;
    } catch (cause) {
      console.warn("[xy-stop-quantities] Retrying stock sync failed", {
        id: row.id, routeId: row.route_id, slotCode: row.slot_code,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      await settle("pending", cause instanceof Error ? cause.message : "Unable to reach XY");
      summary.errors++;
    }
  }
  return summary;
}
