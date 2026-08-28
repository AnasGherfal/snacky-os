export type RefillForecastStatus = "fill_now" | "fill_today" | "fill_next_open" | "monitor" | "healthy" | "data_stale";

export type RefillMachine = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  refill_open_days?: number[] | null;
  refill_critical_percent?: number | string | null;
  refill_today_percent?: number | string | null;
  refill_target_percent?: number | string | null;
  refill_minimum_units?: number | string | null;
  refill_manual_daily_units?: number | string | null;
};

export type LatestRefillStock = {
  machine_id: string | null;
  product_id: string | null;
  slot_code?: string | null;
  current_qty: number | string | null;
  capacity: number | string | null;
  captured_at?: string | null;
};

export type RefillStockHistory = LatestRefillStock & {
  import_batch_id?: string | null;
  sync_run_id?: string | null;
};

export type RefillFillLine = {
  machine_id: string | null;
  product_id: string | null;
  actual_qty: number | string | null;
  created_at: string | null;
};

export type MachineStorageCoverage = {
  machineId: string;
  requestedUnits: number;
  fillableUnits: number;
};

export type MachineRefillForecast = {
  machineId: string;
  machineName: string;
  machineCode: string;
  status: RefillForecastStatus;
  statusLabel: string;
  statusRank: number;
  reason: string;
  actionDate: string;
  openToday: boolean;
  nextOpenDate: string;
  openDays: number[];
  currentUnits: number;
  capacityUnits: number;
  stockPercent: number;
  emptyLanes: number;
  lowLanes: number;
  unitsToTarget: number;
  averageDailyUnits: number;
  daysToEmpty: number | null;
  trendPercent: number | null;
  trendLabel: string;
  latestSnapshotAt: string | null;
  snapshotAgeHours: number | null;
  storageRequestedUnits: number;
  storageFillableUnits: number;
  storageShortageUnits: number;
  policySource: "observed" | "manual" | "insufficient_data";
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OPEN_DAYS = [1, 2, 3, 4, 5, 6, 7];
const STATUS_RANK: Record<RefillForecastStatus, number> = {
  fill_now: 0,
  fill_today: 1,
  fill_next_open: 2,
  monitor: 3,
  data_stale: 4,
  healthy: 5,
};

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value: unknown) {
  return Math.max(0, Math.floor(numberValue(value)));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function datePartsInTripoli(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateKeyToUtc(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function addDays(value: string, days: number) {
  const date = dateKeyToUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoWeekday(value: string) {
  const day = dateKeyToUtc(value).getUTCDay();
  return day === 0 ? 7 : day;
}

export function normalizedOpenDays(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_OPEN_DAYS;
  const days = Array.from(new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))).sort((a, b) => a - b);
  return days.length ? days : DEFAULT_OPEN_DAYS;
}

export function nextOperatingDate(today: string, openDays: number[], includeToday = true) {
  const normalized = normalizedOpenDays(openDays);
  for (let offset = includeToday ? 0 : 1; offset <= 7; offset += 1) {
    const candidate = addDays(today, offset);
    if (normalized.includes(isoWeekday(candidate))) return candidate;
  }
  return today;
}

function machineProductKey(machineId: string, productId: string) {
  return `${machineId}:${productId}`;
}

type RateSample = { consumed: number; elapsedDays: number; endedAt: number };

function demandRates(
  machineId: string,
  history: RefillStockHistory[],
  fills: RefillFillLine[],
  nowMs: number,
) {
  const aggregates = new Map<string, { machineId: string; productId: string; snapshotKey: string; current: number; capacity: number; capturedAt: number }>();
  history.forEach((row) => {
    if (row.machine_id !== machineId || !row.product_id || !row.captured_at) return;
    const capturedAt = Date.parse(row.captured_at);
    if (!Number.isFinite(capturedAt)) return;
    const snapshotKey = row.sync_run_id ?? row.import_batch_id ?? row.captured_at;
    const key = `${machineProductKey(machineId, row.product_id)}:${snapshotKey}`;
    const current = aggregates.get(key) ?? { machineId, productId: row.product_id, snapshotKey, current: 0, capacity: 0, capturedAt };
    current.current += whole(row.current_qty);
    current.capacity += whole(row.capacity);
    current.capturedAt = Math.max(current.capturedAt, capturedAt);
    aggregates.set(key, current);
  });

  const byProduct = new Map<string, Array<{ current: number; capacity: number; capturedAt: number }>>();
  aggregates.forEach((row) => {
    const rows = byProduct.get(row.productId) ?? [];
    rows.push({ current: row.current, capacity: row.capacity, capturedAt: row.capturedAt });
    byProduct.set(row.productId, rows);
  });

  const fillsByProduct = new Map<string, Array<{ quantity: number; createdAt: number }>>();
  fills.forEach((row) => {
    if (row.machine_id !== machineId || !row.product_id || !row.created_at) return;
    const createdAt = Date.parse(row.created_at);
    if (!Number.isFinite(createdAt)) return;
    const rows = fillsByProduct.get(row.product_id) ?? [];
    rows.push({ quantity: whole(row.actual_qty), createdAt });
    fillsByProduct.set(row.product_id, rows);
  });

  const rateByProduct = new Map<string, number>();
  const allSamples: RateSample[] = [];
  byProduct.forEach((observations, productId) => {
    const ordered = observations.sort((a, b) => a.capturedAt - b.capturedAt);
    const productSamples: RateSample[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const elapsedDays = (current.capturedAt - previous.capturedAt) / DAY_MS;
      if (elapsedDays < 0.2 || elapsedDays > 7) continue;
      const filled = (fillsByProduct.get(productId) ?? [])
        .filter((row) => row.createdAt > previous.capturedAt && row.createdAt <= current.capturedAt)
        .reduce((sum, row) => sum + row.quantity, 0);
      const consumed = clamp(previous.current + filled - current.current, 0, Math.max(1, previous.capacity) * Math.max(2, Math.ceil(elapsedDays) + 1));
      const sample = { consumed, elapsedDays, endedAt: current.capturedAt };
      productSamples.push(sample);
      allSamples.push(sample);
    }
    const recent = productSamples.filter((sample) => sample.endedAt >= nowMs - 14 * DAY_MS);
    const observedDays = recent.reduce((sum, sample) => sum + sample.elapsedDays, 0);
    if (observedDays >= 1) rateByProduct.set(productId, recent.reduce((sum, sample) => sum + sample.consumed, 0) / observedDays);
  });

  const periodRate = (startMs: number, endMs: number) => {
    const samples = allSamples.filter((sample) => sample.endedAt > startMs && sample.endedAt <= endMs);
    const days = samples.reduce((sum, sample) => sum + sample.elapsedDays, 0);
    return days > 0 ? samples.reduce((sum, sample) => sum + sample.consumed, 0) / days : 0;
  };
  const recentRate = periodRate(nowMs - 7 * DAY_MS, nowMs);
  const previousRate = periodRate(nowMs - 14 * DAY_MS, nowMs - 7 * DAY_MS);
  const trendPercent = previousRate > 0 ? (recentRate - previousRate) / previousRate : null;

  return { rateByProduct, trendPercent, samples: allSamples.length };
}

function statusCopy(status: RefillForecastStatus, nextOpenDate: string) {
  if (status === "fill_now") return { label: "Fill now", reason: "A lane is empty or the machine is at the critical threshold." };
  if (status === "fill_today") return { label: "Fill today", reason: "Projected demand may exhaust stock before the next safe visit." };
  if (status === "fill_next_open") return { label: "Fill next open day", reason: `The site is closed today; stock can wait until ${nextOpenDate}.` };
  if (status === "monitor") return { label: "Can wait", reason: "Stock is low, but the trend shows it can safely wait for the next planned visit." };
  if (status === "data_stale") return { label: "Refresh XY data", reason: "The latest XY stock snapshot is too old for a safe timing decision." };
  return { label: "Healthy", reason: "Current stock and observed demand do not require a near-term visit." };
}

function trendCopy(value: number | null, samples: number) {
  if (!samples) return "Learning trend";
  if (value === null) return "Baseline forming";
  if (value >= 0.2) return `${Math.round(value * 100)}% faster`;
  if (value <= -0.2) return `${Math.abs(Math.round(value * 100))}% slower`;
  return "Stable";
}

export function buildMachineRefillForecasts({
  machines,
  latestStock,
  stockHistory,
  fills,
  storageCoverage = [],
  now = new Date(),
}: {
  machines: RefillMachine[];
  latestStock: LatestRefillStock[];
  stockHistory: RefillStockHistory[];
  fills: RefillFillLine[];
  storageCoverage?: MachineStorageCoverage[];
  now?: Date;
}) {
  const nowMs = now.getTime();
  const today = datePartsInTripoli(now);
  const coverageByMachine = new Map(storageCoverage.map((row) => [row.machineId, row]));

  return machines.map((machine): MachineRefillForecast => {
    const openDays = normalizedOpenDays(machine.refill_open_days);
    const openToday = openDays.includes(isoWeekday(today));
    const nextOpenDate = nextOperatingDate(today, openDays, openToday);
    const nextOpenAfterToday = nextOperatingDate(today, openDays, false);
    const daysUntilNextOpen = Math.max(1, Math.round((dateKeyToUtc(nextOpenAfterToday).getTime() - dateKeyToUtc(today).getTime()) / DAY_MS));
    const criticalPercent = clamp(numberValue(machine.refill_critical_percent, 15), 0, 100);
    const todayPercent = clamp(numberValue(machine.refill_today_percent, 30), criticalPercent, 100);
    const targetPercent = clamp(numberValue(machine.refill_target_percent, 90), todayPercent, 100);
    const minimumUnits = whole(machine.refill_minimum_units ?? 10);
    const rows = latestStock.filter((row) => row.machine_id === machine.id && whole(row.capacity) > 0);
    const currentUnits = rows.reduce((sum, row) => sum + whole(row.current_qty), 0);
    const capacityUnits = rows.reduce((sum, row) => sum + whole(row.capacity), 0);
    const stockPercent = capacityUnits > 0 ? currentUnits / capacityUnits * 100 : 0;
    const emptyLanes = rows.filter((row) => whole(row.current_qty) <= 0).length;
    const lowLanes = rows.filter((row) => whole(row.current_qty) / Math.max(1, whole(row.capacity)) * 100 <= todayPercent).length;
    const unitsToTarget = rows.reduce((sum, row) => sum + Math.max(0, Math.ceil(whole(row.capacity) * targetPercent / 100) - whole(row.current_qty)), 0);
    const latestSnapshotAt = rows.map((row) => row.captured_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    const latestSnapshotMs = latestSnapshotAt ? Date.parse(latestSnapshotAt) : Number.NaN;
    const snapshotAgeHours = Number.isFinite(latestSnapshotMs) ? Math.max(0, (nowMs - latestSnapshotMs) / 3_600_000) : null;
    const { rateByProduct, trendPercent, samples } = demandRates(machine.id, stockHistory, fills, nowMs);
    const observedDailyUnits = Array.from(rateByProduct.values()).reduce((sum, rate) => sum + rate, 0);
    const manualDailyUnits = machine.refill_manual_daily_units === null || machine.refill_manual_daily_units === undefined
      ? null
      : Math.max(0, numberValue(machine.refill_manual_daily_units));
    const averageDailyUnits = manualDailyUnits ?? observedDailyUnits;
    const productDays = rows.map((row) => {
      if (!row.product_id) return null;
      const rate = rateByProduct.get(row.product_id) ?? 0;
      if (whole(row.current_qty) <= 0) return 0;
      return rate > 0 ? whole(row.current_qty) / rate : null;
    }).filter((value): value is number => value !== null && Number.isFinite(value));
    const totalDays = averageDailyUnits > 0 ? currentUnits / averageDailyUnits : null;
    const daysToEmpty = [...productDays, ...(totalDays === null ? [] : [totalDays])].sort((a, b) => a - b)[0] ?? null;

    let status: RefillForecastStatus;
    if (snapshotAgeHours === null || snapshotAgeHours > 24 || !rows.length) {
      status = "data_stale";
    } else if (!openToday) {
      const needsVisit = emptyLanes > 0
        || stockPercent <= todayPercent
        || (daysToEmpty !== null && daysToEmpty <= 2)
        || (unitsToTarget >= minimumUnits && stockPercent <= 55);
      status = needsVisit ? "fill_next_open" : "healthy";
    } else if (emptyLanes > 0 || stockPercent <= criticalPercent || (daysToEmpty !== null && daysToEmpty <= 0.5)) {
      status = "fill_now";
    } else if (
      stockPercent <= todayPercent
      || (daysToEmpty !== null && daysToEmpty <= daysUntilNextOpen)
      || (daysUntilNextOpen > 1 && daysToEmpty !== null && daysToEmpty <= daysUntilNextOpen + 0.5)
    ) {
      status = "fill_today";
    } else if (unitsToTarget >= minimumUnits && (stockPercent <= 55 || (daysToEmpty !== null && daysToEmpty <= 3))) {
      status = "monitor";
    } else {
      status = "healthy";
    }

    const copy = statusCopy(status, nextOpenDate);
    const coverage = coverageByMachine.get(machine.id);
    const storageRequestedUnits = coverage?.requestedUnits ?? unitsToTarget;
    const storageFillableUnits = coverage?.fillableUnits ?? unitsToTarget;
    return {
      machineId: machine.id,
      machineName: String(machine.name ?? machine.machine_code ?? "Machine"),
      machineCode: String(machine.machine_code ?? ""),
      status,
      statusLabel: copy.label,
      statusRank: STATUS_RANK[status],
      reason: copy.reason,
      actionDate: status === "fill_next_open" ? nextOpenDate : today,
      openToday,
      nextOpenDate,
      openDays,
      currentUnits,
      capacityUnits,
      stockPercent,
      emptyLanes,
      lowLanes,
      unitsToTarget,
      averageDailyUnits,
      daysToEmpty,
      trendPercent,
      trendLabel: trendCopy(trendPercent, samples),
      latestSnapshotAt,
      snapshotAgeHours,
      storageRequestedUnits,
      storageFillableUnits,
      storageShortageUnits: Math.max(0, storageRequestedUnits - storageFillableUnits),
      policySource: manualDailyUnits !== null ? "manual" : samples ? "observed" : "insufficient_data",
    };
  }).sort((a, b) => a.statusRank - b.statusRank || (a.daysToEmpty ?? Number.POSITIVE_INFINITY) - (b.daysToEmpty ?? Number.POSITIVE_INFINITY) || a.machineName.localeCompare(b.machineName));
}

export const REFILL_WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
] as const;
