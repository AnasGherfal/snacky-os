\set ON_ERROR_STOP on
-- Disposable PostgreSQL only. All test changes are rolled back.
begin;
create function pg_temp.check_ok(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',label;end if;raise notice 'PASS: %',label;end$$;

select pg_temp.check_ok(not (select enabled from snacky_notice_private.operational_settings),'new integration starts disabled');
select pg_temp.check_ok((select prosrc from pg_proc where oid='snacky_notice_private.eligible(public.notifications)'::regprocedure)=
 replace((select body from public.test_existing_eligibility),E'\nbegin\n',E'\nbegin\n if n.source_kind in (''buying_list'',''cash_pickup'') then\n  return snacky_notice_private.operational_eligible(n);\n end if;\n'),'existing dispatch eligibility retained verbatim except new source branch');

insert into auth.users(id) values
 ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002'),('10000000-0000-4000-8000-000000000003'),('10000000-0000-4000-8000-000000000004');
insert into public.team_members(id,auth_user_id,role,roles) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner',array['owner']),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','warehouse',array['warehouse']),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','purchasing',array['purchasing']),
 ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','operator',array['operator']);
insert into public.profiles(id,team_member_id,active_status,role,roles)
 select auth_user_id,id,'active',role,roles from public.team_members where id::text like '20000000%';
insert into snacky_private.cash_handover_counters values('10000000-0000-4000-8000-000000000002',true),('10000000-0000-4000-8000-000000000003',true);
insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,locale) values
 ('10000000-0000-4000-8000-000000000002','https://fcm.googleapis.com/fake/counter','fake','fake','ar');
update snacky_notice_private.settings set enabled=true where singleton;
insert into buying_private.lists(id,title,assigned_to) values
 ('30000000-0000-4000-8000-000000000001','Private title price 999','20000000-0000-4000-8000-000000000002');
select pg_temp.check_ok(not exists(select 1 from public.notifications where source_kind='buying_list'),'disabled feature sends nothing');
update snacky_notice_private.operational_settings set enabled=true where singleton;
update buying_private.lists set assigned_to=assigned_to where id='30000000-0000-4000-8000-000000000001';
select pg_temp.check_ok(not exists(select 1 from public.notifications where source_kind='buying_list'),'enable and unchanged save do not backfill');

insert into buying_private.lists(id,title,assigned_to) values
 ('30000000-0000-4000-8000-000000000002','PRIVATE PRICE 8888','20000000-0000-4000-8000-000000000002');
select pg_temp.check_ok((select count(*) from public.notifications where source_id='30000000-0000-4000-8000-000000000002')=1,'new buying assignment produces one in-app notification');
select pg_temp.check_ok((select action_url from public.notifications where source_id='30000000-0000-4000-8000-000000000002')='/buying-lists/30000000-0000-4000-8000-000000000002','shopping alert opens exact existing list');
select pg_temp.check_ok((select count(*) from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id='30000000-0000-4000-8000-000000000002')=1,'only actual subscribed recipient device is queued');
update buying_private.lists set assigned_to=assigned_to,status=status,revision=revision+1 where id='30000000-0000-4000-8000-000000000002';
select pg_temp.check_ok((select count(*) from public.notifications where source_id='30000000-0000-4000-8000-000000000002')=1,'unchanged save and checklist revision do not repeat assignment alert');

