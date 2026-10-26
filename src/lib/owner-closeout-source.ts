import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { isTerminalRouteStatus } from "@/lib/route-workflow";
import {
  buildDueRouteCloseout,
  type DueRouteCloseout,
  type DueRouteRow,
  type DueRouteStopRow,
} from "@/lib/owner-daily-closeout";

type DB = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;

import { loadAllExactOwnerRows } from "@/lib/owner-closeout-pagination";

const routeIdBatchSize = 35;

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
