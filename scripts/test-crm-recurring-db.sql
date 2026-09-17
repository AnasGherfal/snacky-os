\set ON_ERROR_STOP on
-- Existing fixtures refuse databases other than crm_tests. Never run on production.
\ir test-company-hub-db.sql
\ir ../supabase/migrations/20260916214951_crm_recurring_management.sql
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture owner','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture relations','crm',array['crm']::public.team_role[],'22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Fixture colleague','crm',array['crm']::public.team_role[],'33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fixture operator','operator',array['operator']::public.team_role[],'44444444-4444-4444-8444-444444444444');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members;
insert into public.locations(id,name) values('99999999-9999-4999-8999-999999999999','Fixture site');
insert into public.location_relationships(location_id,assigned_to) values('99999999-9999-4999-8999-999999999999','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$declare p jsonb;r jsonb;again jsonb;blocked boolean;today date:=(now() at time zone 'Africa/Tripoli')::date;begin
 p:=jsonb_build_object('title','Fixture routine','instructions','Contact location and record result','target_kind','location','target_id','99999999-9999-4999-8999-999999999999','assigned_to','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cadence','days','every',1,'start_on',today,'end_on','','notice_days',0);
 r:=public.snacky_crm_routine_command_v1('60000000-0000-4000-8000-000000000001','save','70000000-0000-4000-8000-000000000001',0,p);
 again:=public.snacky_crm_routine_command_v1('60000000-0000-4000-8000-000000000001','save','70000000-0000-4000-8000-000000000001',0,p);
 if r<>again then raise exception 'Idempotency failure';end if;
 if not (public.snacky_crm_routines_v1()#>>'{rows,0,paused}')::boolean then raise exception 'New routine activated itself';end if;
 blocked:=false;begin perform public.snacky_crm_routine_command_v1('60000000-0000-4000-8000-000000000001','save','70000000-0000-4000-8000-000000000001',0,p||'{"title":"Changed"}');exception when unique_violation then blocked:=true;end;if not blocked then raise exception 'Changed request reused ID';end if;
 blocked:=false;begin perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'save','70000000-0000-4000-8000-000000000002',0,p||'{"assigned_to":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}');exception when invalid_parameter_value then blocked:=true;end;if not blocked then raise exception 'Routine assigned to pure operator';end if;
 blocked:=false;begin perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'save','70000000-0000-4000-8000-000000000002',0,p||'{"assigned_to":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}');exception when invalid_parameter_value then blocked:=true;end;if not blocked then raise exception 'Routine assigned to unrelated CRM colleague';end if;
 blocked:=false;begin perform crm_automation_private.tick();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Browser can execute scheduler';end if;
 blocked:=false;begin perform count(*) from crm_automation_private.routines;exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Raw private table exposed';end if;
 perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'resume','70000000-0000-4000-8000-000000000001',1,'{}');
 blocked:=false;begin perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'pause','70000000-0000-4000-8000-000000000001',1,'{}');exception when serialization_failure then blocked:=true;end;if not blocked then raise exception 'Stale revision accepted';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
do $$begin
 if not (crm_automation_private.tick()->>'disabled')::boolean then raise exception 'Engine enabled without opt in';end if;
 if exists(select 1 from public.crm_tasks) then raise exception 'Disabled engine generated task';end if;
 if crm_automation_private.next_date('2027-01-31','months',1,'2027-01-31')<>'2027-02-28' or crm_automation_private.next_date('2027-02-28','months',1,'2027-01-31')<>'2027-03-31' or crm_automation_private.next_date('2028-01-31','months',1,'2028-01-31')<>'2028-02-29' then raise exception 'Month-end drift';end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
select public.snacky_crm_routine_command_v1(gen_random_uuid(),'engine.resume','00000000-0000-4000-8000-000000000001',0,'{}');
reset role;
select set_config('request.jwt.claim.sub','',true);
select crm_automation_private.tick();
select crm_automation_private.tick();
do $$declare r jsonb;begin
 if (select count(*) from public.crm_tasks)<>1 or (select count(*) from crm_automation_private.occurrences)<>1 then raise exception 'Repeated tick duplicated task';end if;
 if (select status from public.crm_tasks limit 1)<>'open' then raise exception 'Generation completed work';end if;
 r:=crm_automation_private.tick(now()+interval '3 days');
 if (r->>'generated')::int<>0 or (r->>'blocked')::int<>1 then raise exception 'Unfinished work was duplicated';end if;
 if (select due_date from public.crm_tasks limit 1)<>(now() at time zone 'Africa/Tripoli')::date then raise exception 'Overdue task silently rescheduled';end if;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$declare r jsonb;blocked boolean;begin
 r:=public.snacky_crm_workspace_v1('work',null,'{"scope":"mine","window":"today"}');
 if (r->>'total')::int<>1 then raise exception 'Generated task missing from native My Work';end if;
 blocked:=false;begin perform public.snacky_crm_management_v2();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'CRM employee sees management metrics';end if;
 blocked:=false;begin perform public.snacky_crm_routines_v1();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'CRM employee sees routine directory';end if;
 perform public.snacky_crm_command_v1(gen_random_uuid(),'task.save',(r#>>'{rows,0,id}')::uuid,jsonb_build_object('version',r#>>'{rows,0,data,version}','status','completed','result','Contacted site and recorded outcome.'));
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
select crm_automation_private.tick(now()+interval '3 days');
do $$begin
 if (select count(*) from public.crm_tasks)<>2 then raise exception 'Catch-up not generated';end if;
 if (select skipped_cycles from crm_automation_private.occurrences order by due_on desc limit 1)<>2 then raise exception 'Missed cycles not recorded';end if;
 if (select count(*) from public.crm_tasks where status='completed')<>1 then raise exception 'History changed';end if;
 if exists(select 1 from public.financial_transactions) or exists(select 1 from public.location_admin_obligations) then raise exception 'Recurrence posted money or rent obligations';end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$declare d jsonb;begin
 d:=public.snacky_crm_management_v2('{"days":1}');
 if (d#>>'{metrics,tasks_completed}')::int<>1 then raise exception 'Actual completion not counted';end if;
 perform public.snacky_crm_routine_command_v1(gen_random_uuid(),'pause','70000000-0000-4000-8000-000000000001',2,'{}');
 if not (public.snacky_crm_routines_v1()#>>'{rows,0,paused}')::boolean then raise exception 'Pause not persisted';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
select crm_automation_private.tick(now()+interval '40 days');
do $$begin if (select count(*) from public.crm_tasks)<>2 then raise exception 'Paused routine generated work';end if;end $$;
-- Inactive linked member must be denied despite active profile.
update public.team_members set active=false,active_status='inactive' where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$declare blocked boolean:=false;begin
 begin perform public.snacky_crm_routines_v1();exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Inactive linked manager was accepted';end if;
end $$;
reset role;
do $$begin
 if has_function_privilege('anon','public.snacky_crm_management_v2(jsonb)','execute') or has_function_privilege('authenticated','crm_automation_private.tick(timestamptz)','execute') then raise exception 'Scheduler or overview exposure';end if;
 if (select count(*) from crm_automation_private.routines)<>1 then raise exception 'Unexpected rule after rejected saves';end if;
end $$;
rollback;
\echo 'Recurring database checks passed: disabled engine, explicit activation, role boundaries, idempotency, stale revision, month-end, no duplicate open work, catch-up, native completion, metrics, pause and no money effects.'
