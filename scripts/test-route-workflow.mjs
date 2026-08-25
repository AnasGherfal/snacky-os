import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACTIVE_ROUTE_STATUSES,
  ACTIVE_STOP_STATUSES,
  COMPLETED_STOP_STATUSES,
  OPERATOR_VISIBLE_ROUTE_STATUSES,
  ROUTE_ASSIGNED_STATUS,
  ROUTE_AVAILABLE_STATUS,
  ROUTE_DATABASE_WRITE_STATUSES,
  ROUTE_DATABASE_SAFE_TERMINAL_STATUSES,
  ROUTE_DRAFT_STATUS,
  ROUTE_IN_PROGRESS_STATUS,
  ROUTE_PICKUP_CONFIRMED_STATUS,
  ROUTE_RESERVATION_STATUSES,
  ROUTE_STOP_STATUS_VALUES,
  ROUTE_STATUS_VALUES,
  TERMINAL_ROUTE_STATUSES,
  fallbackRouteStatusForEnumMismatch,
  isActiveRouteStatus,
  isOperatorVisibleRouteStatus,
  isRouteReservationStatus,
  isRouteStopActiveStatus,
  isRouteStopDoneStatus,
  isRouteStatusEnumMismatch,
  isTerminalRouteStatus,
  isRouteItemsEditableStatus,
  missingRouteWorkflowStatuses,
  nextOperatorRouteHref,
  routeDisplayStatus,
  routeStatusForNewRoute,
} from "../src/lib/route-workflow.ts";
import { groupRouteItemsForDisplay, pickupProductPriorityGroup, sortPickupProductRows } from "../src/lib/route-pickup-checklist.ts";

function sourceWindow(path, marker, length = 900) {
  const source = readFileSync(path, "utf8");
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `${path} should contain ${marker}`);
  return source.slice(index, index + length);
}

test("route status groups describe one consistent workflow", () => {
  assert.deepEqual([...ROUTE_STATUS_VALUES], ["draft", "assigned", "in_progress", "pickup_confirmed", "completed", "verified", "payroll_pending", "paid", "disputed", "reviewed", "cancelled"]);
  assert.deepEqual([...OPERATOR_VISIBLE_ROUTE_STATUSES], ["draft"]);
  assert.deepEqual([...ACTIVE_ROUTE_STATUSES], ["in_progress", "pickup_confirmed"]);
  assert.deepEqual([...TERMINAL_ROUTE_STATUSES], ["completed", "verified", "payroll_pending", "paid", "disputed", "cancelled", "reviewed"]);

  for (const status of [ROUTE_DRAFT_STATUS]) {
    assert.equal(isOperatorVisibleRouteStatus(status), true, status);
    assert.equal(isRouteReservationStatus(status), true, status);
  }

  for (const status of [ROUTE_ASSIGNED_STATUS, ROUTE_IN_PROGRESS_STATUS, ROUTE_PICKUP_CONFIRMED_STATUS]) {
    assert.equal(isRouteReservationStatus(status), true, status);
  }

  for (const status of ["completed", "reviewed", "cancelled"]) {
    assert.equal(isTerminalRouteStatus(status), true, status);
    assert.equal(isRouteReservationStatus(status), false, status);
  }

  assert.equal(isOperatorVisibleRouteStatus(ROUTE_AVAILABLE_STATUS), true);
  assert.equal(isActiveRouteStatus("assigned"), false);
  assert.equal(isOperatorVisibleRouteStatus("assigned"), false);
});

test("route item edits stay open for non-terminal routes only", () => {
  assert.equal(isRouteItemsEditableStatus("draft"), true);
  assert.equal(isRouteItemsEditableStatus("pickup_confirmed"), true);
  assert.equal(isRouteItemsEditableStatus("completed"), false);
  assert.equal(isRouteItemsEditableStatus("cancelled"), false);
});

