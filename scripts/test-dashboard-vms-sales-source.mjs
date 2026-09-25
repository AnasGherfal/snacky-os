import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "src/app/dashboard/page.tsx"), "utf8");

test("dashboard missing-cost check uses the current VMS sales dashboard view", () => {
  assert.match(source, /\.from\("vms_sales_dashboard_clean"\)/);
  assert.match(source, /vms_sales_dashboard_clean missing cost products/);
  assert.doesNotMatch(source, /\.from\("vms_sales_clean"\)/);
});
