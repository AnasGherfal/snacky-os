\set ON_ERROR_STOP on
begin;

-- Synthetic isolated fixtures only.
insert into auth.users values
 ('cccccccc-0000-4000-8000-000000000001'),
 ('cccccccc-0000-4000-8000-000000000002'),
 ('cccccccc-0000-4000-8000-000000000003'),
 ('cccccccc-0000-4000-8000-000000000004'),
 ('cccccccc-0000-4000-8000-000000000005');

insert into public.team_members(id,auth_user_id,role,roles)
values
 ('dddddddd-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','owner',array['owner']),
 ('dddddddd-0000-4000-8000-000000000002','cccccccc-0000-4000-8000-000000000002','crm',array['crm']),
 ('dddddddd-0000-4000-8000-000000000003','cccccccc-0000-4000-8000-000000000003','operator',array['operator']),
 ('dddddddd-0000-4000-8000-000000000004','cccccccc-0000-4000-8000-000000000004','operator',array['operator']),
 ('dddddddd-0000-4000-8000-000000000005','cccccccc-0000-4000-8000-000000000005','crm',array['crm']);

insert into public.profiles(id,active_status,role,roles,team_member_id)
select auth_user_id,'active',role,roles,id from public.team_members;

insert into public.push_subscriptions(user_id,endpoint,p256dh,auth)
values('cccccccc-0000-4000-8000-000000000002','https://fcm.googleapis.com/fake/crm','fake','fake');

update snacky_notice_private.settings set enabled=true where singleton;
update snacky_notice_private.dispatch_escalation_settings set enabled=true where singleton;

do $$
declare
 crm uuid:='dddddddd-0000-4000-8000-000000000002';
 crm_no_device uuid:='dddddddd-0000-4000-8000-000000000005';
 op1 uuid:='dddddddd-0000-4000-8000-000000000003';
 op2 uuid:='dddddddd-0000-4000-8000-000000000004';
 issue1 uuid:=gen_random_uuid();task1 uuid:=gen_random_uuid();
 issue2 uuid:=gen_random_uuid();task2 uuid:=gen_random_uuid();
 issue3 uuid:=gen_random_uuid();task3 uuid:=gen_random_uuid();
 issue4 uuid:=gen_random_uuid();task4 uuid:=gen_random_uuid();
 issue5 uuid:=gen_random_uuid();task5 uuid:=gen_random_uuid();
 issue6 uuid:=gen_random_uuid();task6 uuid:=gen_random_uuid();
 result jsonb;claims jsonb;before_count integer;notif uuid;
