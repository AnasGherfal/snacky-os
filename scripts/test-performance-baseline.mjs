import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditPath = path.join(repoRoot, "scripts/audit-performance-baseline.mjs");

test("performance baseline audit reports the protected critical targets", () => {
  const output = execFileSync(process.execPath, [auditPath, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const rows = JSON.parse(output);

  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length >= 8, true);

  const byPath = new Map(rows.map((row) => [row.path, row]));
  for (const target of [
    "src/app/dashboard/page.tsx",
    "src/app/routes/new/RouteCreateForm.tsx",
    "src/app/routes/[id]/page.tsx",
    "src/app/inventory/page.tsx",
    "src/app/refills/page.tsx",
    "src/app/vms-import/page.tsx",
    "src/lib/vms-import-actions.ts",
    "src/lib/operator-actions.ts",
  ]) {
    assert.equal(byPath.has(target), true, `missing baseline target: ${target}`);
  }

  const routeCreate = byPath.get("src/app/routes/new/RouteCreateForm.tsx");
  assert.equal(routeCreate.clientComponent, true);
  assert.equal(typeof routeCreate.bytes, "number");
  assert.equal(typeof routeCreate.dataCallSites, "number");

  const vmsActions = byPath.get("src/lib/vms-import-actions.ts");
  assert.equal(vmsActions.dataCallSites > 0, true);
  assert.equal(vmsActions.awaitSites > 0, true);
});
