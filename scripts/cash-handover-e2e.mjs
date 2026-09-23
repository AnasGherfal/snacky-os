// Destructive synthetic tests ONLY on the disposable loopback Supabase backend.
// Never accepts a connection string, project ID, production account or data.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(import.meta.url);
const { chromium } = require('../.qa/browser/node_modules/playwright');
const AxeBuilder = require('../.qa/browser/node_modules/@axe-core/playwright').default;
const out = 'diagnostics/cash-handover'; mkdirSync(out, { recursive: true });
assert.match(readFileSync('.qa/full/supabase/config.toml', 'utf8'), /snacky-company-isolated/);
const status = Object.fromEntries(readFileSync('.qa/local-status.env', 'utf8').split('\n').map(l => l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
assert.equal(new URL(status.API_URL).hostname, '127.0.0.1'); assert.equal(new URL(status.API_URL).port, '54321');
assert.ok(status.SERVICE_ROLE_KEY && status.ANON_KEY);
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const pg = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '54322', PGUSER: 'postgres', PGDATABASE: 'postgres', PGPASSWORD: 'postgres' };
function sql(query) {
  const r = spawnSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { env: pg, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function dbjson(query) { return JSON.parse(sql(query)); }
const results = [], errors = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (e) { results.push({ name, status: 'failed', message: String(e.message).slice(0, 2000) }); throw e; }
  finally { writeFileSync(`${out}/results.json`, JSON.stringify({ results, errors }, null, 2)); }
}
const password = `Local-QA-${randomUUID()}-Aa9!`, accounts = {};
for (const [key, role] of Object.entries({ owner: 'owner', operator: 'operator', warehouse: 'warehouse', purchasing: 'purchasing', outsider: 'operator', finance: 'finance', crm: 'crm' })) {
  const email = `cash-${key}@example.invalid`;
  const r = await admin.auth.admin.createUser({ email, password, email_confirm: true }); assert.equal(r.error, null, r.error?.message);
  const id = r.data.user.id, member = randomUUID();
  const t = await admin.from('team_members').insert({ id: member, auth_user_id: id, full_name: `QA cash ${key}`, email, role, roles: [role], active: true, active_status: 'active' }); assert.equal(t.error, null, t.error?.message);
  const p = await admin.from('profiles').upsert({ id, team_member_id: member, full_name: `QA cash ${key}`, email, role, roles: [role], active_status: 'active', must_change_password: false }); assert.equal(p.error, null, p.error?.message);
  const client = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email, password }); assert.equal(login.error, null, login.error?.message);
  accounts[key] = { id, member, client, session: login.data.session, email };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUSLFhYGBgYmBgYGBgAAAJdgDMiNdj0QAAAABJRU5ErkJggg==', 'base64');
const bucket = await admin.storage.getBucket('cash-evidence');
if (bucket.error) { const c = await admin.storage.createBucket('cash-evidence', { public: false }); assert.equal(c.error, null, c.error?.message); }
async function photo(path) { const r = await admin.storage.from('cash-evidence').upload(path, png, { contentType: 'image/png' }); assert.equal(r.error, null, r.error?.message); return path; }
const machine = randomUUID();
sql(`insert into public.machines(id,machine_code,name) values('${machine}','CASH-QA','QA Vending Location');`);
const originalOperationalPosition = sql("select jsonb_build_object('routes',(select count(*) from public.routes),'inventory',(select count(*) from public.inventory_movements))::text");
async function rpc(key, name, args = {}) { const r = await accounts[key].client.rpc(name, args); assert.equal(r.error, null, `${name}: ${r.error?.message}`); return r.data; }
async function workspace(key, id = null, status = 'open') { return rpc(key, 'snacky_cash_handover_workspace_v1', { p_id: id, p_status: status }); }
function command(action, collection_id, revision, payload) { return { request_id: randomUUID(), collection_id, action, revision, payload }; }
async function raw(key, c, path = null) { return accounts[key].client.rpc('snacky_cash_handover_command_v1', { p_command: c, p_evidence_path: path }); }
async function execute(key, c, path = null) { const r = await raw(key, c, path); assert.equal(r.error, null, `${c.action}: ${r.error?.message}`); assert.equal(r.data.request_id, c.request_id); assert.equal(r.data.ok, true); return r.data; }
async function failed(key, c, code) { const r = await raw(key, c); assert.ok(r.error, 'Unexpectedly authorized'); if (code) assert.equal(r.error.code, code); return r.error; }
async function grant(key, enabled = true) { return execute('owner', command('counter', null, 0, { user_id: accounts[key].id, enabled })); }
async function enabled(value) { return execute('owner', command('enable', null, 0, { enabled: value })); }
async function removal(key = 'operator', partial = false) {
  const bag = 'QA-' + randomUUID().slice(0, 12).toUpperCase(), request = randomUUID();
  const path = await photo(`qa-removals/${request}.png`);
  const id = await rpc(key, 'record_standalone_cash_removal', { p_machine_ids: [machine], p_removed_at: new Date().toISOString(), p_removal_type: partial ? 'partial' : 'full', p_cash_bag_id: bag, p_compartments: ['notes'], p_removal_evidence_path: path, p_removal_evidence_file_name: 'qa.png', p_notes: partial ? 'Change float intentionally left in the machine' : null, p_client_submission_id: request });
  return { id, bag, path };
}
async function assign(box, key = 'warehouse') {
  const row = (await workspace('owner', box.id)).rows[0];
  return execute('owner', command('assign', box.id, row.revision, { assigned_to: accounts[key].id }));
}
async function drop(box, key = 'warehouse', seal = 'intact', notes = '') {
  const row = (await workspace('operator', box.id)).rows[0];
  const c = command('dropoff', box.id, row.revision, { assigned_to: accounts[key].id, storage_location: 'Storage safe A', seal_condition: seal, notes });
  const path = await photo(`cash-handover-${accounts.operator.id}-${c.request_id}/stored-qa.png`);
  return execute('operator', c, path);
}
async function pickup(box, key = 'warehouse') {
  const row = (await workspace(key, box.id)).rows[0];
  return execute(key, command('pickup', box.id, row.revision, { confirm_bag_id: box.bag, seal_condition: 'intact', notes: '' }));
}
function financeRows(id) { return dbjson(`select coalesce(jsonb_agg(jsonb_build_object('id',id,'amount',amount::text,'status',transaction_status,'void',is_void)),'[]'::jsonb) from public.financial_transactions where linked_cash_collection_id='${id}' or related_cash_collection_id='${id}' or (source_type='cash_collection' and source_id='${id}')`); }
function core(id) { return dbjson(`select jsonb_build_object('amount',actual_cash_collected::text,'status',custody_status,'receiver',storage_received_by,'reconciliation',reconciliation_status,'stored',storage_received_at,'counted_by',counted_by) from public.cash_collections where id='${id}'`); }
const first = await removal(), unrelated = await removal('outsider');
await check('pilot defaults off and unauthorized grant / enrollment is denied', async () => {
  assert.equal((await workspace('owner')).enabled, false);
  await failed('operator', command('enable', null, 0, { enabled: true }), '42501');
  await failed('owner', command('assign', first.id, 0, { assigned_to: accounts.owner.id }), '23514');
  assert.equal(financeRows(first.id).length, 0);
  assert.ok((await accounts.crm.client.rpc('snacky_cash_handover_workspace_v1', {})).error);
  const anon = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } });
  assert.ok((await anon.rpc('snacky_cash_handover_workspace_v1', {})).error);
});
await enabled(true); await grant('warehouse'); await grant('purchasing');
const unidentified = [];
for (const [description, value] of [['NULL', null], ['empty', ''], ['whitespace', '   ']]) {
  await check(`unidentified ${description} records remain visible but cannot enter handover`, async () => {
    const legacy = await removal('owner');
    sql(`update public.cash_collections set cash_bag_id=${value === null ? 'null' : "'" + value + "'"} where id='${legacy.id}'`);
    unidentified.push(legacy);
    const before = sql(`select row_to_json(c)::text from public.cash_collections c where id='${legacy.id}'`);
    const view = await workspace('owner', legacy.id);
    assert.equal(view.rows[0].reference_missing, true); assert.equal(view.rows[0].bag, value);
    assert.equal(view.rows[0].state, 'reference_review'); assert.deepEqual(view.rows[0].actions, []);
    for (const c of [
      command('assign', legacy.id, 0, { assigned_to: accounts.warehouse.id }),
      command('dropoff', legacy.id, 0, { assigned_to: accounts.warehouse.id, storage_location: 'Safe A', seal_condition: 'intact', notes: '' }),
      command('direct_pickup', legacy.id, 0, { confirm_bag_id: 'MADE-UP-REF', seal_condition: 'intact', notes: '' }),
      command('pickup', legacy.id, 0, { confirm_bag_id: 'MADE-UP-REF', seal_condition: 'intact', notes: '' }),
      command('takeover', legacy.id, 0, { confirm_bag_id: 'MADE-UP-REF', seal_condition: 'intact', notes: 'Unverified earlier record' }),
      command('count', legacy.id, 0, { amount: '125', cash_location: 'Safe A' }),
    ]) {
      await failed('owner', c, '23514');
      assert.equal(sql(`select count(*) from snacky_private.cash_handover_requests where request_id='${c.request_id}'`), '0');
    }
    assert.equal(sql(`select row_to_json(c)::text from public.cash_collections c where id='${legacy.id}'`), before);
    assert.equal(sql(`select count(*) from snacky_private.cash_handovers where collection_id='${legacy.id}'`), '0');
    assert.equal(sql(`select count(*) from snacky_private.cash_handover_events where collection_id='${legacy.id}'`), '0');
    assert.equal(financeRows(legacy.id).length, 0);
  });
}
await check('tab and newline references are also unidentified, not new boxes', async () => {
  const legacy = await removal('owner');
  sql(`update public.cash_collections set cash_bag_id=chr(9)||chr(10) where id='${legacy.id}'`);
  assert.equal((await workspace('owner', legacy.id)).rows[0].reference_missing, true);
  assert.deepEqual((await workspace('owner', legacy.id)).rows[0].actions, []);
  await failed('owner', command('direct_pickup', legacy.id, 0, { confirm_bag_id: 'GUESS', seal_condition: 'intact', notes: '' }), '23514');
  assert.equal(financeRows(legacy.id).length, 0);
});
await check('unidentified legacy records retain their original owner review and counting path', async () => {
  const legacy = await removal('owner');
  sql(`update public.cash_collections set cash_bag_id=null where id='${legacy.id}'`);
  await rpc('owner', 'receive_cash_into_storage', { p_collection_id: legacy.id, p_received_at: new Date().toISOString(), p_storage_location: 'Legacy review safe', p_seal_condition: 'intact', p_evidence_path: legacy.path, p_evidence_file_name: 'qa.png', p_notes: 'Local fixture only; existing owner review', p_client_submission_id: randomUUID() });
  await rpc('owner', 'confirm_cash_count_auto_period_v1', { p_collection_id: legacy.id, p_total_amount_lyd: 17, p_client_submission_id: randomUUID() });
  assert.equal(financeRows(legacy.id).length, 1); assert.equal(financeRows(legacy.id)[0].amount, '17.00');
  assert.equal(sql(`select count(*) from snacky_private.cash_handovers where collection_id='${legacy.id}'`), '0');
});
await check('coordinator access does not grant Finance tables, raw cash totals or unrelated boxes', async () => {
  assert.equal((await workspace('warehouse')).can_count, true);
  for (const key of ['operator', 'warehouse', 'purchasing']) for (const table of ['financial_transactions', 'cash_collections']) {
    const r = await accounts[key].client.from(table).select('*');
    if (r.error) assert.equal(r.error.code, '42501'); else assert.equal(r.data.length, 0);
  }
  assert.ok((await accounts.warehouse.client.rpc('snacky_cash_handover_workspace_v1', { p_id: unrelated.id })).error);
  assert.ok((await accounts.warehouse.client.rpc('confirm_cash_count_auto_period_v1', { p_collection_id: first.id, p_total_amount_lyd: 1, p_client_submission_id: randomUUID() })).error);
  assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='snacky_private' and c.relname like 'cash_handover%' and c.relkind='r' and not c.relrowsecurity"), '0');
  assert.equal(sql("select has_table_privilege('authenticated','snacky_private.cash_handover_requests','INSERT')::text"), 'false');
});
await assign(first);
await check('an enrolled box keeps its original physical reference and rejects a mismatched pickup', async () => {
  const r = spawnSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `update public.cash_collections set cash_bag_id=null where id='${first.id}'`], { env: pg, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /enrolled box reference cannot be changed/);
  assert.equal((await workspace('owner', first.id)).rows[0].bag, first.bag);
  await failed('warehouse', command('pickup', first.id, 1, { confirm_bag_id: 'WRONG-BOX', seal_condition: 'intact', notes: '' }), '22023');
  assert.equal(financeRows(first.id).length, 0);
});
await check('collector cannot change the assigned coordinator or count before pickup', async () => {
  await failed('operator', command('dropoff', first.id, 1, { assigned_to: accounts.purchasing.id, storage_location: 'Safe', seal_condition: 'intact', notes: '' }), '22023');
  await failed('warehouse', command('count', first.id, 1, { amount: '10', cash_location: 'With me' }), '42501');
  assert.equal(financeRows(first.id).length, 0);
});
await check('parallel drop-off retries create one event, no false receiver and no Finance amount', async () => {
  const c = command('dropoff', first.id, 1, { assigned_to: accounts.warehouse.id, storage_location: 'Storage safe A', seal_condition: 'intact', notes: '' });
  const path = await photo(`cash-handover-${accounts.operator.id}-${c.request_id}/stored-qa.png`);
  const [a, b] = await Promise.all([raw('operator', c, path), raw('operator', c, path)]);
  assert.equal(a.error, null, a.error?.message); assert.equal(b.error, null, b.error?.message); assert.deepEqual(a.data, b.data);
  assert.equal(sql(`select count(*) from snacky_private.cash_handover_events where collection_id='${first.id}' and event_type='dropoff'`), '1');
  assert.equal(core(first.id).receiver, null); assert.equal(core(first.id).amount, null); assert.equal(financeRows(first.id).length, 0);
  const stored = (await workspace('warehouse', first.id)).rows[0]; assert.equal(stored.state, 'dropped'); assert.deepEqual(stored.actions, ['pickup']);
});
await check('legacy owner count cannot bypass explicit pickup on an enrolled box', async () => {
  const r = await accounts.owner.client.rpc('confirm_cash_count_auto_period_v1', { p_collection_id: first.id, p_total_amount_lyd: 20, p_client_submission_id: randomUUID() });
  assert.equal(r.error?.code, '42501'); assert.equal(core(first.id).amount, null);
});
await check('two devices cannot pick up the same box twice', async () => {
  const p = { confirm_bag_id: first.bag, seal_condition: 'intact', notes: '' };
  const responses = await Promise.all([raw('warehouse', command('pickup', first.id, 2, p)), raw('warehouse', command('pickup', first.id, 2, p))]);
  assert.equal(responses.filter(r => !r.error).length, 1); assert.equal(responses.find(r => r.error).error.code, '40001');
  assert.equal(sql(`select count(*) from snacky_private.cash_handover_events where collection_id='${first.id}' and event_type='pickup'`), '1');
});
const count = command('count', first.id, 3, { amount: '1250.25', cash_location: 'Storage safe A · counted cash compartment' });
await check('Finance failure rolls back count, event and request atomically', async () => {
  sql(`create function snacky_private.qa_cash_fail() returns trigger language plpgsql as $$begin if new.linked_cash_collection_id='${first.id}' then raise exception 'Synthetic Finance failure'; end if; return new; end;$$; create trigger qa_cash_fail before insert or update on public.financial_transactions for each row execute function snacky_private.qa_cash_fail();`);
  try { const r = await raw('warehouse', count); assert.ok(r.error); assert.equal(core(first.id).amount, null); assert.equal(financeRows(first.id).length, 0); assert.equal(sql(`select count(*) from snacky_private.cash_handover_requests where request_id='${count.request_id}'`), '0'); }
  finally { sql('drop trigger qa_cash_fail on public.financial_transactions; drop function snacky_private.qa_cash_fail();'); }
});
await check('same saved count retries post exactly once without VMS data', async () => {
  const [a, b] = await Promise.all([raw('warehouse', count), raw('warehouse', count)]);
  assert.equal(a.error, null, a.error?.message); assert.equal(b.error, null, b.error?.message); assert.deepEqual(a.data, b.data);
  assert.equal(a.data.finance_posted, true); assert.equal(a.data.amount, '1250.25');
  assert.equal(financeRows(first.id).length, 1); assert.equal(financeRows(first.id)[0].amount, '1250.25');
  assert.equal(core(first.id).reconciliation, 'pending'); assert.equal(core(first.id).counted_by, accounts.warehouse.member);
  assert.equal(sql(`select count(*) from public.cash_collection_events where cash_collection_id='${first.id}' and event_type='counted'`), '1');
  assert.equal((await workspace('operator', first.id)).rows[0].amount, null);
  assert.equal((await workspace('warehouse', first.id)).rows[0].amount, '1250.25');
});
await check('receipt recovery is exact and cannot be used to change a confirmed amount', async () => {
  assert.equal((await rpc('warehouse', 'snacky_cash_handover_receipt_v1', { p_command: count })).finance_posted, true);
  await failed('warehouse', { ...count, payload: { ...count.payload, amount: '1250.50' } }, '23505');
  await failed('warehouse', { ...count, request_id: randomUUID(), revision: 4 }, '23514');
  assert.ok((await accounts.purchasing.client.rpc('snacky_cash_handover_receipt_v1', { p_command: count })).error);
  const direct = await accounts.warehouse.client.rpc('ensure_cash_collection_finance_transaction', { p_cash_collection_id: first.id }); assert.equal(direct.error?.code, '42501');
  assert.equal(financeRows(first.id).length, 1);
});
const direct = await removal('owner', true);
await check('direct collection and a genuine zero count do not invent a storage handover', async () => {
  await execute('owner', command('direct_pickup', direct.id, 0, { confirm_bag_id: direct.bag, seal_condition: 'intact', notes: '' }));
  assert.equal(core(direct.id).stored, null);
  await execute('owner', command('count', direct.id, 1, { amount: '0', cash_location: 'Owner custody; empty box verified' }));
  assert.equal(financeRows(direct.id).length, 1); assert.equal(financeRows(direct.id)[0].amount, '0.00');
  assert.equal(sql(`select count(*) from public.cash_collection_events where cash_collection_id='${direct.id}' and event_type='stored'`), '0');
});
const exception = await removal(); await assign(exception); await drop(exception, 'warehouse', 'broken', 'Seal found opened at dropoff'); await pickup(exception);
await check('seal exceptions remain flagged for owner review after counting', async () => {
  await execute('warehouse', command('count', exception.id, 3, { amount: '35', cash_location: 'Storage exception compartment' }));
  assert.equal(core(exception.id).reconciliation, 'variance_review'); assert.equal((await workspace('owner', exception.id)).rows[0].seal_exception, true);
});
const revoked = await removal(); await assign(revoked); await drop(revoked); await pickup(revoked);
await check('grant revocation blocks counting; an explicit owner takeover preserves custody', async () => {
  await grant('warehouse', false);
  await failed('warehouse', command('count', revoked.id, 3, { amount: '40', cash_location: 'Safe' }), '42501');
  assert.equal((await workspace('operator', revoked.id)).rows[0].assignee_active, false);
  await execute('owner', command('takeover', revoked.id, 3, { confirm_bag_id: revoked.bag, seal_condition: 'intact', notes: 'Physically received this box from the former coordinator' }));
  await execute('owner', command('count', revoked.id, 4, { amount: '40', cash_location: 'Owner safe' }));
  assert.equal(core(revoked.id).counted_by, accounts.owner.member); await grant('warehouse');
});
const inactive = await removal(); await assign(inactive, 'purchasing'); await drop(inactive, 'purchasing'); await pickup(inactive, 'purchasing');
await check('inactive profiles and inactive linked staff cannot use a previously issued session', async () => {
  sql(`update public.profiles set active_status='inactive' where id='${accounts.purchasing.id}'`);
  try { await failed('purchasing', command('count', inactive.id, 3, { amount: '11', cash_location: 'Safe' }), '42501'); }
  finally { sql(`update public.profiles set active_status='active' where id='${accounts.purchasing.id}'`); }
  sql(`update public.team_members set active_status='inactive' where id='${accounts.purchasing.member}'`);
  try { await failed('purchasing', command('count', inactive.id, 3, { amount: '11', cash_location: 'Safe' }), '42501'); }
  finally { sql(`update public.team_members set active_status='active' where id='${accounts.purchasing.member}'`); }
});
await check('pause stops new enrollment but allows existing custody to finish', async () => {
  await enabled(false); const fresh = await removal();
  await failed('owner', command('assign', fresh.id, 0, { assigned_to: accounts.warehouse.id }), '23514');
  await execute('purchasing', command('count', inactive.id, 3, { amount: '11', cash_location: 'Storage safe A' }));
});
await check('un-enrolled legacy receive and count remain usable while the pilot is paused', async () => {
  const legacy = await removal('owner');
  await rpc('owner', 'receive_cash_into_storage', { p_collection_id: legacy.id, p_received_at: new Date().toISOString(), p_storage_location: 'Legacy safe', p_seal_condition: 'intact', p_evidence_path: legacy.path, p_evidence_file_name: 'qa.png', p_notes: null, p_client_submission_id: randomUUID() });
  await rpc('owner', 'confirm_cash_count_auto_period_v1', { p_collection_id: legacy.id, p_total_amount_lyd: 70, p_client_submission_id: randomUUID() });
  assert.equal(financeRows(legacy.id).length, 1); assert.equal(financeRows(legacy.id)[0].amount, '70.00');
  assert.equal(sql(`select count(*) from snacky_private.cash_handovers where collection_id='${legacy.id}'`), '0');
});
await check('existing owner void reverses Finance but retains count and audit history', async () => {
  assert.ok((await accounts.warehouse.client.rpc('void_cash_collection', { p_collection_id: exception.id, p_reason: 'Cannot approve own discrepancy', p_client_submission_id: randomUUID() })).error);
  await rpc('owner', 'void_cash_collection', { p_collection_id: exception.id, p_reason: 'Synthetic owner reversal test', p_client_submission_id: randomUUID() });
  assert.equal(core(exception.id).status, 'voided'); assert.equal(core(exception.id).amount, '35.00');
  assert.equal(financeRows(exception.id).filter(r => r.status === 'active' && !r.void).length, 0);
});
await enabled(true);
const browserBox = await removal(); await assign(browserBox);
const app = 'http://localhost:3000';
const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED: 'true', NEXT_PUBLIC_APP_URL: app };
const build = spawnSync('npm', ['run', 'build'], { env, encoding: 'utf8', maxBuffer: 40e6 });
writeFileSync('diagnostics/cash-build.log', build.stdout + '\n' + build.stderr); assert.equal(build.status, 0, 'Production build failed; see cash-build.log');
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], { env, stdio: ['ignore', openSync('diagnostics/cash-server.log', 'w'), openSync('diagnostics/cash-server-errors.log', 'w')] });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(app + '/login')).ok) break; } catch {} if (i === 99) throw Error('Local Next server unavailable'); await new Promise(r => setTimeout(r, 300)); }
  browser = await chromium.launch({ headless: true });
  async function session(key, locale = 'en', width = 390) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    await context.addCookies([
      { name: 'snacky-auth-access-token', value: accounts[key].session.access_token, url: app, httpOnly: true },
      { name: 'snacky-auth-refresh-token', value: accounts[key].session.refresh_token, url: app, httpOnly: true },
      { name: 'snacky_os_language', value: locale, url: app },
    ]);
    const page = await context.newPage(); page.on('pageerror', e => errors.push({ key, message: e.message }));
    await page.goto(app + `/cash-handling?id=${browserBox.id}`); await page.getByText(browserBox.bag, { exact: true }).waitFor();
    return { page, context };
  }
  const owner = await session('owner', 'en', 1440), operator = await session('operator'), counter = await session('warehouse', 'ar');
  await check('English and Arabic legacy review screens do not offer handover or invented references', async () => {
    for (const locale of ['en', 'ar']) {
      const s = await session('owner', locale, 390);
      try {
        await s.page.goto(app + `/cash-handling?id=${unidentified[0].id}`);
        const notice = s.page.getByTestId('cash-reference-review'); await notice.waitFor();
        assert.match(await notice.innerText(), locale === 'en' ? /Physical box reference not recorded/ : /رقم العلبة الفعلي غير مسجل/);
        const labels = locale === 'en' ? ['Assign coordinator','Left in storage','I will count my collected box','Count and record'] : ['إسناد المسؤول','وضعتها في المخزن','سأعد العلبة التي جمعتها','عد النقد وتسجيله'];
        for (const name of labels) assert.equal(await s.page.getByRole('button', { name, exact: true }).count(), 0);
        assert.equal(await s.page.locator('form').count(), 0);
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        await s.page.getByRole('link', { name: locale === 'en' ? 'Open owner reconciliation' : 'فتح مطابقة النقد للمالك', exact: true }).waitFor();
        await s.page.screenshot({ path: `${out}/legacy-reference-review-${locale}.png`, fullPage: true });
      } finally { await s.context.close(); }
    }
  });
  await check('real operator phone form uploads evidence and records unattended drop-off', async () => {
    const p = operator.page; await p.getByRole('button', { name: 'Left in storage', exact: true }).click();
    await p.getByLabel('Exact storage / safe location', { exact: true }).fill('Storage secure cabinet B');
    await p.locator('form input[type=file]').setInputFiles({ name: 'storage.png', mimeType: 'image/png', buffer: png });
    await p.locator('form input[type=checkbox]').check(); await p.getByRole('button', { name: 'Confirm action', exact: true }).click();
    await p.getByRole('status').filter({ hasText: 'Action recorded' }).waitFor();
    assert.equal(core(browserBox.id).receiver, null); assert.equal(financeRows(browserBox.id).length, 0);
    await p.getByRole('link', { name: 'View storage photo', exact: true }).waitFor();
    const url = await p.getByRole('link', { name: 'View storage photo', exact: true }).getAttribute('href');
    const image = await operator.context.request.get(url); assert.equal(image.status(), 200); assert.deepEqual(await image.body(), png);
    await p.screenshot({ path: `${out}/operator-dropoff-mobile.png`, fullPage: true });
  });
  await check('real Arabic coordinator form acknowledges pickup and restores a lost count response', async () => {
    const p = counter.page; await p.reload(); await p.getByRole('button', { name: 'استلام العلبة', exact: true }).click();
    await p.getByLabel('اكتب الرقم الموجود على العلبة / الختم', { exact: true }).fill(browserBox.bag);
    await p.locator('form input[type=checkbox]').check(); await p.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
    await p.getByRole('status').filter({ hasText: 'تم تسجيل الإجراء' }).waitFor();
    await p.getByRole('button', { name: 'عد النقد وتسجيله', exact: true }).click();
    await p.getByLabel('إجمالي النقد المعدود · دينار', { exact: true }).fill('91.25');
    await p.getByLabel('أين يوجد النقد بعد العد؟', { exact: true }).fill('خزنة المخزن، قسم النقد المعدود');
    await p.locator('form input[type=checkbox]').check();
    let committed = false;
    await p.route('**/api/cash-handling', async route => {
      if (route.request().method() === 'POST' && !committed) { const r = await route.fetch(); assert.equal(r.status(), 200); committed = true; await route.abort('failed'); }
      else await route.continue();
    });
    await p.getByRole('button', { name: 'تأكيد العد والتسجيل مرة واحدة', exact: true }).click();
    await p.getByRole('alert').filter({ hasText: 'لم يتأكد الحفظ' }).waitFor(); assert.equal(committed, true);
    await p.unroute('**/api/cash-handling'); await p.reload();
    await p.getByRole('button', { name: 'إعادة الطلب المحفوظ', exact: true }).click();
    await p.getByRole('status').filter({ hasText: 'تم حفظ العد وتسجيله في مالية سناكي' }).waitFor();
    assert.equal(financeRows(browserBox.id).length, 1); assert.equal(financeRows(browserBox.id)[0].amount, '91.25');
    assert.equal(await p.locator('[data-testid=cash-handling]').getAttribute('dir'), 'rtl');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await p.screenshot({ path: `${out}/coordinator-count-ar-mobile.png`, fullPage: true });
  });
  await check('browser / API permission checks hide amounts and reject Finance and cross-origin writes', async () => {
    const response = await operator.context.request.get(app + `/api/cash-handling?id=${browserBox.id}`);
    assert.equal(response.status(), 200); const text = await response.text(); assert.equal(text.includes('91.25'), false); assert.match(response.headers()['cache-control'], /no-store/);
    assert.equal((await counter.context.request.get(app + `/api/cash-handling?id=${unrelated.id}`)).status(), 403);
    assert.equal((await counter.context.request.post(app + '/api/cash-handling', { headers: { Origin: 'https://untrusted.example' }, data: command('enable', null, 0, { enabled: true }) })).status(), 403);
    await counter.page.goto(app + '/finance'); await counter.page.waitForURL(/\/unauthorized/);
    await counter.page.goto(app + `/cash-handling?id=${browserBox.id}`); await counter.page.getByText(browserBox.bag, { exact: true }).waitFor();
  });
  await check('owner desktop overview and scoped accessibility checks', async () => {
    await owner.page.goto(app + '/cash-handling'); await owner.page.getByRole('heading', { name: 'Team cash boxes', exact: true }).waitFor();
    await owner.page.getByText('Owner controls · counting access and pilot', { exact: true }).click();
    await owner.page.getByText('QA cash warehouse', { exact: true }).first().waitFor();
    await owner.page.screenshot({ path: `${out}/owner-cash-overview.png`, fullPage: true });
    for (const page of [owner.page, operator.page, counter.page]) {
      const audit = await new AxeBuilder({ page }).include('[data-testid="cash-handling"]').analyze();
      const blocking = audit.violations.filter(v => ['critical', 'serious'].includes(v.impact)); assert.equal(blocking.length, 0, JSON.stringify(blocking.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))));
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
  });
  await check('cash-only release did not create or change routes or inventory movements', async () => {
    assert.equal(sql("select jsonb_build_object('routes',(select count(*) from public.routes),'inventory',(select count(*) from public.inventory_movements))::text"), originalOperationalPosition);
  });
} finally {
  if (browser) {
    let i = 0; for (const c of browser.contexts()) for (const p of c.pages()) { try { await p.screenshot({ path: `${out}/final-${i++}.png`, fullPage: true }); writeFileSync(`${out}/last-page-${i}.txt`, (await p.locator('body').innerText()).slice(0, 16000)); } catch {} }
    await browser.close();
  }
  server.kill('SIGTERM');
  writeFileSync(`${out}/results.json`, JSON.stringify({ results, errors }, null, 2));
}
console.log(`Completed ${results.length} isolated cash acceptance scenarios.`);
