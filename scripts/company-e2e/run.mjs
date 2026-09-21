// Real Auth, PostgREST, Storage, production Next.js and Chromium. Loopback only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(import.meta.url);
const { chromium } = require('../../.qa/browser/node_modules/playwright');
const AxeBuilder = require('../../.qa/browser/node_modules/@axe-core/playwright').default;
const out = 'diagnostics/company-e2e';
mkdirSync(out, { recursive: true });
const status = Object.fromEntries(readFileSync('.qa/local-status.env', 'utf8').split('\n').map(l => l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m => [m[1], m[2]]));
assert.equal(new URL(status.API_URL).hostname, '127.0.0.1');
assert.equal(new URL(status.API_URL).port, '54321');
assert.ok(status.SERVICE_ROLE_KEY && status.ANON_KEY);
const app = 'http://localhost:3000';
const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED: 'true', NEXT_PUBLIC_APP_URL: app };
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const pg = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '54322', PGUSER: 'postgres', PGDATABASE: 'postgres', PGPASSWORD: 'postgres' };
function sql(query) {
  const r = spawnSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { env: pg, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
async function rpc(client, name, args) {
  const r = await client.rpc(name, args); assert.equal(r.error, null, `${name}: ${r.error?.message}`); return r.data;
}
const password = `QA-only-${randomUUID()}-Aa9!`, accounts = {};
for (const role of ['owner', 'admin', 'crm', 'operator', 'finance', 'investor', 'viewer']) {
  const email = `qa-${role}@example.invalid`;
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `QA ${role}` } });
  assert.equal(result.error, null, result.error?.message);
  const id = result.data.user.id, member = randomUUID();
  const t = await admin.from('team_members').insert({ id: member, auth_user_id: id, full_name: `QA ${role}`, email, role, roles: [role], active: true, active_status: 'active' });
  assert.equal(t.error, null, t.error?.message);
  const p = await admin.from('profiles').upsert({ id, team_member_id: member, full_name: `QA ${role}`, email, role, roles: [role], active_status: 'active', must_change_password: false });
  assert.equal(p.error, null, p.error?.message);
  const client = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email, password }); assert.equal(login.error, null, login.error?.message);
  accounts[role] = { id, member, email, client };
}
const results = [], errors = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed', message: String(error.message).slice(0, 1800) }); throw error; }
  finally { writeFileSync(`${out}/results.json`, JSON.stringify({ results, errors }, null, 2)); }
}
function ledger() { return sql(`select jsonb_build_object('transactions',(select count(*) from public.financial_transactions),'movements',(select count(*) from public.inventory_movements),'routes',(select count(*) from public.routes))::text;`); }
const moneyBefore = ledger();
await check('real database role boundaries', async () => {
  for (const role of ['owner', 'admin', 'crm', 'operator', 'finance']) assert.equal((await rpc(accounts[role].client, 'snacky_company_workspace_v1', {})).manager, ['owner', 'admin'].includes(role));
  for (const role of ['investor', 'viewer']) assert.ok((await accounts[role].client.rpc('snacky_company_workspace_v1', {})).error);
});
const build = spawnSync('npm', ['run', 'build'], { env, encoding: 'utf8', maxBuffer: 30e6 });
writeFileSync('diagnostics/e2e-build.log', build.stdout + '\n' + build.stderr); assert.equal(build.status, 0, 'Production build failed');
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], { env, stdio: ['ignore', openSync('diagnostics/e2e-server.log', 'w'), openSync('diagnostics/e2e-server-errors.log', 'w')] });
let browser;
try {
  for (let n = 0; n < 60; n++) { try { if ((await fetch(app + '/login')).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); if (n === 59) throw Error('Next server unavailable'); }
  browser = await chromium.launch({ headless: true }); const contexts = {};
  async function session(role, locale = 'en', width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: locale === 'ar' ? 'ar-LY' : 'en-GB' });
    await context.addCookies([{ name: 'snacky_os_language', value: locale, url: app }]);
    const page = await context.newPage(); page.on('pageerror', e => errors.push({ role, message: e.message }));
    await page.goto(app + '/login?next=/company');
    await page.locator('input[name=email]').fill(accounts[role].email); await page.locator('input[name=password]').fill(password);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30000 }), page.locator('form button[type=submit]').click()]);
    contexts[role] = context; return page;
  }
  async function post(page, path, payload) { return page.evaluate(async ({ path, payload }) => { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json() }; }, { path, payload }); }
  async function command(page, action, id, revision, version, payload) {
    const result = await post(page, '/api/company/command', { request_id: randomUUID(), action, item_id: id, revision, version, payload });
    assert.equal(result.body.ok, true, JSON.stringify(result)); return result.body;
  }
  const owner = await session('owner'), crm = await session('crm', 'ar', 390), operator = await session('operator'), finance = await session('finance');
  await check('actual login and full Company shell', async () => { for (const page of [owner, crm, operator, finance]) { await page.goto(app + '/company'); await page.locator('.company-hub').waitFor(); assert.ok(await page.locator('header').count()); assert.ok(await page.locator('main').count()); } });
  let itemId, fileHref;
  // A populated server-rendered textarea contributes text to label.textContent.
  // Locate its accessible role/name rather than requiring an exact raw label string.
  const instructions = page => page.getByRole('textbox', { name: /^Instructions \/ responsibilities/ });
  await check('real draft save, reload and exact private review', async () => {
    await owner.goto(app + '/company/new'); await owner.locator('form').getByRole('button', { name: 'English', exact: true }).click();
    await owner.getByLabel('Title', { exact: true }).fill('QA — Visit a potential location');
    await owner.getByLabel('What is this for?', { exact: true }).fill('Test fixture: a saved, role-scoped guide.');
    await instructions(owner).fill('When\nBefore visiting a location.\n\nDo\nRecord the outcome and next action.');
    await owner.getByLabel('Next review date', { exact: true }).fill('2027-01-01');
    await owner.getByLabel('Notify these roles about this version', { exact: true }).check();
    await owner.getByLabel('Require explicit acknowledgement of this version', { exact: true }).check();
    await owner.getByRole('button', { name: 'Save draft', exact: true }).click(); await owner.waitForURL(/\/company\/items\/.*draft=1/);
    itemId = new URL(owner.url()).pathname.split('/').pop(); await owner.reload();
    assert.match(await owner.locator('article').innerText(), /Record the outcome/); assert.match(await owner.locator('article').innerText(), /Review saved draft before publishing/);
  });
  await check('draft isolation through real employee search and direct URLs', async () => {
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_filters: { section: 'guides', q: 'QA' } })).total, 0);
    assert.ok((await accounts.crm.client.rpc('snacky_company_workspace_v1', { p_id: itemId })).error);
    await crm.goto(app + `/company/items/${itemId}?draft=1`); await crm.waitForURL(/\/unauthorized/, { timeout: 15000 });
    assert.equal(await crm.getByText('Record the outcome and next action.', { exact: true }).count(), 0);
  });
  await check('real private upload and authorized preview/download', async () => {
    await owner.goto(app + `/company/items/${itemId}?edit=1`);
    const details = owner.locator('details').filter({ hasText: 'File or editable master' }); if (await details.getAttribute('open') === null) await details.locator('summary').click();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUSLFhYGBgYmBgYGBgAAAJdgDMiNdj0QAAAABJRU5ErkJggg==', 'base64');
    await owner.locator('input[type=file]').setInputFiles({ name: 'QA-image.png', mimeType: 'image/png', buffer: bytes });
    await owner.getByRole('link', { name: 'View attached file', exact: true }).waitFor();
    fileHref = await owner.getByRole('link', { name: 'View attached file', exact: true }).getAttribute('href');
    assert.equal((await contexts.crm.request.get(app + fileHref)).status(), 404);
    await owner.getByRole('button', { name: 'Save draft', exact: true }).click(); await owner.waitForURL(/draft=1/);
    owner.once('dialog', d => d.accept()); await owner.getByRole('button', { name: 'Publish this reviewed revision', exact: true }).click();
    await owner.waitForURL(url => url.pathname.includes(itemId) && !url.searchParams.has('draft'));
    const visible = await contexts.crm.request.get(app + fileHref); assert.equal(visible.status(), 200); assert.deepEqual(await visible.body(), bytes);
    assert.match(visible.headers()['cache-control'], /no-store/); assert.equal(visible.headers()['x-content-type-options'], 'nosniff');
    assert.equal((await contexts.finance.request.get(app + fileHref)).status(), 404);
    const preview = await contexts.crm.newPage(); await preview.goto(app + fileHref + '?preview=1'); await preview.locator('img').waitFor();
    assert.equal(await preview.locator('img').evaluate(i => i.complete && i.naturalWidth === 2), true); await preview.close();
  });
  await check('per-version read and acknowledgement persist and remain separate', async () => {
    const first = await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_id: itemId }); assert.equal(first.record.current_version, 1);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_notices_v1', {})).required_count, 1);
    await crm.goto(app + `/company/items/${itemId}`); await command(crm, 'read', itemId, first.record.revision, 1);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_notices_v1', {})).required_count, 1);
    await command(crm, 'ack', itemId, first.record.revision, 1);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_notices_v1', {})).required_count, 0);
    await crm.reload(); assert.match(await crm.locator('.company-hub').innerText(), /أقررت|acknowledged/);
  });
  await check('duplicates and stale revisions cannot overwrite; historical versions remain intact', async () => {
    const w = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId });
    const payload = { ...w.draft, body_en: 'Updated current instructions.', body_ar: 'التعليمات الحالية المحدّثة.', title_ar: 'زيارة موقع محتمل', summary_ar: 'دليل اختباري للزيارات والمتابعة.', work_path: '/locations-pipeline' };
    const request = { request_id: randomUUID(), action: 'save', item_id: itemId, revision: w.record.revision, payload };
    const [a, b] = await Promise.all([post(owner, '/api/company/command', request), post(owner, '/api/company/command', request)]); assert.deepEqual(a.body, b.body); assert.equal(a.body.ok, true);
    assert.equal((await post(owner, '/api/company/command', { ...request, request_id: randomUUID() })).status, 409);
    assert.notEqual((await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_id: itemId })).record.data.body_en, payload.body_en);
    await command(owner, 'publish', itemId, a.body.revision, 1);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_notices_v1', {})).required_count, 1);
    await crm.goto(app + `/company/items/${itemId}?version=1`); assert.match(await crm.locator('article').innerText(), /نسخة سابقة|Older version/);
    assert.match((await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_id: itemId, p_filters: { version: '1' } })).record.data.body_en, /Record the outcome/);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_filters: { section: 'guides', work_path: '/locations-pipeline' } })).total, 1);
  });
  await check('lost response after a real commit recovers through the actual editor', async () => {
    const before = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId });
    await owner.goto(app + `/company/items/${itemId}?edit=1`);
    const editorBody = instructions(owner);
    await editorBody.waitFor();
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 20 && await editorBody.inputValue() !== 'Updated current instructions.'; i++) await owner.waitForTimeout(50);
      assert.equal(await editorBody.inputValue(), 'Updated current instructions.');
    });
    await editorBody.fill('Confirmed once after response loss.');
    assert.equal(await editorBody.inputValue(), 'Confirmed once after response loss.');
    let savedRequest;
    await owner.route('**/api/company/command', async route => { savedRequest = route.request().postDataJSON(); await route.fetch(); await route.abort('failed'); }, { times: 1 });
    await owner.getByRole('button', { name: 'Save draft', exact: true }).click(); await owner.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor();
    const committed = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId }); assert.equal(committed.record.revision, before.record.revision + 1);
    await owner.reload(); await owner.getByRole('button', { name: 'Retry saved request', exact: true }).click(); await owner.waitForURL(/draft=1/);
    const after = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId }); assert.equal(after.record.revision, committed.record.revision); assert.equal(after.draft.body_en, 'Confirmed once after response loss.'); assert.ok(savedRequest.request_id);
  });
  await check('archive/restore protects access without deleting history', async () => {
    const w = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId }); const archived = await command(owner, 'archive', itemId, w.record.revision, 2);
    assert.ok((await accounts.crm.client.rpc('snacky_company_workspace_v1', { p_id: itemId })).error); assert.equal((await contexts.crm.request.get(app + fileHref)).status(), 404);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_notices_v1', {})).attention_count, 0);
    await command(owner, 'restore', itemId, archived.revision, 2); assert.equal((await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_id: itemId })).record.current_version, 2);
  });
  await check('direct API, foreign origin, oversized body and role gates are enforced', async () => {
    const w = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId });
    assert.equal((await post(crm, '/api/company/command', { request_id: randomUUID(), action: 'publish', item_id: itemId, revision: w.record.revision })).status, 403);
    assert.equal((await contexts.owner.request.post(app + '/api/company/command', { headers: { origin: 'https://other.invalid' }, data: {} })).status(), 403);
    assert.equal((await post(owner, '/api/company/command', { x: 'x'.repeat(260000) })).status, 413);
    assert.equal((await contexts.owner.request.get(app + '/api/company/files/not-a-uuid')).status(), 404);
    for (const role of ['investor', 'viewer']) { const p = await session(role); await p.goto(app + '/company'); await p.waitForURL(/\/unauthorized/, { timeout: 15000 }); }
  });
  await check('inactive linked staff cannot retain access through an older active profile', async () => {
    const id = accounts.crm.member; sql(`update public.team_members set active=false,active_status='inactive' where id='${id}'`);
    assert.ok((await accounts.crm.client.rpc('snacky_company_notices_v1', {})).error); assert.equal((await contexts.crm.request.get(app + fileHref)).status(), 404);
    sql(`update public.team_members set active=true,active_status='active' where id='${id}'`);
  });
  await check('library displays real authorized resources, not placeholder files', async () => {
    const w = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId }), id = randomUUID();
    const d = { ...w.draft, title_en: 'QA image — test library resource', title_ar: 'صورة اختبار — مورد تجريبي', section: 'documents', requires_ack: false, notify: false, summary_en: 'Synthetic acceptance-test material, not an approved Snacky asset.', summary_ar: 'مادة اختبارية وليست من ملفات سناكي المعتمدة.' };
    const saved = await command(owner, 'save', id, 0, undefined, d); await command(owner, 'publish', id, saved.revision, 0);
    assert.equal((await rpc(accounts.crm.client, 'snacky_company_workspace_v1', { p_filters: { section: 'documents' } })).total, 1);
  });
  await check('full-shell Arabic/English mobile and desktop layouts and Company accessibility', async () => {
    const audits = [];
    for (const [label, page, path, width] of [['home-ar-390', crm, '/company', 390], ['guide-ar-390', crm, `/company/items/${itemId}`, 390], ['library-en-1440', owner, '/company/documents', 1440], ['editor-en-320', owner, `/company/items/${itemId}?edit=1`, 320]]) {
      await page.setViewportSize({ width, height: 950 }); await page.goto(app + path); await page.locator('.company-hub').waitFor();
      const bad = await page.evaluate(() => Array.from(document.querySelectorAll('.company-hub *')).filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.right > innerWidth + 2 || r.left < -2); }).map(e => e.tagName + ':' + e.className)); assert.deepEqual(bad, [], label + ' overflow');
      await page.screenshot({ path: `${out}/${label}.png`, fullPage: true });
      const audit = await new AxeBuilder({ page }).include('.company-hub').analyze(); audits.push({ label, violations: audit.violations });
    }
    writeFileSync(`${out}/accessibility.json`, JSON.stringify(audits, null, 2));
    assert.equal(audits.flatMap(a => a.violations).filter(v => ['serious', 'critical'].includes(v.impact)).length, 0, 'Company accessibility violations');
  });
  await check('multipage Arabic printing retains actual instructions and version information', async () => {
    const w = await rpc(accounts.owner.client, 'snacky_company_workspace_v1', { p_id: itemId }), id = randomUUID();
    const paragraphs = Array.from({ length: 42 }, (_, i) => `الخطوة ${i + 1}\nسجّل نتيجة التواصل وحدّد المسؤول والخطوة القادمة وموعد المتابعة. هذه مادة اختبارية للتأكد من سلامة الطباعة وليست سياسة عمل معتمدة.`);
    const d = { ...w.draft, title_ar: 'دليل اختبار الطباعة متعدد الصفحات', title_en: 'Multipage print acceptance fixture', body_ar: paragraphs.join('\n\n') + '\n\nنهاية دليل الاختبار', body_en: '', requires_ack: false, notify: false, file_id: '', work_path: '' };
    const saved = await command(owner, 'save', id, 0, undefined, d); await command(owner, 'publish', id, saved.revision, 0);
    await crm.goto(app + `/company/items/${id}`); await crm.locator('article').waitFor();
    const pdf = await crm.pdf({ path: `${out}/guide-print-ar.pdf`, format: 'A4', printBackground: true }); assert.ok(pdf.length > 15000); assert.match(pdf.subarray(0, 8).toString(), /%PDF/);
  });
  await check('Company commands leave existing routes, inventory and money ledgers unchanged', async () => { assert.equal(ledger(), moneyBefore); });
  await check('real CRM lead conversion and operator-to-relations issue handoff remain connected', async () => {
    const c = (role, action, id, payload) => rpc(accounts[role].client, 'snacky_crm_command_v1', { p_command_id: randomUUID(), p_action: action, p_id: id, p_payload: payload });
    const read = (role, kind, id) => rpc(accounts[role].client, 'snacky_crm_workspace_v1', { p_section: kind, p_id: id });
    const today = new Date().toISOString().slice(0, 10);
    const lead = await c('owner', 'lead.save', null, { place_name: 'QA University', place_type: 'university', assigned_to: accounts.crm.member, visibility: 'assigned', next_action: 'Call the QA contact', next_action_date: today });
    let w = await read('crm', 'lead', lead.id); await c('crm', 'lead.save', lead.id, { version: w.record.data.version, status: 'accepted' });
    const location = await c('crm', 'lead.convert', lead.id, {}); assert.equal((await c('crm', 'lead.convert', lead.id, {})).id, location.id);
    const issue = await c('crm', 'issue.save', null, { customer_phone: '0000000000', location_id: location.id, description: 'QA vending issue', issue_type: 'product_stuck', status: 'waiting', waiting_on: 'Operator inspection', next_action_date: today });
    const task = await c('crm', 'task.save', null, { kind: 'issue', related_id: issue.id, title: 'QA inspect machine', task_type: 'field_action', assigned_to: accounts.operator.member, due_date: today });
    w = await read('operator', 'task', task.id); await c('operator', 'task.save', task.id, { version: w.record.data.version, status: 'completed', result: 'QA field action complete' });
    w = await read('crm', 'issue', issue.id); assert.notEqual(w.record.status, 'resolved'); assert.ok(w.record.data.field_completed_at);
    await c('crm', 'issue.save', issue.id, { version: w.record.data.version, status: 'resolved', resolution: 'QA customer contacted and resolved', refund_amount_lyd: 0 });
    assert.equal((await read('crm', 'issue', issue.id)).record.status, 'resolved'); assert.equal(ledger(), moneyBefore);
    const rent = await c('owner', 'obligation.create', null, { location_id: location.id, title: 'QA rent follow-up', amount_lyd: 100, due_date: today, frequency: 'monthly', assigned_to: accounts.crm.member });
    const rejected = await accounts.crm.client.rpc('snacky_crm_command_v1', { p_command_id: randomUUID(), p_action: 'obligation.paid', p_id: rent.id, p_payload: { payment_date: today, payment_method: 'cash' } }); assert.ok(rejected.error, 'Rent must not be reported paid without proof');
    assert.equal((await read('crm', 'obligation', rent.id)).record.status, 'open'); assert.equal(ledger(), moneyBefore);
  });
  assert.deepEqual(errors, [], 'Browser JavaScript errors');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 2000); });
  writeFileSync(`${out}/results.json`, JSON.stringify({ results, errors }, null, 2));
}
