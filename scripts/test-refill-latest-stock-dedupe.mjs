import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/app/refills/page.tsx", import.meta.url), "utf8");

test("refills derives stock presence from already-loaded latest stock rows", () => {
  assert.match(source, /const hasVmsStock = \(forecastLatestStockResult\.data \?\? \[\]\)\.length > 0/);
});

test("refills does not run a second exact-count query on latest_vms_stock_by_slot", () => {
  const exactStockCounts = [...source.matchAll(/from\("latest_vms_stock_by_slot"\)[\s\S]{0,180}?count:\s*"exact"/g)];
  assert.equal(exactStockCounts.length, 0);
});
