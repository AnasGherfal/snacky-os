\set ON_ERROR_STOP on
begin;
create function public.qa_stocktake_notice_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'FAIL: %',label;end if;
 raise notice 'PASS: %',label;
end$$;
insert into auth.users values
 ('e1111111-1111-4111-8111-111111111111'),('e2222222-2222-4222-8222-222222222222'),
 ('e3333333-3333-4333-8333-333333333333'),('e4444444-4444-4444-8444-444444444444');
insert into public.team_members(id,auth_user_id,role,roles,full_name) values
 ('f1111111-1111-4111-8111-111111111111','e1111111-1111-4111-8111-111111111111','owner',array['owner'],'QA Owner'),
 ('f2222222-2222-4222-8222-222222222222','e2222222-2222-4222-8222-222222222222','warehouse',array['warehouse'],'QA Counter'),
 ('f3333333-3333-4333-8333-333333333333','e3333333-3333-4333-8333-333333333333','warehouse',array['warehouse'],'QA Other Counter'),
 ('f4444444-4444-4444-8444-444444444444','e4444444-4444-4444-8444-444444444444','operator',array['operator'],'QA Restricted Operator');
insert into public.profiles(id,active_status,role,roles,team_member_id,full_name)
select auth_user_id,'active',role,roles,id,full_name from public.team_members where id::text like 'f%';
insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,locale) values
 ('e1111111-1111-4111-8111-111111111111','https://fcm.googleapis.com/stocktake-test/owner','fake','fake','en'),
 ('e2222222-2222-4222-8222-222222222222','https://fcm.googleapis.com/stocktake-test/employee','fake','fake','ar');
insert into public.storage_locations(id,name) values('a1111111-1111-4111-8111-111111111111','Private warehouse name');
update snacky_notice_private.settings set enabled=true where singleton;
select public.qa_stocktake_notice_assert((select not enabled from snacky_notice_private.stocktake_notice_settings where singleton),'feature defaults OFF');
update snacky_notice_private.stocktake_notice_settings set enabled=true where singleton;

-- Preserve every pre-existing eligibility branch, including the optional #231
-- buying/cash hook regardless of installation order.
do $$declare existing text;current_body text;hook text:=E' if n.source_kind=''stocktake'' then\n  return snacky_notice_private.stocktake_notice_eligible(n);\n end if;\n';
 buying_hook text:=E' if n.source_kind in (''buying_list'',''cash_pickup'') then\n  return snacky_notice_private.operational_eligible(n);\n end if;\n';
begin
 select body into existing from public.test_stocktake_existing_eligibility;
 select prosrc into current_body from pg_proc where oid='snacky_notice_private.eligible(public.notifications)'::regprocedure;
 perform public.qa_stocktake_notice_assert(replace(replace(current_body,hook,''),buying_hook,'')=replace(existing,buying_hook,''),'pre-existing eligibility body preserved verbatim');
end$$;

do $$declare
 owner_id uuid:='e1111111-1111-4111-8111-111111111111';
 worker_id uuid:='e2222222-2222-4222-8222-222222222222';
 other_id uuid:='e3333333-3333-4333-8333-333333333333';
 restricted_id uuid:='e4444444-4444-4444-8444-444444444444';
 place uuid:='a1111111-1111-4111-8111-111111111111';
 a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();rev integer;cmd jsonb;r jsonb;r2 jsonb;
 old_n public.notifications;review_n public.notifications;second_n public.notifications;claims jsonb;packet jsonb;claim record;before_count integer;denied boolean;
