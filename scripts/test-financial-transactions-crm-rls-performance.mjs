import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260926105540_optimize_financial_transactions_crm_rls.sql"),
  "utf8",
);

test("financial transaction CRM boundary caches the row-independent access check", () => {
  assert.match(source, /alter policy crm_raw_record_boundary/i);
  assert.match(source, /on public\.financial_transactions/i);
  assert.match(source, /using \(\(select \(not public\.snacky_crm_is_limited\(\)\)\)\)/i);
  assert.match(source, /with check \(\(select \(not public\.snacky_crm_is_limited\(\)\)\)\)/i);
  assert.doesNotMatch(source, /using \(not public\.snacky_crm_is_limited\(\)\)/i);
});
