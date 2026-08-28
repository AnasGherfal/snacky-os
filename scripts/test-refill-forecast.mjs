import assert from "node:assert/strict";
import test from "node:test";

import { buildMachineRefillForecasts, nextOperatingDate } from "../src/lib/refill-forecast.ts";

const baseMachine = {
  id: "machine-1",
  name: "University",
  machine_code: "SNK-1",
  refill_open_days: [1, 2, 3, 4, 6, 7],
  refill_critical_percent: 15,
  refill_today_percent: 30,
  refill_target_percent: 90,
  refill_minimum_units: 10,
};

function stock(current, capturedAt = "2026-08-28T08:00:00.000Z") {
  return [{ machine_id: "machine-1", product_id: "water", slot_code: "001", current_qty: current, capacity: 10, captured_at: capturedAt }];
}

test("a closed Friday defers a non-stale machine to Saturday", () => {
  const [forecast] = buildMachineRefillForecasts({
    machines: [baseMachine],
    latestStock: stock(2),
    stockHistory: stock(2),
    fills: [],
    now: new Date("2026-08-28T10:00:00.000Z"),
  });
  assert.equal(forecast.openToday, false);
  assert.equal(forecast.status, "fill_next_open");
  assert.equal(forecast.actionDate, "2026-08-29");
});

test("a healthy closed machine stays healthy instead of creating an unnecessary visit", () => {
  const [forecast] = buildMachineRefillForecasts({
    machines: [baseMachine],
    latestStock: stock(10),
    stockHistory: stock(10),
    fills: [],
    now: new Date("2026-08-28T10:00:00.000Z"),
  });
  assert.equal(forecast.openToday, false);
  assert.equal(forecast.status, "healthy");
});

test("an empty lane on an operating day is fill now", () => {
  const [forecast] = buildMachineRefillForecasts({
    machines: [baseMachine],
    latestStock: stock(0, "2026-08-27T08:00:00.000Z"),
    stockHistory: stock(0, "2026-08-27T08:00:00.000Z"),
    fills: [],
    now: new Date("2026-08-27T10:00:00.000Z"),
  });
  assert.equal(forecast.status, "fill_now");
});

test("Thursday stock that cannot survive the Friday closure is fill today", () => {
  const history = [
    ...stock(5, "2026-08-26T08:00:00.000Z"),
    ...stock(3, "2026-08-27T08:00:00.000Z"),
  ];
  const [forecast] = buildMachineRefillForecasts({
    machines: [baseMachine],
    latestStock: stock(3, "2026-08-27T08:00:00.000Z"),
    stockHistory: history,
    fills: [],
    now: new Date("2026-08-27T10:00:00.000Z"),
  });
  assert.equal(forecast.status, "fill_today");
  assert.ok((forecast.daysToEmpty ?? 99) < 2);
});

test("recorded fills are added back when estimating actual depletion", () => {
  const history = [
    ...stock(4, "2026-08-24T08:00:00.000Z"),
    ...stock(8, "2026-08-25T08:00:00.000Z"),
    ...stock(6, "2026-08-26T08:00:00.000Z"),
  ];
  const [forecast] = buildMachineRefillForecasts({
    machines: [{ ...baseMachine, refill_open_days: [1, 2, 3, 4, 5, 6, 7] }],
    latestStock: stock(6, "2026-08-26T08:00:00.000Z"),
    stockHistory: history,
    fills: [{ machine_id: "machine-1", product_id: "water", actual_qty: 6, created_at: "2026-08-24T12:00:00.000Z" }],
    now: new Date("2026-08-26T10:00:00.000Z"),
  });
  assert.ok(forecast.averageDailyUnits >= 2);
  assert.equal(forecast.policySource, "observed");
});

test("next operating date skips configured closure days", () => {
  assert.equal(nextOperatingDate("2026-08-27", [1, 2, 3, 4, 6, 7], false), "2026-08-29");
});
