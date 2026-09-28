import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const component = readFileSync(new URL('../src/components/CrmSharedWorkShortcuts.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/app/my-work/page.tsx', import.meta.url), 'utf8');

test('shared shortcuts are active CRM/management only, not operator access', () => {
  assert.match(component, /getCurrentProfile\(\)/);
  assert.match(component, /profile\.active_status !== 'active'/);
  assert.match(component, /hasAnyRole\(profile, \['owner', 'admin', 'supervisor', 'crm'\]\)/);
  assert.match(component, /return null/);
  assert.doesNotMatch(component, /getSupabaseAdminClient|service_role|\.from\(|\.rpc\(/);
});

test('navigation uses existing supported scope, time and meeting filters', () => {
  for (const href of [
    '/my-work?scope=mine&window=attention',
    '/my-work?scope=all&window=attention',
    '/follow-ups?scope=all&type=meeting&window=week',
    '/my-work?scope=all&window=overdue',
  ]) assert.ok(component.includes(href), href);
});

test('guide preserves individual ownership, permission boundary and Arabic support', () => {
  assert.ok(component.includes('Keep one relationship owner.'));
  assert.ok(component.includes('only records your account may access'));
  assert.ok(component.includes("dir={ar ? 'rtl' : 'ltr'}"));
  assert.ok(component.includes('aria-labelledby="crm-shared-work-title"'));
  assert.doesNotMatch(component, /2500|2,500|Hiba|@snacky\.ly/);
});

test('entry is on My Work while quick issue remains first and existing sections survive', () => {
  assert.ok(page.includes('<CrmSharedWorkShortcuts/>'));
  assert.ok(page.indexOf('<CrmQuickIssueAction/>') < page.indexOf('<CrmSharedWorkShortcuts/>'));
  for (const name of ['CrmNotesSummary', 'CrmLeadFocusOverview', 'CrmWorkspace', 'CrmRelationshipOverview']) {
    assert.ok(page.includes(`<${name}`), name);
  }
});
