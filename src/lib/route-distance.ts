/**
 * Admin-only operational route distance calculations.
 * Source of truth: ordered route_stops + directional, manually verified edge distances.
 * Never add a return-to-storage leg or invent unknown road distances.
 * This module contains no user/permission or database access so it can be tested directly.
 */
export type DistanceEdgeRow = {
  id?: string;
  from_storage_location_id: string | null;
  from_machine_id: string | null;
  to_machine_id: string;
  distance_km: number | string;
  notes?: string | null;
};

export type DistanceRouteRow = {
  id: string;
  route_date: string | null;
  status: string | null;
  operator_id: string | null;
};

export type DistanceStopRow = {
  id: string;
  route_id: string;
  machine_id: string | null;
  stop_order: number | null;
  status: string | null;
};

export type RouteDistanceLeg = {
  stopId: string;
  stopOrder: number;
  fromKind: "storage" | "machine";
  fromId: string | null;
  fromName: string;
  toId: string | null;
  toName: string;
  km: number | null;
};

export type CalculatedRouteDistance = {
  routeId: string;
  routeDate: string | null;
  operatorId: string | null;
  operatorName: string;
  status: string | null;
  completed: boolean;
  legs: RouteDistanceLeg[];
  stopCount: number;
  knownKm: number;
  totalKm: number | null;
  missingLegCount: number;
};

const COMPLETE_STATUSES = new Set(["completed", "verified", "reviewed", "payroll_pending", "paid", "disputed"]);
const SKIPPED_STATUSES = new Set(["skipped", "canceled", "cancelled"]);
const roundKm = (value: number) => Math.round(value * 100) / 100;

export function isCompletedDistanceRoute(status: string | null | undefined) {
  return COMPLETE_STATUSES.has(String(status ?? "").toLowerCase());
}

export function routeDistanceEdgeKey(fromKind: "storage" | "machine", fromId: string, toId: string) {
  return fromKind + ":" + fromId + ">machine:" + toId;
}

export function indexRouteDistanceEdges(edges: DistanceEdgeRow[]) {
  const indexed = new Map<string, number>();
  for (const edge of edges) {
    const fromId = edge.from_machine_id ?? edge.from_storage_location_id;
    const kind = edge.from_machine_id ? "machine" : "storage";
    const km = Number(edge.distance_km);
    if (!fromId || !edge.to_machine_id || !Number.isFinite(km) || km < 0) continue;
    indexed.set(routeDistanceEdgeKey(kind, fromId, edge.to_machine_id), roundKm(km));
  }
  return indexed;
}

export function calculateRouteDistance(input: {
  route: DistanceRouteRow;
  stops: DistanceStopRow[];
  machineNames: Map<string, string>;
  operatorName?: string | null;
  storageLocationId: string | null;
  storageName?: string | null;
  edges: Map<string, number>;
}): CalculatedRouteDistance {
  const { route, machineNames, storageLocationId, edges } = input;
  const completed = isCompletedDistanceRoute(route.status);
  const stops = input.stops
    .filter((stop) => stop.route_id === route.id)
    .filter((stop) => completed
      ? String(stop.status ?? "").toLowerCase() === "completed"
      : !SKIPPED_STATUSES.has(String(stop.status ?? "").toLowerCase()))
    .sort((a, b) => Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0) || a.id.localeCompare(b.id));

  let fromKind: "storage" | "machine" = "storage";
  let fromId: string | null = storageLocationId;
  let fromName = input.storageName || "Storage";
  let knownKm = 0;
  let missingLegCount = 0;
  const legs: RouteDistanceLeg[] = [];

  for (const stop of stops) {
    const toId = stop.machine_id;
    const toName = toId ? machineNames.get(toId) || "Unmapped machine" : "Machine not set";
    const sameMachine = fromKind === "machine" && Boolean(toId) && fromId === toId;
    const key = fromId && toId ? routeDistanceEdgeKey(fromKind, fromId, toId) : null;
    const edgeKm = key ? edges.get(key) : undefined;
    // Two consecutive records for the very same machine require no inter-site travel.
    const km = sameMachine ? 0 : edgeKm === undefined ? null : edgeKm;
    if (km === null) missingLegCount += 1;
    else knownKm += km;
    legs.push({
      stopId: stop.id,
      stopOrder: Number(stop.stop_order ?? 0),
      fromKind,
      fromId,
      fromName,
      toId,
      toName,
      km,
    });
    fromKind = "machine";
    fromId = toId;
    fromName = toName;
  }

  knownKm = roundKm(knownKm);
  return {
    routeId: route.id,
    routeDate: route.route_date,
    operatorId: route.operator_id,
    operatorName: input.operatorName || "Unassigned",
    status: route.status,
    completed,
    legs,
    stopCount: legs.length,
    knownKm,
    totalKm: legs.length > 0 && missingLegCount === 0 ? knownKm : null,
    missingLegCount: missingLegCount + (legs.length === 0 ? 1 : 0),
  };
}

export function sumOperatorRouteDistances(rows: CalculatedRouteDistance[], month: string | null = null) {
  const completed = rows.filter((route) => route.completed && (!month || String(route.routeDate ?? "").startsWith(month)));
  const fullyMeasured = completed.filter((route) => route.totalKm !== null);
  return {
    completedRoutes: completed.length,
    fullyMeasuredRoutes: fullyMeasured.length,
    incompleteRoutes: completed.length - fullyMeasured.length,
    confirmedKm: roundKm(fullyMeasured.reduce((sum, route) => sum + (route.totalKm ?? 0), 0)),
    missingLegCount: completed.reduce((sum, route) => sum + route.missingLegCount, 0),
  };
}
