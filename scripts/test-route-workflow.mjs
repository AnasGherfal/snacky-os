import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_ROUTE_STATUSES,
  OPERATOR_VISIBLE_ROUTE_STATUSES,
  ROUTE_ASSIGNED_STATUS,
  ROUTE_AVAILABLE_STATUS,
  ROUTE_DATABASE_SAFE_TERMINAL_STATUSES,
  ROUTE_DRAFT_STATUS,
  ROUTE_FILLING_STATUS,
  ROUTE_IN_PROGRESS_STATUS,
  ROUTE_PICKUP_CONFIRMED_STATUS,
  ROUTE_RESERVATION_STATUSES,
  TERMINAL_ROUTE_STATUSES,
  fallbackRouteStatusForEnumMismatch,
  isActiveRouteStatus,
  isOperatorVisibleRouteStatus,
  isRouteReservationStatus,
  isRouteStatusEnumMismatch,
  isTerminalRouteStatus,
  routeDisplayStatus,
  routeStatusForNewRoute,
} from "../src/lib/route-workflow.ts";

test("route status groups describe one consistent workflow", () => {
  assert.deepEqual([...OPERATOR_VISIBLE_ROUTE_STATUSES], ["available", "ready", "draft"]);
  assert.deepEqual([...ACTIVE_ROUTE_STATUSES], ["in_progress", "pickup_confirmed", "filling", "started", "machine_filling"]);
  assert.deepEqual([...TERMINAL_ROUTE_STATUSES], ["completed", "cancelled", "reviewed", "canceled"]);

  for (const status of [ROUTE_AVAILABLE_STATUS, "ready", ROUTE_DRAFT_STATUS]) {
    assert.equal(isOperatorVisibleRouteStatus(status), true, status);
    assert.equal(isRouteReservationStatus(status), true, status);
  }

  for (const status of [ROUTE_ASSIGNED_STATUS, ROUTE_IN_PROGRESS_STATUS, ROUTE_PICKUP_CONFIRMED_STATUS, ROUTE_FILLING_STATUS, "started", "machine_filling"]) {
    assert.equal(isRouteReservationStatus(status), true, status);
  }

  for (const status of ["completed", "reviewed", "cancelled", "canceled"]) {
    assert.equal(isTerminalRouteStatus(status), true, status);
    assert.equal(isRouteReservationStatus(status), false, status);
  }

  assert.equal(isActiveRouteStatus("assigned"), false);
  assert.equal(isOperatorVisibleRouteStatus("assigned"), false);
});

test("route creation and display statuses handle current and migrated databases", () => {
  assert.equal(routeStatusForNewRoute(null), ROUTE_AVAILABLE_STATUS);
  assert.equal(routeStatusForNewRoute("operator-1"), ROUTE_ASSIGNED_STATUS);

  assert.equal(fallbackRouteStatusForEnumMismatch(ROUTE_AVAILABLE_STATUS), ROUTE_DRAFT_STATUS);
  assert.equal(fallbackRouteStatusForEnumMismatch(ROUTE_PICKUP_CONFIRMED_STATUS), ROUTE_IN_PROGRESS_STATUS);
  assert.equal(fallbackRouteStatusForEnumMismatch(ROUTE_FILLING_STATUS), ROUTE_IN_PROGRESS_STATUS);
  assert.equal(fallbackRouteStatusForEnumMismatch("canceled"), "cancelled");

  assert.equal(routeDisplayStatus("draft", null), ROUTE_AVAILABLE_STATUS);
  assert.equal(routeDisplayStatus("ready", null), ROUTE_AVAILABLE_STATUS);
  assert.equal(routeDisplayStatus("assigned", "operator-1"), ROUTE_ASSIGNED_STATUS);
});

test("database-safe status filters avoid production enum mismatch values", () => {
  assert.deepEqual([...ROUTE_DATABASE_SAFE_TERMINAL_STATUSES], ["completed", "reviewed", "cancelled"]);

  for (const status of ROUTE_DATABASE_SAFE_TERMINAL_STATUSES) {
    assert.equal(["draft", "assigned", "in_progress", "completed", "reviewed", "cancelled"].includes(status), true, status);
  }

  assert.equal(ROUTE_RESERVATION_STATUSES.includes("available"), true);
  assert.equal(ROUTE_RESERVATION_STATUSES.includes("pickup_confirmed"), true);
});

test("route status enum mismatch detection matches Supabase errors", () => {
  const error = {
    message: 'invalid input value for enum route_status: "available"',
    code: "22P02",
  };
  assert.equal(isRouteStatusEnumMismatch(error, "available"), true);
  assert.equal(isRouteStatusEnumMismatch(error, "assigned"), false);
  assert.equal(isRouteStatusEnumMismatch({ message: "permission denied" }, "available"), false);
});