test("route creation and display statuses use database statuses only", () => {
  assert.equal(routeStatusForNewRoute(null), ROUTE_DRAFT_STATUS);
  assert.equal(routeStatusForNewRoute("operator-1"), ROUTE_ASSIGNED_STATUS);

  assert.equal(fallbackRouteStatusForEnumMismatch(ROUTE_PICKUP_CONFIRMED_STATUS), ROUTE_IN_PROGRESS_STATUS);
  assert.equal(fallbackRouteStatusForEnumMismatch(ROUTE_AVAILABLE_STATUS), null);
  assert.equal(fallbackRouteStatusForEnumMismatch("canceled"), null);

  assert.equal(routeDisplayStatus("draft", null), ROUTE_AVAILABLE_STATUS);
  assert.equal(routeDisplayStatus(routeStatusForNewRoute(null), null), ROUTE_AVAILABLE_STATUS);
  assert.equal(routeDisplayStatus("assigned", "operator-1"), ROUTE_ASSIGNED_STATUS);
});

test("partial route continuation respects independent stop statuses", () => {
  assert.deepEqual([...ROUTE_STOP_STATUS_VALUES], ["pending", "picked", "in_progress", "completed", "skipped", "canceled", "arrived", "refilling", "cash_collected", "issue_reported"]);
  assert.deepEqual([...ACTIVE_STOP_STATUSES], ["picked", "in_progress", "arrived", "refilling", "cash_collected", "issue_reported"]);
  assert.deepEqual([...COMPLETED_STOP_STATUSES], ["completed", "skipped", "canceled"]);
  assert.equal(isRouteStopDoneStatus("completed"), true);
  assert.equal(isRouteStopDoneStatus("skipped"), true);
  assert.equal(isRouteStopDoneStatus("canceled"), true);
  assert.equal(isRouteStopActiveStatus("picked"), true);
  assert.equal(isRouteStopActiveStatus("in_progress"), true);

  const routeId = "route-1";
  const stops = [
    { id: "stop-a", status: "completed", stop_order: 1 },
    { id: "stop-b", status: "skipped", stop_order: 2 },
    { id: "stop-c", status: "pending", stop_order: 3 },
  ];
  assert.equal(
    nextOperatorRouteHref({ routeId, status: "in_progress", hasPickup: true, stops }),
    "/operator/routes/route-1/pick-list",
  );

  assert.equal(
    nextOperatorRouteHref({
      routeId,
      status: "in_progress",
      hasPickup: true,
      stops: [{ id: "stop-c", status: "picked", stop_order: 3 }, ...stops.slice(0, 2)],
    }),
    "/operator/routes/route-1/stops/stop-c",
  );

  assert.equal(
    nextOperatorRouteHref({
      routeId,
      status: "in_progress",
      hasPickup: true,
      stops: stops.map((stop) => stop.id === "stop-c" ? { ...stop, status: "skipped" } : stop),
    }),
    "/operator/routes/route-1/leftovers",
  );
});

test("database write statuses avoid production enum mismatch values", () => {
  assert.deepEqual([...ROUTE_DATABASE_WRITE_STATUSES], ["draft", "assigned", "in_progress", "pickup_confirmed", "completed", "verified", "payroll_pending", "paid", "disputed", "reviewed", "cancelled"]);
  assert.deepEqual([...ROUTE_DATABASE_SAFE_TERMINAL_STATUSES], ["completed", "reviewed", "cancelled"]);

  for (const status of ROUTE_DATABASE_WRITE_STATUSES) {
    assert.equal(["draft", "assigned", "in_progress", "pickup_confirmed", "completed", "verified", "payroll_pending", "paid", "disputed", "reviewed", "cancelled"].includes(status), true, status);
  }

  assert.equal(ROUTE_RESERVATION_STATUSES.includes("available"), false);
  assert.equal(ROUTE_RESERVATION_STATUSES.includes("pickup_confirmed"), true);
});

test("route status enum mismatch detection matches Supabase errors", () => {
  const error = {
    message: 'invalid input value for enum route_status: "pickup_confirmed"',
    code: "22P02",
  };
  assert.equal(isRouteStatusEnumMismatch(error, "pickup_confirmed"), true);
  assert.equal(isRouteStatusEnumMismatch(error, "assigned"), false);
  assert.equal(isRouteStatusEnumMismatch({ message: "permission denied" }, "pickup_confirmed"), false);
});

