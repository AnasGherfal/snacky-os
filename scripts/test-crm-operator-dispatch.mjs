import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const migration=read('supabase/migrations/20260923174536_crm_operator_dispatch_v1.sql');
const lib=read('src/lib/crm-dispatch.ts');
const api=read('src/app/api/crm/dispatch/route.ts');
const panel=read('src/components/CrmDispatchPanel.tsx');
const workspace=read('src/components/CrmWorkspace.tsx');
const forms=read('src/components/CrmRecordForms.tsx');
const crm=read('src/lib/crm-workspace.ts');
const notices=read('supabase/migrations/20260919220000_assignment_notifications.sql');
const reliability=read('supabase/migrations/20261002104000_operations_reliability_v1.sql');
const crmOwnedAssignment=read('supabase/migrations/20261002214500_crm_owned_operator_issue_assignment.sql');
const fieldQueueForm=read('src/components/CrmIssueFieldQueue.tsx');
const fieldQueueApi=read('src/app/api/crm/field-queue/route.ts');
const crmCommandApi=read('src/app/api/crm/command/route.ts');
const operatorIssues=read('src/app/operator/issues/page.tsx');
const routeStopApi=read('src/app/api/operator/routes/[id]/stops/[stopId]/route.ts');
const routeStopPage=read('src/app/operator/routes/[id]/stops/[stopId]/page.tsx');
const machineHistory=read('src/app/machines/[id]/page.tsx');
const machineDashboard=read('src/app/machines-dashboard/page.tsx');

test('dispatch extends existing CRM tasks instead of creating a second task system',()=>{
 assert.match(migration,/alter table public\.crm_tasks/i);
 assert.doesNotMatch(migration,/create table[^;]+field_tasks/i);
 assert.match(migration,/task_type<>'field_action'/i);
 assert.match(workspace,/CrmDispatchTaskPanel/);
 assert.match(workspace,/CrmIssueDispatchSummary/);
});

test('new field actions start assigned with acknowledgement deadlines while legacy tasks stay legacy',()=>{
 for(const state of ['assigned','accepted','en_route','working','blocked','fixed'])assert.ok(migration.includes("'"+state+"'"));
 assert.match(migration,/if old\.dispatch_state is null/i);
 assert.match(migration,/Legacy field actions cannot be silently converted/i);
 for(const minutes of ['10 minutes','20 minutes','30 minutes','60 minutes'])assert.ok(migration.includes(minutes));
});

test('only the assigned employee reports ordered physical progress',()=>{
 assert.match(migration,/v_task\.assigned_to is distinct from v_actor_member/i);
 assert.ok(migration.includes("v_action='accept'"));
 assert.ok(migration.includes("v_task.dispatch_state<>'assigned'"));
 assert.ok(migration.includes("v_action='en_route'"));
 assert.ok(migration.includes("v_task.dispatch_state<>'accepted'"));
 assert.ok(migration.includes("v_action='start'"));
 assert.ok(migration.includes("v_action='block'"));
 assert.ok(migration.includes("dispatch_state<>'working'"));
});

test('fixed requires report plus image proof and completes field task only',()=>{
 assert.ok(migration.includes("Upload at least one field photo before marking the task fixed"));
 assert.match(migration,/from public\.crm_documents d/i);
 assert.ok(migration.includes("set dispatch_state='fixed'"));
 assert.ok(migration.includes("status='completed'"));
 assert.ok(migration.includes("result=v_note"));
 assert.doesNotMatch(migration,/update public\.issues set status='resolved'/i);
 assert.match(panel,/Finishing field work does not close the customer issue/i);
});

test('generic field-task updates cannot bypass managed dispatch state',()=>{
 assert.match(migration,/Use the operator dispatch controls for this field action/i);
 assert.ok(migration.includes("current_setting('snacky.crm_dispatch_task_id'"));
 assert.ok(migration.includes("set_config('snacky.crm_dispatch_task_id','',true)"));
 assert.match(migration,/new\.status is distinct from old\.status/i);
 assert.ok(workspace.includes("d.task_type==='field_action'&&d.dispatch_state&&!context.staff"));
});

test('reassignment resets physical handoff state',()=>{
 assert.match(migration,/new\.assigned_to is distinct from old\.assigned_to/i);
 for(const fragment of ["new.dispatch_state:='assigned'","new.acknowledged_at:=null","new.work_started_at:=null","new.fixed_at:=null"])assert.ok(migration.includes(fragment));
 assert.doesNotMatch(migration,/delete from public\.crm_activities/i);
});

