import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

// Never run this fixture runner on a production or arbitrary database.
assert.equal(process.env.PGDATABASE, 'crm_tests', 'An isolated crm_tests database is required.');
const canonical = readFileSync('scripts/test-connected-relations-db.sql', 'utf8');
const marker = '\nbegin;\n';
const start = canonical.indexOf(marker);
assert.ok(start > 0 && canonical.indexOf(marker, start + 1) === -1, 'Review the changed canonical fixture before replaying it.');
const cases = canonical.slice(start + 1);
assert.match(cases, /rollback;\s*$/);
assert.doesNotMatch(cases, /\\i(?:r)?\s/);
const guard = String.raw`\set ON_ERROR_STOP on
select current_database()='crm_tests' as isolated \gset
\if :isolated
\else
 \echo 'Refusing Company release fixtures outside crm_tests'
 \quit 2
\endif
`;
function psql(args, input) {
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    env: process.env, input, encoding: 'utf8', maxBuffer: 20_000_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Database release regression failed.');
}
// This runs native CRM cases BEFORE the new schema, then all Company cases.
psql(['-f', 'scripts/test-company-hub-db.sql']);
// Replay the SAME canonical CRM cases AFTER the Company migration. Do not fork
// or weaken those cases; their transaction rolls back synthetic test records.
console.log('Replaying unchanged native CRM workflows AFTER Company migration.');
psql([], guard + cases);
console.log('PASS: native CRM before/after and Company database release checks.');
