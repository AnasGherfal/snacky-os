import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  calculateRouteDistance,
  indexRouteDistanceEdges,
  type CalculatedRouteDistance,
  type DistanceEdgeRow,
  type DistanceRouteRow,
  type DistanceStopRow,
} from "@/lib/route-distance";

export type RouteDistanceMachine = { id: string; name: string | null };
export type RouteDistanceStorage = { id: string; name: string | null; active: boolean | null };
export type RouteDistanceOperator = { id: string; full_name: string | null };
export type MissingRouteDistanceLink = {
  fromKind: "storage" | "machine";
  fromId: string | null;
  fromName: string;
  toId: string | null;
  toName: string;
  uses: number;
  routes: number;
};

export type LoadedRouteDistances = {
  routes: CalculatedRouteDistance[];
  edges: DistanceEdgeRow[];
  machines: RouteDistanceMachine[];
  storages: RouteDistanceStorage[];
  operators: RouteDistanceOperator[];
  activeStorageId: string | null;
  missingLinks: MissingRouteDistanceLink[];
};

const PAGE_SIZE = 1000;

// Every historical stop counts. Supabase REST defaults to at most 1,000 rows per request.
async function fetchEveryRow<T>(
  page: (first: number, last: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let first = 0; ; first += PAGE_SIZE) {
    const result = await page(first, first + PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const batch = result.data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

export async function loadAdminRouteDistances(): Promise<LoadedRouteDistances> {
  // Call only from an owner/admin-guarded server component or server action.
  // The service-role client and the private edges table must never reach a client component.
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("Supabase admin client is not configured.");

  const [routes, stops, machines, storages, operators, edges] = await Promise.all([
    fetchEveryRow<DistanceRouteRow>((a, b) => db.from("routes")
      .select("id,route_date,status,operator_id").order("route_date", { ascending: false }).order("id").range(a, b)),
    fetchEveryRow<DistanceStopRow>((a, b) => db.from("route_stops")
      .select("id,route_id,machine_id,stop_order,status").order("route_id").order("stop_order").order("id").range(a, b)),
    fetchEveryRow<RouteDistanceMachine>((a, b) => db.from("machines")
      .select("id,name").order("name").range(a, b)),
    fetchEveryRow<RouteDistanceStorage>((a, b) => db.from("storage_locations")
      .select("id,name,active").order("name").range(a, b)),
    fetchEveryRow<RouteDistanceOperator>((a, b) => db.from("team_members")
      .select("id,full_name").order("full_name").range(a, b)),
    fetchEveryRow<DistanceEdgeRow>((a, b) => db.from("route_distance_edges")
      .select("id,from_machine_id,from_storage_location_id,to_machine_id,distance_km,notes").order("created_at").range(a, b)),
  ]);

  const activeStorages = storages.filter((storage) => storage.active);
  // Current Snacky production uses one active warehouse called MAIN; do not silently
  // pick an arbitrary warehouse if more than one is introduced.
  const main = activeStorages.find((storage) => String(storage.name ?? "").toUpperCase() === "MAIN");
  const activeStorage = main ?? (activeStorages.length === 1 ? activeStorages[0] : null);
  const stopMap = new Map<string, DistanceStopRow[]>();
  for (const stop of stops) {
    const list = stopMap.get(stop.route_id) ?? [];
    list.push(stop);
    stopMap.set(stop.route_id, list);
  }
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name || "Unnamed machine"]));
  const operatorNames = new Map(operators.map((operator) => [operator.id, operator.full_name || "Unnamed operator"]));
  const indexedEdges = indexRouteDistanceEdges(edges);
  const calculated = routes
    .filter((route) => !["cancelled", "canceled"].includes(String(route.status ?? "").toLowerCase()))
    .map((route) => calculateRouteDistance({
      route,
      stops: stopMap.get(route.id) ?? [],
      machineNames,
      operatorName: route.operator_id ? operatorNames.get(route.operator_id) : null,
      storageLocationId: activeStorage?.id ?? null,
      storageName: activeStorage?.name ?? "Storage not configured",
      edges: indexedEdges,
    }));

  const missing = new Map<string, MissingRouteDistanceLink & { routeIds: Set<string> }>();
  for (const route of calculated.filter((entry) => entry.completed)) {
    for (const leg of route.legs.filter((entry) => entry.km === null)) {
      const key = leg.fromKind + ":" + (leg.fromId ?? "none") + ":" + (leg.toId ?? "none");
      const found = missing.get(key) ?? {
        fromKind: leg.fromKind,
        fromId: leg.fromId,
        fromName: leg.fromName,
        toId: leg.toId,
        toName: leg.toName,
        uses: 0,
        routes: 0,
        routeIds: new Set<string>(),
      };
      found.uses += 1;
      found.routeIds.add(route.routeId);
      found.routes = found.routeIds.size;
      missing.set(key, found);
    }
  }

  return {
    routes: calculated,
    edges,
    machines,
    storages: activeStorages,
    operators,
    activeStorageId: activeStorage?.id ?? null,
    missingLinks: [...missing.values()].sort((a, b) => b.uses - a.uses),
  };
}
