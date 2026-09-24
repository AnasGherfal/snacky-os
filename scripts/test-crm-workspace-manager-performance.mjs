import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260924153427_optimize_crm_workspace_manager_reads.sql"),
  "utf8",
);

test("CRM workspace manager reads short-circuit row authorization without changing non-manager behavior", () => {
  assert.match(source, /pg_get_functiondef\('public\.snacky_crm_workspace_v1\(text,uuid,jsonb\)'::regprocedure\)/i);
  assert.match(source, /where public\.snacky_crm_allowed\(r\.kind,r\.id\)/i);
  assert.match(source, /where \(manager or public\.snacky_crm_allowed\(r\.kind,r\.id\)\)/i);
  assert.match(source, /ddl := replace/i);
  assert.match(source, /if position\('where \(manager or public\.snacky_crm_allowed\(r\.kind,r\.id\)\)' in ddl\) > 0 then[\s\S]*return;/i);
});
