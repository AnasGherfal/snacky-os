import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=p=>fs.readFileSync(p,'utf8');
const form=read('src/components/CrmForm.tsx');
const workspace=read('src/components/CrmWorkspace.tsx');
const duplicateApi=read('src/app/api/crm/issue-duplicates/route.ts');
const worker=read('src/app/api/notifications/dispatch/route.ts');
const escalation=read('supabase/migrations/20261002083000_issue_field_escalation_v2.sql');
const machineFields=read('src/components/MachineSiteDistanceFields.tsx');
const machineNew=read('src/app/machines/new/page.tsx');
const machineEdit=read('src/app/machines/[id]/edit/page.tsx');

test('quick issue intake checks likely duplicates and requires an explicit separate-incident acknowledgement',()=>{
 assert.match(form,/issueIntake = action === 'issue\.save' && !recordId/);
 assert.match(form,/\/api\/crm\/issue-duplicates/);
 assert.match(form,/Possible existing issue/);
 assert.match(form,/This is separate — create another issue/);
 assert.match(form,/duplicateBlocked/);
 assert.match(duplicateApi,/not\('status','in','\(resolved,closed\)'\)/);
 assert.match(duplicateApi,/gte\('created_at',since24\)/);
});

test('repeat machine problems are counted across 30 days and surfaced in intake and issue detail',()=>{
 assert.match(duplicateApi,/repeat_count_30d/);
 assert.match(duplicateApi,/30\*24\*60\*60\*1000/);
 assert.match(form,/Repeated issue/);
 assert.match(workspace,/repeatIssueCount>=3/);
 assert.match(workspace,/technician repair/);
});

test('field escalation reuses the existing worker and persists one receipt per stage generation',()=>{
 for(const stage of ['unclaimed_overdue','operator_idle','field_blocked','field_blocked_management'])assert.ok(escalation.includes(stage));
 assert.match(escalation,/primary key\(task_id,stage,generation_key,recipient_member_id\)/);
 assert.match(escalation,/snacky_notice_private\.deliveries/);
 assert.match(escalation,/snacky_notice_private\.wake\(\)/);
 assert.match(worker,/snacky_process_issue_field_escalations_v1/);
 assert.doesNotMatch(escalation,/cron\.schedule|net\.http_post/i);
});

test('unclaimed and idle thresholds are priority-aware and blocked high-priority work reaches management',()=>{
 for(const value of ['10 minutes','15 minutes','20 minutes','30 minutes','45 minutes','60 minutes','90 minutes'])assert.ok(escalation.includes(value));
 assert.match(escalation,/dispatch_state='available'/);
 assert.match(escalation,/dispatch_state='accepted'/);
 assert.match(escalation,/dispatch_state='en_route'/);
 assert.match(escalation,/dispatch_state='blocked'/);
 assert.match(escalation,/priority in \('high','urgent','critical'\)/);
});

test('machine forms edit one-way site distance instead of creating conflicting machine distance copies',()=>{
 assert.match(machineFields,/One-way distance from storage \(km\)/);
 assert.match(machineFields,/Saved on the site so every machine at the same location uses one consistent distance/);
 assert.match(machineNew,/from\("locations"\)\.update\(\{ distance_from_storage_km/);
 assert.match(machineEdit,/from\("locations"\)\.update\(\{ distance_from_storage_km/);
 assert.match(machineNew,/MachineSiteDistanceFields/);
 assert.match(machineEdit,/MachineSiteDistanceFields/);
});