test('command retries are actor and payload bound and stale task versions fail',()=>{
 assert.match(migration,/crm_dispatch_private\.requests/i);
 assert.match(migration,/pg_advisory_xact_lock/i);
 assert.match(migration,/v_saved\.actor_user_id is distinct from v_actor_user/i);
 assert.match(migration,/v_saved\.request is distinct from p_command/i);
 assert.match(migration,/v_version is distinct from v_task\.updated_at::text/i);
 assert.match(panel,/sessionStorage/);
 assert.match(panel,/Retry saved action/i);
});

test('private request data is RLS protected and public wrapper is security invoker',()=>{
 assert.match(migration,/alter table crm_dispatch_private\.requests enable row level security/i);
 assert.match(migration,/revoke all on crm_dispatch_private\.requests from public,anon,authenticated/i);
 assert.match(migration,/create or replace function public\.snacky_issue_dispatch_command_v1/i);
 assert.match(migration,/security invoker/i);
});

test('CRM API guard preserves current company and buying surfaces while adding dispatch only',()=>{
 for(const entry of ['snacky_buying_sources_v1','snacky_buying_workspace_v1','snacky_company_workspace_v1','snacky_crm_lead_desk_v1','snacky_crm_lead_focus_command_v1','snacky_issue_dispatch_command_v1'])assert.ok(migration.includes(entry));
});

test('existing notification system remains assignment and completion transport',()=>{
 assert.match(notices,/assignment_changed/i);
 assert.match(notices,/field_completed/i);
 assert.doesNotMatch(migration,/create table[^;]+notifications/i);
 assert.doesNotMatch(migration,/web-push|push_subscriptions/i);
});

test('operator phone UI exposes assigned dispatch steps and visit outcomes with photo proof',()=>{
 for(const label of ['Accept task','On my way','Start / resume work','Mark blocked','Fixed','Needs technician','Needs spare part','Machine offline'])assert.ok(panel.includes(label));
 assert.doesNotMatch(panel,/OperatorIssueReleaseButton/);
 assert.ok(panel.includes('proofImages<1'));
 assert.ok(panel.includes('crm-documents'));
 assert.match(panel,/Finishing field work does not close the customer issue/i);
 assert.match(panel,/customer issue stays open/i);
});

test('CRM sees acknowledgement overdue and keeps final closure separate',()=>{
 assert.match(panel,/crmDispatchAckOverdue/);
 assert.match(panel,/overdue/);
 assert.ok(workspace.includes('Verify customer outcome & close'));
 assert.ok(workspace.includes("status:'resolved'"));
 assert.match(workspace,/fieldWorkReadyForCrm/);
});

test('field assignments inherit urgency and categories cover machine dispatch cases',()=>{
 assert.ok(workspace.includes("priority={d.priority??'normal'}"));
 assert.ok(forms.includes("priority==='critical'?'urgent':priority"));
 for(const category of ['payment_reader','machine_dirty','cooling_issue','power_off','screen_keypad','visit_required'])assert.ok(crm.includes(category));
});

test('API is same-origin, bounded, authenticated and receipt checked',()=>{
 assert.match(api,/crmDispatchSameOrigin/);
 assert.match(api,/readCompanyBody\(request,50000\)/);
 assert.ok(api.includes("hasAnyRole(profile,['owner','admin','supervisor','crm','operator'])"));
 assert.match(api,/snacky_issue_dispatch_command_v1/);
 assert.match(api,/crmDispatchReceiptMatches/);
 assert.match(lib,/crmDispatchReceiptMatches/);
});


