/**
 * The machine product picker must reflect the latest VERIFIED XY slot product,
 * not an old slot's product left behind in machine_slots.
 *
 * This is a read-model only. No machine slot assignments, stock quantities,
 * product mappings or route reservations are edited here.
 */
export type RoutePlanogramSlot = {
  id: string;
  machine_id: string;
  slot_code: string | null;
  product_id: string | null;
  par_qty: number | null;
  min_qty: number | null;
};
export type VerifiedMachineStockSlot = {
  id: string;
  machine_id: string | null;
  slot_code: string | null;
  product_id: string | null;
  vms_product_name?: string | null;
  current_qty?: number | null;
  capacity: number | null;
};
export type UnmappedMachineXySlot = {
  machineId: string;
  slotCode: string;
  xyProductName: string;
  currentQty: number | null;
  capacity: number | null;
};

const slotKey = (machineId: unknown, slotCode: unknown) =>
  String(machineId ?? "").trim() + ":" + String(slotCode ?? "").trim();

const xyPhysicalLane = (value: unknown) => {
  const str = String(value ?? "").trim();
  return /^\d{1,3}$/.test(str) && Number(str) >= 1 && Number(str) <= 60;
};

export function reconcileRoutePlanogramToVerifiedXy({
  planogram,
  latestXy,
}: {
  planogram: readonly RoutePlanogramSlot[];
  latestXy: readonly VerifiedMachineStockSlot[];
}): { rows: RoutePlanogramSlot[]; unmapped: UnmappedMachineXySlot[] } {
  const latestBySlot = new Map(
    latestXy.filter(row => row.machine_id && xyPhysicalLane(row.slot_code))
      .map(row => [slotKey(row.machine_id, row.slot_code), row]),
  );
  const merged = new Map<string, RoutePlanogramSlot>();

  // Preserve old planogram rows only if there is no current XY slot.
  // When XY says a different product or an unmapped one, the old planogram
  // identity must NOT be shown as if it is currently in the machine.
  for (const row of planogram) {
    if (!row.machine_id || !xyPhysicalLane(row.slot_code)) continue;
    const key = slotKey(row.machine_id, row.slot_code);
    const fresh = latestBySlot.get(key);
    merged.set(key, fresh
      ? { ...row, product_id: fresh.product_id, par_qty: fresh.capacity ?? row.par_qty }
      : row);
  }

  for (const [key, latest] of latestBySlot.entries()) {
    if (merged.has(key)) continue;
    merged.set(key, {
      id: `xy-${latest.id}`,
      machine_id: latest.machine_id!,
      slot_code: latest.slot_code,
      product_id: latest.product_id,
      par_qty: latest.capacity,
      min_qty: null,
    });
  }

  const unmapped = [...latestBySlot.values()]
    .filter(row => !row.product_id)
    .map(row => ({
      machineId: row.machine_id!,
      slotCode: String(row.slot_code),
      xyProductName: String(row.vms_product_name || "Unmapped XY product"),
      currentQty: row.current_qty ?? null,
      capacity: row.capacity,
    }));

  return {
    rows: [...merged.values()].sort((a,b) =>
      a.machine_id.localeCompare(b.machine_id) ||
      String(a.slot_code).localeCompare(String(b.slot_code), undefined, {numeric:true})),
    unmapped,
  };
}
