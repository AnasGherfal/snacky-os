export function groupMachineLayoutRows<T extends { slotCode: string }>(slots: T[]) {
  const sorted = [...slots].sort((a, b) => (
    String(a.slotCode).localeCompare(String(b.slotCode), undefined, { numeric: true })
  ));
  const firstTwenty = sorted.filter((slot) => {
    const n = Number(slot.slotCode);
    return Number.isFinite(n) && n >= 1 && n <= 20;
  });
  // XY wide elevator machines often use 001/003/.../019 across the first row.
  const hasWideTopPattern = firstTwenty.length >= 6
    && firstTwenty.every((slot) => Number(slot.slotCode) % 2 === 1);
  const rows = new Map<number, T[]>();
  sorted.forEach((slot) => {
    const n = Number(slot.slotCode);
    if (!Number.isFinite(n) || n <= 0) {
      rows.set(99, [...(rows.get(99) ?? []), slot]);
      return;
    }
    const rowIndex = hasWideTopPattern
      ? n <= 20 ? 1 : Math.floor((n - 21) / 10) + 2
      : Math.floor((n - 1) / 10) + 1;
    rows.set(rowIndex, [...(rows.get(rowIndex) ?? []), slot]);
  });
  return Array.from(rows.entries()).sort(([a], [b]) => a - b)
    .map(([rowIndex, rowSlots]) => ({
      rowIndex,
      slots: rowSlots.sort((a, b) => Number(a.slotCode) - Number(b.slotCode)),
    }));
}
