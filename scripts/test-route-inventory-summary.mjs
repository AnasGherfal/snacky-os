import assert from "node:assert/strict";
import test from "node:test";
import { inventoryMovementIdempotencyKey, normalizeInventoryEntityType, normalizeInventoryMovementReason } from "../src/lib/inventory-movement.ts";
import { summarizeRouteInventoryMovements } from "../src/lib/route-inventory-summary.ts";

test("route inventory summary keeps pickup, fill, and return balances aligned", () => {
  const summary = summarizeRouteInventoryMovements([
    { product_id: "product-x", quantity: 20, reason: "storage_to_operator_bag", from_entity_type: "storage", to_entity_type: "operator_bag" },
    { product_id: "product-x", quantity: 15, reason: "operator_bag_to_machine", from_entity_type: "operator_bag", to_entity_type: "machine" },
    { product_id: "product-x", quantity: 5, reason: "operator_bag_to_storage", from_entity_type: "operator_bag", to_entity_type: "storage" },
  ]);

  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0], {
    productId: "product-x",
    loadedQty: 20,
    filledQty: 15,
    returnedQty: 5,
    damagedQty: 0,
    adjustmentInQty: 0,
    adjustmentOutQty: 0,
    remainingQty: 0,
  });
});

test("route inventory summary handles damaged stock without double counting", () => {
  const summary = summarizeRouteInventoryMovements([
    { product_id: "product-x", quantity: 20, reason: "storage_to_operator_bag", from_entity_type: "storage", to_entity_type: "operator_bag" },
    { product_id: "product-x", quantity: 15, reason: "operator_bag_to_machine", from_entity_type: "operator_bag", to_entity_type: "machine" },
    { product_id: "product-x", quantity: 2, reason: "damaged", from_entity_type: "operator_bag", to_entity_type: "waste" },
    { product_id: "product-x", quantity: 3, reason: "operator_bag_to_storage", from_entity_type: "operator_bag", to_entity_type: "storage" },
  ]);

  assert.equal(summary.length, 1);
  assert.equal(summary[0].loadedQty, 20);
  assert.equal(summary[0].filledQty, 15);
  assert.equal(summary[0].damagedQty, 2);
  assert.equal(summary[0].returnedQty, 3);
  assert.equal(summary[0].remainingQty, 0);
});

test("route inventory summary normalizes historical movement aliases", () => {
  const summary = summarizeRouteInventoryMovements([
    { product_id: "product-x", quantity: 20, reason: "storage_to_route", from_entity_type: "storage", to_entity_type: "operator_bag" },
    { product_id: "product-x", quantity: 12, reason: "route_to_machine", from_entity_type: "operator_bag", to_entity_type: "machine" },
    { product_id: "product-x", quantity: 3, reason: "route_to_storage_return", from_entity_type: "operator_bag", to_entity_type: "storage" },
    { product_id: "product-x", quantity: 2, reason: "machine_to_storage_return", from_entity_type: "machine", to_entity_type: "storage" },
    { product_id: "product-x", quantity: 1, reason: "route_to_damaged", from_entity_type: "operator_bag", to_entity_type: "waste" },
  ]);

  assert.equal(summary.length, 1);
  assert.equal(summary[0].loadedQty, 20);
  assert.equal(summary[0].filledQty, 12);
  assert.equal(summary[0].returnedQty, 5);
  assert.equal(summary[0].damagedQty, 1);
  assert.equal(summary[0].remainingQty, 2);
});

test("explicit-zero stop return records zero filled and all assigned units returned", () => {
  const summary = summarizeRouteInventoryMovements([
    { product_id: "product-x", quantity: 5, reason: "storage_to_operator_bag", from_entity_type: "storage", to_entity_type: "operator_bag" },
    { product_id: "product-x", quantity: 5, reason: "operator_bag_to_storage", from_entity_type: "operator_bag", to_entity_type: "storage" },
  ]);

  assert.deepEqual(summary[0], {
    productId: "product-x",
    loadedQty: 5,
    filledQty: 0,
    returnedQty: 5,
    damagedQty: 0,
    adjustmentInQty: 0,
    adjustmentOutQty: 0,
    remainingQty: 0,
  });
});

test("machine fill corrections reduce filled quantity regardless of movement order", () => {
  const summary = summarizeRouteInventoryMovements([
    { product_id: "product-x", quantity: 8, reason: "manual_correction", from_entity_type: "machine", to_entity_type: "operator_bag" },
    { product_id: "product-x", quantity: 8, reason: "operator_bag_to_storage", from_entity_type: "operator_bag", to_entity_type: "storage" },
    { product_id: "product-x", quantity: 8, reason: "operator_bag_to_machine", from_entity_type: "operator_bag", to_entity_type: "machine" },
    { product_id: "product-x", quantity: 8, reason: "storage_to_operator_bag", from_entity_type: "storage", to_entity_type: "operator_bag" },
  ]);

  assert.equal(summary[0].loadedQty, 8);
  assert.equal(summary[0].filledQty, 0);
  assert.equal(summary[0].returnedQty, 8);
  assert.equal(summary[0].remainingQty, 0);
});

test("inventory movement helpers normalize locations and idempotency keys", () => {
  assert.equal(normalizeInventoryEntityType("route"), "operator_bag");
  assert.equal(normalizeInventoryEntityType("machine"), "machine");
  assert.equal(normalizeInventoryEntityType("waste_bin"), "waste");
  assert.equal(normalizeInventoryMovementReason("storage_to_route"), "storage_to_operator_bag");
  assert.equal(normalizeInventoryMovementReason("route_to_storage_return"), "operator_bag_to_storage");
  assert.equal(normalizeInventoryMovementReason("route_to_damaged"), "damaged");
  assert.equal(normalizeInventoryMovementReason("machine_to_storage_return"), "machine_to_storage");
  assert.equal(inventoryMovementIdempotencyKey("route-pickup", "route 1", "product/2", 15), "route-pickup:route%201:product%2F2:15");
});