-- A -> B -> A must retire A's first queued notification, even though A owns it again.
create temporary table old_notifications as select id from public.notifications where source_id='30000000-0000-4000-8000-000000000002';
update buying_private.lists set assigned_to='20000000-0000-4000-8000-000000000003' where id='30000000-0000-4000-8000-000000000002';
select pg_temp.check_ok(not exists(select 1 from public.notifications n join old_notifications o using(id) where snacky_notice_private.eligible(n)),'old assignee no longer eligible');
select pg_temp.check_ok(exists(select 1 from public.notifications where source_id='30000000-0000-4000-8000-000000000002' and user_id='10000000-0000-4000-8000-000000000003'),'buyer with no phone still receives in-app notification');
select pg_temp.check_ok(not exists(select 1 from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.user_id='10000000-0000-4000-8000-000000000003'),'no registered device produces no fake delivery');
update buying_private.lists set assigned_to='20000000-0000-4000-8000-000000000002' where id='30000000-0000-4000-8000-000000000002';
select pg_temp.check_ok(not exists(select 1 from public.notifications n join old_notifications o using(id) where snacky_notice_private.eligible(n)),'reassigning back does not revive old A notification');
select pg_temp.check_ok((select count(*) from public.notifications n where n.source_id='30000000-0000-4000-8000-000000000002' and snacky_notice_private.eligible(n))=1,'only current assignment generation is eligible');
update buying_private.lists set status='completed' where id='30000000-0000-4000-8000-000000000002';
select pg_temp.check_ok(not exists(select 1 from public.notifications n where n.source_id='30000000-0000-4000-8000-000000000002' and snacky_notice_private.eligible(n)),'completed shopping suppresses old push');

-- Exactly the existing drop-off save order: handover first, collection second.
insert into public.cash_collections(id,cash_bag_id,custody_status) values('40000000-0000-4000-8000-000000000001','PRIVATE-BOX','removed');
insert into snacky_private.cash_handovers(collection_id,assigned_to,stage) values
 ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','assigned');
select pg_temp.check_ok(not exists(select 1 from public.notifications where source_kind='cash_pickup'),'assignment alone does not claim box is in storage');
update snacky_private.cash_handovers set stage='dropped',deposited_at=now() where collection_id='40000000-0000-4000-8000-000000000001';
select pg_temp.check_ok(not exists(select 1 from public.notifications where source_kind='cash_pickup'),'handover-first update cannot send premature pickup alert');
update public.cash_collections set custody_status='in_storage',storage_received_at=now() where id='40000000-0000-4000-8000-000000000001';
select pg_temp.check_ok((select count(*) from public.notifications where source_kind='cash_pickup')=1,'completed deposit queues one pickup alert');
select pg_temp.check_ok((select action_url from public.notifications where source_kind='cash_pickup')='/cash-handling?id=40000000-0000-4000-8000-000000000001','pickup alert opens exact existing cash record');
update snacky_private.cash_handovers set stage=stage,revision=revision+1 where collection_id='40000000-0000-4000-8000-000000000001';
update public.cash_collections set custody_status=custody_status,storage_received_at=storage_received_at where id='40000000-0000-4000-8000-000000000001';
select pg_temp.check_ok((select count(*) from public.notifications where source_kind='cash_pickup')=1,'repeated deposit save does not duplicate pickup');

-- Revoke permission after claim: payload must disappear before transport.
do $$declare delivery jsonb;payload jsonb;begin
 select x into delivery from jsonb_array_elements(public.snacky_claim_notification_deliveries_v1(50)) x
 join snacky_notice_private.deliveries d on d.id=(x->>'id')::uuid
 join public.notifications n on n.id=d.notification_id where n.source_kind='cash_pickup' limit 1;
 perform pg_temp.check_ok(delivery is not null,'pickup notification claim exists');
 payload:=public.snacky_notification_delivery_payload_v1((delivery->>'id')::uuid,(delivery->>'lease_id')::uuid);
 perform pg_temp.check_ok(payload->'payload'->>'lang'='ar' and payload->'payload'->>'dir'='rtl','Arabic device receives Arabic RTL copy');
 update snacky_private.cash_handover_counters set enabled=false where user_id='10000000-0000-4000-8000-000000000002';
 payload:=public.snacky_notification_delivery_payload_v1((delivery->>'id')::uuid,(delivery->>'lease_id')::uuid);
 perform pg_temp.check_ok(payload is null,'counter revocation after claim prevents push payload');
 update snacky_private.cash_handover_counters set enabled=true where user_id='10000000-0000-4000-8000-000000000002';
 update snacky_private.cash_handovers set stage='picked_up' where collection_id='40000000-0000-4000-8000-000000000001';
 payload:=public.snacky_notification_delivery_payload_v1((delivery->>'id')::uuid,(delivery->>'lease_id')::uuid);
 perform pg_temp.check_ok(payload is null,'pickup after claim suppresses obsolete pickup request');