begin
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 cmd:=jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',a,'action','create','revision',0,
  'payload',jsonb_build_object('storage_location_id',place,'assigned_to',worker_id,'title','SECRET_TITLE_12345','notes','PRIVATE_NOTE_98765','due_on',current_date));
 r:=public.snacky_storage_stocktake_command_v1(cmd);rev:=(r->>'revision')::integer;
 select * into old_n from public.notifications where source_kind='stocktake' and source_id=a;
 perform public.qa_stocktake_notice_assert(old_n.user_id=worker_id and old_n.recipient_member_id='f2222222-2222-4222-8222-222222222222'::uuid and old_n.event_kind='assigned','assignment resolves profile ID to correct employee team ID');
 perform public.qa_stocktake_notice_assert(old_n.action_url='/inventory/stocktake?id='||a::text,'tap target opens exact existing stocktake');
 perform public.qa_stocktake_notice_assert((select count(*)=1 from snacky_notice_private.deliveries where notification_id=old_n.id),'only registered recipient device queued');
 r2:=public.snacky_storage_stocktake_command_v1(cmd);
 perform public.qa_stocktake_notice_assert(r=r2 and (select count(*)=1 from public.notifications where source_id=a),'exact create retry produces one notification');
 update stocktake_private.assignments set status=status,assigned_to=assigned_to,title='CHANGED_PRIVATE_TITLE' where id=a;
 perform public.qa_stocktake_notice_assert((select count(*)=1 from public.notifications where source_id=a),'no-op and title edits do not notify');
 perform public.qa_stocktake_notice_assert(not exists(select 1 from public.notifications where source_id=a and concat(title,message,title_ar,message_ar)~'SECRET|PRIVATE|12345|98765'),'lock-screen copy excludes source titles and private notes');
 claims:=public.snacky_claim_notification_deliveries_v1(50);
 select d.id,d.lease_id into claim from snacky_notice_private.deliveries d where notification_id=old_n.id;
 packet:=public.snacky_notification_delivery_payload_v1(claim.id,claim.lease_id);
 perform public.qa_stocktake_notice_assert(packet->'payload'->>'lang'='ar' and packet->'payload'->>'dir'='rtl' and packet->'payload'->>'title'='تم إسناد جرد مخزن إليك','real sender packet contains Arabic RTL assignment copy');
 update public.team_members set active=false where auth_user_id=worker_id;
 perform public.qa_stocktake_notice_assert(public.snacky_notification_delivery_payload_v1(claim.id,claim.lease_id) is null,'deactivation after claim suppresses transport');
 update public.team_members set active=true where auth_user_id=worker_id;
 update public.team_members set auth_user_id=other_id where id='f2222222-2222-4222-8222-222222222222';
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(old_n),'mismatched canonical account link suppresses alert');
 update public.team_members set auth_user_id=worker_id where id='f2222222-2222-4222-8222-222222222222';

 perform set_config('request.jwt.claim.sub',worker_id::text,true);
 cmd:=jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',a,'action','submit','revision',rev,'payload',jsonb_build_object('confirmed_empty',true));
 r:=public.snacky_storage_stocktake_command_v1(cmd);rev:=(r->>'revision')::integer;
 select * into review_n from public.notifications where source_id=a and event_kind='submitted';
 perform public.qa_stocktake_notice_assert(review_n.user_id=owner_id,'real submission alerts only the owner/admin who created this count');
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(old_n),'submission invalidates old assignment alert');
 perform public.qa_stocktake_notice_assert((select status='submitted' from stocktake_private.assignments where id=a) and (select count(*)=0 from public.inventory_movements),'submission notification does not approve count or change inventory');
 r2:=public.snacky_storage_stocktake_command_v1(cmd);
 perform public.qa_stocktake_notice_assert(r=r2 and (select count(*)=1 from public.notifications where source_id=a and event_kind='submitted'),'exact submit retry does not repeat review alert');
 denied:=false;
 begin
  perform public.snacky_storage_stocktake_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',a,'action','approve','revision',rev,'payload','{}'::jsonb));
 exception when insufficient_privilege then denied:=true;end;
 perform public.qa_stocktake_notice_assert(denied,'employee cannot approve own count');

 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 r:=public.snacky_storage_stocktake_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',a,'action','recount','revision',rev,'payload',jsonb_build_object('note','Please recount physically')));rev:=(r->>'revision')::integer;
 select * into second_n from public.notifications where source_id=a and event_kind='recount';
 perform public.qa_stocktake_notice_assert(second_n.user_id=worker_id and snacky_notice_private.eligible(second_n),'recount request alerts assigned employee');
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(review_n),'recount invalidates earlier owner review notification');
 perform set_config('request.jwt.claim.sub',worker_id::text,true);
 r:=public.snacky_storage_stocktake_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',a,'action','submit','revision',rev,'payload',jsonb_build_object('confirmed_empty',true)));rev:=(r->>'revision')::integer;
 perform public.qa_stocktake_notice_assert((select count(*)=2 from public.notifications where source_id=a and event_kind='submitted') and not snacky_notice_private.eligible(review_n),'resubmission creates fresh review generation without reviving old one');
 select n.* into review_n from public.notifications n join snacky_notice_private.stocktake_notice_generations g on g.notification_id=n.id where g.assignment_id=a;
 update public.profiles set role='operator',roles=array['operator'] where id=owner_id;
 update public.team_members set role='operator',roles=array['operator'] where auth_user_id=owner_id;
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(review_n),'revoked owner/admin role suppresses review push');
 update public.profiles set role='owner',roles=array['owner'] where id=owner_id;
 update public.team_members set role='owner',roles=array['owner'] where auth_user_id=owner_id;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 r:=public.snacky_storage_stocktake_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',a,'action','approve','revision',rev,'payload','{}'::jsonb));
 perform public.qa_stocktake_notice_assert((select status='approved' from stocktake_private.assignments where id=a) and not snacky_notice_private.eligible(review_n),'real zero-variance approval suppresses pending review alert');

 r:=public.snacky_storage_stocktake_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'assignment_id',b,'action','create','revision',0,'payload',jsonb_build_object('storage_location_id',place,'assigned_to',other_id,'title','No device fixture')));
 select * into old_n from public.notifications where source_id=b;
 perform public.qa_stocktake_notice_assert(old_n.user_id=other_id and not exists(select 1 from snacky_notice_private.deliveries where notification_id=old_n.id),'no registered device still gets inbox alert without fake push');
 update stocktake_private.assignments set assigned_to=worker_id where id=b;
 update stocktake_private.assignments set assigned_to=other_id where id=b;
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(old_n) and (select count(*)=3 from public.notifications where source_id=b),'reassign away and back does not revive first alert');
 select n.* into old_n from public.notifications n join snacky_notice_private.stocktake_notice_generations g on g.notification_id=n.id where g.assignment_id=b;
 update snacky_notice_private.stocktake_notice_settings set enabled=false where singleton;
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(old_n),'pause suppresses existing queued stocktake notifications');
 update stocktake_private.assignments set assigned_to=worker_id where id=b;
 update stocktake_private.assignments set assigned_to=other_id where id=b;
 update snacky_notice_private.stocktake_notice_settings set enabled=true where singleton;
 before_count:=(select count(*) from public.notifications where source_id=b);
 update stocktake_private.assignments set assigned_to=assigned_to,status=status where id=b;
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(old_n) and before_count=(select count(*) from public.notifications where source_id=b),'disabled handoffs remain tracked and enabling does not backfill');
 update stocktake_private.assignments set assigned_to=restricted_id where id=b;
 perform public.qa_stocktake_notice_assert(before_count=(select count(*) from public.notifications where source_id=b),'pure operator without existing stocktake page access is not alerted');
 update stocktake_private.assignments set assigned_to=worker_id where id=b;
 select n.* into old_n from public.notifications n join snacky_notice_private.stocktake_notice_generations g on g.notification_id=n.id where g.assignment_id=b;
 update stocktake_private.assignments set status='cancelled' where id=b;
 perform public.qa_stocktake_notice_assert(not snacky_notice_private.eligible(old_n),'cancelled count suppresses queued employee alert');
