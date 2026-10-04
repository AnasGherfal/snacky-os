/** Part 1: read-only urgency. This module never creates duties, routes or reservations. */
export type WorkPriority = 'immediate' | 'urgent' | 'today' | 'monitor' | 'healthy' | 'verify';
export const WORK_PRIORITY_ORDER: Record<WorkPriority, number> = { immediate: 0, urgent: 1, today: 2, verify: 3, monitor: 4, healthy: 5 };
export const WORK_STOCK_MAX_AGE_MS = 30 * 60_000;
export type WorkLane = { code: string; quantity: unknown; capacity: unknown; capturedAt: string | null; productId: string | null };
export type WorkMachine = { id: string; name: string; expectedCodes: string[]; openDays: number[] | null };
export function physicalWorkLane(code: string): string | null {
  const value = String(code).trim();
  return /^\d{1,4}$/.test(value) ? String(Number(value)).padStart(3, '0') : null;
}
function whole(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
export function workDayInTripoli(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
export function summarizeWorkMachine(machine: WorkMachine, rows: WorkLane[], now: Date) {
  const byCode = new Map<string, WorkLane>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const code = physicalWorkLane(row.code);
    if (!code) continue;
    if (byCode.has(code)) duplicates.add(code);
    byCode.set(code, row);
  }
  const codes = new Set([...machine.expectedCodes.map(physicalWorkLane).filter((s): s is string => s !== null), ...byCode.keys()]);
  let empty = 0, low = 0, unknown = 0, unmapped = 0, known = 0, fillSum = 0;
  let oldest: number | null = null, newest: number | null = null;
  for (const code of codes) {
    const row = byCode.get(code);
    if (!row || duplicates.has(code)) { unknown++; continue; }
    const at = Date.parse(row.capturedAt || '');
    if (Number.isFinite(at)) { oldest = oldest === null ? at : Math.min(oldest, at); newest = newest === null ? at : Math.max(newest, at); }
    const qty = whole(row.quantity), cap = whole(row.capacity);
    if (!Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > WORK_STOCK_MAX_AGE_MS || qty === null || cap === null || cap < 1 || cap > 1000 || qty > cap) { unknown++; continue; }
    known++;
    if (!row.productId) unmapped++;
    fillSum += qty / cap * 100;
    if (qty === 0) empty++;
    else if (qty <= 2 || qty / cap <= .2) low++;
  }
  const mean = known ? fillSum / known : null;
  // Use all expected lanes for proportion thresholds; missing lanes cannot inflate an urgency ratio.
  const fraction = codes.size ? (empty + low) / codes.size : 0;
  let priority: WorkPriority;
  if (!known) priority = 'verify';
  else if (empty >= 25 || empty / codes.size >= .6 || (!unknown && mean! <= 15)) priority = 'immediate';
  else if (empty >= 20 || fraction >= .5 || (!unknown && mean! <= 25)) priority = 'urgent';
  else if (empty >= 16 || fraction >= .35 || (!unknown && mean! <= 35)) priority = 'today';
  else if (unknown) priority = 'verify';
  else if (empty || low || mean! <= 55) priority = 'monitor';
  else priority = 'healthy';
  const validDays = machine.openDays?.filter(d => Number.isInteger(d) && d >= 1 && d <= 7) ?? [];
  const weekday = new Date(`${workDayInTripoli(now)}T12:00:00Z`).getUTCDay() || 7;
  return {
    machineId: machine.id, name: machine.name, priority, empty, low, unknown, unmapped,
    lanes: codes.size, knownLanes: known,
    averageLaneFullness: !unknown && mean !== null ? Math.round(mean) : null,
    oldestSnapshotAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestSnapshotAt: newest === null ? null : new Date(newest).toISOString(),
    openToday: validDays.length ? validDays.includes(weekday) : null,
    needsService: ['immediate', 'urgent', 'today'].includes(priority),
  };
}
