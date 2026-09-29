import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = fs.readFileSync(path.join(root, "src/app/dashboard/page.tsx"), "utf8");

test("dashboard missing-cost health check has a 1 second request budget", () => {
  assert.match(
    dashboard,
    /from\("vms_sales_dashboard_clean"\)[\s\S]*?eq\("cost_missing", true\)[\s\S]*?abortSignal\(AbortSignal\.timeout\(1000\)\)/,
  );
});

test("missing-cost timeout only affects the dashboard health counter", () => {
  assert.match(dashboard, /Products without cost/);
  assert.match(dashboard, /Some health counters are partial right now/);
});
