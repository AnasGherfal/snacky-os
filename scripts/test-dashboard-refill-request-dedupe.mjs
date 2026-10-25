import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = fs.readFileSync(path.join(root, "src/app/dashboard/page.tsx"), "utf8");
const restockData = fs.readFileSync(path.join(root, "src/lib/restock-priority-data.ts"), "utf8");
const restockPage = fs.readFileSync(path.join(root, "src/app/restock-priority/page.tsx"), "utf8");

test("dashboard starts one shared refill recommendation request", () => {
  const directReads = dashboard.match(/\.from\("refill_recommendations"\)/g) ?? [];
  assert.equal(directReads.length, 1, "Dashboard should issue one direct refill_recommendations request");
  assert.match(dashboard, /const refillRowsPromise = safeDashboardQuery<RefillRow\[]>/);
  assert.match(dashboard, /\.select\("product_id, machine_id, machine_name, import_batch_id, product_name/);
});

test("dashboard restock reuses the in-flight refill rows", () => {
  assert.match(
    dashboard,
    /safeRestockPriorityForDashboard\(supabase, errors, refillRowsPromise\.then\(\(result\) => result\.data\)\)/,
  );
  assert.match(restockData, /recommendationsPromise\?: PromiseLike<RestockRecommendationRow\[]>/);
  assert.match(restockData, /const recommendationSummariesPromise = options\.recommendationsPromise/);
  assert.match(restockData, /\? Promise\.resolve\(\{ data: undefined as RestockRecommendationSummaryRow\[] \| undefined/);
  assert.match(restockData, /inventoryReadClient\.rpc\("snacky_restock_refill_summary_v1"\)/);
});

test("dedicated restock page keeps its own recommendation read", () => {
  assert.match(restockPage, /loadRestockPriorityData\(supabase\)/);
  assert.doesNotMatch(restockPage, /recommendationsPromise/);
});
