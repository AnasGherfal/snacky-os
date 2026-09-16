import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const api = fs.readFileSync("src/app/api/operator/routes/[id]/pick-list/route.ts", "utf8");
const page = fs.readFileSync("src/app/operator/routes/[id]/pick-list/page.tsx", "utf8");
test("active route stops remain in the pickup plan", () => {
  assert.doesNotMatch(api, /pendingStopIds\.size && stop/);
  assert.match(api, /if \(stop && !includesRelevantStop\(String\(stop\.id/);
});
test("the merged direct-pickup flow does not retain a browser prepared snapshot that can freeze the checklist", () => {
  assert.match(page,/confirmPickupDirect/);
  assert.doesNotMatch(page,/preparedSummaryMatchesRouteTotals|setPreparedBatch|prepared\.get\(productId\)/);
  assert.match(page,/disabled=\{locked \|\| confirmed \|\| submitting\}/);
  assert.match(page,/!allSelectedPickupItemsChecked/);
  assert.match(page,/setConfirmed\(Boolean\(payload\.confirmed\)\)/);
});
