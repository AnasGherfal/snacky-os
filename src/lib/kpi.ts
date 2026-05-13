import { lyd, pct } from "@/lib/format";

export const LOW_STORAGE_QTY = 20;

export function numberValue(value: unknown) {
  return Number(value ?? 0);
}

export function dateKey(value: string | null | undefined) {
  if (!value) return "Unknown";
  return new Date(value).toISOString().slice(0, 10);
}

export function monthKey(value: string | null | undefined) {
  if (!value) return "Unknown";
  return new Date(value).toISOString().slice(0, 7);
}

export function formatInteger(value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatDays(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value > 365) return "365+ days";
  return `${value.toFixed(1)} days`;
}

export function formatLydOrDash(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : lyd(value);
}

export function formatPctOrDash(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : pct(value);
}

export function groupSum<T>(rows: T[], keyFn: (row: T) => string, valueFn: (row: T) => number) {
  const grouped = new Map<string, number>();

  rows.forEach((row) => {
    const key = keyFn(row);
    grouped.set(key, (grouped.get(key) ?? 0) + valueFn(row));
  });

  return Array.from(grouped.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export function groupCount<T>(rows: T[], keyFn: (row: T) => string) {
  const grouped = new Map<string, number>();

  rows.forEach((row) => {
    const key = keyFn(row);
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  });

  return grouped;
}

export function observedDayCount(salesRows: any[]) {
  const dates = salesRows
    .map((row) => new Date(row.period_end ?? row.period_start).getTime())
    .filter((value) => Number.isFinite(value));

  if (!dates.length) return 1;

  const min = Math.min(...dates);
  const max = Math.max(...dates);
  return Math.max(1, Math.ceil((max - min) / 86400000) + 1);
}

export function observedMonthCount(salesRows: any[]) {
  const months = new Set(salesRows.map((row) => monthKey(row.period_end ?? row.period_start)).filter((key) => key !== "Unknown"));
  return Math.max(1, months.size);
}

export function latestObservedMonth(salesRows: any[]) {
  const months = salesRows.map((row) => monthKey(row.period_end ?? row.period_start)).filter((key) => key !== "Unknown").sort();
  return months.at(-1) ?? null;
}

export function salesAmount(row: any) {
  return numberValue(row.sales_amount);
}

export function soldQty(row: any) {
  return numberValue(row.sold_qty);
}

export function productName(row: any) {
  return row.product?.name ?? row.products?.name ?? "Unmapped product";
}

export function machineName(row: any) {
  return row.machine?.name ?? row.machines?.name ?? "Unmapped machine";
}

export function locationName(row: any) {
  return row.machine?.location?.name ?? row.machines?.locations?.name ?? row.machines?.location?.name ?? "No location";
}

export function productCost(row: any) {
  const cost = numberValue(row.product?.cost_price ?? row.products?.cost_price);
  return cost > 0 ? cost : null;
}

export function grossProfitForSale(row: any) {
  const cost = productCost(row);
  if (cost === null) return null;
  return salesAmount(row) - soldQty(row) * cost;
}
