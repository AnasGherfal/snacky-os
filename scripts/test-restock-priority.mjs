import assert from "node:assert/strict";
import test from "node:test";
import { computeRestockPriority, filterRestockItems, restockCounts } from "../src/lib/restock-priority.ts";

const products = [
  {
    id: "mr-crunch",
    sku: "SNK-MR",
    name: "Mr Crunch طربوش",
    category: "snack",
    active: true,
    restock_priority: "high",
    min_storage_qty: 20,
    target_storage_qty: 80,
    reorder_point: 30,
    reorder_qty: 60,
    last_purchase_cost_lyd: 1.25,
    last_purchase_date: "2026-05-20",
  },
  {
    id: "doritos",
    sku: "SNK-DO",
    name: "Doritos Nacho Chips",
    category: "snack",
    active: true,
    restock_priority: "normal",
    min_storage_qty: 12,
    target_storage_qty: 48,
    reorder_point: 18,
    reorder_qty: 36,
  },
  {
    id: "water",
    sku: "SNK-WA",
    name: "Water 500ml",
    category: "drink",
    active: true,
    restock_priority: "normal",
    min_storage_qty: 10,
    target_storage_qty: 60,
  },
  {
    id: "slow",
    sku: "SNK-SL",
    name: "Slow Seller",
    category: "other",
    active: true,
    restock_priority: "normal",
    min_storage_qty: 0,
    target_storage_qty: 0,
  },
];

test("storage thresholds work without VMS data and critical products sort first", () => {
  const items = computeRestockPriority({
    products,
    storageRows: [
      { product_id: "mr-crunch", quantity_on_hand: 0 },
      { product_id: "doritos", quantity_on_hand: 8 },
      { product_id: "water", quantity_on_hand: 45 },
      { product_id: "slow", quantity_on_hand: 50 },
    ],
  });

  assert.equal(items[0].productId, "mr-crunch");
  assert.equal(items[0].status, "out");
  assert.equal(items[1].productId, "doritos");
  assert.equal(items[1].section, "critical");
  assert.equal(items.find((item) => item.productId === "slow").section, "normal");
  assert.equal(filterRestockItems(items, "focus").some((item) => item.productId === "slow"), false);
});

test("route, VMS, machine, and sales signals increase priority when present", () => {
  const items = computeRestockPriority({
    products,
    storageRows: [
      { product_id: "water", quantity_on_hand: 20 },
      { product_id: "slow", quantity_on_hand: 50 },
    ],
    recommendations: [
      { product_id: "water", machine_name: "Benghazi Mall", suggested_qty: 20, final_qty_to_take: 20 },
    ],
    routeNeeds: [
      { product_id: "water", planned_qty: 30, picked_qty: 5, route_status: "assigned" },
    ],
    machineSlots: [
      { product_id: "water", machine_id: "m1", machine_name: "Benghazi Mall", active: true },
      { product_id: "water", machine_id: "m2", machine_name: "Tripoli Office", active: true },
    ],
    vmsStockRows: [
      { product_id: "water", machine_id: "m1", machine_name: "Benghazi Mall", current_qty: 0, capacity: 20 },
    ],
    salesRows: [
      { product_id: "water", sales_month: "2026-05-01", units_sold: 180, stock_velocity_units_per_day: 6 },
    ],
  });
  const water = items.find((item) => item.productId === "water");

  assert.equal(water.section, "critical");
  assert.equal(water.activeRouteNeedQty, 25);
  assert.equal(water.machinesNeedingCount, 1);
  assert.equal(water.isFastSeller, true);
  assert.equal(filterRestockItems(items, "routes").some((item) => item.productId === "water"), true);
  assert.equal(filterRestockItems(items, "machines").some((item) => item.productId === "water"), true);
});

test("counts separate critical, low, important, and normal sections", () => {
  const counts = restockCounts(
    computeRestockPriority({
      products,
      storageRows: [
        { product_id: "mr-crunch", quantity_on_hand: 0 },
        { product_id: "doritos", quantity_on_hand: 40 },
        { product_id: "water", quantity_on_hand: 50 },
        { product_id: "slow", quantity_on_hand: 50 },
      ],
    }),
  );

  assert.equal(counts.critical, 1);
  assert.equal(counts.normal, 1);
  assert.ok(counts.important >= 1);
});

test("legacy active route statuses remain reserved while terminal routes do not", () => {
  const items = computeRestockPriority({
    products,
    storageRows: [{ product_id: "water", quantity_on_hand: 40 }],
    routeNeeds: [
      { product_id: "water", planned_qty: 12, picked_qty: 2, route_status: "started" },
      { product_id: "water", planned_qty: 8, picked_qty: 0, route_status: "completed" },
      { product_id: "water", planned_qty: 6, picked_qty: 0, route_status: "cancelled" },
    ],
  });

  assert.equal(items.find((item) => item.productId === "water").activeRouteNeedQty, 10);
});
