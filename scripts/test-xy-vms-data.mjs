import assert from "node:assert/strict";
import test from "node:test";
import { classifyXyLane, xyProductIdentity } from "../src/lib/xy-vms-data.ts";

test("XY catalogue exposes selling and purchase prices", () => {
  const identity = xyProductIdentity({ spbh: "42", spmc: "Water", spjg: "2.500", spjj: "1.250" });
  assert.equal(identity.vmsProductId, "42");
  assert.equal(identity.sellingPrice, 2.5);
  assert.equal(identity.costPrice, 1.25);
});

test("configured XY lane preserves exact lane, quantity, and capacity", () => {
  const lane = classifyXyLane({ hdbh: "001", spbh: "42", spmc: "Water", hdkc: "3", hdrl: "7" });
  assert.equal(lane.kind, "configured");
  assert.equal(lane.slotCode, "001");
  assert.equal(lane.currentQty, 3);
  assert.equal(lane.capacity, 7);
});

test("XY 0000 255/255 rows are placeholders, never machine stock", () => {
  const lane = classifyXyLane({ hdbh: "061", spbh: "0000", hdkc: "255", hdrl: "255" });
  assert.equal(lane.kind, "placeholder");
});

test("impossible XY quantities fail validation", () => {
  const lane = classifyXyLane({ hdbh: "001", spbh: "42", spmc: "Water", hdkc: "8", hdrl: "7" });
  assert.equal(lane.kind, "invalid");
  assert.match(lane.reason, /exceeds capacity/);
});
