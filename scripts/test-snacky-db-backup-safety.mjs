import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/snacky-postgres-full-backup-manual.yml","utf8");
const preflight = fs.readFileSync("scripts/sql/vms-archived-cleanup-preflight.sql","utf8");
const doc = fs.readFileSync("docs/SNACKY_DB_RECOVERY_AND_CLEANUP.md","utf8");

test("privileged full database backup can only be manually dispatched by owner on master", () => {
  assert.match(workflow,/^\s+workflow_dispatch:$/m);
  assert.match(workflow,/github\.repository == 'AnasGherfal\/snacky-os'/);
  assert.match(workflow,/github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow,/github\.actor == 'AnasGherfal'/);
  assert.match(workflow,/environment: Production/);
  assert.doesNotMatch(workflow,/^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow,/BACKUP ONLY - DO NOT CHANGE DATABASE/);
});

test("full backup uses only protected secrets and PG17 read-only pg_dump", () => {
  assert.match(workflow,/secrets\.SNACKY_DB_BACKUP_URL/);
  assert.match(workflow,/secrets\.SNACKY_R2_ACCOUNT_ID/);
  assert.match(workflow,/secrets\.SNACKY_R2_ACCESS_KEY_ID/);
  assert.match(workflow,/secrets\.SNACKY_R2_SECRET_ACCESS_KEY/);
  assert.match(workflow,/postgres:17\.6/);
  assert.match(workflow,/pg_dump --dbname "\$SNACKY_DB_BACKUP_URL"/);
  assert.match(workflow,/--format=custom --compress=6 --no-owner --no-acl/);
  assert.match(workflow,/--user "\$\(id -u\):\$\(id -g\)"/);
  assert.match(workflow,/PGSSLMODE=require/);
  assert.match(workflow,/BACKUP_DIR=\$RUNNER_TEMP\/snacky-db-backup/);
  assert.match(workflow,/\$GITHUB_ENV/);
  assert.doesNotMatch(workflow,/BACKUP_DIR:.*runner\.temp/);
  assert.match(workflow,/url\.port!=="5432"/);
  assert.match(workflow,/url\.username!=="postgres\.thrthmeyhuhxnmizjhqx"/);
  assert.ok(workflow.includes('url.pathname!=="/postgres"'));
  assert.match(workflow,/pooler\\?\.supabase\\?\.com|pooler\.supabase\.com/);
  assert.doesNotMatch(workflow,/(?:aws|postgres):\/\/[^\s'"]+:[^ \n'"]+@/);
  assert.doesNotMatch(workflow,/actions\/upload-artifact/);
});

test("R2 backup requires a verified TOC, private upload, byte-identical readback and manifest", () => {
  assert.match(workflow,/pg_restore --list \/backup\/snacky\.dump/);
  assert.match(workflow,/TABLE DATA \+public \+vms_import_rows/);
  assert.match(workflow,/TABLE DATA \+auth \+users/);
  assert.match(workflow,/--if-none-match "\*"/);
  assert.match(workflow,/s3api put-object/);
  assert.match(workflow,/s3api get-object/);
  assert.match(workflow,/cmp -s "\$BACKUP_DIR\/snacky\.dump" "\$BACKUP_DIR\/verified\.dump"/);
  assert.match(workflow,/pg_restore --list \/backup\/verified\.dump/);
  assert.match(workflow,/restoreDrillCompleted:false/);
  assert.match(workflow,/storageObjectsIncluded:false/);
  assert.match(workflow,/if: always\(\)/);
  assert.match(workflow,/rm -f "\$BACKUP_DIR\/snacky\.dump"/);
});

test("cleanup preflight enumerates only eight exact archived batch IDs, no writes", () => {
  const reviewed=[...preflight.matchAll(/\('([a-f0-9-]{36})'::uuid,\s*(\d+)\)/g)].map(m=>[m[1],Number(m[2])]);
  assert.equal(reviewed.length,8);
  assert.equal(new Set(reviewed.map(x=>x[0])).size,8);
  assert.equal(reviewed.reduce((n,x)=>n+x[1],0),16134);
  assert.match(preflight,/status='deleted'/);
  assert.match(preflight,/is_active IS false/);
  assert.match(preflight,/present_rows=expected_rows/);
  assert.match(preflight,/foreign_keys_pointing_to_import_rows/);
  assert.match(preflight,/linked_transactions_to_keep/);
  assert.match(preflight,/linked_monthly_profit_to_keep/);
  assert.match(preflight,/pg_database_size\(current_database\(\)\)/);
  assert.doesNotMatch(preflight,/\bDELETE\s+FROM\b|\bUPDATE\s+(?:public\.)|\bTRUNCATE\b|\bDROP\s+TABLE\b|\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(workflow,/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
});

test("restoration and storage data remain explicit blockers", () => {
  assert.match(doc,/restore.*nonproduction/i);
  assert.match(doc,/does not include bytes of Supabase Storage objects/i);
  assert.match(doc,/Explicit owner authorization/i);
  assert.match(doc,/no production data cleanup is authorized/i);
  assert.match(doc,/Restore deleted batch/);
  assert.match(doc,/raw-row deletion is BLOCKED/);
});
