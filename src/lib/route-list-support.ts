import type { SupabaseClient } from "@supabase/supabase-js";
import { readCompleteList } from "./complete-list-read.ts";
export type RouteOperatorSummary = { id: string; full_name: string };
export type RouteMachineSummary = {
  id: string; name: string | null; machine_code: string | null;
  location: { id: string; name: string | null } | { id: string; name: string | null }[] | null;
};
export type RouteStopSummary = {
  id?: string; route_id: string; machine_id: string | null; stop_order: number;
  machine: RouteMachineSummary | RouteMachineSummary[] | null;
};
type ReadError = { code?: string; message: string };
type ReadResult<T> = { data: T[] | null; error: ReadError | null };
type StopResult = ReadResult<RouteStopSummary> & { machineError: ReadError | null };
function missingRelationship(error: ReadError | null) {
  return !!error && ["PGRST200", "PGRST201", "PGRST204", "42703"].includes(error.code ?? "");
}
async function loadStops(db: SupabaseClient, routeIds: string[], signal: AbortSignal): Promise<StopResult> {
  if (!routeIds.length) return { data: [], error: null, machineError: null };
  const joined = await readCompleteList<RouteStopSummary>(
    ({ from, to, signal }) => db.from("route_stops")
      .select("id, route_id, machine_id, stop_order, machine:machines(id, name, machine_code, location:locations(id, name))", { count: "exact" })
      .in("route_id", routeIds).order("route_id").order("stop_order").order("id")
      .range(from, to).abortSignal(signal),
    { key: row => String(row.id ?? ''), signal },
  );
  if (!joined.error) return { data: joined.data, error: null, machineError: null };
  // Permission/timeout/partial-data failures must NOT trigger a second cascade.
  if (!missingRelationship(joined.error)) return { data: null, error: joined.error, machineError: null };
  const stops = await readCompleteList<Omit<RouteStopSummary, 'machine'>>(
    ({ from, to, signal }) => db.from("route_stops")
      .select("id, route_id, machine_id, stop_order", { count: "exact" })
      .in("route_id", routeIds).order("route_id").order("stop_order").order("id")
      .range(from, to).abortSignal(signal),
    { key: row => String(row.id ?? ''), signal },
  );
  if (stops.error) return { data: null, error: stops.error, machineError: null };
  const machineIds = [...new Set(stops.data.map(row => row.machine_id).filter((id): id is string => Boolean(id)))];
  if (!machineIds.length) return { data: stops.data.map(row => ({ ...row, machine: null })), error: null, machineError: null };
  // Smaller batches bound URL size when an owner's page spans many routes.
  const byId = new Map<string, RouteMachineSummary>();
  let machineError: ReadError | null = null;
  for (let offset = 0; offset < machineIds.length; offset += 100) {
    const machines = await db.from("machines").select("id, name, machine_code, location:locations(id, name)")
      .in("id", machineIds.slice(offset, offset + 100)).abortSignal(signal);
    if (machines.error) { machineError = machines.error; break; }
    (machines.data ?? []).forEach(machine => byId.set(String(machine.id), machine as RouteMachineSummary));
  }
  return { data: stops.data.map(row => ({ ...row, machine: row.machine_id ? byId.get(row.machine_id) ?? null : null })), error: null, machineError };
}
/** Caller first authorizes the route page and supplies only visible route IDs.
 * One parallel request wave; every overflow page shares the same deadline.
 * No global cache, unscoped query, inventory mutation or workflow mutation. */
export async function loadRouteListSupport(db: SupabaseClient, routeIds: string[], operatorIds: string[]): Promise<{ operators: ReadResult<RouteOperatorSummary>; stops: StopResult }> {
  const signal = AbortSignal.timeout(10000);
  const uniqueRoutes = [...new Set(routeIds)];
  const uniqueOperators = [...new Set(operatorIds)];
  // Visible route pages are capped at 100. Reject unexpected callers rather
  // than silently dropping operators/routes or issuing an unbounded IN query.
  if (uniqueRoutes.length > 100 || uniqueOperators.length > 100) {
    const error = { code: 'READ_TOO_LARGE', message: 'Narrow the route-page selection.' };
    return { operators: { data: null, error }, stops: { data: null, error, machineError: null } };
  }
  const [operators, stops] = await Promise.all([
    uniqueOperators.length
      ? db.from("team_members").select("id, full_name").in("id", uniqueOperators).abortSignal(signal)
      : Promise.resolve({ data: [], error: null }),
    loadStops(db, uniqueRoutes, signal),
  ]);
  return { operators: operators as ReadResult<RouteOperatorSummary>, stops };
}
