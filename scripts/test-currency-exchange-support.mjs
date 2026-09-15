import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as validation from '../src/lib/business-record-validation.ts';
import * as authz from '../src/lib/authz.ts';
import { transactionImpacts, computeFinanceBalancesFromCutoff, isProfitAffectingTransaction } from '../src/lib/finance-balance.ts';
import { normalizeFinanceLedgerRow, loadFinanceLedgerRows, FINANCE_TRANSACTION_FULL_COLUMNS, FINANCE_TRANSACTION_STABLE_COLUMNS } from '../src/lib/finance-ledger.ts';
const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const exchange = { kind: 'exchange', client_submission_id: ID, transaction_date: validation.businessDate(), source_account_id: 'snacky_lyd', destination_account_id: 'snacky_usd', source_amount: '9000.00', destination_amount: '1000.00', note: 'Test exchange' };
const issue = { kind: 'issue', client_submission_id: ID, machine_id: '', customer_name: 'Test customer', customer_phone: '0910000000', contact_channel: 'whatsapp', issue_type: 'product_stuck', priority: 'normal', description: 'Test issue' };
const fx = { transaction_date: '2026-09-15', transaction_effect: 'transfer', direction: 'money_out', amount: 9000, signed_amount: -9000, currency: 'LYD', account_id: 'snacky_lyd', source_account_id: 'snacky_lyd', destination_account_id: 'snacky_usd', transfer_destination_amount: 1000, transaction_status: 'active', category: 'Currency Exchange' };

test('buying USD affects both native balances once and does not create profit/expense', () => {
  assert.deepEqual(transactionImpacts(fx), { snacky_lyd: -9000, snacky_usd: 1000 });
  assert.deepEqual(computeFinanceBalancesFromCutoff({ rows: [fx], openingBalances: { snacky_lyd: 10000, snacky_usd: 200, owner_lyd: 0, owner_usd: 0 } }), { snacky_lyd: 1000, snacky_usd: 1200, owner_lyd: 0, owner_usd: 0 });
  assert.equal(isProfitAffectingTransaction(fx), false);
  assert.deepEqual(transactionImpacts({ ...fx, source_account_id: 'owner_lyd' }), { owner_lyd: -9000, snacky_usd: 1000 });
  assert.deepEqual(transactionImpacts({ ...fx, transfer_destination_amount: '1023.47' }), { snacky_lyd: -9000, snacky_usd: 1023.47 });
});
test('same-currency transfers and opening cutoff are preserved; unknown FX is never 1:1', () => {
  assert.deepEqual(transactionImpacts({ ...fx, destination_account_id: 'owner_lyd', transfer_destination_amount: undefined }), { snacky_lyd: -9000, owner_lyd: 9000 });
  assert.throws(() => transactionImpacts({ ...fx, transfer_destination_amount: undefined }), /missing its received amount/);
  assert.throws(() => transactionImpacts({ ...fx, transfer_destination_amount: 'bad' }), /missing its received amount/);
  assert.deepEqual(transactionImpacts({ ...fx, transaction_status: 'voided' }), {});
  assert.deepEqual(transactionImpacts(normalizeFinanceLedgerRow({ ...fx, transaction_status: 'archived' })), {});
  const before = computeFinanceBalancesFromCutoff({ rows: [] });
  assert.deepEqual(computeFinanceBalancesFromCutoff({ rows: [{ ...fx, transaction_date: '2026-04-28', transfer_destination_amount: undefined }] }), before);
});
test('all normal ledger read levels include exact destination currency amount', async () => {
  for (const columns of [FINANCE_TRANSACTION_FULL_COLUMNS, FINANCE_TRANSACTION_STABLE_COLUMNS]) assert.ok(columns.includes('transfer_destination_amount'));
  let attempts = 0;
  const result = await loadFinanceLedgerRows({ label: 'test FX schema guard', buildQuery: async () => { attempts++; return { data: null, error: { code: '42703', message: 'column transfer_destination_amount does not exist' } }; } });
  assert.equal(attempts, 1); assert.ok(result.error); assert.deepEqual(result.data, []);
});
test('amounts, dates, roles-independent input, and unknown machine reports validate', () => {
  assert.equal(validation.validateBusinessRecord('exchange', exchange), null);
  assert.equal(validation.validateBusinessRecord('issue', issue), null);
  for (const bad of ['', '0', '-1', 'NaN', 'Infinity', '1.001', '10000000000', '1e4']) assert.equal(validation.recordMoney(bad), null, bad);
  assert.equal(validation.validBusinessDate('2026-02-30', '2026-09-15'), false);
  assert.equal(validation.validBusinessDate('2026-05-15', '2026-09-15'), false);
  assert.equal(validation.validBusinessDate('2026-09-16', '2026-09-15'), false);
  assert.ok(validation.validateBusinessRecord('exchange', { ...exchange, destination_account_id: 'owner_lyd' }));
  assert.ok(validation.validateBusinessRecord('issue', { ...issue, description: '' }));
  assert.ok(validation.validateBusinessRecord('issue', { ...issue, machine_id: 'fake-machine' }));
});
test('durable saved payloads are kind-scoped and malformed data fails closed', () => {
  assert.deepEqual(validation.readSavedBusinessRecord(JSON.stringify(exchange), 'exchange'), exchange);
  for (const bad of ['broken', '{}', 'null', '[]', JSON.stringify(issue), JSON.stringify({ ...exchange, source_amount: 9000 })]) assert.throws(() => validation.readSavedBusinessRecord(bad, 'exchange'));
});

