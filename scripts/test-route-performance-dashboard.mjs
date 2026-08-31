import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildMonthlyOperationsReport, movementUnitDelta } from "../src/lib/monthly-operations-report.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(root, "src/app/reports/route-performance/page.tsx"), "utf8");
const reports = fs.readFileSync(path.join(root, "src/app/reports/page.tsx"), "utf8");
const tabs = fs.readFileSync(path.join(root, "src/components/module-tabs-config.ts"), "utf8");

const routes = [
  { id: "route-1", route_date: "2026-08-03", operator_id: "op-1", status: "completed", started_at: "2026-08-03T08:00:00Z", completed_at: "2026-08-03T10:00:00Z", cancellation_reason: null },
  { id: "route-2", route_date: "2026-08-04", operator_id: "op-1", status: "cancelled", started_at: null, completed_at: null, cancellation_reason: "Site closed" },
  { id: "route-3", route_date: "2026-08-05", operator_id: "op-2", status: "verified", started_at: "2026-08-05T08:00:00Z", completed_at: "2026-08-05T09:00:00Z", cancellation_reason: null },
];
const stops = [
  { id: "stop-1", route_id: "route-1", machine_id: "machine-1", status: "completed", completed_at: "2026-08-03T09:00:00Z" },
  { id: "stop-2", route_id: "route-2", machine_id: "machine-2", status: "skipped", completed_at: null },
  { id: "stop-3", route_id: "route-3", machine_id: "machine-2", status: "completed", completed_at: "2026-08-05T08:45:00Z" },
];
const movement = (overrides) => ({
  related_route_id: "route-1",
  related_route_stop_id: "stop-1",
  related_machine_id: "machine-1",
  quantity: 0,
  reason: null,
  source_type: null,
  from_entity_type: null,
  to_entity_type: null,
  ...overrides,
});

test("ledger movement classification keeps actual route units truthful", () => {
  assert.deepEqual(movementUnitDelta(movement({ quantity: 10, reason: "storage_to_operator_bag", from_entity_type: "storage", to_entity_type: "operator_bag" })), { loaded: 10, filled: 0, returned: 0, damaged: 0, machineStorage: 0 });
  assert.deepEqual(movementUnitDelta(movement({ quantity: 6, reason: "operator_bag_to_machine", from_entity_type: "operator_bag", to_entity_type: "machine" })), { loaded: 0, filled: 6, returned: 0, damaged: 0, machineStorage: 0 });
  assert.deepEqual(movementUnitDelta(movement({ quantity: 1, reason: "manual_correction", from_entity_type: "machine", to_entity_type: "operator_bag" })), { loaded: 0, filled: -1, returned: 0, damaged: 0, machineStorage: 0 });
  assert.equal(movementUnitDelta(movement({ quantity: 2, reason: "returned_from_machine", from_entity_type: "machine", to_entity_type: "operator_bag" })).filled, 0);
});

test("monthly operations separates completed visits from positive fill visits", () => {
  const report = buildMonthlyOperationsReport({
    routes,
    stops,
    movements: [
      movement({ quantity: 10, reason: "storage_to_operator_bag", from_entity_type: "storage", to_entity_type: "operator_bag" }),
      movement({ quantity: 6, reason: "operator_bag_to_machine", from_entity_type: "operator_bag", to_entity_type: "machine" }),
      movement({ quantity: 1, reason: "manual_correction", from_entity_type: "machine", to_entity_type: "operator_bag" }),
      movement({ quantity: 2, reason: "operator_bag_to_storage", from_entity_type: "operator_bag", to_entity_type: "storage" }),
      movement({ quantity: 1, reason: "damaged", from_entity_type: "operator_bag", to_entity_type: "waste" }),
    ],
    refills: [
      { route_id: "route-1", route_stop_id: "stop-1", machine_id: "machine-1", fill_status: "partial", issues_found: false },
      { route_id: "route-3", route_stop_id: "stop-3", machine_id: "machine-2", fill_status: "full", issues_found: true },
    ],
    manualSales: [{ route_id: "route-1", operator_id: "op-1", quantity: 2, total_amount_lyd: 10, status: "confirmed" }],
    fillLines: [
      { route_id: "route-1", route_stop_id: "stop-1", machine_id: "machine-1", action_type: "assigned_fill", assigned_qty: 8, actual_qty: 5, difference_qty: -3, needs_review: true },
      { route_id: "route-3", route_stop_id: "stop-3", machine_id: "machine-2", action_type: "assigned_fill", assigned_qty: 4, actual_qty: 0, difference_qty: -4, needs_review: true },
    ],
  });

  assert.equal(report.summary.routesScheduled, 3);
  assert.equal(report.summary.routesCompleted, 2, "verified routes remain completed work");
  assert.equal(report.summary.routesCancelled, 1);
  assert.equal(report.summary.completedVisits, 2);
  assert.equal(report.summary.fillVisits, 1, "a completed zero-fill visit is not called a fill");
  assert.equal(report.summary.uniqueMachinesFilled, 1);
  assert.equal(report.summary.loaded, 10);
  assert.equal(report.summary.filled, 5);
  assert.equal(report.summary.returned, 2);
  assert.equal(report.summary.damaged, 1);
  assert.equal(report.summary.shortageUnits, 7);
  assert.equal(report.summary.zeroFillLines, 1);
  assert.equal(report.summary.manualSaleUnits, 2);
  assert.equal(report.operators.find((operator) => operator.operatorId === "op-1")?.completedRoutes, 1);
  assert.equal(report.attentionRoutes.length, 3);
});

test("monthly refill totals include routes without an assigned operator", () => {
  const report = buildMonthlyOperationsReport({
    routes: [{ id: "route-unassigned", route_date: "2026-08-14", operator_id: null, status: "completed", started_at: null, completed_at: null, cancellation_reason: null }],
    stops: [{ id: "stop-unassigned", route_id: "route-unassigned", machine_id: "machine-a", status: "completed", completed_at: null }],
    movements: [],
    refills: [{ route_id: "route-unassigned", route_stop_id: "stop-unassigned", machine_id: "machine-a", fill_status: "partial", issues_found: true }],
    manualSales: [{ route_id: "route-unassigned", operator_id: null, quantity: 3, total_amount_lyd: 15, status: "confirmed" }],
    fillLines: [{ route_id: "route-unassigned", route_stop_id: "stop-unassigned", machine_id: "machine-a", action_type: "assigned_fill", assigned_qty: 4, actual_qty: 2, difference_qty: -2, needs_review: true }],
  });

  assert.equal(report.summary.partialFills, 1);
  assert.equal(report.summary.issueVisits, 1);
  assert.equal(report.summary.manualSalesLyd, 15);
  assert.equal(report.attentionRoutes.length, 1, "shortage and review routes remain visible even when completed");
});

test("monthly operations is visible, bilingual, and paginates beyond Supabase's row cap", () => {
  assert.match(page, /Monthly Operations/);
  assert.match(page, /التقرير التشغيلي الشهري/);
  assert.match(page, /PAGE_SIZE = 1000/);
  assert.match(page, /fetchAllPages/);
  assert.match(page, /inventory_movements/);
  assert.match(page, /route_stop_fill_lines/);
  assert.match(reports, /href: "\/reports\/route-performance"/);
  assert.match(reports, /ابدأ من هنا/);
  assert.match(tabs, /href: "\/reports\/route-performance"/);
  assert.match(tabs, /label: "Monthly Operations", href: "\/reports\/route-performance", labelAr: "التقرير التشغيلي الشهري"/);
});
