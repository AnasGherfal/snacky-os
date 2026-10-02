import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922133238_optimize_vms_import_row_write_rls.sql"),
  "utf8",
);

test("VMS import row write policies cache row-independent authorization checks", () => {
  for (const policy of [
    "snacky_vms_import_rows_insert_by_vms_import_permission",
    "snacky_vms_import_rows_insert_by_vms_import_role",
    "snacky_vms_import_rows_update_by_vms_import_permission",
    "snacky_vms_import_rows_update_by_vms_import_role",
  ]) {
    assert.match(source, new RegExp(`alter policy ${policy}`, "i"));
  }

  const permissionChecks = source.match(/select public\.snacky_current_profile_can_manage_vms_mappings\(\)/gi) ?? [];
  const roleChecks = source.match(/select public\.snacky_current_profile_has_any_role\(array\['owner','admin'\]::text\[\]\)/gi) ?? [];

  assert.equal(permissionChecks.length, 3);
  assert.equal(roleChecks.length, 3);
  assert.doesNotMatch(source, /with check \(snacky_current_profile_can_manage_vms_mappings\(\)\)/i);
  assert.doesNotMatch(source, /using \(snacky_current_profile_has_any_role\(/i);
});