function actionHarness({ role = 'owner', active = true, response, auditFails = false, token = 'token' } = {}) {
  const calls = [];
  const exports = {};
  const imports = {
    'next/cache': { revalidatePath() {} },
    '@/lib/auth': { getCurrentProfile: async () => ({ id: ID, team_member_id: TEAM, role, roles: [role], active_status: active ? 'active' : 'inactive' }), getAuthAccessToken: async () => token },
    '@/lib/authz': authz,
    '@/lib/supabase-server': { getSupabaseServerClient: () => ({ rpc: async (name, payload) => { calls.push({ name, payload }); return response ? response(name, payload) : { data: name.includes('exchange') ? { id: ID, amount: payload.p_source_amount, destination_amount: payload.p_destination_amount, source_account_id: payload.p_source_account_id, destination_account_id: payload.p_destination_account_id, transaction_status: 'active' } : { id: ID, status: 'open' }, error: null }; } }) },
    '@/lib/activity-log': { logActivity: async () => { if (auditFails) throw new Error('audit unavailable'); } },
    '@/lib/business-record-validation': validation,
  };
  const code = ts.transpileModule(read('src/lib/business-record-actions.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, FormData, console, require(id) { assert.ok(imports[id], id); return imports[id]; } });
  const run = (kind, values) => { const fd = new FormData(); for (const [key, value] of Object.entries(values)) fd.set(key, value); return (kind === 'exchange' ? exports.recordCurrencyExchange : exports.createCustomerIssue)(fd); };
  return { calls, run };
}
test('real server actions enforce active role boundaries and use only atomic RPCs', async () => {
  for (const role of ['owner', 'admin', 'supervisor', 'finance']) { const h = actionHarness({ role }); assert.equal((await h.run('exchange', exchange)).ok, true); assert.equal(h.calls[0].payload.p_destination_amount, 1000); }
  for (const role of ['crm', 'operator', 'warehouse', 'viewer', 'investor']) { const h = actionHarness({ role }); assert.equal((await h.run('exchange', exchange)).ok, false); assert.equal(h.calls.length, 0); }
  for (const role of ['owner', 'admin', 'supervisor', 'crm']) { const h = actionHarness({ role }); assert.equal((await h.run('issue', issue)).ok, true); assert.equal(h.calls[0].payload.p_machine_id, null); }
  for (const role of ['operator', 'finance', 'viewer', 'warehouse']) { const h = actionHarness({ role }); assert.equal((await h.run('issue', issue)).ok, false); assert.equal(h.calls.length, 0); }
  const inactive = actionHarness({ active: false }); assert.equal((await inactive.run('exchange', exchange)).ok, false); assert.equal(inactive.calls.length, 0);
});
test('uncertain writes, altered results, command conflicts, and audit failures have safe outcomes', async () => {
  const network = actionHarness({ response: async () => { throw new Error('timeout'); } });
  assert.equal((await network.run('exchange', exchange)).retrySameRequest, true);
  const conflict = actionHarness({ response: async () => ({ data: null, error: { code: '23505' } }) });
  assert.equal((await conflict.run('exchange', exchange)).retrySameRequest, true);
  const wrong = actionHarness({ response: async () => ({ data: { id: ID, amount: 1 }, error: null }) });
  assert.equal((await wrong.run('exchange', exchange)).retrySameRequest, true);
  const audit = actionHarness({ auditFails: true }); assert.equal((await audit.run('exchange', exchange)).ok, true);
});
test('database migration guards exact amounts, replay, privacy, and immutable exchange sides', () => {
  const migration = read('supabase/migrations/20260915160000_explicit_currency_exchange.sql');
  const support = read('supabase/migrations/20260915160100_customer_issue_entry.sql');
  assert.match(migration, /pg_advisory_xact_lock/); assert.match(migration, /saved\.transfer_destination_amount is distinct from p_destination_amount/);
  assert.match(migration, /security_invoker=true/); assert.match(migration, /THEN ft\.transfer_destination_amount ELSE abs\(ft\.amount\)/);
  assert.match(migration, /before update on public\.financial_transactions/); assert.match(migration, /'transfer'/);
  assert.match(support, /enable row level security/); assert.match(support, /reported_by=public\.snacky_current_team_member_id\(\)/);
  assert.match(support, /from public,anon/); assert.doesNotMatch(support, /insert into public\.financial_transactions/);
  // The route delegates to the integrated workspace; verify the real entry
  // and its authorization rather than requiring copied markup in page.tsx.
  const page = read('src/app/issues/page.tsx');
  const workspace = read('src/components/CrmWorkspace.tsx');
  assert.match(page, /CrmWorkspace section="issue"/);
  assert.match(workspace, /href="\/issues\/new"/);
  assert.match(workspace, /profile.active_status!==?'active'|profile.active_status !== 'active'/);
  assert.equal(authz.canAccessPath({id:'viewer',role:'viewer',activeStatus:'active'},'/issues'),false);
  assert.equal(authz.canAccessPath({id:'crm',role:'crm',activeStatus:'active'},'/issues/new'),true);
});

// Output read-model call sites for review. Pure projection unit tests cannot
// establish that every caller actually loads the newly needed currency field.
test('audit balance projection call sites', () => {
  function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []); }
  for (const file of walk('src')) {
    const text = fs.readFileSync(file, 'utf8');
    if (/(computeFinanceBalances|transactionImpacts)\s*\(/.test(text) && !file.endsWith('finance-balance.ts')) console.log('BALANCE_READ_MODEL', file, text.includes('loadFinanceLedgerRows') ? 'canonical ledger loader' : text.match(/\.select\([\s\S]*?\)/g)?.join(' | ').slice(0,3000));
  }
});
