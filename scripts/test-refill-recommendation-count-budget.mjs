import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/app/refills/page.tsx", import.meta.url), "utf8");

test("refill recommendations do not request an unused exact count", () => {
  const start = source.indexOf("async function loadRefillRecommendations");
  const end = source.indexOf("async function loadForecastMachines", start);
  const loader = source.slice(start, end);
  assert.doesNotMatch(loader, /count:\s*"exact"/);
  assert.match(loader, /\.limit\(1000\)/);
});

test("refill proof totals still use exact counts because the UI displays them", () => {
  assert.match(source, /machine_refill_history"[\s\S]*?count:\s*"exact"/);
  assert.match(source, /historyIssueCountResult\.count/);
  assert.match(source, /PaginationControls[\s\S]*?totalCount=\{historyCountResult\.count \?\? 0\}/);
});
