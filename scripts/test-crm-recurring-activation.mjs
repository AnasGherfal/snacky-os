import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync('src/lib/crm-recurring.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function enabled(value) {
 const exports = {};
 const env = value === undefined ? {} : { NEXT_PUBLIC_SNACKY_CRM_RECURRING_ENABLED: value };
 vm.runInNewContext(code, { exports, process: { env } });
 return exports.crmRecurringEnabled;
}
test('approved rollout enables the app by default and retains an explicit false rollback switch', () => {
 assert.equal(enabled(undefined), true);
 assert.equal(enabled('true'), true);
 assert.equal(enabled('false'), false);
});
test('app visibility does not activate the task worker or any routine', () => {
 const sql = fs.readFileSync('supabase/migrations/20260916214951_crm_recurring_management.sql', 'utf8');
 assert.match(sql, /enabled boolean not null default false/);
 assert.match(sql, /paused boolean not null default true/);
 assert.doesNotMatch(source, /\.rpc\(|cron\.schedule|insert into/i);
});
