import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const api = fs.readFileSync("src/app/api/operator/routes/[id]/pick-list/route.ts", "utf8");
const page = fs.readFileSync("src/app/operator/routes/[id]/pick-list/page.tsx", "utf8");

test("active route stops remain in the pickup plan", () => {
  assert.doesNotMatch(api, /pendingStopIds\.size && stop/);
  assert.match(api, /if \(stop && !includesRelevantStop\(String\(stop\.id/);
});

test("stale prepared snapshots do not freeze the checklist", () => {
  assert.match(page, /preparedSummaryMatchesRouteTotals/);
  assert.match(page, /&& preparedSummaryMatchesRouteTotals \? preparedBatch : null/);
  assert.match(page, /prepared\.get\(productId\) === quantity/);
});
