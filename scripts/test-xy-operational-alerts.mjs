import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  verifiedSalesCoverage, lastSaleTimestamp, noSalesFor24Hours, xyOperationalAlertEventKey, knownXyNotificationEventKeys,
} from "../src/lib/xy-operational-alert-rules.ts";

const now = Date.parse("2026-10-09T10:00:00Z");
const valid = {
  status: "completed",
  completed_at: "2026-10-09T09:20:00Z",
  range_start: "2026-10-06T09:00:00Z",
  range_end: "2026-10-09T09:15:00Z",
  fetched_rows: 250,
  mapped_machine_rows: 250,
  coverage_complete: true,
};

test("24h no-sale notification is blocked without live, complete XY transaction coverage", () => {
  assert.equal(verifiedSalesCoverage(valid, now), true);
  assert.equal(verifiedSalesCoverage(null, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, coverage_complete: false }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, coverage_complete: null }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, status: "failed" }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, completed_at: "2026-10-09T05:00:00Z" }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, range_start: "2026-10-09T03:00:00Z" }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, range_end: "2026-10-09T07:00:00Z" }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, fetched_rows: 0, mapped_machine_rows: 0 }, now), false);
  assert.equal(verifiedSalesCoverage({ ...valid, mapped_machine_rows: 245 }, now), false);
});

test("no sales for exactly 24h, but not for new machine or recently sold one", () => {
  const created = now - 72 * 60 * 60 * 1000;
  assert.equal(noSalesFor24Hours(now - 24 * 60 * 60 * 1000, created, now), true);
  assert.equal(noSalesFor24Hours(now - 23 * 60 * 60 * 1000, created, now), false);
  assert.equal(noSalesFor24Hours(null, created, now), true);
  assert.equal(noSalesFor24Hours(null, now - 22 * 60 * 60 * 1000, now), false);
  assert.equal(noSalesFor24Hours(now + 60 * 1000, created, now), false);
});

test("latest successful sale timestamp checks payment and delivery", () => {
  assert.equal(lastSaleTimestamp({ payment_time: null, delivery_time: "2026-10-09T09:30:00Z" }), now - 30 * 60 * 1000);
  assert.equal(lastSaleTimestamp({ payment_time: "2026-10-08T08:00:00Z", delivery_time: "2026-10-08T07:00:00Z" }), Date.parse("2026-10-08T08:00:00Z"));
  assert.equal(lastSaleTimestamp(null), null);
});

test("episode key identifies owner and last-sale anchor to prevent duplicate alarms", () => {
  const k1 = xyOperationalAlertEventKey("xy_machine_no_sales_24h","owner-1:machine-1","no-history");
  const k2 = xyOperationalAlertEventKey("xy_machine_no_sales_24h","owner-1:machine-1","2026-10-09T09:00:00Z");
  const k3 = xyOperationalAlertEventKey("xy_machine_no_sales_24h","owner-2:machine-1","no-history");
  assert.notEqual(k1,k2);
  assert.notEqual(k1,k3);
});

test("protected XY scheduled worker persists owner in-app alerts, not web push", () => {
  const cron = fs.readFileSync("src/app/api/cron/xy-vms/route.ts","utf8");
  const worker = fs.readFileSync("src/lib/xy-operational-alerts.ts","utf8");
  const bell = fs.readFileSync("src/components/NotificationCenter.tsx","utf8");
  assert.match(cron,/scanXyOperationalAlerts/);
  assert.match(worker,/source_kind: "xy_operational_alert"/);
  assert.match(worker,/lastSalesSuccessResult/);
  assert.match(worker,/if \(!salesReady\)/);
  assert.match(worker,/noSalesFor24Hours/);
  assert.match(worker,/stockedMachineIds/);
  assert.match(worker,/status === "pending"/);
  assert.match(worker,/error\?\.code === "23505"/);
  assert.doesNotMatch(worker,/sendPush|sendEmail|webpush/);
  assert.match(bell,/Operations alerts and work updates/);
});


test("existing XY notification preflight uses bounded exact-key batches and skips only verified persisted keys", async () => {
  const keys = Array.from({ length: 45 }, (_, i) => `notice-${i}`);
  const known = new Set(["notice-0","notice-21","notice-44"]);
  const requests = [];
  const result = await knownXyNotificationEventKeys([...keys, "notice-0"], async (chunk) => {
    requests.push(chunk);
    return { data: chunk.filter(key => known.has(key)).map(event_key => ({ event_key })), error: null };
  });
  assert.equal(result.verified, true);
  assert.deepEqual([...result.keys].sort(), [...known].sort());
  assert.deepEqual(requests.map(page => page.length), [20,20,5]);
  assert.equal(requests.flat().length,45,"Repeated keys must not trigger redundant reads");
});

test("unreadable or inconsistent notification preflight always falls back to index-protected insertion", async () => {
  const scenarios = [
    async () => ({ data: null, error: null }),
    async () => ({ data: [], error: { message:"temporarily unavailable" } }),
    async () => { throw new Error("network interrupted"); },
    async () => ({ data: [{ event_key:"unrelated-key" }], error: null }),
    async () => ({ data: [{ event_key:null }], error: null }),
  ];
  for (const read of scenarios) {
    const result = await knownXyNotificationEventKeys(["existing-key"], read);
    assert.equal(result.verified, false);
    assert.equal(result.keys.size, 0, "A failed lookup cannot hide an undelivered alert");
  }
  const empty = await knownXyNotificationEventKeys([], async () => {
    throw new Error("Empty inputs must not query the database");
  });
  assert.equal(empty.verified,true);
  assert.equal(empty.keys.size,0);
});

test("XY worker checks existing event keys before insert but retains atomic 23505 fallback", () => {
  const worker = fs.readFileSync("src/lib/xy-operational-alerts.ts","utf8");
  const lookup = worker.indexOf("await knownXyNotificationEventKeys(");
  const insert = worker.indexOf('from("notifications").insert(');
  assert.ok(lookup >= 0 && insert > lookup);
  assert.match(worker,/if \(existingKeys\.has\(eventKey\)\) \{ existing\+\+; continue; \}/);
  assert.match(worker,/if \(error\?\.code === "23505"\) \{ existingKeys\.add\(eventKey\); existing\+\+; continue; \}/);
  assert.match(worker,/if \(!lookup\.verified\)/);
  assert.doesNotMatch(worker,/\.upsert\(/,"Partial event_key unique index is not a safe PostgREST upsert target");
});
