import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  calculateRouteDistance,
  indexRouteDistanceEdges,
  sumOperatorRouteDistances,
} from "../src/lib/route-distance.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const storage = "storage-main";
const ids = { khalij: "kh", school: "school", hospital: "hosp", mall: "mall", land: "land", att: "att" };
const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
const edge = (origin, destination, km) => ({
  from_storage_location_id: origin === storage ? storage : null,
  from_machine_id: origin === storage ? null : origin,
  to_machine_id: destination,
  distance_km: km,
});
const distances = indexRouteDistanceEdges([
  edge(storage, ids.khalij, 22), edge(storage, ids.school, 39),
  edge(storage, ids.mall, 3.5), edge(storage, ids.att, 9.7),
  edge(ids.khalij, ids.school, 22), edge(ids.school, ids.khalij, 20),
  edge(ids.att, ids.hospital, 10),
]);
function route(id, machines, { status = "completed", month = "2026-11", operatorId = "noury", statuses = [] } = {}) {
  return calculateRouteDistance({
    route: { id, route_date: month + "-10", operator_id: operatorId, status },
    stops: machines.map((machine_id, index) => ({
      id: id + "-stop-" + index, route_id: id, stop_order: index + 1,
      machine_id, status: statuses[index] ?? "completed",
    })),
    machineNames: names, operatorName: "Noury", storageLocationId: storage, storageName: "MAIN", edges: distances,
  });
}

test("one-stop route counts storage to site only, not return", () => {
  const result = route("r1", [ids.khalij]);
  assert.equal(result.totalKm, 22);
  assert.equal(result.legs.length, 1);
});

test("multi-stop routes follow saved stop order and asymmetric directional distances", () => {
  assert.equal(route("r2", [ids.khalij, ids.school]).totalKm, 44);
  assert.equal(route("r3", [ids.school, ids.khalij]).totalKm, 59);
  assert.deepEqual(route("r4", [ids.att, ids.hospital]).legs.map((leg) => leg.km), [9.7, 10]);
});

test("unknown road links remain missing instead of being replaced with zero", () => {
  const result = route("r5", [ids.mall, ids.land]);
  assert.equal(result.knownKm, 3.5);
  assert.equal(result.totalKm, null);
  assert.equal(result.missingLegCount, 1);
  const summary = sumOperatorRouteDistances([route("r2", [ids.khalij, ids.school]), result]);
  assert.equal(summary.confirmedKm, 44);
  assert.equal(summary.incompleteRoutes, 1);
  assert.equal(summary.completedRoutes, 2);
});

test("historical month and all-time summaries only count completed routes", () => {
  const current = route("r6", [ids.khalij], { month: "2026-11" });
  const previous = route("r7", [ids.school], { month: "2026-10" });
  const pending = route("r8", [ids.school], { status: "pickup_confirmed" });
  assert.equal(sumOperatorRouteDistances([current, previous, pending], "2026-11").confirmedKm, 22);
  assert.equal(sumOperatorRouteDistances([current, previous, pending]).confirmedKm, 61);
});

test("skipped stops do not imply completed visits or a fabricated traveled distance", () => {
  const result = route("r9", [ids.khalij, ids.land, ids.school], { statuses: ["completed", "skipped", "completed"] });
  assert.equal(result.stopCount, 2);
  assert.equal(result.totalKm, 44);
});

test("owner-only server and UI code do not expose the distance matrix to operators", () => {
  const page = read("src/app/reports/route-distances/page.tsx");
  const action = read("src/lib/route-distance-actions.ts");
  const migration = read("supabase/migrations/20261114190000_route_distance_edges.sql");
  const operatorPage = read("src/app/operator/routes/page.tsx");
  assert.match(page, /canManagePayroll\(profile\)/);
  assert.match(action, /canManagePayroll\(profile\)/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all.*anon, authenticated/i);
  assert.doesNotMatch(operatorPage, /route-distances/);
  assert.match(page, /All-time km/);
  assert.match(page, /مسافات الجولات/);
});
