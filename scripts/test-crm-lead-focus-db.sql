\set ON_ERROR_STOP on
-- The existing fixture refuses any database other than crm_tests.
\ir test-company-hub-db.sql
create temporary table focus_legacy_fingerprints as select oid,md5(pg_get_functiondef(oid)) digest from pg_proc where oid in ('public.snacky_crm_command_v1(uuid,text,uuid,jsonb)'::regprocedure,'public.snacky_crm_workspace_v1(text,uuid,jsonb)'::regprocedure);
\ir ../supabase/migrations/20260919162204_crm_lead_focus.sql
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture owner','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture CRM','crm',array['crm']::public.team_role[],'22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Fixture other','crm',array['crm']::public.team_role[],'33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fixture operator','operator',array['operator']::public.team_role[],'44444444-4444-4444-8444-444444444444');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members;
insert into public.locations(id,name) values('99999999-9999-4999-8999-999999999999','Installed fixture location');
insert into public.location_pipeline_leads(id,place_name,status,assigned_to_user_id,created_by_member_id,visibility,next_action,next_action_date,converted_location_id)
select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Focus fixture '||lpad(n::text,2,'0'),case n when 43 then 'accepted' when 44 then 'machine_placed' when 45 then 'rejected' else 'want_to_contact' end,
 case when n=46 then 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' else 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' end::uuid,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',case when n=46 then 'assigned' else 'team' end,
 case when n=1 then 'Keep the earlier appointment' else null end,
 case when n=1 then (now() at time zone 'Africa/Tripoli')::date-1 when n in (44,45) then (now() at time zone 'Africa/Tripoli')::date-5 else null end,
 case when n=44 then '99999999-9999-4999-8999-999999999999'::uuid end
from generate_series(1,46)n;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$
declare a uuid:='60000000-0000-4000-8000-000000000040';b uuid:='60000000-0000-4000-8000-000000000041';early uuid:='60000000-0000-4000-8000-000000000001';closed uuid:='60000000-0000-4000-8000-000000000045';
 request uuid:=gen_random_uuid();today date:=(now() at time zone 'Africa/Tripoli')::date;data jsonb;items jsonb;answer jsonb;again jsonb;bad jsonb;blocked boolean;cnt int;version text;
