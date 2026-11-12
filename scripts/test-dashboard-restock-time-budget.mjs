import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = fs.readFileSync(path.join(root, "src/app/dashboard/page.tsx"), "utf8");
const restockData = fs.readFileSync(path.join(root, "src/lib/restock-priority-data.ts"), "utf8");
const restockPage = fs.readFileSync(path.join(root, "src/app/restock-priority/page.tsx"), "utf8");

test("dashboard caps only the optional restock sales-velocity query", () => {
  assert.match(dashboard, /salesQueryTimeoutMs: 1000/);
  assert.match(dashboard, /repairMissingRouteStockLines: false/);
  assert.match(dashboard, /recommendationsPromise/);
  assert.match(restockData, /salesQueryTimeoutMs\?: number/);
  assert.match(restockData, /AbortSignal\.any/);
  assert.match(restockData, /Math\.min\(10000,options\.salesQueryTimeoutMs\)/);
  assert.match(restockData, /\.abortSignal\(signal\)/);
});

test("dedicated restock page paginates exact counts with a shared deadline", () => {
  assert.match(restockPage, /loadRestockPriorityData\(supabase\)/);
  assert.doesNotMatch(restockPage, /salesQueryTimeoutMs/);
  assert.match(restockData, /readCompleteList/);
  assert.match(restockData, /\.eq\("sales_month",salesMonth\)/);
});
