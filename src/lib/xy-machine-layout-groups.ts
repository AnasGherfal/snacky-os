/**
 * Snacky six-shelf XY cabinets: top shelf 0, bottom shelf 5.
 *
 * All route stops share the same physical row labels, irrespective of machine
 * location, identifier, sparse channels or the particular product layout.
 * XY slot codes are actual editable vendor selections, not physical row
 * numbers. Never generate nonexistent XY slots to fill a visible row.
 */
export const SNACKY_PHYSICAL_ROW_COUNT = 6;

export type MachineLayoutGroupOptions = {
  // Kept for existing route calls; grouping must not be tied to one machine.
  machineCode?: string | null;
};

function laneNumber(value: string): number | null {
  const code = String(value ?? "").trim();
  // Historical VMS-## product identifiers do not address a physical XY lane.
  if (!/^\d{1,3}$/.test(code)) return null;
  const lane = Number(code);
  return Number.isSafeInteger(lane) && lane >= 1 && lane <= 60 ? lane : null;
}

export function physicalMachineRowForSlot(
  slotCode: string,
  _options: MachineLayoutGroupOptions = {},
): number | null {
  const lane = laneNumber(slotCode);
  return lane === null ? null : Math.floor((lane - 1) / 10);
}

export function unmappedMachineSelectionCodes<T extends { slotCode: string }>(
  slots: readonly T[],
  options: MachineLayoutGroupOptions = {},
): string[] {
  return slots
    .filter((slot) => physicalMachineRowForSlot(slot.slotCode, options) === null)
    .map((slot) => slot.slotCode);
}

/**
 * Certain six-shelf cabinets have only five final water lanes (046-050)
 * without any 041-045 or 051-060 lanes. The owner-provided example places
 * these on the lowest shelf. Detect this from the lane pattern itself, never
 * from one hardcoded machine ID. This does not create a 041-045 stock lane.
 */
function hasSparseLastShelf<T extends { slotCode: string }>(slots: readonly T[]): boolean {
  const lanes = slots.map((slot) => laneNumber(slot.slotCode)).filter((n): n is number => n !== null);
  return lanes.some((n) => n >= 46 && n <= 50)
    && !lanes.some((n) => n >= 41 && n <= 45)
    && !lanes.some((n) => n >= 51 && n <= 60);
}

export function groupMachineLayoutRows<T extends { slotCode: string }>(
  slots: readonly T[],
  _options: MachineLayoutGroupOptions = {},
): Array<{ rowIndex: number; slots: T[] }> {
  const rows = new Map<number, T[]>();
  const sparseLastShelf = hasSparseLastShelf(slots);

  for (const slot of slots) {
    const lane = laneNumber(slot.slotCode);
    if (lane === null) continue;
    const usualRow = Math.floor((lane - 1) / 10);
    const row = sparseLastShelf && lane >= 46 && lane <= 50 ? 5 : usualRow;
    rows.set(row, [...(rows.get(row) ?? []), slot]);
  }

  // Always show six physical shelves 0–5 for every Snacky machine.
  // A shelf without a mapped XY lane is read-only, not a fictitious slot.
  return Array.from({ length: SNACKY_PHYSICAL_ROW_COUNT }, (_, rowIndex) => ({
    rowIndex,
    slots: (rows.get(rowIndex) ?? []).sort((a, b) =>
      Number(a.slotCode) - Number(b.slotCode)),
  }));
}
