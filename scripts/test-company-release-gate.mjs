import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as domain from '../src/lib/company-hub.ts';
import * as authz from '../src/lib/authz.ts';

const id = '11111111-1111-4111-8111-111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const jsx = (type, props) => ({type, props});
function load(file, imports, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  vm.runInNewContext(code, {exports, console, URLSearchParams, ...globals, require(name) {
    assert.ok(name in imports, `Unexpected import ${name}`);
    return imports[name];
  }});
  return exports;
}
function* nodes(node) {
  if (Array.isArray(node)) { for (const child of node) yield* nodes(child); return; }
  if (!node || typeof node !== 'object') return;
  yield node; yield* nodes(node.props?.children);
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return text(node.props?.children);
}
async function page({role = 'owner', params = {}, detail = true, published = 1, latest = published, ar = false} = {}) {
  const template = {...domain.emptyCompanyContent(), title_en: 'PUBLISHED OLD TITLE', body_en: 'PUBLISHED OLD BODY', owner_id: member};
  const draft = {...template, title_en: 'SAVED DRAFT TITLE', body_en: 'SAVED DRAFT BODY', owner_id: id};
  const profile = {id, team_member_id: member, role, roles: [role], active_status: 'active', full_name: 'Fixture staff'};
  const action = () => null;
  const data = {manager: role === 'owner', rows: [], total: 0, offset: 0, attention_count: 1, required_count: 1,
    record: detail ? {id, revision: 4, current_version: published, archived: false, owner_name: 'Published owner', data: template, read_at: null, ack_at: null} : null,
    draft: role === 'owner' ? draft : null,
    directory: [{id, name: 'Draft owner'}, {id: member, name: 'Published owner'}],
    history: latest ? [{version: latest, title_en: 'Current', published_at: '2026-09-16'}] : [], acknowledgements: [],
  };
  const {CompanyHub} = load('src/components/CompanyHub.tsx', {
    'react/jsx-runtime': {jsx, jsxs: jsx, Fragment: 'fragment'},
    'next/link': {default: 'a'}, 'node:crypto': {randomUUID: () => id},
    'next/navigation': {redirect(to) {throw Error(`REDIRECT:${to}`);}, notFound() {throw Error('NOT_FOUND');}},
    '@/lib/auth': {getCurrentProfile: async () => profile, getAuthenticatedSupabaseServerClient: async () => ({rpc: async () => ({data})})},
    '@/lib/authz': authz, '@/lib/i18n/server': {getServerI18n: async () => ({locale: ar ? 'ar' : 'en'})},
    '@/components/ui': {PageHeader: 'header-component', ErrorState: 'error-component'},
    '@/components/CompanyEditor': {CompanyAction: action, CompanyEditor: 'editor', CompanyPrint: 'print'},
    '@/lib/company-hub': {...domain, companyHubEnabled: true},
    '@/lib/company-templates': {companyTemplates: [], companyTemplate: () => undefined},
  });
  return {tree: await CompanyHub({parts: detail ? ['items', id] : [], searchParams: params}), action};
}

test('published detail cannot publish a different, unseen saved draft', async () => {
  const {tree, action} = await page();
  assert.equal([...nodes(tree)].filter(n => n.type === action && n.props.action === 'publish').length, 0);
  assert.ok([...nodes(tree)].some(n => n.props?.href === `/company/items/${id}?draft=1`));
});
test('publication review displays the exact saved draft, its owner and revision', async () => {
  const {tree, action} = await page({params: {draft: '1'}});
  const article = [...nodes(tree)].find(n => n.type === 'article');
  assert.match(text(article), /SAVED DRAFT BODY/);
  assert.doesNotMatch(text(article), /PUBLISHED OLD BODY/);
  assert.match(text(article), /Draft owner/);
  assert.match(text(article), /Draft revision.*4/);
  const publish = [...nodes(tree)].find(n => n.type === action && n.props.action === 'publish');
  assert.equal(publish.props.revision, 4);
  assert.equal([...nodes(tree)].filter(n => n.type === action && ['read', 'ack'].includes(n.props.action)).length, 0);
});
test('ordinary staff cannot access the draft preview URL', async () => {
  await assert.rejects(() => page({role: 'crm', params: {draft: '1'}}), /REDIRECT:\/unauthorized/);
});
test('historical version is conspicuous and links to the current published record', async () => {
  const {tree} = await page({role: 'crm', published: 1, latest: 2, params: {version: '1'}});
  assert.match(text(tree), /Older version/);
  assert.ok([...nodes(tree)].some(n => n.props?.href === `/company/items/${id}` && text(n).includes('current')));
});
test('relations home offers one primary daily-work link, not duplicate buttons', async () => {
  const {tree} = await page({role: 'crm', detail: false});
  assert.equal([...nodes(tree)].filter(n => n.props?.href === '/my-work').length, 1);
});
test('Arabic draft preview remains RTL and never labels an unpublished draft as a policy acknowledgement', async () => {
  const {tree, action} = await page({params: {draft: '1'}, ar: true});
  assert.equal(tree.props.dir, 'rtl');
  assert.match(text(tree), /مراجعة المسودة/);
  assert.equal([...nodes(tree)].filter(n => n.type === action && n.props.action === 'ack').length, 0);
});
