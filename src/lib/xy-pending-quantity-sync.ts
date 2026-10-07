import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  loadConfirmedXyProductIds,
  syncMachineQuantityRowsToXy,
  type XySyncMachineQuantityRow,
} from "@/lib/xy-refill-quantity-sync";

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown XY synchronization error");
}

export async function retryPendingXyQuantitySyncs(limit = 20) {
  const admin = getSupabaseAdminClient();
  if (!admin) return { attempted: 0, verified: 0, pending: 0, failed: 0, skipped: true, reason: "Supabase admin client unavailable." };

  const { data, error } = await admin
    .from("route_stop_quantity_confirmations")
    .select("id, route_id, route_stop_id, machine_id, quantity_rows, verification_status, sync_attempt_count, updated_at, machine:machines(id, name, machine_code, vms_machine_id)")
    .in("verification_status", ["offline_pending", "xy_sync_pending"])
    .eq("auto_sync_eligible", true)
    .order("last_sync_attempt_at", { ascending: true, nullsFirst: true })
    .order("submitted_at", { ascending: true })
    .limit(Math.max(1, Math.min(100, limit)));

  if (error) throw error;

  let verified = 0;
  let pending = 0;
  let failed = 0;

  for (const record of data ?? []) {
    const rows = Array.isArray(record.quantity_rows) ? record.quantity_rows as XySyncMachineQuantityRow[] : [];
    const machine = relation(record.machine as any);
    const vmsMachineId = String(machine?.vms_machine_id ?? "").trim();
    const attemptedAt = new Date().toISOString();
    const nextAttemptCount = Number(record.sync_attempt_count ?? 0) + 1;

    if (!vmsMachineId || !rows.length) {
      failed += 1;
      await admin
        .from("route_stop_quantity_confirmations")
        .update({
          verification_status: "xy_sync_pending",
          sync_attempt_count: nextAttemptCount,
          last_sync_attempt_at: attemptedAt,
          last_sync_error: !vmsMachineId ? "Machine is not linked to an XY machine id." : "Saved refill has no lane quantities to synchronize.",
          auto_sync_eligible: false,
          updated_at: attemptedAt,
        })
        .eq("id", record.id);
      continue;
    }

    try {
      const mappings = await loadConfirmedXyProductIds(admin as any, rows.map((row) => row.productId));
      const result = await syncMachineQuantityRowsToXy({
        vmsMachineId,
        rows,
        expectedVmsProductIds: mappings,
        persistPrepared: async (preparedRows) => {
          const { data: claimed, error: targetSaveError } = await admin
            .from("route_stop_quantity_confirmations")
            .update({
              quantity_rows: preparedRows,
              verification_status: "xy_sync_pending",
              auto_sync_eligible: true,
              updated_at: attemptedAt,
            })
            .eq("id", record.id)
            .eq("updated_at", record.updated_at)
            .in("verification_status", ["offline_pending", "xy_sync_pending"])
            .select("quantity_rows")
            .maybeSingle();
          if (targetSaveError) throw targetSaveError;
          if (claimed?.quantity_rows && Array.isArray(claimed.quantity_rows)) {
            return claimed.quantity_rows as XySyncMachineQuantityRow[];
          }

          const { data: current, error: currentError } = await admin
            .from("route_stop_quantity_confirmations")
            .select("quantity_rows")
            .eq("id", record.id)
            .single();
          if (currentError) throw currentError;
          const canonicalRows = Array.isArray(current.quantity_rows)
            ? current.quantity_rows as XySyncMachineQuantityRow[]
            : [];
          if (!canonicalRows.length) throw new Error("The saved refill target changed during XY synchronization.");
          return canonicalRows;
        },
      });

      if (result.status === "verified") {
        verified += 1;
        const { error: updateError } = await admin
          .from("route_stop_quantity_confirmations")
          .update({
            verification_status: "xy_api_verified",
            quantity_rows: result.quantityRows ?? rows,
            offline_reason: null,
            sync_attempt_count: nextAttemptCount,
            last_sync_attempt_at: attemptedAt,
            last_sync_error: null,
            auto_sync_eligible: false,
            resolved_at: attemptedAt,
            updated_at: attemptedAt,
          })
          .eq("id", record.id)
          .in("verification_status", ["offline_pending", "xy_sync_pending"]);
        if (updateError) throw updateError;
      } else {
        pending += 1;
        const { error: updateError } = await admin
          .from("route_stop_quantity_confirmations")
          .update({
            verification_status: "xy_sync_pending",
            quantity_rows: result.quantityRows ?? rows,
            sync_attempt_count: nextAttemptCount,
            last_sync_attempt_at: attemptedAt,
            last_sync_error: result.message ?? "XY has not confirmed this refill yet.",
            auto_sync_eligible: result.status === "pending",
            updated_at: attemptedAt,
          })
          .eq("id", record.id)
          .in("verification_status", ["offline_pending", "xy_sync_pending"]);
        if (updateError) throw updateError;
      }
    } catch (syncError) {
      failed += 1;
      const message = errorMessage(syncError).slice(0, 1000);
      await admin
        .from("route_stop_quantity_confirmations")
        .update({
          verification_status: "xy_sync_pending",
          sync_attempt_count: nextAttemptCount,
          last_sync_attempt_at: attemptedAt,
          last_sync_error: message,
          updated_at: attemptedAt,
        })
        .eq("id", record.id)
        .in("verification_status", ["offline_pending", "xy_sync_pending"]);
    }
  }

  return {
    attempted: (data ?? []).length,
    verified,
    pending,
    failed,
    skipped: false,
  };
}
