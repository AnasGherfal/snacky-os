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


/**
 * Skip in-app XY notices that are already persisted. This is a best-effort,
 * read-only optimization: errors never count as existing notices, so callers
 * must still rely on the database's unique event-key index during insert.
 *
 * Chunking bounds PostgREST URL length and avoids list-read row caps. Keys
 * are unique within this lookup, and no notification rows are modified.
 */
export async function knownXyNotificationEventKeys(
  candidateKeys: readonly string[],
  readChunk: (keys: string[]) => Promise<{
    data: Array<{ event_key: string | null }> | null;
    error: unknown | null;
  }>,
): Promise<{ keys: Set<string>; verified: boolean }> {
  const uniqueKeys = [...new Set(candidateKeys)];
  const known = new Set<string>();
  const failed = () => ({ keys: new Set<string>(), verified: false });
  for (let i = 0; i < uniqueKeys.length; i += 20) {
    const chunk = uniqueKeys.slice(i, i + 20);
    try {
      const { data, error } = await readChunk(chunk);
      if (error || !Array.isArray(data) || data.length > chunk.length) return failed();
      const requested = new Set(chunk);
      for (const row of data) {
        if (!row || typeof row.event_key !== "string" || !requested.has(row.event_key)) {
          return failed();
        }
        known.add(row.event_key);
      }
    } catch {
      return failed();
    }
  }
  return { keys: known, verified: true };
}


/**
 * A reported "complete" vendor sync is not enough to declare zero machine
 * sales: an empty, archived or unpersisted raw transaction source must fail
 * closed. The caller only passes rows independently confirmed to be from
 * non-deleted imported batches, successfully sold, and machine/product mapped.
 *
 * A successful sale anywhere on the network in the verified past-24h window
 * establishes minimum database/source continuity; machine-specific absence
 * checks still run separately, never from this global count alone.
 */
export function verifiedRecentXySalesEvidence(
  records: readonly ({
    payment_time?: string | null;
    delivery_time?: string | null;
  } | null)[],
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  return records.some((record) => {
    if (!record) return false;
    return [record.payment_time, record.delivery_time].some((value) => {
      if (!value || typeof value !== "string") return false;
      const at = Date.parse(value);
      return Number.isFinite(at) && at >= cutoff && at <= nowMs;
    });
  });
}
