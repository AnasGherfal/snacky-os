import "server-only";

import type { MachineQuantityRow } from "@/lib/machine-quantity-confirmation";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot } from "@/lib/xy-vms-control";

type DbClient = {
  from: (table: string) => any;
};

export type XySyncMachineQuantityRow = MachineQuantityRow & {
  /**
   * Live XY stock observed before this refill was first pushed.
   * Stored before the external write so a retry never adds the refill twice.
   */
  xySyncBaseQty?: number;
  /**
   * Absolute XY stock target for this refill. Once assigned, it is immutable
   * for this saved confirmation and all later retries.
   */
  xySyncTargetQty?: number;
};

export type XyQuantitySyncRowResult = {
  slotCode: string;
  expectedQty: number;
  actualQty: number | null;
  status: "verified" | "already_synced" | "pending" | "blocked";
  message: string | null;
};

export type XyQuantitySyncResult = {
  status: "verified" | "pending" | "blocked";
  rows: XyQuantitySyncRowResult[];
  message: string | null;
};

export type XyQuantityPreparationResult = {
  status: "prepared" | "pending" | "blocked";
  rows: XySyncMachineQuantityRow[];
  message: string | null;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function safeUnit(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function firstMessage(results: XyQuantitySyncRowResult[]) {
  return results.find((row) => row.status === "blocked")?.message
    ?? results.find((row) => row.status === "pending")?.message
    ?? null;
}

export async function loadConfirmedXyProductIds(client: DbClient, productIds: string[]) {
  const ids = Array.from(new Set(productIds.map(clean).filter(Boolean)));
  const byProductId = new Map<string, string>();
  if (!ids.length) return byProductId;

  const { data, error } = await client
    .from("vms_product_mappings")
    .select("product_id, vms_product_id, last_seen_at")
    .in("product_id", ids)
    .eq("match_status", "confirmed")
    .not("vms_product_id", "is", null)
    .order("last_seen_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  for (const row of data ?? []) {
    const productId = clean(row.product_id);
    const vmsProductId = clean(row.vms_product_id);
    if (productId && vmsProductId && !byProductId.has(productId)) {
      byProductId.set(productId, vmsProductId);
    }
  }
  return byProductId;
}

function blockedPreparation(
  rows: XySyncMachineQuantityRow[],
  message: string,
): XyQuantityPreparationResult {
  return { status: "blocked", rows, message };
}

/**
 * Convert "operator physically added N" into an immutable absolute XY target.
 *
 * This happens before any external XY write and the caller must persist the
 * returned rows before calling applyPreparedMachineQuantityRowsToXy().
 *
 * Why:
 * - Route planning stock can be stale because sales may happen before refill.
 * - An offline machine may come back and sell before the next retry.
 * - A network/app failure after an XY write must not add the same refill twice.
 *
 * The first time XY is reachable we snapshot live stock and set:
 *   xySyncTargetQty = live stock + operator added quantity
 * Later retries reuse that exact target instead of recalculating it.
 */
export async function prepareMachineQuantityRowsForXy(args: {
  vmsMachineId: string;
  rows: XySyncMachineQuantityRow[];
  expectedVmsProductIds: Map<string, string>;
}): Promise<XyQuantityPreparationResult> {
  if (!args.rows.length) return { status: "prepared", rows: [], message: null };

  const alreadyPrepared = args.rows.every((row) => safeUnit(row.xySyncTargetQty) !== null);
  if (alreadyPrepared) {
    return { status: "prepared", rows: args.rows, message: null };
  }

  let liveLayout;
  try {
    liveLayout = await readXyMachineLayout(args.vmsMachineId);
  } catch (error) {
    return {
      status: "pending",
      rows: args.rows,
      message: error instanceof Error ? error.message : "XY is not reachable right now.",
    };
  }

  const prepared: XySyncMachineQuantityRow[] = [];

  for (const row of args.rows) {
    const existingTarget = safeUnit(row.xySyncTargetQty);
    if (existingTarget !== null) {
      prepared.push(row);
      continue;
    }

    const slotCode = clean(row.slotCode);
    if (!slotCode || slotCode === "VMS" || slotCode === "VMS item") {
      return blockedPreparation(args.rows, "A refill row is not linked to a specific XY slot.");
    }

    const live = liveLayout.find((slot) => clean(slot.slotCode) === slotCode) ?? null;
    if (!live) {
      return blockedPreparation(args.rows, `XY no longer reports slot ${slotCode}.`);
    }

    const expectedVmsProductId = args.expectedVmsProductIds.get(row.productId) ?? "";
    if (!expectedVmsProductId) {
      return blockedPreparation(args.rows, `${row.productName} does not have a confirmed XY product mapping.`);
    }
    if (clean(live.vmsProductId) !== expectedVmsProductId) {
      return blockedPreparation(
        args.rows,
        `Slot ${slotCode} contains a different XY product than the Snacky refill plan. No quantity was changed.`,
      );
    }

    const priceLyd = Number(live.priceLyd);
    if (!Number.isFinite(priceLyd) || priceLyd <= 0) {
      return blockedPreparation(args.rows, `XY does not report a reliable selling price for slot ${slotCode}.`);
    }

    const liveQty = safeUnit(live.currentQty);
    if (liveQty === null) {
      return {
        status: "pending",
        rows: args.rows,
        message: `XY does not report a reliable stock quantity for slot ${slotCode} yet.`,
      };
    }

    const addedQty = safeUnit(row.addedQty);
    if (addedQty === null || addedQty <= 0) {
      return blockedPreparation(args.rows, `Snacky has no valid refill quantity for slot ${slotCode}.`);
    }

    prepared.push({
      ...row,
      xySyncBaseQty: liveQty,
      xySyncTargetQty: liveQty + addedQty,
    });
  }

  return { status: "prepared", rows: prepared, message: null };
}

/**
 * Apply rows whose immutable XY target has already been persisted.
 *
 * The function always re-reads the live lane before writing, preserves the
 * current XY product/price, and verifies product + price + target stock after
 * the write. It never recalculates the target on a retry.
 */
export async function applyPreparedMachineQuantityRowsToXy(args: {
  vmsMachineId: string;
  rows: XySyncMachineQuantityRow[];
  expectedVmsProductIds: Map<string, string>;
}): Promise<XyQuantitySyncResult> {
  if (!args.rows.length) return { status: "verified", rows: [], message: null };

  if (args.rows.some((row) => safeUnit(row.xySyncTargetQty) === null)) {
    return {
      status: "blocked",
      message: "The saved refill does not have a persisted XY target yet.",
      rows: args.rows.map((row) => ({
        slotCode: row.slotCode,
        expectedQty: safeUnit(row.xySyncTargetQty) ?? row.finalQty,
        actualQty: null,
        status: "blocked",
        message: "The saved refill does not have a persisted XY target yet.",
      })),
    };
  }

  let liveLayout;
  try {
    liveLayout = await readXyMachineLayout(args.vmsMachineId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "XY is not reachable right now.";
    return {
      status: "pending",
      message,
      rows: args.rows.map((row) => ({
        slotCode: row.slotCode,
        expectedQty: safeUnit(row.xySyncTargetQty) ?? row.finalQty,
        actualQty: null,
        status: "pending",
        message,
      })),
    };
  }

  const results: XyQuantitySyncRowResult[] = [];

  for (const row of args.rows) {
    const slotCode = clean(row.slotCode);
    const targetQty = safeUnit(row.xySyncTargetQty);
    if (!slotCode || targetQty === null) {
      results.push({
        slotCode: slotCode || "VMS",
        expectedQty: targetQty ?? row.finalQty,
        actualQty: null,
        status: "blocked",
        message: "This saved refill is missing a valid XY slot or target quantity.",
      });
      continue;
    }

    const live = liveLayout.find((slot) => clean(slot.slotCode) === slotCode) ?? null;
    if (!live) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: null,
        status: "blocked",
        message: `XY no longer reports slot ${slotCode}.`,
      });
      continue;
    }

    const expectedVmsProductId = args.expectedVmsProductIds.get(row.productId) ?? "";
    if (!expectedVmsProductId) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: live.currentQty,
        status: "blocked",
        message: `${row.productName} does not have a confirmed XY product mapping.`,
      });
      continue;
    }
    if (clean(live.vmsProductId) !== expectedVmsProductId) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: live.currentQty,
        status: "blocked",
        message: `Slot ${slotCode} contains a different XY product than the saved Snacky refill. No quantity was changed.`,
      });
      continue;
    }

    const priceLyd = Number(live.priceLyd);
    if (!Number.isFinite(priceLyd) || priceLyd <= 0) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: live.currentQty,
        status: "blocked",
        message: `XY does not report a reliable selling price for slot ${slotCode}.`,
      });
      continue;
    }

    const currentQty = safeUnit(live.currentQty);
    if (currentQty === null) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: live.currentQty,
        status: "pending",
        message: `XY does not report a reliable stock quantity for slot ${slotCode} yet.`,
      });
      continue;
    }

    if (currentQty === targetQty) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: currentQty,
        status: "already_synced",
        message: null,
      });
      continue;
    }

    try {
      const write = await setXySlotProduct({
        vmsMachineId: args.vmsMachineId,
        slotCode,
        vmsProductId: expectedVmsProductId,
        priceLyd,
        stockQty: targetQty,
      });

      if (!write.accepted) {
        results.push({
          slotCode,
          expectedQty: targetQty,
          actualQty: currentQty,
          status: "pending",
          message: write.message
            ? `XY rejected slot ${slotCode}: ${write.message}`
            : `XY did not accept the stock update for slot ${slotCode}.`,
        });
        continue;
      }

      const verification = await verifyXySlot({
        vmsMachineId: args.vmsMachineId,
        slotCode,
        expectedVmsProductId,
        expectedPriceLyd: priceLyd,
        expectedStockQty: targetQty,
      });

      if (!verification.verified) {
        results.push({
          slotCode,
          expectedQty: targetQty,
          actualQty: verification.state?.currentQty ?? null,
          status: "pending",
          message: `XY accepted slot ${slotCode}, but the machine has not confirmed the new quantity yet.`,
        });
        continue;
      }

      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: verification.state?.currentQty ?? targetQty,
        status: "verified",
        message: null,
      });
    } catch (error) {
      results.push({
        slotCode,
        expectedQty: targetQty,
        actualQty: currentQty,
        status: "pending",
        message: error instanceof Error ? error.message : `Could not update slot ${slotCode} in XY.`,
      });
    }
  }

  const hasBlocked = results.some((row) => row.status === "blocked");
  const hasPending = results.some((row) => row.status === "pending");
  return {
    status: hasBlocked ? "blocked" : hasPending ? "pending" : "verified",
    rows: results,
    message: firstMessage(results),
  };
}
