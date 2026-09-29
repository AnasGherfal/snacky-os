import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = fs.readFileSync(path.join(root, "src/app/dashboard/page.tsx"), "utf8");
const financeHealthPage = fs.readFileSync(path.join(root, "src/app/admin/finance-health/page.tsx"), "utf8");

test("dashboard uses finance_health_report summary instead of detailed finance diagnostics", () => {
  assert.match(dashboard, /\.rpc\("finance_health_report"\)/);
  assert.match(dashboard, /AbortSignal\.timeout\(1000\)/);
  assert.doesNotMatch(dashboard, /loadFinanceHealthDiagnostics/);
});

test("dedicated finance health page keeps detailed diagnostics", () => {
  assert.match(financeHealthPage, /loadFinanceHealthDiagnostics\(supabase\)/);
  assert.match(financeHealthPage, /finance_health_report/);
});
