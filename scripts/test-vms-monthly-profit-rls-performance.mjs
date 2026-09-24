import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260924152842_optimize_vms_monthly_profit_read_rls.sql"),
  "utf8",
);

test("monthly VMS profit read policies cache row-independent authorization checks", () => {
  assert.match(source, /alter policy crm_raw_record_boundary/i);
  assert.match(source, /on public\.vms_monthly_product_profit/i);
  assert.match(source, /using \(\(select \(not public\.snacky_crm_is_limited\(\)\)\)\)/i);

  assert.match(source, /alter policy snacky_vms_monthly_product_profit_select_by_vms_import_permissi/i);
  assert.match(source, /using \(\(select public\.snacky_current_profile_can_view_vms_import\(\)\)\)/i);

  assert.doesNotMatch(source, /using \(not public\.snacky_crm_is_limited\(\)\)/i);
  assert.doesNotMatch(source, /using \(snacky_current_profile_can_view_vms_import\(\)\)/i);
});
