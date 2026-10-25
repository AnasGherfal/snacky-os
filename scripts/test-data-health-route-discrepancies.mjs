import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/operations-health/page.tsx", "utf8");

test("owner Data Health includes the existing unresolved route stock review queue", () => {
  assert.ok(page.includes('ROUTE_INVENTORY_OPEN_STATUSES'));
  assert.ok(page.includes('from("route_inventory_discrepancies")'));
  assert.ok(page.includes('select("id",{count:"exact",head:true})'));
  assert.ok(page.includes('in("status",[...ROUTE_INVENTORY_OPEN_STATUSES])'));
  assert.ok(page.includes('["Open route stock differences",openRouteDiscrepancyCount,"/routes/inventory-review"]'));
});

test("unavailable discrepancy totals never appear as a verified zero", () => {
  assert.ok(page.includes("!routeDiscrepanciesResult.error && typeof routeDiscrepanciesResult.count ==="));
  assert.ok(page.includes("openRouteDiscrepancyCount === null"));
  assert.ok(page.includes("They have not been treated as zero"));
  assert.ok(page.includes('role="alert"'));
});

test("the Data Health summary remains read-only and does not adjust historical stock", () => {
  assert.doesNotMatch(page, /db\.from\("route_inventory_discrepancies"\)\s*\.insert\(/);
  assert.doesNotMatch(page, /db\.from\("route_inventory_discrepancies"\)\s*\.update\(/);
  assert.doesNotMatch(page, /db\.from\("route_inventory_discrepancies"\)\s*\.delete\(/);
});
