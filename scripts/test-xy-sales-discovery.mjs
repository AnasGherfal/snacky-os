import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const discovery = fs.readFileSync("src/lib/xy-sales-discovery.ts", "utf8");
const route = fs.readFileSync("src/app/api/cron/xy-sales-discovery/route.ts", "utf8");

test("sales discovery is read-only and probes known query-style endpoints", () => {
  for (const endpoint of [
    "queryOrder",
    "queryMachineOrder",
    "querySale",
    "queryTrade",
    "queryTransaction",
  ]) {
    assert.match(discovery, new RegExp('"' + endpoint + '"'));
  }
  assert.match(discovery, /callXyApiRaw/);
  assert.doesNotMatch(discovery, /\.from\("routes"\)/);
  assert.doesNotMatch(discovery, /\.from\("inventory_movements"\)/);
  assert.doesNotMatch(discovery, /\.from\("vms_transactions_raw"\)\.(insert|upsert|update|delete)/);
});

test("sales discovery tries merchant, pagination, machine, and date parameter shapes", () => {
  assert.match(discovery, /merchant_only/);
  assert.match(discovery, /page_num/);
  assert.match(discovery, /page_no/);
  assert.match(discovery, /machine_page_num/);
  assert.match(discovery, /start_end_time/);
  assert.match(discovery, /kssj_jssj/);
  assert.match(discovery, /start_end_date/);
});

test("discovery persists field names and messages, not first-row values", () => {
  assert.match(discovery, /first_row_keys/);
  assert.match(discovery, /top_level_keys/);
  assert.doesNotMatch(discovery, /sampleRows|first_row:/);
  assert.match(discovery, /Discovery persists endpoint messages and field names, not transaction values/);
});

test("protected discovery endpoint requires the scheduler credential", () => {
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /discoverXySalesEndpoints/);
  assert.match(route, /bestCandidate/);
});
