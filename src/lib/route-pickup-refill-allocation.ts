export type PickupRefillLine = {
  id: string;
  machineId: string | null;
  productId: string;
  plannedQty: number;
};

export type PickupRefillItem = {
  machineId: string | null;
  productId: string;
  quantity: number;
  actionType?: "planned_pick" | "extra_product";
};

export type PickupRefillLinePick = {
  id: string;
  picked_qty: number;
};

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function machineProductKey(machineId: string | null | undefined, productId: string) {
  return `${machineId ?? ""}:${productId}`;
}

/**
 * Reconciles the current, machine-level pickup checklist with legacy refill rows.
 *
 * A checked quantity is allowed to differ from the old recommendation. When it
 * exceeds the recommendation, the final matching refill row receives the
 * remainder so no checked units disappear. Quantities are grouped before they
 * are allocated so a refill row is emitted at most once.
 */
export function buildRefillLinePickRows({
  stopItems,
  legacyItems,
  refillLines,
}: {
  stopItems: PickupRefillItem[];
  legacyItems: Omit<PickupRefillItem, "machineId" | "actionType">[];
  refillLines: PickupRefillLine[];
}): PickupRefillLinePick[] {
  const uniqueLines = new Map<string, PickupRefillLine>();
  refillLines.forEach((line) => {
    const id = String(line.id ?? "").trim();
    const productId = String(line.productId ?? "").trim();
    if (!id || !productId || uniqueLines.has(id)) return;
    uniqueLines.set(id, {
      id,
      machineId: line.machineId ? String(line.machineId) : null,
      productId,
      plannedQty: unitQuantity(line.plannedQty),
    });
  });

  const linesByMachineProduct = new Map<string, PickupRefillLine[]>();
  const linesByProduct = new Map<string, PickupRefillLine[]>();
  uniqueLines.forEach((line) => {
    const machineKey = machineProductKey(line.machineId, line.productId);
    linesByMachineProduct.set(machineKey, [...(linesByMachineProduct.get(machineKey) ?? []), line]);
    linesByProduct.set(line.productId, [...(linesByProduct.get(line.productId) ?? []), line]);
  });

  const pickedByMachineProduct = new Map<string, { machineId: string | null; productId: string; quantity: number }>();
  stopItems
    .filter((item) => item.actionType !== "extra_product")
    .forEach((item) => {
      const productId = String(item.productId ?? "").trim();
      if (!productId) return;
      const machineId = item.machineId ? String(item.machineId) : null;
      const key = machineProductKey(machineId, productId);
      const current = pickedByMachineProduct.get(key);
      pickedByMachineProduct.set(key, {
        machineId,
        productId,
        quantity: (current?.quantity ?? 0) + unitQuantity(item.quantity),
      });
    });

  const pickedByLineId = new Map<string, number>();
  const allocate = (quantity: number, lines: PickupRefillLine[]) => {
    let remaining = unitQuantity(quantity);
    lines.forEach((line, index) => {
      const isLast = index === lines.length - 1;
      const pickedQty = isLast ? remaining : Math.min(remaining, unitQuantity(line.plannedQty));
      remaining -= pickedQty;
      pickedByLineId.set(line.id, (pickedByLineId.get(line.id) ?? 0) + pickedQty);
    });
  };

  pickedByMachineProduct.forEach((item) => {
    allocate(item.quantity, linesByMachineProduct.get(machineProductKey(item.machineId, item.productId)) ?? []);
  });

  legacyItems.forEach((item) => {
    const productId = String(item.productId ?? "").trim();
    if (!productId) return;
    allocate(unitQuantity(item.quantity), linesByProduct.get(productId) ?? []);
  });

  return Array.from(pickedByLineId.entries())
    .map(([id, picked_qty]) => ({ id, picked_qty }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
