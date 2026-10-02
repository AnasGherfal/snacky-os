import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922132935_optimize_vms_import_row_read_rls.sql"),
  "utf8",
);

test("VMS import row read policies cache row-independent authorization checks", () => {
  assert.match(source, /alter policy crm_raw_record_boundary/i);
  assert.match(source, /on public\.vms_import_rows/i);
  assert.match(source, /select \(not public\.snacky_crm_is_limited\(\)\)/i);

  assert.match(source, /alter policy snacky_vms_import_rows_select_by_vms_import_permission/i);
  assert.match(source, /select public\.snacky_current_profile_can_view_vms_import\(\)/i);

  assert.match(source, /alter policy snacky_vms_import_rows_select_by_vms_import_role/i);
  assert.match(source, /select public\.snacky_current_profile_has_any_role\(array\['owner','admin'\]::text\[\]\)/i);

  assert.doesNotMatch(source, /using \(snacky_current_profile_can_view_vms_import\(\)\)/i);
  assert.doesNotMatch(source, /using \(snacky_current_profile_has_any_role\(/i);
});