begin
 -- Default rollout is explicit; test turns it on above.
 if not (select enabled from snacky_notice_private.dispatch_escalation_settings where singleton) then raise exception 'Fixture did not enable escalation';end if;

 insert into public.issues(id,assigned_to,reported_by,status,priority) values(issue1,crm,crm,'open','urgent');
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at)
 values(task1,'Urgent machine power visit',op1,crm,'open','field_action',issue1,'urgent','assigned',now()-interval '5 minutes');

 result:=public.snacky_process_dispatch_escalations_v1(null);
 if (result->>'generated')::integer<>1 then raise exception 'Overdue urgent task did not escalate: %',result;end if;
 if (select count(*) from public.notifications where source_id=task1 and event_kind='ack_overdue' and recipient_member_id=crm)<>1 then raise exception 'CRM overdue notification missing';end if;
 if (select count(*) from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id=task1 and n.event_kind='ack_overdue')<>1 then raise exception 'Registered CRM device was not queued';end if;
 perform public.snacky_process_dispatch_escalations_v1(null);
 if (select count(*) from public.notifications where source_id=task1 and event_kind='ack_overdue')<>1 then raise exception 'Repeated scan duplicated escalation';end if;

 -- Acceptance after queue but before claim must suppress delivery.
 update public.crm_tasks set dispatch_state='accepted' where id=task1;
 claims:=public.snacky_claim_notification_deliveries_v1(50);
 if exists(select 1 from jsonb_array_elements(claims) x join snacky_notice_private.deliveries d on d.id=(x.value->>'id')::uuid join public.notifications n on n.id=d.notification_id where n.source_id=task1) then raise exception 'Accepted task was still claimed';end if;
 if not exists(select 1 from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id=task1 and d.status='skipped') then raise exception 'Accepted task reminder was not skipped';end if;

 -- Reassignment is a new generation; old queued reminder dies, new deadline can escalate once.
 insert into public.issues(id,assigned_to,reported_by,status,priority) values(issue2,crm,crm,'open','urgent');
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at)
 values(task2,'Urgent screen visit',op1,crm,'open','field_action',issue2,'urgent','assigned',now()-interval '5 minutes');
 perform public.snacky_process_dispatch_escalations_v1(null);
 update public.crm_tasks set assigned_to=op2,ack_due_at=now()+interval '10 minutes' where id=task2;
 perform public.snacky_claim_notification_deliveries_v1(50);
 if not exists(select 1 from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id=task2 and d.status='skipped') then raise exception 'Old-assignee reminder survived reassignment';end if;
 update public.crm_tasks set ack_due_at=now()-interval '1 minute' where id=task2;
 perform public.snacky_process_dispatch_escalations_v1(null);
 if (select count(*) from snacky_notice_private.dispatch_escalation_receipts where task_id=task2)<>2 then raise exception 'New assignment generation did not get a separate receipt';end if;

 -- Closed/practice work is never escalated.
 insert into public.issues(id,assigned_to,reported_by,status,priority) values(issue3,crm,crm,'resolved','urgent');
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at)
 values(task3,'Closed issue task',op1,crm,'open','field_action',issue3,'urgent','assigned',now()-interval '5 minutes');
 insert into public.issues(id,assigned_to,reported_by,status,priority,is_practice) values(issue4,crm,crm,'open','urgent',true);
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at,is_practice)
 values(task4,'Practice urgent task',op1,crm,'open','field_action',issue4,'urgent','assigned',now()-interval '5 minutes',true);
 before_count:=(select count(*) from public.notifications);
 perform public.snacky_process_dispatch_escalations_v1(null);
 if (select count(*) from public.notifications)<>before_count then raise exception 'Closed or practice work generated escalation';end if;

 -- CRM without registered phone still receives in-app notification, with no fake delivery.
 insert into public.issues(id,assigned_to,reported_by,status,priority) values(issue5,crm_no_device,crm_no_device,'open','urgent');
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at)
 values(task5,'Urgent no-device task',op1,crm_no_device,'open','field_action',issue5,'urgent','assigned',now()-interval '5 minutes');
 result:=public.snacky_process_dispatch_escalations_v1(null);
 if (result->>'no_device')::integer<1 then raise exception 'No-device readiness was not reported';end if;
 select id into notif from public.notifications where source_id=task5 and event_kind='ack_overdue';
 if notif is null then raise exception 'No-device CRM lost in-app escalation';end if;
 if exists(select 1 from snacky_notice_private.deliveries where notification_id=notif) then raise exception 'No-device CRM got a fake push delivery';end if;

 -- Inactive CRM owner is not a valid automated escalation recipient.
 update public.profiles set active_status='inactive' where team_member_id=crm_no_device;
 insert into public.issues(id,assigned_to,reported_by,status,priority) values(issue6,crm_no_device,crm,'open','urgent');
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at)
 values(task6,'Inactive CRM task',op1,crm,'open','field_action',issue6,'urgent','assigned',now()-interval '5 minutes');
 result:=public.snacky_process_dispatch_escalations_v1(null);
 if exists(select 1 from public.notifications where source_id=task6 and event_kind='ack_overdue') then raise exception 'Inactive CRM received escalation';end if;
 if (result->>'missing_recipient')::integer<1 then raise exception 'Inactive CRM was not reported as missing recipient';end if;
 update public.profiles set active_status='active' where team_member_id=crm_no_device;

 -- Feature pause is authoritative.
 update snacky_notice_private.dispatch_escalation_settings set enabled=false where singleton;
 before_count:=(select count(*) from public.notifications);
 result:=public.snacky_process_dispatch_escalations_v1(null);
 if coalesce((result->>'disabled')::boolean,false) is not true then raise exception 'Disabled feature did not report disabled';end if;
 if (select count(*) from public.notifications)<>before_count then raise exception 'Disabled feature emitted notifications';end if;

 raise notice 'PASS: urgent deadline, dedupe, accept-before-delivery, reassignment, closure, practice, no-device, inactive-recipient and pause';
end $$;

do $$
begin
 if has_table_privilege('authenticated','snacky_notice_private.dispatch_escalation_receipts','SELECT') then raise exception 'Escalation receipts exposed to authenticated';end if;
 if has_function_privilege('authenticated','public.snacky_process_dispatch_escalations_v1(timestamptz)','EXECUTE') then raise exception 'Client can invoke escalation processor';end if;
 if not has_function_privilege('service_role','public.snacky_process_dispatch_escalations_v1(timestamptz)','EXECUTE') then raise exception 'Worker cannot invoke escalation processor';end if;
end $$;

rollback;