begin
 data:=public.snacky_crm_lead_desk_v1('{}');if (data->>'total')::int<>46 then raise exception 'Lead count mismatch';end if;
 if data#>>'{rows,0,id}'<>early::text then raise exception 'Overdue work is not first before focus';end if;
 if (public.snacky_crm_lead_desk_v1('{"group":"agreed"}')->>'total')::int<>1 or (public.snacky_crm_lead_desk_v1('{"group":"installed"}')->>'total')::int<>1 or (public.snacky_crm_lead_desk_v1('{"group":"declined"}')->>'total')::int<>1 then raise exception 'Outcome segments wrong';end if;
 if (public.snacky_crm_lead_desk_v1('{"window":"overdue"}')->>'total')::int<>1 then raise exception 'Installed or declined treated as overdue';end if;
 -- Select records from a later page by server search; retain exact revision tokens.
 select jsonb_agg(jsonb_build_object('id',r->>'id','version',r#>>'{data,version}','focus_revision',r->'focus_revision') order by r->>'id') into items
 from jsonb_array_elements(public.snacky_crm_lead_desk_v1('{"q":"Focus fixture 4"}')->'rows')r where r->>'id' in (a::text,b::text);
 answer:=public.snacky_crm_lead_focus_command_v1(request,'set',items,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+6,null);
 again:=public.snacky_crm_lead_focus_command_v1(request,'set',items,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+6,null);
 if answer<>again or (answer->>'count')::int<>2 then raise exception 'Replay was not idempotent';end if;
 data:=public.snacky_crm_lead_desk_v1('{}');if data#>>'{rows,0,id}' not in (a::text,b::text) or data#>>'{rows,1,id}' not in (a::text,b::text) or data#>>'{rows,2,id}'<>early::text then raise exception 'Focus was not sorted before all pages/overdue';end if;
 if data#>>'{rows,0,assigned_to}'<>'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' or data#>>'{rows,0,next_action}' is null then raise exception 'Assignment or research next step missing';end if;
 blocked:=false;begin perform public.snacky_crm_lead_focus_command_v1(request,'set',items,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+7,null);exception when unique_violation then blocked:=true;end;if not blocked then raise exception 'Same id accepted changed payload';end if;
 blocked:=false;begin perform count(*) from crm_lead_private.focus;exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Private focus readable directly';end if;
 -- CRM may read their new assignment but cannot focus/reassign through this manager endpoint.
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 data:=public.snacky_crm_lead_desk_v1('{"focus":"active","scope":"mine"}');if (data->>'total')::int<>2 then raise exception 'Employee focus missing';end if;
 if (public.snacky_crm_lead_desk_v1('{}')->>'total')::int<>45 then raise exception 'Private lead leaked';end if;
 blocked:=false;begin perform public.snacky_crm_lead_focus_command_v1(gen_random_uuid(),'set',items,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+6,null);exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'CRM changed management focus';end if;
 perform set_config('request.path','/rpc/snacky_crm_lead_desk_v1',true);perform set_config('request.method','POST',true);perform public.snacky_crm_api_request_guard();
 perform set_config('request.path','/rpc/legacy_finance_write',true);blocked:=false;begin perform public.snacky_crm_api_request_guard();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'API boundary broadened';end if;
 -- The original assignee can fill the new place's missing information and log a genuine interaction.
 data:=public.snacky_crm_workspace_v1('lead',a,'{}');version:=data#>>'{record,data,version}';
 perform public.snacky_crm_command_v1(gen_random_uuid(),'lead.save',a,jsonb_build_object('version',version,'contact_person_name','Test office contact','contact_phone','0911234567'));
 perform public.snacky_crm_command_v1(gen_random_uuid(),'note.add',a,'{"kind":"lead","activity_type":"note","summary":"Fixture research completed; actual next action recorded."}');
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 blocked:=false;begin perform public.snacky_crm_lead_focus_command_v1(gen_random_uuid(),'set',items,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+6,null);exception when serialization_failure then blocked:=true;end;if not blocked then raise exception 'Stale update was accepted';end if;
 -- A later invalid record must roll back an earlier valid member of the same batch.
 select jsonb_agg(jsonb_build_object('id',r->>'id','version',r#>>'{data,version}','focus_revision',r->'focus_revision') order by r->>'id') into bad
 from jsonb_array_elements(public.snacky_crm_lead_desk_v1('{"q":"Focus fixture 0"}')->'rows')r where r->>'id'=early::text;
 data:=public.snacky_crm_lead_desk_v1('{"group":"declined"}');bad:=bad||jsonb_build_array(jsonb_build_object('id',closed,'version',data#>>'{rows,0,data,version}','focus_revision',0));
 blocked:=false;begin perform public.snacky_crm_lead_focus_command_v1(gen_random_uuid(),'set',bad,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+6,null);exception when invalid_parameter_value then blocked:=true;end;if not blocked then raise exception 'Closed lead focused';end if;
 data:=public.snacky_crm_workspace_v1('lead',early,'{}');if data#>>'{record,assigned_to}'<>'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then raise exception 'Partial batch assignment escaped rollback';end if;
 bad:=jsonb_build_array(jsonb_build_object('id',early,'version',data#>>'{record,data,version}','focus_revision',0));
 perform public.snacky_crm_lead_focus_command_v1(gen_random_uuid(),'set',bad,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',today+6,null);
 data:=public.snacky_crm_workspace_v1('lead',early,'{}');if data#>>'{record,due_date}'<>(today-1)::text or data#>>'{record,next_action}'<>'Keep the earlier appointment' then raise exception 'Existing deadline or instructions overwritten';end if;
 -- Clear metadata only, not the lead, deadline or employee.
 data:=public.snacky_crm_lead_desk_v1('{"q":"Focus fixture 40"}');bad:=jsonb_build_array(jsonb_build_object('id',a,'version',data#>>'{rows,0,data,version}','focus_revision',data#>'{rows,0,focus_revision}'));
 perform public.snacky_crm_lead_focus_command_v1(gen_random_uuid(),'clear',bad);
 data:=public.snacky_crm_lead_desk_v1('{"q":"Focus fixture 40"}');if (data#>>'{rows,0,focused}')::boolean or data#>>'{rows,0,assigned_to}'<>'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' then raise exception 'Clear changed the assignment or kept focus';end if;
 perform set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
 blocked:=false;begin perform public.snacky_crm_lead_desk_v1('{}');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Operator lead directory access';end if;
end $$;
reset role;
-- Time passes without a cleanup job. Metadata persists but expired focus is not active.
update crm_lead_private.focus set starts_on=(now() at time zone 'Africa/Tripoli')::date-7,ends_on=(now() at time zone 'Africa/Tripoli')::date-1 where lead_id='60000000-0000-4000-8000-000000000041';
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$begin
 if (public.snacky_crm_lead_desk_v1('{"q":"Focus fixture 41","focus":"active"}')->>'total')::int<>0 then raise exception 'Expired focus still active';end if;
 if (public.snacky_crm_lead_desk_v1('{"q":"Focus fixture 41","scope":"mine"}')->>'total')::int<>1 then raise exception 'Expiry lost assignment or source';end if;
end $$;
reset role;
update public.team_members set active=false,active_status='inactive' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
set local role authenticated;
do $$declare blocked boolean:=false;begin begin perform public.snacky_crm_lead_desk_v1('{}');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Inactive linked employee retained focus access';end if;end $$;
reset role;
do $$begin
 if exists(select 1 from focus_legacy_fingerprints where digest<>md5(pg_get_functiondef(oid))) then raise exception 'Existing CRM functions changed';end if;
 if exists(select 1 from public.crm_tasks) or exists(select 1 from public.financial_transactions) then raise exception 'Focus created tasks or money';end if;
 if has_function_privilege('anon','public.snacky_crm_lead_desk_v1(jsonb)','EXECUTE') then raise exception 'Anonymous RPC grant';end if;
 if has_table_privilege('authenticated','crm_lead_private.focus','SELECT') then raise exception 'Private direct table grant';end if;
 if (select count(*) from crm_lead_private.receipts)<>3 then raise exception 'Retry or failed batch produced receipt';end if;
end $$;
rollback;
\echo 'Lead focus privacy, atomicity, ordering, expiry and native workflow invariants passed.'
