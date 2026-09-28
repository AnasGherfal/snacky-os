import type { SupabaseClient } from "@supabase/supabase-js";

export type RouteOperatorSummary = { id: string; full_name: string };
export type RouteMachineSummary = {
  id: string;
  name: string | null;
  machine_code: string | null;
  location: { id: string; name: string | null } | { id: string; name: string | null }[] | null;
};
export type RouteStopSummary = {
  route_id: string;
  machine_id: string | null;
  stop_order: number;
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
  const joined = await db.from("route_stops")
    .select("route_id, machine_id, stop_order, machine:machines(id, name, machine_code, location:locations(id, name))")
    .in("route_id", routeIds).order("stop_order", { ascending: true }).abortSignal(signal);
  if (!joined.error) return { data: joined.data as RouteStopSummary[], error: null, machineError: null };
  // Do not turn a timeout/permission error into another chain of requests.
  if (!missingRelationship(joined.error)) return { data: null, error: joined.error, machineError: null };

  // Older schemas retain the previous optional-summary fallback.
  const stops = await db.from("route_stops").select("route_id, machine_id, stop_order")
    .in("route_id", routeIds).order("stop_order", { ascending: true }).abortSignal(signal);
  if (stops.error) return { data: null, error: stops.error, machineError: null };
  const rows = (stops.data ?? []) as Omit<RouteStopSummary, "machine">[];
  const machineIds = [...new Set(rows.map(row => row.machine_id).filter((id): id is string => Boolean(id)))];
  if (!machineIds.length) return { data: rows.map(row => ({ ...row, machine: null })), error: null, machineError: null };
  const machines = await db.from("machines").select("id, name, machine_code, location:locations(id, name)")
    .in("id", machineIds).abortSignal(signal);
  const byId = new Map((machines.data ?? []).map(machine => [String(machine.id), machine as RouteMachineSummary]));
  return {
    data: rows.map(row => ({ ...row, machine: row.machine_id ? byId.get(row.machine_id) ?? null : null })),
    error: null,
    machineError: machines.error,
  };
}

/** Server caller must first authorize the route page and obtain its visible route IDs.
 * No process-global/user-shared cache and no inventory or workflow writes.
 * One request wave for operators + stops/machine labels; fallbacks share its deadline.
 */
export async function loadRouteListSupport(
  db: SupabaseClient,
  routeIds: string[],
  operatorIds: string[],
): Promise<{ operators: ReadResult<RouteOperatorSummary>; stops: StopResult }> {
  const signal = AbortSignal.timeout(5000);
  const [operators, stops] = await Promise.all([
    operatorIds.length
      ? db.from("team_members").select("id, full_name").in("id", operatorIds).abortSignal(signal)
      : Promise.resolve({ data: [], error: null }),
    loadStops(db, routeIds, signal),
  ]);
  return { operators: operators as ReadResult<RouteOperatorSummary>, stops };
}
