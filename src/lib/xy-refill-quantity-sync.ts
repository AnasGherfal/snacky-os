import "server-only";

import type { MachineQuantityRow } from "@/lib/machine-quantity-confirmation";
import { readXyMachineLayout, setXySlotProduct, verifyXySlot } from "@/lib/xy-vms-control";

type DbClient = {
  from: (table: string) => any;
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

function clean(value: unknown) {
  return String(value ?? "").trim();
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

/**
 * Push the post-refill stock numbers from Snacky OS into XY.
 *
 * Safety rules:
 * - Never guess a lane, product, price, or stock value.
 * - Preserve the product and selling price currently programmed in XY.
 * - Refuse to write when the Snacky product mapping does not match the live lane.
 * - Re-read XY after every accepted write and only report "verified" after
 *   product, price, and stock all match.
 * - A retry first reads live XY, making the operation safe to resume after a
 *   timeout or an app close without blindly duplicating a write.
 */
export async function syncMachineQuantityRowsToXy(args: {
  vmsMachineId: string;
  rows: MachineQuantityRow[];
  expectedVmsProductIds: Map<string, string>;
}): Promise<XyQuantitySyncResult> {
  if (!args.rows.length) return { status: "verified", rows: [], message: null };

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
        expectedQty: row.finalQty,
        actualQty: null,
        status: "pending",
        message,
      })),
    };
  }

  const results: XyQuantitySyncRowResult[] = [];

  for (const row of args.rows) {
    const slotCode = clean(row.slotCode);
    if (!slotCode || slotCode === "VMS" || slotCode === "VMS item") {
      results.push({
        slotCode: slotCode || "VMS",
        expectedQty: row.finalQty,
        actualQty: null,
        status: "blocked",
        message: "This refill row is not linked to a specific XY slot.",
      });
      continue;
    }

    const live = liveLayout.find((slot) => clean(slot.slotCode) === slotCode) ?? null;
    if (!live) {
      results.push({
        slotCode,
        expectedQty: row.finalQty,
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
        expectedQty: row.finalQty,
        actualQty: live.currentQty,
        status: "blocked",
        message: `${row.productName} does not have a confirmed XY product mapping.`,
      });
      continue;
    }

    if (clean(live.vmsProductId) !== expectedVmsProductId) {
      results.push({
        slotCode,
        expectedQty: row.finalQty,
        actualQty: live.currentQty,
        status: "blocked",
        message: `Slot ${slotCode} contains a different XY product than the Snacky refill plan. No quantity was changed.`,
      });
      continue;
    }

    const priceLyd = Number(live.priceLyd);
    if (!Number.isFinite(priceLyd) || priceLyd <= 0) {
      results.push({
        slotCode,
        expectedQty: row.finalQty,
        actualQty: live.currentQty,
        status: "blocked",
        message: `XY does not report a reliable selling price for slot ${slotCode}.`,
      });
      continue;
    }

    const currentQty = Number(live.currentQty);
    if (!Number.isSafeInteger(currentQty) || currentQty < 0) {
      results.push({
        slotCode,
        expectedQty: row.finalQty,
        actualQty: live.currentQty,
        status: "pending",
        message: `XY does not report a reliable stock quantity for slot ${slotCode} yet.`,
      });
      continue;
    }

    if (currentQty === row.finalQty) {
      results.push({
        slotCode,
        expectedQty: row.finalQty,
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
        stockQty: row.finalQty,
      });

      if (!write.accepted) {
        results.push({
          slotCode,
          expectedQty: row.finalQty,
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
        expectedStockQty: row.finalQty,
      });

      if (!verification.verified) {
        results.push({
          slotCode,
          expectedQty: row.finalQty,
          actualQty: verification.state?.currentQty ?? null,
          status: "pending",
          message: `XY accepted slot ${slotCode}, but the machine has not confirmed the new quantity yet.`,
        });
        continue;
      }

      results.push({
        slotCode,
        expectedQty: row.finalQty,
        actualQty: verification.state?.currentQty ?? row.finalQty,
        status: "verified",
        message: null,
      });
    } catch (error) {
      results.push({
        slotCode,
        expectedQty: row.finalQty,
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
