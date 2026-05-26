import test from "node:test";
import assert from "node:assert/strict";
import { latestKnownProductUnitCost, resolvePurchaseUnitCost } from "../src/lib/purchase-cost-memory.ts";

test("blank unit cost uses last saved product cost", () => {
  const decision = resolvePurchaseUnitCost({
    product: { name: "Pepsi", last_purchase_cost_lyd: 5 },
    unitCost: 0,
    unitCostBlank: true,
    unitCostZeroConfirmed: false,
    pricingMode: "unit",
    lineTotal: 0,
    totalUnits: 10,
  });
  assert.deepEqual(decision, { kind: "product_memory", unitCost: 5 });
});

test("explicit zero cost requires confirmation", () => {
  const decision = resolvePurchaseUnitCost({
    product: { name: "Pepsi", last_purchase_cost_lyd: 5 },
    unitCost: 0,
    unitCostBlank: false,
    unitCostZeroConfirmed: false,
    pricingMode: "unit",
    lineTotal: 0,
    totalUnits: 10,
  });
  assert.equal(decision.kind, "zero_unconfirmed");
  assert.match(decision.message, /Confirm this product is free/);
});

test("blank unit cost without product memory is blocked", () => {
  const decision = resolvePurchaseUnitCost({
    product: { name: "New Product" },
    unitCost: 0,
    unitCostBlank: true,
    unitCostZeroConfirmed: false,
    pricingMode: "unit",
    lineTotal: 0,
    totalUnits: 10,
  });
  assert.equal(decision.kind, "missing");
  assert.match(decision.message, /no previous cost exists/);
});

test("line total can derive unit cost", () => {
  const decision = resolvePurchaseUnitCost({
    product: { name: "Receipt Item" },
    unitCost: 0,
    unitCostBlank: true,
    unitCostZeroConfirmed: false,
    pricingMode: "total",
    lineTotal: 50,
    totalUnits: 20,
  });
  assert.deepEqual(decision, { kind: "derived_total", unitCost: 2.5 });
});

test("last purchase cost wins over current and average cost", () => {
  assert.equal(latestKnownProductUnitCost({
    last_purchase_cost_lyd: 6,
    current_cost_price_lyd: 4,
    average_cost_lyd: 5,
  }), 6);
});
