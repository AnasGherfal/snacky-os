import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const entry = read('src/app/issues/new/page.tsx');
const workspace = read('src/components/CrmWorkspace.tsx');
const reportApi = read('src/app/api/crm/command/route.ts');
const assignApi = read('src/app/api/crm/field-queue/route.ts');
const claimApi = read('src/app/api/operator/issues/claim/route.ts');
const claimScreen = read('src/app/operator/issues/page.tsx');
const faultForm = read('src/components/CrmForm.tsx');
const assignmentForm = read('src/components/CrmIssueFieldQueue.tsx');

test('fault button opens a real, role-checked, machine-selectable submit form', () => {
  assert.match(entry, /params\.dispatch !== 'operator'/);
  assert.match(entry, /hasAnyRole\(profile, \['owner', 'admin', 'supervisor', 'crm'\]\)/);
  assert.match(entry, /CrmForm action="machine\.report"/);
  assert.match(entry, /getSupabaseAdminClient\(\)/);
  assert.match(entry, /select\('id,name,machine_code,status'\)/);
  assert.match(entry, /name: 'machine_id'/);
  assert.match(entry, /name: 'description'/);
  assert.match(entry, /name: 'priority'/);
  assert.match(faultForm, /fetch\('\/api\/crm\/command'/);
  assert.match(reportApi, /snacky_report_machine_issue_v1/);
});

test('unclaimed shared machine issues can be directly assigned by CRM', () => {
  assert.match(workspace, /hasUnclaimedFieldWork/);
  assert.match(workspace, /task\.dispatch_state==='available'&&task\.assigned_to==null/);
  assert.match(workspace, /!hasActiveFieldWork\|\|hasUnclaimedFieldWork/);
  assert.match(workspace, /canAssignFieldWork&&!fieldWorkReadyForCrm\?<CrmIssueFieldQueueForm/);
  assert.match(assignmentForm, /operator_id:operatorId/);
  assert.match(assignApi, /snacky_issue_field_queue_command_v1/);
});

test('operators still have an independent claim route, never a duplicate CRM task', () => {
  assert.match(claimScreen, /snacky_available_machine_issues_v1/);
  assert.match(claimScreen, /MachineIssueClaimButton/);
  assert.match(claimApi, /snacky_claim_machine_issue_v1/);
  assert.match(claimApi, /data\.assigned_to !== profile\.team_member_id/);
});