end$$;

-- Internal alert errors must not roll back business state. Source inputs are not
-- included in diagnostics. Fault invalidates ALL prior generations for this slice.
create function public.qa_fail_stocktake_notification() returns trigger language plpgsql as $$begin
 if new.source_kind='stocktake' then raise exception 'PRIVATE_FAULT_DO_NOT_LOG' using errcode='23514';end if;return new;
end$$;
create trigger qa_fail_stocktake_notification before insert on public.notifications for each row execute function public.qa_fail_stocktake_notification();
do $$declare a uuid:=gen_random_uuid();begin
 insert into stocktake_private.assignments(id,storage_location_id,assigned_to,title,created_by) values(a,'a1111111-1111-4111-8111-111111111111','e2222222-2222-4222-8222-222222222222','Fault fixture','e1111111-1111-4111-8111-111111111111');
 perform public.qa_stocktake_notice_assert(exists(select 1 from stocktake_private.assignments where id=a),'notification failure preserves assignment save');
 perform public.qa_stocktake_notice_assert((select not enabled and last_error_code='23514' from snacky_notice_private.stocktake_notice_settings where singleton),'internal error pauses only stocktake integration with safe error code');
 perform public.qa_stocktake_notice_assert((select enabled from snacky_notice_private.settings where singleton),'existing route and CRM notifications remain enabled after stocktake fault');
 update stocktake_private.assignments set status='cancelled' where id=a;
end$$;
drop trigger qa_fail_stocktake_notification on public.notifications;

-- Network wake failures retain the committed inbox/outbox event for the existing worker.
create or replace function snacky_notice_private.wake() returns void language plpgsql security definer set search_path='' as $$begin raise exception 'Synthetic network unavailable';end$$;
update snacky_notice_private.stocktake_notice_settings set enabled=true where singleton;
do $$declare a uuid:=gen_random_uuid();begin
 insert into stocktake_private.assignments(id,storage_location_id,assigned_to,title,created_by) values(a,'a1111111-1111-4111-8111-111111111111','e2222222-2222-4222-8222-222222222222','Wake fixture','e1111111-1111-4111-8111-111111111111');
 perform public.qa_stocktake_notice_assert(exists(select 1 from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.source_id=a),'wake failure keeps persisted delivery');
 perform public.qa_stocktake_notice_assert((select enabled from snacky_notice_private.stocktake_notice_settings where singleton),'wake failure does not disable usable stocktake integration');
end$$;
select public.qa_stocktake_notice_assert(not has_table_privilege('authenticated','snacky_notice_private.stocktake_notice_generations','SELECT'),'staff cannot read private notification generations');
select public.qa_stocktake_notice_assert(not has_function_privilege('authenticated','snacky_notice_private.sync_stocktake_notice(uuid,text)','EXECUTE'),'staff cannot invoke alert writer');
select public.qa_stocktake_notice_assert(not has_table_privilege('authenticated','stocktake_private.assignments','UPDATE'),'no raw stocktake update grant introduced');
select public.qa_stocktake_notice_assert((select count(*)=0 from public.inventory_movements),'notification checks left inventory ledger untouched');
rollback;
