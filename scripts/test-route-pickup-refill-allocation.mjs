import assert from "node:assert/strict";
import test from "node:test";

import { buildRefillLinePickRows } from "../src/lib/route-pickup-refill-allocation.ts";

test("checked quantities above stale refill recommendations are preserved", () => {
  const rows = buildRefillLinePickRows({
    stopItems: [
      { machineId: "machine-a", productId: "product-a", quantity: 21, actionType: "planned_pick" },
      { machineId: "machine-b", productId: "product-a", quantity: 11, actionType: "planned_pick" },
    ],
    legacyItems: [],
    refillLines: [
      { id: "line-a", machineId: "machine-a", productId: "product-a", plannedQty: 19 },
      { id: "line-b", machineId: "machine-b", productId: "product-a", plannedQty: 5 },
    ],
  });

  assert.deepEqual(rows, [
    { id: "line-a", picked_qty: 21 },
    { id: "line-b", picked_qty: 11 },
  ]);
  assert.equal(rows.reduce((sum, row) => sum + row.picked_qty, 0), 32);
});

test("multiple checklist rows share each refill line exactly once", () => {
  const rows = buildRefillLinePickRows({
    stopItems: [
      { machineId: "machine-a", productId: "product-a", quantity: 7, actionType: "planned_pick" },
      { machineId: "machine-a", productId: "product-a", quantity: 5, actionType: "planned_pick" },
    ],
    legacyItems: [],
    refillLines: [
      { id: "line-a", machineId: "machine-a", productId: "product-a", plannedQty: 8 },
      { id: "line-b", machineId: "machine-a", productId: "product-a", plannedQty: 2 },
    ],
  });

  assert.deepEqual(rows, [
    { id: "line-a", picked_qty: 8 },
    { id: "line-b", picked_qty: 4 },
  ]);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
});

test("assigned extra products do not alter legacy refill picked totals", () => {
  const rows = buildRefillLinePickRows({
    stopItems: [
      { machineId: "machine-a", productId: "product-a", quantity: 9, actionType: "planned_pick" },
      { machineId: "machine-a", productId: "product-a", quantity: 3, actionType: "extra_product" },
    ],
    legacyItems: [],
    refillLines: [
      { id: "line-a", machineId: "machine-a", productId: "product-a", plannedQty: 9 },
    ],
  });

  assert.deepEqual(rows, [{ id: "line-a", picked_qty: 9 }]);
});

test("zero checked quantities are explicitly written for matching refill products", () => {
  const rows = buildRefillLinePickRows({
    stopItems: [
      { machineId: "machine-a", productId: "product-a", quantity: 0, actionType: "planned_pick" },
    ],
    legacyItems: [],
    refillLines: [
      { id: "line-a", machineId: "machine-a", productId: "product-a", plannedQty: 10 },
    ],
  });

  assert.deepEqual(rows, [{ id: "line-a", picked_qty: 0 }]);
});
