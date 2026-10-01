export type ScheduledSiteStockRow = {
  product_id: string | null;
  current_qty?: number | string | null;
  captured_at?: string | null;
  sync_run_id?: string | null;
  import_batch_id?: string | null;
};

export type ScheduledSiteFillRow = {
  product_id: string | null;
  actual_qty?: number | string | null;
  created_at?: string | null;
};

export type ScheduledSitePeriod = {
  start: string;
  end: string;
};

export type ScheduledSiteDemandRow = {
  product_id: string;
  site_name: string;
  observed_operating_days: number;
  coverage_operating_days: number;
  observed_units: number;
  projected_units: number;
  daily_rate: number;
  previous_period_units: number;
  current_period_units: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function whole(value: unknown) {
  return Math.max(0, Math.floor(numberValue(value)));
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

function normalizedOpenDays(value: number[] | null | undefined) {
  const days = Array.from(new Set((value ?? []).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))).sort((a, b) => a - b);
  return days.length ? days : [1, 2, 3, 4, 5, 6, 7];
}

export function countOperatingDays(startDate: string, calendarDays: number, openDays: number[]) {
  const days = Math.max(1, Math.floor(numberValue(calendarDays)));
  const open = normalizedOpenDays(openDays);
  let count = 0;
  for (let offset = 0; offset < days; offset += 1) {
    if (open.includes(isoWeekday(addDays(startDate, offset)))) count += 1;
  }
  return count;
}

function periodContains(day: string, period: ScheduledSitePeriod | null | undefined) {
  return Boolean(period?.start && period?.end && day >= period.start && day <= period.end);
}

function snapshotKey(row: ScheduledSiteStockRow) {
  return String(row.sync_run_id ?? row.import_batch_id ?? row.captured_at ?? "").trim();
}

function rounded(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function computeScheduledSiteDemand({
  siteName,
  openDays,
  coverageDays,
  stockRows,
  fillRows,
  previousPeriod,
  currentPeriod,
  now = new Date(),
  minimumCompletedOperatingDays = 2,
}: {
  siteName: string;
  openDays: number[];
  coverageDays: number;
  stockRows: ScheduledSiteStockRow[];
  fillRows: ScheduledSiteFillRow[];
  previousPeriod?: ScheduledSitePeriod | null;
  currentPeriod?: ScheduledSitePeriod | null;
  now?: Date;
  minimumCompletedOperatingDays?: number;
}): ScheduledSiteDemandRow[] {
  const today = datePartsInTripoli(now);
  const open = normalizedOpenDays(openDays);
  const snapshotAggregates = new Map<string, { productId: string; day: string; capturedAt: number; qty: number }>();
  const machineDaySpan = new Map<string, { first: number; last: number }>();

  for (const row of stockRows) {
    const productId = String(row.product_id ?? "").trim();
    const rawCaptured = String(row.captured_at ?? "").trim();
    if (!productId || !rawCaptured) continue;
    const capturedAt = Date.parse(rawCaptured);
    if (!Number.isFinite(capturedAt)) continue;
    const day = datePartsInTripoli(new Date(capturedAt));
    if (day >= today || !open.includes(isoWeekday(day))) continue;
    const keyPart = snapshotKey(row);
    if (!keyPart) continue;

    const key = `${productId}:${day}:${keyPart}`;
    const current = snapshotAggregates.get(key) ?? { productId, day, capturedAt, qty: 0 };
    current.qty += whole(row.current_qty);
    current.capturedAt = Math.max(current.capturedAt, capturedAt);
    snapshotAggregates.set(key, current);

    const span = machineDaySpan.get(day) ?? { first: capturedAt, last: capturedAt };
    span.first = Math.min(span.first, capturedAt);
    span.last = Math.max(span.last, capturedAt);
    machineDaySpan.set(day, span);
  }

  const eligibleDays = Array.from(machineDaySpan.entries())
    .filter(([, span]) => (span.last - span.first) / 3_600_000 >= 6)
    .map(([day]) => day)
    .sort();

  if (eligibleDays.length < Math.max(1, minimumCompletedOperatingDays)) return [];

  const eligible = new Set(eligibleDays);
  const productDaySnapshots = new Map<string, Array<{ capturedAt: number; qty: number }>>();
  for (const row of snapshotAggregates.values()) {
    if (!eligible.has(row.day)) continue;
    const key = `${row.productId}:${row.day}`;
    const rows = productDaySnapshots.get(key) ?? [];
    rows.push({ capturedAt: row.capturedAt, qty: row.qty });
    productDaySnapshots.set(key, rows);
  }

  const fillsByProductDay = new Map<string, number>();
  for (const row of fillRows) {
    const productId = String(row.product_id ?? "").trim();
    const rawCreated = String(row.created_at ?? "").trim();
    if (!productId || !rawCreated) continue;
    const createdAt = Date.parse(rawCreated);
    if (!Number.isFinite(createdAt)) continue;
    const day = datePartsInTripoli(new Date(createdAt));
    if (!eligible.has(day)) continue;
    const key = `${productId}:${day}`;
    fillsByProductDay.set(key, (fillsByProductDay.get(key) ?? 0) + whole(row.actual_qty));
  }

  const dailyConsumption = new Map<string, Map<string, number>>();
  const productIds = new Set<string>();
  for (const [key, rows] of productDaySnapshots) {
    const separator = key.lastIndexOf(":");
    const productId = key.slice(0, separator);
    const day = key.slice(separator + 1);
    const ordered = rows.sort((a, b) => a.capturedAt - b.capturedAt);
    const startQty = ordered[0]?.qty ?? 0;
    const endQty = ordered.at(-1)?.qty ?? 0;
    const filled = fillsByProductDay.get(`${productId}:${day}`) ?? 0;
    const consumed = Math.max(0, startQty + filled - endQty);
    const byDay = dailyConsumption.get(productId) ?? new Map<string, number>();
    byDay.set(day, consumed);
    dailyConsumption.set(productId, byDay);
    productIds.add(productId);
  }

  const coverageOperatingDays = countOperatingDays(today, coverageDays, open);
  const results: ScheduledSiteDemandRow[] = [];

  for (const productId of productIds) {
    const byDay = dailyConsumption.get(productId) ?? new Map<string, number>();
    const observed = eligibleDays.map((day) => ({ day, units: byDay.get(day) ?? 0 }));
    const observedUnits = observed.reduce((sum, row) => sum + row.units, 0);
    if (observedUnits <= 0) continue;

    const averageRate = observedUnits / eligibleDays.length;
    const recentRows = observed.slice(-Math.min(2, observed.length));
    const recentRate = recentRows.reduce((sum, row) => sum + row.units, 0) / Math.max(1, recentRows.length);
    const dailyRate = Math.max(averageRate, recentRate);
    const projectedUnits = Math.ceil(dailyRate * coverageOperatingDays);
    if (projectedUnits <= 0) continue;

    results.push({
      product_id: productId,
      site_name: siteName,
      observed_operating_days: eligibleDays.length,
      coverage_operating_days: coverageOperatingDays,
      observed_units: observedUnits,
      projected_units: projectedUnits,
      daily_rate: rounded(dailyRate),
      previous_period_units: observed.filter((row) => periodContains(row.day, previousPeriod)).reduce((sum, row) => sum + row.units, 0),
      current_period_units: observed.filter((row) => periodContains(row.day, currentPeriod)).reduce((sum, row) => sum + row.units, 0),
    });
  }

  return results.sort((a, b) => b.projected_units - a.projected_units || a.product_id.localeCompare(b.product_id));
}
