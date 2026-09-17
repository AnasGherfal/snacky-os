\set ON_ERROR_STOP on
\ir test-crm-recurring-db.sql
-- Additional disposable scenarios after the main fixture transaction rolled back.
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Edge owner','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Edge relations','crm',array['crm']::public.team_role[],'22222222-2222-4222-8222-222222222222');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members;
insert into public.locations(id,name) values('99999999-9999-4999-8999-999999999999','Edge site');
insert into public.location_relationships(location_id,assigned_to) values('99999999-9999-4999-8999-999999999999','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$declare p jsonb;begin
 p:=jsonb_build_object('title','Edge routine','instructions','','target_kind','location','target_id','99999999-9999-4999-8999-999999999999','assigned_to','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cadence','days','every',1,'start_on',(now() at time zone 'Africa/Tripoli')::date,'end_on',(now() at time zone 'Africa/Tripoli')::date,'notice_days',0);
 perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'save','70000000-0000-4000-8000-000000000003',0,p);
 perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'resume','70000000-0000-4000-8000-000000000003',1,'{}');
 perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'engine.resume','00000000-0000-4000-8000-000000000001',0,'{}');
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
update public.locations set status='archived' where id='99999999-9999-4999-8999-999999999999';
select crm_automation_private.tick();
do $$begin if exists(select 1 from crm_automation_private.occurrences) then raise exception 'Archived source generated work';end if;end $$;
update public.locations set status='active' where id='99999999-9999-4999-8999-999999999999';
update public.team_members set active=false where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select crm_automation_private.tick();
do $$begin if exists(select 1 from crm_automation_private.occurrences) then raise exception 'Inactive assignee generated work';end if;end $$;
update public.team_members set active=true where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
create function pg_temp.reject_recurring_occurrence() returns trigger language plpgsql as $$begin raise exception 'Synthetic post-task insert failure';end $$;
create trigger qa_reject_occurrence before insert on crm_automation_private.occurrences for each row execute function pg_temp.reject_recurring_occurrence();
do $$declare n int;events int;result jsonb;begin
 select count(*) into n from public.crm_tasks;select count(*) into events from public.crm_activities;
 result:=crm_automation_private.tick();
 if (result->>'errors')::int<>1 then raise exception 'Failure not surfaced';end if;
 if (select count(*) from public.crm_tasks)<>n or (select count(*) from public.crm_activities)<>events then raise exception 'Half-written task or audit survived failed occurrence';end if;
end $$;
drop trigger qa_reject_occurrence on crm_automation_private.occurrences;
select crm_automation_private.tick();
do $$begin if (select count(*) from crm_automation_private.occurrences)<>1 then raise exception 'Recovery did not generate exactly once';end if;end $$;
update public.crm_tasks set status='completed',result='Edge test done',completed_at=now(),completed_by='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id in(select task_id from crm_automation_private.occurrences);
select crm_automation_private.tick(now()+interval '40 days');
do $$begin if (select count(*) from crm_automation_private.occurrences)<>1 then raise exception 'Ended schedule generated another cycle';end if;end $$;
rollback;
\echo 'Additional recurring invariants passed: terminal source, inactive assignee, task/audit rollback, recovery, end date.'
