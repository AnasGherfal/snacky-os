import { normalizeInventoryEntityType } from "@/lib/inventory-movement";
import type { RouteInventoryMovementRow } from "@/lib/route-inventory-summary";

/** Net committed bag -> machine fills only. Route inventory is not adjusted by
 * reading this helper; machine slot stock and planned quantities are not used.
 */
export type MachineFillMovement = {
  machineId: string;
  productId: string;
  filledQty: number;
};

export function summarizeRouteMachineFillMovements(
  movements: readonly RouteInventoryMovementRow[],
  routeMachineIds: readonly string[],
): { verified: true; rows: MachineFillMovement[] } | { verified: false; rows: [] } {
  const allowed = new Set(routeMachineIds);
  const totals = new Map<string, MachineFillMovement>();
  for (const row of movements) {
    const from = normalizeInventoryEntityType(row.from_entity_type);
    const to = normalizeInventoryEntityType(row.to_entity_type);
    const filled = from === "operator_bag" && to === "machine";
    // A normal returned_from_machine movement is old machine inventory, not a
    // correction of the current route's recorded fill.
    const fillCorrection = from === "machine" && to === "operator_bag"
      && String(row.reason ?? "").trim() !== "returned_from_machine";
    if (!filled && !fillCorrection) continue;

    const machineId = String(filled ? row.to_entity_id ?? "" : row.from_entity_id ?? "").trim();
    const productId = String(row.product_id ?? "").trim();
    const rawQty = row.quantity;
    const amount = typeof rawQty === "number" || (typeof rawQty === "string" && rawQty.trim())
      ? Number(rawQty) : Number.NaN;
    if (!machineId || !allowed.has(machineId) || !productId
      || !Number.isSafeInteger(amount) || amount <= 0) {
      return {verified:false,rows:[]};
    }
    const key = machineId + ":" + productId;
    const current = totals.get(key);
    const net = (current?.filledQty ?? 0) + (filled ? amount : -amount);
    if (!Number.isSafeInteger(net)) return {verified:false,rows:[]};
    totals.set(key, {machineId,productId,filledQty:net});
  }
  const rows = [...totals.values()];
  // A negative net machine fill indicates an invalid correction sequence.
  // Do not call it a verified negative physical refill.
  if (rows.some(row => row.filledQty < 0)) return {verified:false,rows:[]};
  return {verified:true,rows:rows.filter(row => row.filledQty > 0)};
}