end$$;

insert into public.cash_collections(id,cash_bag_id,custody_status,storage_received_at,actual_cash_collected) values
 ('40000000-0000-4000-8000-000000000002','ZERO-COUNT','in_storage',now(),0),
 ('40000000-0000-4000-8000-000000000003','   ','in_storage',now(),null),
 ('40000000-0000-4000-8000-000000000004','NO-DEPOSIT','in_storage',null,null);
insert into snacky_private.cash_handovers(collection_id,assigned_to,stage)
 select id,'10000000-0000-4000-8000-000000000002','assigned' from public.cash_collections where id<>'40000000-0000-4000-8000-000000000001';
select pg_temp.check_ok((select count(*) from public.notifications where source_kind='cash_pickup')=1,'zero counted, missing reference and unrecorded deposit excluded');
select pg_temp.check_ok(not exists(select 1 from public.notifications where source_kind in ('buying_list','cash_pickup') and (message||message_ar||title||title_ar) ~ 'PRIVATE|8888|999|ZERO-COUNT'),'notification copy contains no user-entered source data');

-- Canonical account and current-role checks, no employee impersonation in production.
update public.team_members set auth_user_id='10000000-0000-4000-8000-000000000004' where id='20000000-0000-4000-8000-000000000002';
insert into buying_private.lists(id,assigned_to) values('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002');
select pg_temp.check_ok(not exists(select 1 from public.notifications where source_id='30000000-0000-4000-8000-000000000003'),'mismatched canonical account not notified');
update public.team_members set auth_user_id='10000000-0000-4000-8000-000000000002' where id='20000000-0000-4000-8000-000000000002';

-- A lost network wake retains the real delivery for the normal worker.
create or replace function snacky_notice_private.wake() returns void language plpgsql security definer set search_path='' as $$begin raise exception 'Synthetic offline transport';end$$;
insert into buying_private.lists(id,assigned_to) values('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002');
select pg_temp.check_ok(exists(select 1 from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id='30000000-0000-4000-8000-000000000004'),'network wake failure retains persisted delivery');
select pg_temp.check_ok((select enabled from snacky_notice_private.operational_settings),'network outage does not disable source integration');

-- Failed notification write: preserve the source save, safely pause only this integration.
create function pg_temp.reject_operational_notification() returns trigger language plpgsql as $$begin raise exception 'Synthetic outbox write failure';end$$;
create trigger reject_operational_notification before insert on public.notifications for each row when(new.source_kind in ('buying_list','cash_pickup')) execute function pg_temp.reject_operational_notification();
insert into buying_private.lists(id,assigned_to) values('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000002');
select pg_temp.check_ok(exists(select 1 from buying_private.lists where id='30000000-0000-4000-8000-000000000005'),'optional notification DB failure cannot roll back shopping assignment');
select pg_temp.check_ok(not (select enabled from snacky_notice_private.operational_settings) and (select last_error_code is not null from snacky_notice_private.operational_settings),'internal alert failure pauses new integration with diagnostic');
select pg_temp.check_ok((select enabled from snacky_notice_private.settings),'existing route and CRM notification worker stays enabled');
select pg_temp.check_ok(not has_table_privilege('authenticated','snacky_notice_private.operational_generations','SELECT'),'staff cannot read private notification generations');
select pg_temp.check_ok(not has_function_privilege('authenticated','snacky_notice_private.sync_operational_notice(text,uuid)','EXECUTE'),'staff cannot manufacture operational alerts');
select pg_temp.check_ok(not has_function_privilege('anon','snacky_notice_private.operational_eligible(public.notifications)','EXECUTE'),'anonymous callers cannot inspect eligibility');
select pg_temp.check_ok((select value from public.test_notice_ledger_guard where id=1)=100,'ledger sentinel unchanged');
rollback;
