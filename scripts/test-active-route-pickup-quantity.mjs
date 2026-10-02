import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/app/api/operator/routes/[id]/pick-list/route.ts", "utf8");

test("pickup keeps pending and active stops visible after route start", () => {
  assert.match(source, /isRouteStopDoneStatus/);
  assert.match(source, /const actionableStopIds = new Set/);
  assert.match(source, /!isRouteStopDoneStatus\(String\(stop\.status/);
  assert.doesNotMatch(source, /const relevantStopIds = pendingStopIds\.size/);
});

test("prepared pickup stops remain visible for retry after a lag", () => {
  assert.match(source, /const preparedStopIds = new Set/);
  assert.match(source, /preparedStopIds\.forEach\(\(stopId\) => actionableStopIds\.add\(stopId\)\)/);
});