test("schema validation reports missing enum values before route workflow writes", () => {
  assert.deepEqual(
    missingRouteWorkflowStatuses({
      routeStatuses: ["draft", "assigned", "in_progress", "completed", "verified", "payroll_pending", "paid", "disputed", "reviewed", "cancelled"],
      routeStopStatuses: [...ROUTE_STOP_STATUS_VALUES],
    }),
    { routeStatuses: ["pickup_confirmed"], routeStopStatuses: [] },
  );

  assert.deepEqual(
    missingRouteWorkflowStatuses({
      routeStatuses: [...ROUTE_STATUS_VALUES],
      routeStopStatuses: [...ROUTE_STOP_STATUS_VALUES],
    }),
    { routeStatuses: [], routeStopStatuses: [] },
  );
});

test("route reservation queries do not send UI-only statuses into route_status enum filters", () => {
  const createPageReservationQuery = sourceWindow(
    "src/app/routes/new/page.tsx",
    '.from("route_stock_lines")',
  );
  const createApiReservationQuery = sourceWindow(
    "src/app/api/routes/route.ts",
    '.select("route_id, product_id, planned_qty, picked_qty")',
  );

  for (const querySource of [createPageReservationQuery, createApiReservationQuery]) {
    assert.equal(querySource.includes('.in("status"'), false);
    assert.equal(querySource.includes(".in('status'"), false);
    assert.equal(querySource.includes('.eq("status", ROUTE_AVAILABLE_STATUS'), false);
    assert.equal(querySource.includes('"available"'), false);
  }
});

test("route pickup checklist prioritizes Mr Crunch, then Doritos, then other products", () => {
  const sorted = sortPickupProductRows([
    { productName: "Water 500ml" },
    { productName: "Doritos Nacho" },
    { productName: "طربوش Cheese" },
    { productName: "Chips Classic" },
    { productName: "Mr Crunch Tarboouch" },
    { productName: "دوريتوس Green Hot" },
  ]);

  assert.deepEqual(sorted.map((row) => row.productName), [
    "Mr Crunch Tarboouch",
    "طربوش Cheese",
    "Doritos Nacho",
    "دوريتوس Green Hot",
    "Chips Classic",
    "Water 500ml",
  ]);
  assert.equal(pickupProductPriorityGroup("Tarboouch"), 1);
  assert.equal(pickupProductPriorityGroup("Doritos Green Hot"), 2);
  assert.equal(pickupProductPriorityGroup("Water"), 3);
});

test("route product grouping keeps similar products together in the expected family order", () => {
  const grouped = groupRouteItemsForDisplay([
    { productName: "Water 500ml", quantity: 1 },
    { productName: "Doritos Nacho", quantity: 2 },
    { productName: "Brioche Roll", quantity: 3 },
    { productName: "Luppo", quantity: 4 },
    { productName: "Almarai Strawberry Milk", quantity: 4 },
    { productName: "Bebeto Gummies", quantity: 5 },
    { productName: "X!R", quantity: 6 },
    { productName: "Pepsi Cola", quantity: 6 },
    { productName: "Mr Crunch Tarboosh", quantity: 7 },
    { productName: "Galaxy Chocolate", quantity: 8 },
    { productName: "Snickers", quantity: 9 },
    { productName: "Twix", quantity: 10 },
    { productName: "Mystery Snack", quantity: 11 },
  ]);

  assert.deepEqual(grouped.map((group) => group.groupKey), [
    "chips",
    "chocolates",
    "rolls_bakery",
    "almarai_dairy",
    "candy",
    "drinks",
    "water",
    "other",
  ]);
  assert.deepEqual(grouped[0].items.map((item) => item.productName), ["Mr Crunch Tarboosh", "Doritos Nacho"]);
  assert.deepEqual(grouped[1].items.map((item) => item.productName), ["Galaxy Chocolate", "Snickers", "Twix", "Luppo"]);
  assert.deepEqual(grouped[5].items.map((item) => item.productName), ["Pepsi Cola", "X!R"]);
  assert.equal(grouped[0].totalQuantity, 9);
  assert.equal(grouped[0].defaultExpanded, true);
  assert.equal(grouped[2].defaultExpanded, false);
});
