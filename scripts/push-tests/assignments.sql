\set ON_ERROR_STOP on
begin;
-- Synthetic isolated fixtures; no live subscriptions or actual push service calls.
insert into auth.users values('aaaaaaaa-0000-4000-8000-000000000001'),('aaaaaaaa-0000-4000-8000-000000000002'),('aaaaaaaa-0000-4000-8000-000000000003'),('aaaaaaaa-0000-4000-8000-000000000004');
insert into public.team_members(id,auth_user_id,role,roles) select ('bbbbbbbb-0000-4000-8000-'||lpad(x::text,12,'0'))::uuid,('aaaaaaaa-0000-4000-8000-'||lpad(x::text,12,'0'))::uuid,case x when 1 then 'owner' when 2 then 'crm' else 'operator' end,array[case x when 1 then 'owner' when 2 then 'crm' else 'operator' end] from generate_series(1,4)x;
insert into public.profiles(id,active_status,role,roles,team_member_id) select auth_user_id,'active',role,roles,id from public.team_members;
insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) select id,'https://fcm.googleapis.com/fake/'||id,'fake','fake' from auth.users where id::text like 'aaaaaaaa%';
insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values('aaaaaaaa-0000-4000-8000-000000000003','https://fcm.googleapis.com/fake/second','fake','fake');
update snacky_notice_private.settings set token_hash=encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex');
do $$begin
 if (public.snacky_notification_worker_start_v1(repeat('b',64))->>'authorized')::boolean then raise exception 'Wrong worker token accepted';end if;
end$$;
select public.snacky_notification_worker_start_v1(repeat('a',64));

do $$declare r uuid:=gen_random_uuid();l uuid:=gen_random_uuid();t uuid:=gen_random_uuid();iss uuid:=gen_random_uuid();loc uuid:=gen_random_uuid();ob uuid:=gen_random_uuid();routine uuid:=gen_random_uuid();ins uuid:=gen_random_uuid();doc uuid:=gen_random_uuid();before_count integer;claims jsonb;c jsonb;payload jsonb;
 owner_id uuid:='bbbbbbbb-0000-4000-8000-000000000001';crm uuid:='bbbbbbbb-0000-4000-8000-000000000002';op uuid:='bbbbbbbb-0000-4000-8000-000000000003';other_op uuid:='bbbbbbbb-0000-4000-8000-000000000004';
