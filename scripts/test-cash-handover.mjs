import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateCashCommand, cashReceiptMatches, cashCents, cashSameOrigin } from '../src/lib/cash-handover.ts';
import { canAccessPath, canViewFinancials, canEditFinancialTransactions, canCountCash } from '../src/lib/authz.ts';
const id = () => randomUUID();
const command = (action = 'count', payload = { amount: '120.25', cash_location: 'Storage safe A' }) => ({ request_id: id(), collection_id: id(), action, revision: 2, payload });
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20260923120059_cash_handover_coordinator_v1.sql');

test('single-total cash uses exact integer cents, including an empty box', () => {
  assert.equal(cashCents('0'), 0); assert.equal(cashCents('0.25'), 25);
  assert.equal(cashCents('120.5'), 12050); assert.equal(cashCents('99999999.99'), 9999999999);
});
for (const amount of ['NaN', 'Infinity', '-1', '1e3', '100,50', '00.25', '2.001', '100000000', '', ' 20', '.50', 20, null]) {
  test(`rejects ambiguous or invalid cash total ${JSON.stringify(amount)}`, () => assert.throws(() => validateCashCommand(command('count', { amount, cash_location: 'Safe' }))));
}
test('commands cannot forge identity, revision, Finance fields or arbitrary action keys', () => {
  const c = command(); assert.deepEqual(validateCashCommand(c), c);
  for (const bad of [{ ...c, actor_id: id() }, { ...c, revision: -1 }, { ...c, revision: 1.2 }, { ...c, revision: 1000000000 }, { ...c, collection_id: null }, { ...c, payload: { ...c.payload, finance_account: 'owner_lyd' } }, { ...c, action: '__proto__' }]) assert.throws(() => validateCashCommand(bad));
});
test('management is explicit and not disguised as a box command', () => {
  assert.ok(validateCashCommand({ ...command('enable', { enabled: false }), collection_id: null, revision: 0 }));
  assert.throws(() => validateCashCommand(command('enable', { enabled: true })));
  assert.throws(() => validateCashCommand({ ...command('counter', { user_id: id(), enabled: 'true' }), collection_id: null, revision: 0 }));
});
test('dropoff, seal problems and custody takeover require meaningful evidence fields', () => {
  const p = { assigned_to: id(), storage_location: 'Safe A', seal_condition: 'intact', notes: '' };
  assert.ok(validateCashCommand(command('dropoff', p)));
  assert.throws(() => validateCashCommand(command('dropoff', { ...p, storage_location: '' })));
  assert.throws(() => validateCashCommand(command('dropoff', { ...p, seal_condition: 'broken' })));
  assert.ok(validateCashCommand(command('pickup', { confirm_bag_id: 'S-20', seal_condition: 'broken', notes: 'Seal already open' })));
  assert.throws(() => validateCashCommand(command('takeover', { confirm_bag_id: 'S-20', seal_condition: 'intact', notes: '' })));
});
test('confirmation must match the exact request, action, box, revision and amount', () => {
  const c = command(); const r = { ok: true, request_id: c.request_id, collection_id: c.collection_id, action: 'count', revision: 3, amount: '120.25', finance_posted: true };
  assert.ok(cashReceiptMatches(c, r));
  for (const bad of [{ ...r, request_id: id() }, { ...r, collection_id: id() }, { ...r, revision: 4 }, { ...r, amount: '120.26' }, { ...r, amount: 'NaN' }, { ...r, finance_posted: false }, { ...r, action: 'pickup' }, null]) assert.equal(cashReceiptMatches(c, bad), false);
});
test('cash workspace entry does not confer Finance or legacy counting permissions', () => {
  for (const role of ['operator', 'warehouse', 'purchasing']) {
    const user = { id: id(), role, activeStatus: 'active' };
    assert.equal(canAccessPath(user, '/cash-handling'), true);
    assert.equal(canAccessPath(user, '/finance'), false);
    assert.equal(canViewFinancials(user), false); assert.equal(canEditFinancialTransactions(user), false); assert.equal(canCountCash(user), false);
    assert.equal(canAccessPath({ ...user, activeStatus: 'inactive' }, '/cash-handling'), false);
  }
  for (const role of ['crm', 'investor', 'viewer']) assert.equal(canAccessPath({ id: id(), role }, '/cash-handling'), false);
});
test('cross-origin, missing-origin and mismatched-host writes are rejected', () => {
  const request = headers => new Request('https://snacky.example/api/cash-handling', { method: 'POST', headers });
  assert.equal(cashSameOrigin(request({ Origin: 'https://snacky.example' })), true);
  assert.equal(cashSameOrigin(request({})), false);
  assert.equal(cashSameOrigin(request({ Origin: 'https://evil.example' })), false);
  assert.equal(cashSameOrigin(request({ Origin: 'https://snacky.example', 'Sec-Fetch-Site': 'cross-site' })), false);
});
test('all new state is private and opt-in; there is no historical backfill or role migration', () => {
  for (const name of ['settings', 'counters', 'requests', 'events']) assert.match(sql, new RegExp(`alter table snacky_private.cash_handover_${name} enable row level security`));
  assert.match(sql, /enabled boolean not null default false/);
  assert.doesNotMatch(sql, /alter type|add value|update public\.profiles|update public\.team_members|grant[^;]+public\.financial_transactions/i);
  assert.match(sql, /execution_xid=pg_current_xact_id\(\)/);
  assert.match(sql, /r\.actor_user_id<>v_actor or r\.command<>p_command/);
  assert.match(sql, /pg_advisory_xact_lock/); assert.match(sql, /cash_collections where id=v_id for update/);
});
test('Finance remains on the existing writer and success requires a checked single posting', () => {
  const commandSection = sql.slice(sql.indexOf('create function snacky_private.cash_handover_command_v1_impl'));
  assert.match(commandSection, /perform public\.confirm_cash_count_auto_period_v1\(v_id,v_amount,v_request\)/);
  assert.match(commandSection, /v_finance_count<>1 or v_finance_amount is distinct from v_amount/);
  assert.doesNotMatch(commandSection, /insert into public\.financial_transactions|update public\.financial_transactions|insert into public\.inventory_movements/);
  assert.match(sql, /storage_received_by=null/);
  assert.match(sql, /receiver_confirmed',false/);
});
test('API authenticates, bounds uploads, scopes signing, verifies receipts and retains uncertain evidence', () => {
  const api = read('src/app/api/cash-handling/route.ts');
  assert.match(api, /cashSameOrigin\(request\)/); assert.match(api, /readCompanyBody/);
  assert.match(api, /snacky_cash_handover_receipt_v1/); assert.match(api, /cashReceiptMatches/);
  assert.match(api, /delete row.evidence_path/); assert.doesNotMatch(api, /removeCashEvidence/);
  assert.doesNotMatch(api, /\.from\(['"]financial_transactions/);
});
test('mobile workspace keeps the immutable retry across reload and never displays a company balance', () => {
  const ui = read('src/components/CashHandlingWorkspace.tsx');
  assert.match(ui, /sessionStorage\.setItem\(storageKey, JSON\.stringify\(command\)\)/);
  assert.match(ui, /send\(pending, true\)/); assert.match(ui, /dir=\{ar \? 'rtl' : 'ltr'\}/);
  assert.doesNotMatch(ui, /totalAvailableCash|owner_lyd|finance\.view/);
});
