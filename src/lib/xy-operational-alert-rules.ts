/**
 * XY operational alerts are always in-app records. Never infer "no sales"
 * from missing or delayed vendor data.
 */
export type XySalesCoverage = {
  status: string | null;
  completed_at: string | null;
  range_start: string | null;
  range_end: string | null;
  fetched_rows: number | null;
  mapped_machine_rows: number | null;
  coverage_complete: boolean | null;
};

export function verifiedSalesCoverage(coverage: XySalesCoverage | null, nowMs: number): boolean {
  if (!coverage || coverage.coverage_complete !== true
    || !["completed", "completed_with_warnings"].includes(String(coverage.status))) return false;
  const completed = Date.parse(String(coverage.completed_at ?? ""));
  const start = Date.parse(String(coverage.range_start ?? ""));
  const end = Date.parse(String(coverage.range_end ?? ""));
  const fetched = Number(coverage.fetched_rows);
  const mapped = Number(coverage.mapped_machine_rows);
  return Number.isFinite(completed) && Number.isFinite(start) && Number.isFinite(end)
    && completed <= nowMs && nowMs - completed <= 90 * 60 * 1000
    && start <= nowMs - 24 * 60 * 60 * 1000
    && end <= nowMs && nowMs - end <= 90 * 60 * 1000
    // A zero-result response is not proof of zero sales across the network.
    && fetched > 0 && Number.isSafeInteger(fetched)
    && mapped === fetched;
}

export function lastSaleTimestamp(record: {
  payment_time: string | null;
  delivery_time: string | null;
} | null): number | null {
  if (!record) return null;
  const candidates = [record.payment_time, record.delivery_time]
    .map((value) => Date.parse(String(value ?? "")))
    .filter((value) => Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : null;
}

export function noSalesFor24Hours(lastSaleAt: number | null, machineCreatedAt: number, nowMs: number): boolean {
  if (!Number.isFinite(machineCreatedAt) || machineCreatedAt > nowMs - 24 * 60 * 60 * 1000) return false;
  if (lastSaleAt !== null && (!Number.isFinite(lastSaleAt) || lastSaleAt > nowMs)) return false;
  return lastSaleAt === null || lastSaleAt <= nowMs - 24 * 60 * 60 * 1000;
}

export function xyOperationalAlertEventKey(kind: string, scope: string, episode: string) {
  return ["xy_operation_v1", kind, scope, episode].map((part) => encodeURIComponent(part)).join(":").slice(0, 240);
}
