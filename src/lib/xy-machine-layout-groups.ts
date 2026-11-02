/**
 * XY lane numbers are vending selection IDs, not a count of physical rows.
 *
 * The six-shelf Snacky cabinets shown in the route workflow use zero-based
 * physical rows (top 0, bottom 5). Never compress gaps in the XY planogram:
 * missing/disabled selections must not shift the rows underneath them.
 *
 * Istiklal's owner-verified photo shows six shelves. Its five final water
 * selections (046-050) belong to the bottom shelf, row 5; row 4 currently has
 * no configured XY lanes. Do not fabricate stock or editable 041-045 lanes.
 */
const ISTIKLAL_MACHINE_CODE = "2509000369";
const SIX_SHELF_ROW_COUNT = 6;

export type MachineLayoutGroupOptions = {
  machineCode?: string | null;
};

function isIstiklal(machineCode?: string | null) {
  return String(machineCode ?? "").trim().replace(/^SNK-/i, "") === ISTIKLAL_MACHINE_CODE;
}

export function physicalMachineRowForSlot(
  slotCode: string,
  options: MachineLayoutGroupOptions = {},
): number | null {
  // VMS-### and other historical pseudo-selections are NOT a physical lane.
  const value = String(slotCode ?? "").trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const lane = Number(value);
  if (!Number.isSafeInteger(lane) || lane < 1 || lane > 60) return null;

  // Istiklal: top two chip shelves have five odd-numbered lanes each.
  // Its bottom shelf uses 046-050; 041-045 must not be auto-invented.
  if (isIstiklal(options.machineCode) && lane >= 46 && lane <= 50) return 5;
  return Math.floor((lane - 1) / 10);
}

export function unmappedMachineSelectionCodes<T extends { slotCode: string }>(
  slots: readonly T[],
  options: MachineLayoutGroupOptions = {},
) {
  return slots.filter((slot) => physicalMachineRowForSlot(slot.slotCode, options) === null)
    .map((slot) => slot.slotCode);
}

export function groupMachineLayoutRows<T extends { slotCode: string }>(
  slots: readonly T[],
  options: MachineLayoutGroupOptions = {},
): Array<{ rowIndex: number; slots: T[] }> {
  const grouped = new Map<number, T[]>();
  for (const slot of slots) {
    const physicalRow = physicalMachineRowForSlot(slot.slotCode, options);
    if (physicalRow === null) continue;
    grouped.set(physicalRow, [...(grouped.get(physicalRow) ?? []), slot]);
  }

  // Istiklal's six physical shelves are known even when XY does not expose
  // one shelf. Empty rows are read-only placeholders, not XY selections.
  const visibleRowNumbers = isIstiklal(options.machineCode)
    ? Array.from({ length: SIX_SHELF_ROW_COUNT }, (_, row) => row)
    : [...grouped.keys()].sort((a, b) => a - b);

  return visibleRowNumbers.map((rowIndex) => ({
    rowIndex,
    slots: (grouped.get(rowIndex) ?? []).sort((a, b) =>
      Number(a.slotCode) - Number(b.slotCode)),
  }));
}
