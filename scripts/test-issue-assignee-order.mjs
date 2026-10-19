import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read = path => fs.readFileSync(path, 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(read('src/lib/crm-issue-assignee.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const assignee = exports.crmIssueAssignee;
const machine = { data: { issue_type: 'machine_unavailable', contact_channel: 'other' } };
const assigned = { issue_id: 'issue', field_task_id: 'task', operator_id: 'operator', operator_name: 'Yamen Furrara', dispatch_state: 'fixed' };

test('completed repair shows its operator, not the owner who recorded it', () => {
  const result = assignee(machine, assigned, false, 'Anas');
  assert.equal(result.name, 'Yamen Furrara');
  assert.equal(result.label, 'Assigned operator');
});
test('active repair still shows the authoritative task assignee', () => {
  assert.equal(assignee(machine, { ...assigned, dispatch_state: 'working' }, false, 'Anas').name, 'Yamen Furrara');
});
test('available work does not invent an operator from the reporter', () => {
  const result = assignee(machine, { ...assigned, operator_id: null, operator_name: null, dispatch_state: 'available' }, false, 'Anas');
  assert.match(result.name, /Unassigned/);
  assert.notEqual(result.name, 'Anas');
});
test('machine-only report without a task is waiting for an operator', () => {
  assert.match(assignee(machine, { ...assigned, field_task_id: null, operator_id: null, operator_name: null }, false, 'Anas').name, /waiting for operator/);
});
test('customer complaint without a repair retains its CRM owner', () => {
  const result = assignee({ data: { issue_type: 'money_no_product', customer_phone: 'test' } }, { ...assigned, field_task_id: null }, false, 'Hiba');
  assert.equal(result.label, 'CRM owner');
  assert.equal(result.name, 'Hiba');
});
test('Arabic operator responsibility is explicit', () => {
  const result = assignee(machine, assigned, true, 'Anas');
  assert.equal(result.label, 'المشغّل المسؤول');
  assert.equal(result.name, 'Yamen Furrara');
});
test('failed assignment read does not falsely show the reporter as assignee', () => {
  const result = assignee(machine, undefined, false, 'Anas');
  assert.match(result.name, /unavailable/);
  assert.notEqual(result.name, 'Anas');
});
test('display helper does not mutate permissions or original history', () => {
  const original = JSON.stringify({ machine, assigned });
  assignee(machine, assigned, false, 'Anas');
  assert.equal(JSON.stringify({ machine, assigned }), original);
});
test('issue list and detail use the same actual-operator label', () => {
  const page = read('src/components/CrmWorkspace.tsx');
  assert.match(page, /snacky_issue_assignment_summary_v1/);
  assert.match(page, /row\.issue_assignee\?\.name/);
  assert.match(page, /issueAssignee\?\.name/);
  assert.match(page, /Newest first/);
  assert.match(page, /name\(d\.created_by_member_id\?\?d\.created_by\?\?d\.reported_by\)/);
  assert.match(read('src/components/CrmRecordForms.tsx'), /CRM owner \(not repair operator\)/);
});
test('database summary is authorized and chooses latest non-archived field work', () => {
  const sql = read('supabase/migrations/20261019163000_issue_assignee_and_newest_order.sql');
  assert.match(sql, /snacky_crm_allowed\('issue',i.id,false\)/);
  assert.match(sql, /t\.archived_at is null/);
  assert.match(sql, /order by t.created_at desc,t.id desc/);
  assert.match(sql, /revoke all .* from public,anon/);
  assert.doesNotMatch(sql, /update public\.(issues|crm_tasks|route_manual_sales)|insert into public\.inventory_movements/i);
});
test('newest issue selection happens before pagination, not just within a page', () => {
  const sql = read('supabase/migrations/20261019163000_issue_assignee_and_newest_order.sql');
  assert.match(sql, /issue-newest-first-v1/);
  assert.match(sql, /then created_at end desc nulls last/);
  assert.match(sql, /then x.created_at end desc nulls last/);
  assert.match(sql, /then id end desc/);
  assert.match(sql, /limit 40 offset skip/);
  assert.match(sql, /p_section<>''issue'' then overdue/);
});
