import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260926104953_optimize_route_fill_history_crm_rls.sql"),
  "utf8",
);

test("route fill history CRM policies cache the row-independent access check", () => {
  assert.match(source, /alter policy crm_legacy_noncrm_access/i);
  assert.match(source, /alter policy crm_raw_record_boundary/i);
  assert.match(source, /on public\.route_stop_fill_lines/i);
  const optimizedChecks = source.match(/select \(not public\.snacky_crm_is_limited\(\)\)/gi) ?? [];
  assert.equal(optimizedChecks.length, 4);
  assert.doesNotMatch(source, /using \(not public\.snacky_crm_is_limited\(\)\)/i);
});
