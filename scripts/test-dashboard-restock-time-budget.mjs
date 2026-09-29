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
  assert.match(dashboard, /loadRestockPriorityData\(supabase, \{ salesQueryTimeoutMs: 1000 \}\)/);
  assert.match(restockData, /salesQueryTimeoutMs\?: number/);
  assert.match(restockData, /AbortSignal\.timeout\(options\.salesQueryTimeoutMs\)/);
  assert.match(restockData, /query\.abortSignal\(/);
});

test("dedicated restock page keeps exact uncapped loading", () => {
  assert.match(restockPage, /loadRestockPriorityData\(supabase\)/);
  assert.doesNotMatch(restockPage, /salesQueryTimeoutMs/);
});
