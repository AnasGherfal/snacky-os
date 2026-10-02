import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  calculateSimpleStockCheck,
  simpleStockCheckStatusLabel,
} from "../src/lib/simple-stock-check.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const page = fs.readFileSync(path.join(root, "src/app/inventory/stock-check/page.tsx"), "utf8");
const tabs = fs.readFileSync(path.join(root, "src/components/module-tabs-config.ts"), "utf8");

test("simple stock check compares this month's bought and sold units with current stock", () => {
  const result = calculateSimpleStockCheck({
    boughtUnits: 100,
    soldUnits: 60,
    recordedLossUnits: 2,
    storageUnits: 20,
    machineUnits: 15,
    operatorUnits: 0,
  });

  assert.equal(result.remainingFromThisMonthsPurchases, 38);
  assert.equal(result.currentTotalUnits, 35);
  assert.equal(result.possibleMissingUnits, 3);
  assert.equal(result.status, "possible_missing");
  assert.equal(simpleStockCheckStatusLabel(result.status), "Check possible missing");
});

test("old stock prevents a false monthly purchase shortage", () => {
  const result = calculateSimpleStockCheck({
    boughtUnits: 100,
    soldUnits: 60,
    storageUnits: 30,
    machineUnits: 25,
  });

  assert.equal(result.remainingFromThisMonthsPurchases, 40);
  assert.equal(result.currentTotalUnits, 55);
  assert.equal(result.possibleMissingUnits, 0);
  assert.equal(result.priorOrOtherStockUnits, 15);
  assert.equal(result.status, "prior_stock_present");
});

test("selling more than purchased is labeled as using prior stock", () => {
  const result = calculateSimpleStockCheck({
    boughtUnits: 20,
    soldUnits: 45,
    storageUnits: 5,
    machineUnits: 7,
  });

  assert.equal(result.boughtMinusSoldUnits, -25);
  assert.equal(result.remainingFromThisMonthsPurchases, 0);
  assert.equal(result.possibleMissingUnits, 0);
  assert.equal(result.status, "using_prior_stock");
});

test("simple page exposes only the operational monthly comparison by default", () => {
  for (const label of [
    "This Month Stock Check",
    "Bought this month",
    "Sold this month",
    "Storage now",
    "Machines now",
    "Operator stock",
    "Possible missing",
    "Left from this month buying",
    "by machine",
  ]) {
    assert.match(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.match(page, /calculateSimpleStockCheck/);
  assert.match(page, /latest_vms_stock_by_slot/);
  assert.match(page, /vms_monthly_product_profit/);
  assert.match(page, /purchase_orders/);
  assert.match(page, /current_inventory_by_location/);
  assert.match(page, /Advanced exact reconciliation/);
});

test("inventory navigation points to the simple Stock Check", () => {
  assert.match(tabs, /label:\s*"Stock Check",\s*href:\s*"\/inventory\/stock-check"/);
  assert.doesNotMatch(tabs, /label:\s*"Missing Items",\s*href:\s*"\/inventory\/reconciliation"/);
});
