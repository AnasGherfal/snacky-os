import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922131700_optimize_refill_crm_rls_checks.sql"),
  "utf8",
);

test("refill-path CRM policies cache the row-independent role check", () => {
  for (const table of [
    "machine_slots",
    "machines",
    "products",
    "vms_import_batches",
    "vms_stock_snapshots",
  ]) {
    assert.match(source, new RegExp(`on public\\.${table}`, "i"));
  }

  const optimizedChecks = source.match(/select \(not public\.snacky_crm_is_limited\(\)\)/gi) ?? [];
  assert.equal(optimizedChecks.length, 16);
  assert.doesNotMatch(source, /using \(not public\.snacky_crm_is_limited\(\)\)/i);
  assert.doesNotMatch(source, /with check \(not public\.snacky_crm_is_limited\(\)\)/i);
});
