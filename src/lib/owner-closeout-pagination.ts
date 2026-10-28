/**
 * Pure paging guard for manager financial/operational reads.
 * Kept free of auth/Next.js imports so it can be tested without a server.
 */
type PageRow = { id: string };
type PageResult<T> = { data: T[] | null; count: number | null; error: unknown | null };

const pageSize = 300;
const maxRows = 12000;

/** Correctness beats a plausible but partial count. A PostgREST row cap,
 * a changing row count during pagination, duplicates or unreadable pages
 * invalidate the ENTIRE owner closeout snapshot.
 */
export async function loadAllExactOwnerRows<T extends PageRow>(
  readPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const all: T[] = [];
  const ids = new Set<string>();
  let expected: number | null = null;
  for (let from = 0; from < maxRows; from += pageSize) {
    const result = await readPage(from, from + pageSize - 1);
    if (result.error) throw new Error("Owner closeout source query failed.");
    if (typeof result.count !== "number" || !Number.isSafeInteger(result.count) || result.count < 0) {
      throw new Error("Owner closeout exact source count unavailable.");
    }
    if (expected === null) {
      expected = result.count;
      if (expected > maxRows) throw new Error("Owner closeout source exceeds the safe row read cap.");
    } else if (result.count !== expected) {
      throw new Error("Owner closeout source changed during pagination.");
    }
    const requiredRows = Math.min(pageSize, Math.max(0,expected-from));
    if (!Array.isArray(result.data) || result.data.length !== requiredRows) {
      throw new Error("Owner closeout page was truncated; refusing incomplete route or stop counts.");
    }
    for (const row of result.data) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id)) {
        throw new Error("Owner closeout source returned duplicate or missing identifiers.");
      }
      ids.add(row.id);
    }
    all.push(...result.data);
    if (all.length === expected) return all;
  }
  throw new Error("Owner closeout source could not finish within the read cap.");
}

