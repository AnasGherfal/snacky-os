import type { MachineQuantityRow } from "@/lib/machine-quantity-confirmation";
import type { XySlotState } from "@/lib/xy-vms-control";

export type XyQuantityMismatch = {
  slotCode: string;
  expectedQty: number;
  actualQty: number | null;
  reason:
    | "missing_slot"
    | "quantity_mismatch"
    | "generic_slot"
    | "duplicate_slot"
    | "product_mismatch"
    | "unmapped_product";
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Read-only comparison: this function never sends XY commands and never
 * treats a product's combined stock as proof that each sellable selection works.
 * Optional mapping makes the PRODUCT assigned to the selection part of proof.
 */
export function verifyMachineQuantityRowsAgainstXy(
  rows: MachineQuantityRow[],
  layout: XySlotState[],
  productByVmsId?: ReadonlyMap<string, string>,
) {
  const bySlot = new Map(layout.map((row) => [clean(row.slotCode), row]));
  const seenSlots = new Set<string>();
  const mismatches: XyQuantityMismatch[] = [];

  for (const row of rows) {
    const slotCode = clean(row.slotCode);
    const failure = (reason: XyQuantityMismatch["reason"], actualQty: number | null = null) =>
      mismatches.push({ slotCode: slotCode || "VMS", expectedQty: row.finalQty, actualQty, reason });

    if (!slotCode || ["VMS", "VMS item"].includes(slotCode)) {
      failure("generic_slot");
      continue;
    }
    if (seenSlots.has(slotCode)) {
      failure("duplicate_slot");
      continue;
    }
    seenSlots.add(slotCode);

    const live = bySlot.get(slotCode);
    if (!live) {
      failure("missing_slot");
      continue;
    }
    if (productByVmsId) {
      const mappedProductId = productByVmsId.get(clean(live.vmsProductId));
      if (!mappedProductId) {
        failure("unmapped_product", live.currentQty);
        continue;
      }
      if (clean(row.productId) !== mappedProductId) {
        failure("product_mismatch", live.currentQty);
        continue;
      }
    }
    if (live.currentQty === null || Number(live.currentQty) !== Number(row.finalQty)) {
      failure("quantity_mismatch", live.currentQty);
    }
  }
  return { verified: rows.length > 0 && mismatches.length === 0, mismatches };
}