test('CRM assigns field work to one named active operator',()=>{
 assert.match(crmOwnedAssignment,/p_payload->>'operator_id'/);
 assert.match(crmOwnedAssignment,/t\.role::text='operator'/);
 assert.match(crmOwnedAssignment,/t\.roles::text\[\]&&array\['operator'\]/);
 assert.match(crmOwnedAssignment,/insert into public\.crm_tasks/);
 assert.match(crmOwnedAssignment,/'field_action',v_operator_id/);
 assert.match(crmOwnedAssignment,/Operator field visit assigned by Customer Relations/);
 assert.match(fieldQueueForm,/Assign field action/);
 assert.match(fieldQueueForm,/operator_id:operatorId/);
 assert.match(workspace,/operators=\{\(context\.directory/);
});

test('quick CRM machine report records the issue without broadcasting operator work',()=>{
 assert.match(crmOwnedAssignment,/create or replace function public\.snacky_report_machine_issue_v1/i);
 assert.match(crmOwnedAssignment,/'operator_notified',false/);
 assert.match(crmOwnedAssignment,/'needs_field_assignment',not v_has_field_work/);
 const quickReportSection=crmOwnedAssignment.slice(crmOwnedAssignment.indexOf('create or replace function public.snacky_report_machine_issue_v1'));
 assert.doesNotMatch(quickReportSection,/snacky_issue_field_queue_command_v1\('create'/);
 assert.match(forms,/Record machine issue/);
 assert.doesNotMatch(forms,/Report & notify operators/);
 assert.match(crmCommandApi,/Machine issue recorded\. Assign an operator from the issue if a field visit is needed\./);
 assert.doesNotMatch(crmCommandApi,/Machine issue sent to operators\./);
});

test('operators cannot claim or release customer issue work from the shared queue',()=>{
 assert.doesNotMatch(operatorIssues,/Operator workload/);
 assert.doesNotMatch(operatorIssues,/Available machine issues/);
 assert.doesNotMatch(operatorIssues,/Claim issue/);
 assert.doesNotMatch(operatorIssues,/Release back to queue/);
 assert.match(operatorIssues,/My assigned field work/);
 assert.ok(fieldQueueApi.includes("hasAnyRole(profile,['owner','admin','supervisor','crm'])"));
 assert.match(fieldQueueApi,/Only CRM field assignment is supported/);
 assert.match(crmOwnedAssignment,/p_action<>'create'/);
});

test('operator visit can finish as repair technician part or offline without closing customer complaint',()=>{
 for(const state of ['needs_technician','needs_part','machine_offline'])assert.ok(reliability.includes("'"+state+"'"));
 assert.match(reliability,/Upload at least one field photo before completing the field task/);
 assert.match(reliability,/Arrange technician visit/);
 assert.match(reliability,/Arrange spare part and follow-up visit/);
 assert.match(reliability,/Machine offline — arrange maintenance before reopening/);
 assert.match(reliability,/waiting_on='management'/);
 assert.match(reliability,/insert into public\.crm_tasks/);
 assert.match(reliability,/'admin'/);
 assert.match(reliability,/Operator diagnosis:/);
 assert.match(reliability,/next_step,\(a->>'issue_id'\)::uuid,'admin',issue_owner/);
 assert.doesNotMatch(reliability,/update public\.issues\s+set status='resolved'/i);
});

test('machine offline changes machine to maintenance and a later repair can reactivate it',()=>{
 assert.match(reliability,/v_action='machine_offline'/);
 assert.match(reliability,/set status='maintenance'/);
 assert.match(reliability,/v_action='fix'/);
 assert.match(reliability,/set status='active'/);
});

test('issue operational state comes from the assigned field dispatch instead of manual CRM status controls',()=>{
 assert.match(workspace,/crmIssueOperationalStatus/);
 assert.match(workspace,/operational_status/);
 assert.match(workspace,/latestDispatch/);
 assert.match(crmOwnedAssignment,/status='assigned'/);
 assert.match(crmOwnedAssignment,/waiting_on='operator'/);
 assert.match(crmOwnedAssignment,/Operator field visit assigned by Customer Relations/);
});

test('route stop surfaces only sanitized open issues for the machine being serviced',()=>{
 assert.match(routeStopApi,/from\("issues"\)/);
 assert.match(routeStopApi,/select\("id, issue_type, priority, status, description, created_at"\)/);
 assert.match(routeStopApi,/eq\("machine_id", stop\.machine_id\)/);
 assert.match(routeStopApi,/machineIssues/);
 assert.doesNotMatch(routeStopApi,/customer_phone/);
 assert.doesNotMatch(routeStopApi,/customer_whatsapp/);
 assert.match(routeStopPage,/Issues reported for this machine/);
 assert.match(routeStopPage,/Customer Relations still owns the complaint/);
});

test('machine page preserves service history and management dashboard surfaces maintenance attention',()=>{
 assert.match(machineHistory,/Machine service history/);
 assert.match(machineHistory,/Waiting technician \/ part/);
 assert.match(machineHistory,/latestFieldByIssue/);
 assert.match(machineDashboard,/Maintenance attention/);
 assert.match(machineDashboard,/snacky_machine_maintenance_attention_v1/);
 for(const label of ['Machines down','Waiting technician / part','Repeat failures · 30d','Open >24h','Repaired · 7d'])assert.ok(machineDashboard.includes(label));
 assert.match(reliability,/repeat_failures/);
 assert.match(reliability,/open_over_24h/);
});
