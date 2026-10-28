import type { TrainingLane, TrainingProduct, TrainingStop } from "../components/testing-lab/TrainingRouteClient";

export type QaMachineSnapshot = {
  id: string; name: string; machineCode: string;
  slots: Array<{
    slotCode: string; productId: string | null; productName: string;
    currentQty: number | null; capacity: number | null; priceLyd: number; capturedAt: string | null;
  }>;
};
export type QaReadOnlySnapshot = {
  ok: boolean; error?: string; capturedAt: string | null;
  machines: QaMachineSnapshot[];
};
export type QaOmittedSelection = {
  machineCode: string;
  slotCode: string;
  reason: "unknown_quantity" | "unknown_capacity" | "invalid_stock" | "unknown_price";
};

/**
 * Simulated training never fills missing XY data with zero or an invented price/
 * capacity. Excluded selections remain a visible unverified list, not a pretend
 * empty lane or a recommended product pickup. No DB/XY writes occur here.
 */
export function buildRealMachineTrainingFixture(snapshot: QaReadOnlySnapshot): {
  stops: TrainingStop[];
  products: TrainingProduct[];
  capturedAt: string | null;
  omitted: QaOmittedSelection[];
} {
  if (!Array.isArray(snapshot.machines) || snapshot.machines.length === 0) {
    throw new Error("No verified machines in the XY training snapshot.");
  }
  const byProduct = new Map<string, TrainingProduct>();
  const omitted: QaOmittedSelection[] = [];
  const stops: TrainingStop[] = snapshot.machines.map(machine => {
    let planned = 0;
    const lanes: TrainingLane[] = [];
    for (const slot of machine.slots) {
      const quantityKnown = typeof slot.currentQty === "number" &&
        Number.isSafeInteger(slot.currentQty) && slot.currentQty >= 0;
      const capacityKnown = typeof slot.capacity === "number" &&
        Number.isSafeInteger(slot.capacity) && slot.capacity > 0 && slot.capacity <= 500;
      const reason: QaOmittedSelection["reason"] | null =
        !quantityKnown ? "unknown_quantity"
          : !capacityKnown ? "unknown_capacity"
            : slot.currentQty! > slot.capacity! ? "invalid_stock"
              : !Number.isFinite(slot.priceLyd) || slot.priceLyd <= 0
                ? "unknown_price" : null;
      if (reason) {
        omitted.push({ machineCode: machine.machineCode, slotCode: slot.slotCode, reason });
        continue;
      }
      // Quantity and capacity have already passed strict integer and bound
      // checks; their non-null assertions do NOT stand in for default values.
      const capacity = slot.capacity!;
      const starting = slot.currentQty!;
      const productId = slot.productId ?? `unmapped:${machine.id}:${slot.slotCode}`;
      if (!byProduct.has(productId)) {
        byProduct.set(productId, { id: productId, en: slot.productName, ar: slot.productName });
      }
      const needed = Math.max(0, Math.min(6, capacity - starting));
      const plannedAdd = planned < 6 && slot.productId && needed >= 2 && starting < Math.floor(capacity * 0.75)
        ? needed : 0;
      if (plannedAdd > 0) planned++;
      lanes.push({
        code: slot.slotCode, productId, originalProductId: productId,
        initialQty: starting, plannedAdd, actualAdd: 0,
        capacity, xyQty: starting, xyProductId: productId,
        priceLyd: slot.priceLyd, oldStockHandled: false,
      });
    }
    if (lanes.length === 0) {
      throw new Error(`No verified XY selection quantities, capacities and prices for machine ${machine.machineCode}.`);
    }
    return {
      id: machine.id, name: machine.name, location: "Tripoli", machineCode: machine.machineCode,
      status: "assigned" as const, xyPending: false, pendingReason: "", cleaningDone: false,
      photoReady: false, note: "", verifiedAt: null, issues: [], lanes,
    };
  });
  return { stops, products: [...byProduct.values()], capturedAt: snapshot.capturedAt, omitted };
}