begin
 insert into public.routes(id,operator_id,status,route_date,created_by) values(r,op,'draft','2026-09-19',owner_id);
 if exists(select 1 from public.notifications where source_id=r) then raise exception 'Draft route notified';end if;
 update public.routes set status='assigned' where id=r;
 if (select count(*) from public.notifications where source_id=r and event_kind='assigned')<>1 then raise exception 'Route assignment missing/duplicated';end if;
 if (select count(*) from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id=r)<>2 then raise exception 'All exact-recipient devices were not queued';end if;
 update public.routes set route_date=route_date where id=r;
 if (select count(*) from public.notifications where source_id=r)<>1 then raise exception 'Unchanged save notified';end if;
 update public.routes set operator_id=other_op where id=r;
 if (select count(*) from public.notifications where source_id=r and event_kind='assigned')<>2 then raise exception 'Reassignment missing';end if;
 claims:=public.snacky_claim_notification_deliveries_v1(50);
 if (select count(*) from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id=r and n.recipient_member_id=op and n.event_kind='assigned' and d.status='skipped')<>2 then raise exception 'Stale assignment not suppressed';end if;
 for c in select value from jsonb_array_elements(claims) loop
  payload:=public.snacky_notification_delivery_payload_v1((c->>'id')::uuid,(c->>'lease_id')::uuid);
  if payload is null then raise exception 'Valid claimed notification lacks payload';end if;
  if public.snacky_finish_notification_delivery_v1((c->>'id')::uuid,gen_random_uuid(),'accepted') then raise exception 'Wrong lease accepted';end if;
  if not public.snacky_finish_notification_delivery_v1((c->>'id')::uuid,(c->>'lease_id')::uuid,'accepted') then raise exception 'Valid receipt not saved';end if;
 end loop;
 if jsonb_array_length(public.snacky_claim_notification_deliveries_v1(50))<>0 then raise exception 'Accepted notifications claimed twice';end if;
 update public.routes set status='cancelled' where id=r;
 if not exists(select 1 from public.notifications where source_id=r and event_kind='cancelled' and recipient_member_id=other_op) then raise exception 'Cancellation not notified';end if;
 insert into public.location_pipeline_leads(id,place_name,assigned_to_user_id,created_by_member_id) values(l,'Synthetic lead',crm,owner_id);
 update public.location_pipeline_leads set next_action_date='2026-09-22' where id=l;
 if (select count(*) from public.notifications where source_id=l)<>1 then raise exception 'Create plus final update caused two alerts';end if;
 insert into public.issues(id,assigned_to,reported_by) values(iss,crm,owner_id);
 insert into public.crm_tasks(id,title,assigned_to,created_by,issue_id,task_type,due_date) values(t,'Synthetic field action',op,crm,iss,'field_action','2026-09-20');
 update public.crm_tasks set status='completed' where id=t;
 if not exists(select 1 from public.notifications where source_id=iss and event_kind='field_completed' and recipient_member_id=crm) then raise exception 'Customer owner not notified of field result';end if;
 if exists(select 1 from public.notifications where source_id=t and event_kind='completed' and recipient_member_id=crm) then raise exception 'Duplicate field completion alert';end if;
 insert into public.crm_tasks(id,title,assigned_to,created_by) values(gen_random_uuid(),'Ordinary follow-up',crm,owner_id) returning id into t;
 update public.crm_tasks set status='completed' where id=t;
 if not exists(select 1 from public.notifications where source_id=t and event_kind='completed' and recipient_member_id=owner_id) then raise exception 'Task creator completion alert missing';end if;
 insert into public.locations values(loc,'Synthetic location','active');
 insert into public.location_relationships(location_id,assigned_to,created_by) values(loc,crm,owner_id);
 insert into public.location_admin_obligations(id,title,assigned_to,due_date) values(ob,'Synthetic rent follow-up',crm,'2026-09-23');
 insert into crm_automation_private.routines(id,title,assigned_to) values(routine,'Synthetic recurring follow-up',crm);
 insert into public.operator_instructions(id,title,operator_id,created_by_member_id) values(ins,'Synthetic instruction',op,owner_id);
 if (select count(*) from public.notifications where source_id in (loc,ob,routine,ins) and event_kind='assigned')<>4 then raise exception 'Some assignment types are missing';end if;
 select count(*) into before_count from public.notifications;
 insert into public.location_pipeline_leads(id,place_name,assigned_to_user_id,is_practice) values(gen_random_uuid(),'Practice',crm,true);
 update public.profiles set active_status='inactive' where team_member_id=crm;
 insert into public.location_pipeline_leads(id,place_name,assigned_to_user_id) values(gen_random_uuid(),'Inactive account',crm);
 if (select count(*) from public.notifications)<>before_count then raise exception 'Practice or inactive assignee notified';end if;
 update public.profiles set active_status='active' where team_member_id=crm;
 insert into company_private.items(id) values(doc);
 insert into company_private.versions values(doc,1,'{"title_en":"Synthetic company update","title_ar":"تحديث تجريبي","audience":["crm"],"notify":true}');
 update company_private.items set current_version=1 where id=doc;
 if (select count(*) from public.notifications where source_id=doc)<>1 or exists(select 1 from public.notifications where source_id=doc and recipient_member_id<>crm) then raise exception 'Company audience was not isolated';end if;
 update public.team_members set active=false where id=crm;
 if exists(select 1 from public.notifications n where source_id=doc and snacky_notice_private.eligible(n)) then raise exception 'Disabled member remained eligible';end if;
 update public.team_members set active=true where id=crm;
 claims:=public.snacky_claim_notification_deliveries_v1(50);
 c:=claims->0;
 if c is not null then
  update public.push_subscriptions set is_active=false where id=(select subscription_id from snacky_notice_private.deliveries where id=(c->>'id')::uuid);
  if public.snacky_notification_delivery_payload_v1((c->>'id')::uuid,(c->>'lease_id')::uuid) is not null then raise exception 'Disabled device remained deliverable';end if;
 end if;
 update snacky_notice_private.settings set enabled=false;
 perform public.snacky_notification_worker_start_v1(repeat('a',64));
 if (select enabled from snacky_notice_private.settings) then raise exception 'Worker reversed an administrative pause';end if;
 if not public.snacky_notification_delivery_mode_v1() then raise exception 'Pause re-enabled legacy route sender';end if;
 raise notice 'PASS: route assignment, all devices, unchanged save, reassignment, stale suppression, leases, cancellation, leads, issues, field completion, relationships, rent tasks, routines, instructions, audience, inactivity, pause';
end$$;
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$begin
 if exists(select 1 from public.notifications where user_id<>auth.uid()) then raise exception 'Other user notifications exposed';end if;
 begin perform public.snacky_claim_notification_deliveries_v1(20);raise exception 'Client claimed delivery';exception when insufficient_privilege then null;end;
 begin perform public.snacky_notification_worker_start_v1(repeat('a',64));raise exception 'Client activated worker';exception when insufficient_privilege then null;end;
end$$;
reset role;
rollback;
