import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { isTerminalRouteStatus } from "@/lib/route-workflow";
import {
  buildDueRouteCloseout,
  type DueRouteCloseout,
  type DueRouteRow,
  type DueRouteStopRow,
} from "@/lib/owner-daily-closeout";

type DB = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;

type PageRow = { id: string };
type PageResult<T> = { data: T[] | null; count: number | null; error: unknown | null };

const pageSize = 300;
const maxRows = 12000;
const routeIdBatchSize = 35;

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

/** Uses ONLY the signed-in RLS-scoped client, and reads route stops only for
 * due, still-open routes. No admin bypass, no new RPC, no database writes.
 */
export async function readOwnerDueRouteCloseout(
  db: DB,
  todayTripoli: string,
): Promise<{ data: DueRouteCloseout | null; error: string | null }> {
  try {
    const routes = await loadAllExactOwnerRows<DueRouteRow>(async (from,to) => {
      const result = await db.from("routes")
        .select("id,route_date,status,operator_id", {count:"exact"})
        .lte("route_date",todayTripoli)
        .order("route_date", {ascending:true})
        .order("id", {ascending:true})
        .range(from,to);
      return {data: result.data as DueRouteRow[] | null,count:result.count,error:result.error};
    });
    const openIds = routes.filter(route => !isTerminalRouteStatus(route.status)).map(route => route.id);
    const stops: DueRouteStopRow[] = [];
    const seenStops = new Set<string>();
    for (let i=0;i<openIds.length;i+=routeIdBatchSize) {
      const batchIds = openIds.slice(i,i+routeIdBatchSize);
      const rows = await loadAllExactOwnerRows<DueRouteStopRow>(async (from,to) => {
        const result = await db.from("route_stops")
          .select("id,route_id,status", {count:"exact"})
          .in("route_id",batchIds)
          .order("id", {ascending:true})
          .range(from,to);
        return {data:result.data as DueRouteStopRow[] | null,count:result.count,error:result.error};
      });
      for (const stop of rows) {
        if (seenStops.has(stop.id) || !batchIds.includes(stop.route_id)) {
          throw new Error("Owner closeout returned duplicate or cross-route stop data.");
        }
        seenStops.add(stop.id);
        stops.push(stop);
      }
    }
    return {data:buildDueRouteCloseout({routes,stops,todayTripoli}),error:null};
  } catch (error) {
    console.error("[owner-closeout] Cannot verify full due route source", {
      reason:error instanceof Error ? error.message : "unclassified_query_error",
    });
    return {data:null,error:"Due route or stop data could not be completely verified."};
  }
}
