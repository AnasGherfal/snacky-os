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
function route(id, machines, { status = "completed", month = "2026-11", operatorId = "noury", statuses = [], schoolReturnKm = null } = {}) {
  return calculateRouteDistance({
    route: { id, route_date: month + "-10", operator_id: operatorId, status },
    stops: machines.map((machine_id, index) => ({
      id: id + "-stop-" + index, route_id: id, stop_order: index + 1,
      machine_id, status: statuses[index] ?? "completed",
    })),
    machineNames: names, operatorName: "Noury", storageLocationId: storage, storageName: "MAIN", edges: distances,
    returnToStorageKmByMachineId: schoolReturnKm === null ? undefined : new Map([[ids.school, schoolReturnKm]]),
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

test("school as sole final stop includes 25 km return to MAIN without adding a visit", () => {
  const result = route("school-alone", [ids.school], { schoolReturnKm: 25 });
  assert.equal(result.knownKm, 64); // Storage -> school 39 + school -> storage 25
  assert.equal(result.totalKm, 64);
  assert.equal(result.stopCount, 1);
  assert.equal(result.legs.length, 2);
  assert.deepEqual(result.legs.map((leg) => [leg.legKind, leg.km, leg.fromName, leg.toName]), [
    ["visit", 39, "MAIN", "school"],
    ["return_to_storage", 25, "school", "MAIN"],
  ]);
});

test("multi-stop route ending at the school gets return exactly once", () => {
  const result = route("end-school", [ids.khalij, ids.school], { schoolReturnKm: 25 });
  assert.equal(result.stopCount, 2);
  assert.equal(result.totalKm, 69); // 22 + 22 + 25
  assert.equal(result.legs.filter((leg) => leg.legKind === "return_to_storage").length, 1);
});

test("school before another stop gets no return and no double-counted travel", () => {
  const result = route("school-first", [ids.school, ids.khalij], { schoolReturnKm: 25 });
  assert.equal(result.totalKm, 59); // 39 + 20, no 25
  assert.equal(result.legs.filter((leg) => leg.legKind === "return_to_storage").length, 0);
});

test("non-school routes and incomplete or skipped school visits get no return", () => {
  const other = route("not-school", [ids.khalij], { schoolReturnKm: 25 });
  assert.equal(other.totalKm, 22);
  assert.equal(other.legs.length, 1);

  const active = route("school-active", [ids.school], { status: "pickup_confirmed", schoolReturnKm: 25 });
  assert.equal(active.totalKm, 39);
  assert.equal(active.legs.length, 1);

  const skippedSchool = route("school-skipped", [ids.khalij, ids.school], { statuses: ["completed", "skipped"], schoolReturnKm: 25 });
  assert.equal(skippedSchool.totalKm, 22);
});

test("configured return distance may be edited and unknown outbound legs stay unknown", () => {
  assert.equal(route("edit-return", [ids.school], { schoolReturnKm: 30 }).totalKm, 69);
  assert.equal(route("zero-return", [ids.school], { schoolReturnKm: 0 }).totalKm, 39);
  const unknown = route("missing-middle", [ids.mall, ids.school], { schoolReturnKm: 25 });
  assert.equal(unknown.knownKm, 28.5);
  assert.equal(unknown.totalKm, null);
  assert.equal(unknown.missingLegCount, 1);
});

test("school return changes historical/monthly operator totals but not route counts", () => {
  const school = route("school-october", [ids.school], { month: "2026-10", schoolReturnKm: 25 });
  const ordinary = route("other-november", [ids.khalij], { schoolReturnKm: 25 });
  assert.equal(sumOperatorRouteDistances([school, ordinary], "2026-10").confirmedKm, 64);
  assert.equal(sumOperatorRouteDistances([school, ordinary], "2026-11").confirmedKm, 22);
  assert.equal(sumOperatorRouteDistances([school, ordinary]).confirmedKm, 86);
  assert.equal(sumOperatorRouteDistances([school, ordinary]).completedRoutes, 2);
});

test("school return settings are admin-only, scoped and visible in route detail", () => {
  const server = read("src/lib/route-distance-server.ts");
  const page = read("src/app/reports/route-distances/page.tsx");
  const action = read("src/lib/route-distance-actions.ts");
  const migration = read("supabase/migrations/20261117005500_school_return_distance_rule.sql");
  assert.ok(server.includes('from("route_return_distance_rules")'));
  assert.ok(server.includes("returnToStorageKmByMachineId"));
  assert.ok(page.includes("school-return-distance"));
  assert.ok(page.includes('legKind === "return_to_storage"'));
  assert.ok(action.includes("canManagePayroll(profile)"));
  assert.ok(action.includes('school?.name !== "Elite Future School"'));
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all.*anon, authenticated/i);
  assert.ok(migration.includes("25.00"));
});
