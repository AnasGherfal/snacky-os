import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = fs.readFileSync(path.join(root, "src/app/dashboard/page.tsx"), "utf8");
const restockData = fs.readFileSync(path.join(root, "src/lib/restock-priority-data.ts"), "utf8");
const restockPage = fs.readFileSync(path.join(root, "src/app/restock-priority/page.tsx"), "utf8");

test("dashboard never performs route-stock repair writes while loading restock summary", () => {
  assert.match(dashboard, /salesQueryTimeoutMs: 1000/);
  assert.match(dashboard, /repairMissingRouteStockLines: false/);
  assert.match(dashboard, /recommendationsPromise/);
  assert.doesNotMatch(restockData, /\.(upsert|insert|update|delete|rpc)\s*\(/);
});

test("dedicated restock page uses in-memory fallback without repairing route records on GET", () => {
  assert.match(restockPage, /loadRestockPriorityData\(supabase\)/);
  assert.doesNotMatch(restockData, /async function repairMissingRouteStockLines/);
  assert.match(restockData, /read-only fallback/);
});
