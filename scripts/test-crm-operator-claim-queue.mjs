import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const migration=read('supabase/migrations/20261001133000_crm_operator_claim_queue.sql');
const forms=read('src/components/CrmRecordForms.tsx');
const workspace=read('src/components/CrmWorkspace.tsx');
const panel=read('src/components/CrmDispatchPanel.tsx');
const quick=read('src/components/CrmQuickIssueAction.tsx');
const queue=read('src/components/CrmOperatorIssueQueue.tsx');
const api=read('src/app/api/crm/field-broadcast/route.ts');
const lib=read('src/lib/crm-dispatch.ts');

test('machine field work is broadcast unassigned and first operator claims it',()=>{
 assert.match(migration,/dispatch_state.*available/s);
 assert.match(migration,/snacky_issue_field_broadcast_v1/);
 assert.match(migration,/values\\(title,v_issue_id,'field_action',null/);
 assert.match(migration,/v_action='claim'/);
 assert.match(migration,/assigned_to=v_actor_member,dispatch_state='accepted'/);
 assert.match(migration,/This visit was already claimed/);
 assert.ok(lib.includes("'claim'"));
 assert.ok(lib.includes("'available'"));
 assert.match(panel,/Claim visit/);
});

test('all active operators receive the available visit and queue access disappears after claim',()=>{
 assert.match(migration,/snacky_notice_private\.field_available/);
 assert.match(migration,/role::text='operator'/);
 assert.match(migration,/event_kind='available'/);
 assert.match(migration,/dispatch_state'='available'/);
 assert.match(migration,/snacky_operator_field_queue_v1/);
 assert.match(migration,/event_kind='ack_overdue'/);
 assert.match(migration,/snacky_crm_collaboration_workspace_v1/);
 assert.match(queue,/Machine issues available to claim/);
});

test('CRM does not assign operators from CRM forms',()=>{
 assert.match(forms,/\['owner','admin','supervisor','crm'\]\.includes\(String\(p\.role\)\)/);
 assert.doesNotMatch(forms,/Operator field action/);
 assert.match(workspace,/Send machine visit to operators/);
 assert.doesNotMatch(workspace,/Assign operator action \/ customer follow-up/);
});

test('quick issue is a compact inline intake instead of a duplicate link',()=>{
 assert.match(quick,/CrmForm action="issue\.save"/);
 assert.match(quick,/Only the essentials/);
 assert.doesNotMatch(quick,/href="\/issues\/new" className="inline-flex/);
 assert.doesNotMatch(workspace,/Quick customer issue/);
 assert.match(workspace,/New customer issue/);
});

test('field broadcast API is bounded, same-origin and CRM-only',()=>{
 assert.match(api,/crmSameOrigin/);
 assert.match(api,/readCompanyBody\(request,50000\)/);
 assert.match(api,/hasAnyRole\(profile,\['owner','admin','supervisor','crm'\]\)/);
 assert.match(api,/snacky_issue_field_broadcast_v1/);
});
