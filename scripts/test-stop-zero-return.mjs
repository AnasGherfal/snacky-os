import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildExplicitZeroFillReturnPlans } from "../src/lib/route-stop-zero-return.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("explicit zero returns the full quantity assigned to that stop", () => {
  assert.deepEqual(
    buildExplicitZeroFillReturnPlans([
      { productId: "water", assignedQty: 6, quantity: 0 },
      { productId: "chips", assignedQty: 4, quantity: 2 },
      { productId: "juice", assignedQty: 0, quantity: 0 },
    ]),
    [{ productId: "water", quantity: 6 }],
  );
});

test("duplicate planned rows for one product are returned once as an aggregated plan", () => {
  assert.deepEqual(
    buildExplicitZeroFillReturnPlans([
      { productId: "water", assignedQty: 3, quantity: 0 },
      { productId: "water", assignedQty: 2, quantity: 0 },
    ]),
    [{ productId: "water", quantity: 5 }],
  );
});

test("partial underfills remain in the operator bag for normal leftover reconciliation", () => {
  assert.deepEqual(
    buildExplicitZeroFillReturnPlans([
      { productId: "water", assignedQty: 6, quantity: 2 },
    ]),
    [],
  );
});

test("stop completion persists explicit-zero returns with stable inventory audit data", () => {
  const actions = read("src/lib/operator-actions.ts");

  assert.match(actions, /buildExplicitZeroFillReturnPlans\(normalizedFilledItems\)/);
  assert.match(actions, /snacky_route_leftover_storage_location_id/);
  assert.match(actions, /reason: "operator_bag_to_storage"/);
  assert.match(actions, /source_type: "route_stop_zero_fill_return"/);
  assert.match(actions, /related_route_stop_id: stopId/);
  assert.match(actions, /route-stop-zero-fill-return/);
  assert.match(actions, /update\(\{ returned_qty: returnedQty/);
});

test("route summaries display explicit zero and returned quantity", () => {
  const adminSummary = read("src/app/routes/[id]/page.tsx");
  const operatorSummary = read("src/app/operator/routes/[id]/page.tsx");

  assert.match(adminSummary, /String\(line\.action_type \?\? ""\) !== "missing_product_report"/);
  assert.match(adminSummary, /route_stop_zero_fill_return/);
  assert.match(adminSummary, /zeroFillReturnMovements\.reduce/);
  assert.match(operatorSummary, /Number\(item\.returned_qty \?\? 0\)/);
  assert.doesNotMatch(operatorSummary, /item\.picked_qty \|\| item\.planned_qty/);
});
