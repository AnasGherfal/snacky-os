/** Complete, bounded reads for operational lists. Never treat a truncated result
 * or a failed page as an empty warehouse/route. Callers must request exact count,
 * retain their authorization filters, and use a deterministic unique ordering.
 * No cross-user cache and no writes. This is a display snapshot, not a write lock.
 */
export type ListReadError = { code?: string; message: string };
export type ListPage<T> = { data: T[] | null; count: number | null; error: ListReadError | null };
export type CompleteList<T> =
  | { data: T[]; count: number; error: null }
  | { data: null; count: null; error: ListReadError };
export type ListPageRequest = { from: number; to: number; signal: AbortSignal };
export async function readCompleteList<T>(
  fetchPage: (page: ListPageRequest) => PromiseLike<ListPage<T>>,
  options: { key: (row: T) => string; pageSize?: number; maxRows?: number; signal?: AbortSignal } ,
): Promise<CompleteList<T>> {
  const pageSize = options.pageSize ?? 500;
  const maxRows = options.maxRows ?? 20000;
  const fail = (code: string, message: string): CompleteList<T> => ({ data: null, count: null, error: { code, message } });
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100000) {
    return fail('READ_CONFIGURATION', 'Invalid bounded-list read configuration.');
  }
  const signal = options.signal ?? AbortSignal.timeout(10000);
  const rows: T[] = [];
  const seen = new Set<string>();
  let expected: number | null = null;
  try {
    for (let requests = 0; requests < 200; requests++) {
      if (signal.aborted) return fail('READ_TIMEOUT', 'The complete list could not be verified before the read deadline. Retry.');
      const result = await fetchPage({ from: rows.length, to: rows.length + pageSize - 1, signal });
      if (signal.aborted) return fail('READ_TIMEOUT', 'The complete list could not be verified before the read deadline. Retry.');
      if (result.error) return { data: null, count: null, error: result.error };
      if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count) || Number(result.count) < 0) {
        return fail('READ_UNVERIFIED', 'A complete row count was not provided; partial data were withheld.');
      }
      const count = result.count as number;
      if (count > maxRows) return fail('READ_TOO_LARGE', 'This list exceeds the safe read limit. Narrow the date or route filter.');
      if (expected !== null && expected !== count) return fail('READ_CHANGED', 'The list changed while loading. Refresh before reviewing quantities.');
      expected = count;
      for (const row of result.data) {
        const key = options.key(row);
        if (typeof key !== 'string' || !key.trim() || seen.has(key)) {
          return fail('READ_CHANGED', 'Duplicate or missing row identities prevent a complete, reliable list. Refresh.');
        }
        seen.add(key);
        rows.push(row);
      }
      if (rows.length > count) return fail('READ_CHANGED', 'Row count changed while loading. Refresh.');
      if (rows.length === count) return { data: rows, count, error: null };
      if (result.data.length === 0) return fail('READ_INCOMPLETE', 'The source stopped before all rows were received. No partial total is shown.');
      // Advance by actual received rows, not requested page size: PostgREST may
      // enforce a smaller maximum. A short page is NOT proof of end-of-data.
    }
    return fail('READ_INCOMPLETE', 'Read request limit reached before the complete list was verified.');
  } catch (error) {
    return fail(signal.aborted ? 'READ_TIMEOUT' : 'READ_FAILED',
      error instanceof Error ? error.message : 'The complete list could not be verified.');
  }
}
