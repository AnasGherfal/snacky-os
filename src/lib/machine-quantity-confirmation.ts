export type MachineQuantityAllocation = {
  machine_slot_id?: string | null;
  slot_code?: string | null;
  current_qty?: unknown;
  final_take_qty?: unknown;
  recommended_take_qty?: unknown;
};

export type MachineQuantitySourceItem = {
  productId: string;
  productName: string;
  slotCode?: string | null;
  machineSlotId?: string | null;
  currentQty?: unknown;
  assignedQty?: unknown;
  filledQty?: unknown;
  slotAllocations?: MachineQuantityAllocation[] | null;
};

export type MachineQuantityRow = {
  productId: string;
  productName: string;
  machineSlotId: string | null;
  slotCode: string;
  previousQty: number;
  addedQty: number;
  finalQty: number;
};

export type MachineQuantityPlanRow = {
  product_id?: unknown;
  machine_slot_id?: unknown;
  slot_code?: unknown;
  planned_quantity?: unknown;
  slot_allocations?: unknown;
  product?: { name?: unknown } | { name?: unknown }[] | null;
};

export type MachineQuantityFilledItem = {
  productId?: unknown;
  quantity?: unknown;
};

export const MACHINE_QUANTITY_READY_STATUSES = [
  "xy_screenshot_saved",
  "offline_pending",
  "owner_completed",
] as const;

export type MachineQuantityVerificationStatus =
  | "legacy_confirmed"
  | (typeof MACHINE_QUANTITY_READY_STATUSES)[number];

export type MachineQuantityEvidenceFile = {
  photoUrl: string | null;
  photoPath: string | null;
  originalName: string | null;
  uploadedAt: string;
};

export function machineQuantityEvidenceReady(status: unknown) {
  return MACHINE_QUANTITY_READY_STATUSES.includes(String(status ?? "") as (typeof MACHINE_QUANTITY_READY_STATUSES)[number]);
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function allocationsFor(item: MachineQuantitySourceItem): MachineQuantityAllocation[] {
  const allocations = Array.isArray(item.slotAllocations)
    ? item.slotAllocations.filter((allocation) => allocation && typeof allocation === "object")
    : [];
  if (allocations.length) return allocations;
  return [{
    machine_slot_id: item.machineSlotId ?? null,
    slot_code: item.slotCode ?? null,
    current_qty: item.currentQty ?? 0,
    final_take_qty: item.assignedQty ?? item.filledQty ?? 0,
  }];
}

/**
 * Turns a product-level refill result into the exact machine selections that
 * need their programmed quantity updated. The saved route allocation order is
 * preserved so a partial fill produces the same deterministic rows on the
 * phone and during server-side completion verification.
 */
export function buildMachineQuantityRows(items: MachineQuantitySourceItem[]): MachineQuantityRow[] {
  const rows: MachineQuantityRow[] = [];

  items.forEach((item) => {
    let remaining = unitQuantity(item.filledQty);
    const allocations = allocationsFor(item);

    allocations.forEach((allocation, index) => {
      const plannedAddition = unitQuantity(allocation.final_take_qty ?? allocation.recommended_take_qty);
      const isLast = index === allocations.length - 1;
      const addedQty = isLast ? remaining : Math.min(remaining, plannedAddition);
      remaining -= addedQty;
      if (addedQty <= 0) return;

      const previousQty = unitQuantity(allocation.current_qty);
      rows.push({
        productId: clean(item.productId),
        productName: clean(item.productName) || "Unknown product",
        machineSlotId: clean(allocation.machine_slot_id) || null,
        slotCode: clean(allocation.slot_code) || clean(item.slotCode) || "VMS",
        previousQty,
        addedQty,
        finalQty: previousQty + addedQty,
      });
    });
  });

  return rows.sort((left, right) => (
    left.slotCode.localeCompare(right.slotCode, undefined, { numeric: true })
    || left.productId.localeCompare(right.productId)
  ));
}

export function buildMachineQuantitySourcesFromPlan(
  planRows: MachineQuantityPlanRow[],
  filledItems: MachineQuantityFilledItem[],
) {
  const filledByProduct = new Map<string, number>();
  filledItems.forEach((item) => {
    const productId = clean(item.productId);
    if (!productId) return;
    filledByProduct.set(productId, (filledByProduct.get(productId) ?? 0) + unitQuantity(item.quantity));
  });

  const grouped = new Map<string, MachineQuantitySourceItem>();
  planRows.forEach((plan) => {
    const productId = clean(plan.product_id);
    if (!productId) return;
    const relation = Array.isArray(plan.product) ? plan.product[0] : plan.product;
    const parsedAllocations = Array.isArray(plan.slot_allocations)
      ? plan.slot_allocations.filter((value): value is MachineQuantityAllocation => Boolean(value && typeof value === "object"))
      : [];
    const fallbackAllocation: MachineQuantityAllocation = {
      machine_slot_id: clean(plan.machine_slot_id) || null,
      slot_code: clean(plan.slot_code) || null,
      current_qty: 0,
      final_take_qty: unitQuantity(plan.planned_quantity),
    };
    const current = grouped.get(productId) ?? {
      productId,
      productName: clean(relation?.name) || "Unknown product",
      slotCode: clean(plan.slot_code) || null,
      machineSlotId: clean(plan.machine_slot_id) || null,
      currentQty: 0,
      assignedQty: 0,
      filledQty: filledByProduct.get(productId) ?? 0,
      slotAllocations: [],
    };
    current.assignedQty = unitQuantity(current.assignedQty) + unitQuantity(plan.planned_quantity);
    current.slotAllocations = [...(current.slotAllocations ?? []), ...(parsedAllocations.length ? parsedAllocations : [fallbackAllocation])];
    grouped.set(productId, current);
  });

  return Array.from(grouped.values());
}

export function machineQuantityConfirmationKey(rows: MachineQuantityRow[]) {
  return JSON.stringify(rows.map((row) => ({
    product_id: row.productId,
    machine_slot_id: row.machineSlotId,
    slot_code: row.slotCode,
    previous_qty: row.previousQty,
    added_qty: row.addedQty,
    final_qty: row.finalQty,
  })));
}
