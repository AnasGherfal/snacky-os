import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const migration=read('supabase/migrations/20260924154410_urgent_dispatch_escalation_v1.sql');
const route=read('src/app/api/notifications/dispatch/route.ts');
const crm=read('src/components/CrmWorkspace.tsx');
const panel=read('src/components/CrmDispatchPanel.tsx');

test('escalation starts disabled and reuses existing notice worker/outbox',()=>{
 assert.match(migration,/dispatch_escalation_settings/);
 assert.match(migration,/enabled boolean not null default false/);
 assert.match(migration,/snacky_notice_private\.deliveries/);
 assert.match(migration,/snacky_notice_private\.wake\(\)/);
 assert.doesNotMatch(migration,/create table[^;]+push_queue/i);
 assert.doesNotMatch(migration,/cron\.schedule|net\.http_post/i);
});

test('only urgent unaccepted field actions past ack deadline qualify',()=>{
 assert.match(migration,/task_type='field_action'/);
 assert.match(migration,/priority in \('urgent','critical'\)/);
 assert.match(migration,/dispatch_state='assigned'/);
 assert.match(migration,/ack_due_at<=p_now/);
 assert.match(migration,/status='open'/);
 assert.match(migration,/is_practice,false\)=false/);
 assert.match(migration,/archived_at is null/);
});

test('one receipt exists per assignment generation and recipient',()=>{
 assert.match(migration,/primary key\(task_id,assignee_member_id,ack_due_at,stage,recipient_member_id\)/);
 assert.match(migration,/on conflict do nothing/);
 assert.match(migration,/dispatch_ack_overdue:/);
});

test('queued reminders recheck acknowledgement reassignment and issue closure at delivery time',()=>{
 assert.match(migration,/event_kind='ack_overdue'/);
 assert.match(migration,/t\.dispatch_state='assigned'/);
 assert.match(migration,/i\.assigned_to=n\.recipient_member_id/);
 assert.match(migration,/i\.status::text not in \('resolved','closed','cancelled','canceled'\)/);
 assert.match(migration,/t\.ack_due_at<=clock_timestamp\(\)/);
});

test('push content contains work label only and no customer or financial fields',()=>{
 assert.match(migration,/Urgent field task not accepted/);
 assert.match(migration,/مهمة ميدانية عاجلة لم يتم قبولها/);
 for(const forbidden of ['customer_phone','customer_whatsapp','amount_involved_lyd','financial_transactions','purchase_orders','inventory_movements'])assert.ok(!migration.includes(forbidden));
});

test('processor is service-role only and private tables have no staff grants',()=>{
 assert.match(migration,/revoke all on snacky_notice_private\.dispatch_escalation_settings/);
 assert.match(migration,/revoke all on function public\.snacky_process_dispatch_escalations_v1\(timestamptz\)[\s\S]*from public,anon,authenticated/);
 assert.match(migration,/grant execute on function public\.snacky_process_dispatch_escalations_v1\(timestamptz\)[\s\S]*to service_role/);
 assert.match(migration,/security invoker/);
});

test('worker scans deadlines before ordinary delivery without letting scan failure block the queue',()=>{
 assert.match(route,/snacky_process_dispatch_escalations_v1/);
 assert.match(route,/dispatchWorkNotifications/);
 assert.match(route,/escalation\.error/);
 assert.match(route,/unavailable: true/);
});

test('CRM readiness exposes counts only and never push endpoints or keys',()=>{
 assert.match(crm,/push_subscriptions/);
 assert.match(crm,/select\('user_id'\)/);
 assert.match(crm,/active_notification_devices/);
 for(const secret of ['endpoint','p256dh','auth'])assert.ok(!crm.includes(`select('${secret}`));
});

test('CRM presents English and Arabic fallback when no device is registered',()=>{
 assert.match(panel,/No active notification device — contact the operator directly/);
 assert.match(panel,/لا يوجد جهاز مسجل للإشعارات لدى المشغّل/);
 assert.match(panel,/Provider acceptance does not mean the operator saw it/);
 assert.match(panel,/قبول خدمة الإشعار لا يعني أن المشغّل شاهد الرسالة/);
 assert.match(panel,/Urgent acceptance is overdue — contact or reassign the operator now/);
});
