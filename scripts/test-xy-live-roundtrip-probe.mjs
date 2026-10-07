import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync("src/app/api/internal/xy-live-roundtrip/route.ts", "utf8");

test("live XY round-trip probe accepts scheduler auth or a one-time database-armed nonce and is machine-whitelisted", () => {
  assert.match(route, /authorization/);
  assert.match(route, /SCHEDULER_TOKEN_SHA256/);
  assert.match(route, /xy_live_roundtrip_armed/);
  assert.match(route, /xy_live_roundtrip_consumed/);
  assert.match(route, /contains\("metadata", \{ nonce \}\)/);
  assert.match(route, /10 \* 60 \* 1000/);
  assert.match(route, /2609000196/);
  assert.match(route, /2404120076/);
  assert.match(route, /if \(machine\.location_id\)/);
  assert.match(route, /vms_sales_dashboard_clean/);
  assert.match(route, /sales in the last 24 hours/);
});

test("live probe verifies quantity, price and product and restores the original lane", () => {
  assert.match(route, /quantityTarget/);
  assert.match(route, /priceTarget/);
  assert.match(route, /donor\.vmsProductId/);
  assert.match(route, /verifyXySlot/);
  assert.match(route, /restoreBaseline/);
  assert.match(route, /Final XY lane state does not match the original baseline/);
  assert.match(route, /final_restore_verified/);
});

test("live probe is one-shot and does not expose a generic target", () => {
  assert.match(route, /xy_live_roundtrip_verified/);
  assert.match(route, /already ran in the last 24 hours/);
  assert.match(route, /One-time authorization was already consumed/);
  assert.doesNotMatch(route, /body\.machine|body\.slot|body\.product|body\.price|body\.quantity/);
});
