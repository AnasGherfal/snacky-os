import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922131053_optimize_inventory_crm_rls_check.sql"),
  "utf8",
);

test("inventory CRM boundary caches the row-independent role check once per statement", () => {
  assert.match(source, /alter policy crm_raw_record_boundary/i);
  assert.match(source, /on public\.inventory_movements/i);
  assert.match(source, /using \(\(select \(not public\.snacky_crm_is_limited\(\)\)\)\)/i);
  assert.match(source, /with check \(\(select \(not public\.snacky_crm_is_limited\(\)\)\)\)/i);
  assert.doesNotMatch(source, /using \(not public\.snacky_crm_is_limited\(\)\)/i);
});
