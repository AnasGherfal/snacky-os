\set ON_ERROR_STOP on
-- The existing isolated fixture refuses any database other than crm_tests.
-- It applies all five actual CRM migrations and verifies native workflows first.
\ir test-connected-relations-db.sql
\ir ../supabase/migrations/20260916150634_company_hub.sql
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444'),('55555555-5555-4555-8555-555555555555');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture owner','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture relations','crm',array['crm']::public.team_role[],'22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Fixture finance','finance',array['finance']::public.team_role[],'33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fixture operator','operator',array['operator']::public.team_role[],'44444444-4444-4444-8444-444444444444'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Fixture investor','investor',array['investor']::public.team_role[],'55555555-5555-4555-8555-555555555555');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members;
create policy fixture_broad_storage on storage.objects for select to authenticated using(true);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$
declare i uuid:='60000000-0000-4000-8000-000000000001';f uuid:='60000000-0000-4000-8000-000000000002';request uuid:=gen_random_uuid();d jsonb;r jsonb;again jsonb;revision int;blocked boolean;path text;v int;
begin
 d:=jsonb_build_object('title_en','Fixture guide','title_ar','إجراء تجريبي','summary_en','Fixture only','summary_ar','','body_en','Record the outcome.','body_ar','سجّل النتيجة.','section','guides','audience',jsonb_build_array('crm','operator'),'owner_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','review_date','2027-01-01','source_url','','file_id','','work_path','/my-work','external_shareable',false,'requires_ack',true,'notify',true);
 r:=public.snacky_company_command_v1(request,'save',i,0,null,d);
 again:=public.snacky_company_command_v1(request,'save',i,0,null,d);
 if r<>again then raise exception 'Saved retry was not idempotent';end if;
 blocked:=false;begin perform public.snacky_company_command_v1(request,'save',i,0,null,d||'{"title_en":"Changed"}');exception when unique_violation then blocked:=true;end;if not blocked then raise exception 'Changed payload reused request';end if;
 blocked:=false;begin perform count(*) from company_private.items;exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Raw private table access';end if;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 if (public.snacky_company_workspace_v1(null,'{"section":"guides"}')->>'total')::int<>0 then raise exception 'Draft leaked through search';end if;
 blocked:=false;begin perform public.snacky_company_workspace_v1(i);exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Draft leaked by ID';end if;
 blocked:=false;begin perform public.snacky_company_command_v1(gen_random_uuid(),'publish',i,1);exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Employee could publish';end if;
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 r:=public.snacky_company_command_v1(gen_random_uuid(),'publish',i,1);revision:=(r->>'revision')::int;
 path:='11111111-1111-4111-8111-111111111111/'||f::text||'/'||repeat('a',64);
 insert into storage.objects(bucket_id,name) values('company-documents',path);
 r:=public.snacky_company_command_v1(f,'file.register',f,0,null,jsonb_build_object('object_path',path,'digest',repeat('a',64),'original_name','fixture.pdf','mime_type','application/pdf','size_bytes',10));
 d:=d||jsonb_build_object('file_id',f,'body_en','Private draft edit.');
 r:=public.snacky_company_command_v1(gen_random_uuid(),'save',i,revision,null,d);revision:=(r->>'revision')::int;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 r:=public.snacky_company_workspace_v1(i);
 if r#>>'{record,data,body_en}'<>'Record the outcome.' or r->'draft'<>'null'::jsonb then raise exception 'Unpublished edits leaked';end if;
 foreach v in array array[0,-1] loop
  blocked:=false;begin perform public.snacky_company_workspace_v1(i,jsonb_build_object('version',v));exception when invalid_parameter_value then blocked:=true;end;if not blocked then raise exception 'Invalid version exposed draft';end if;
 end loop;
 if public.snacky_company_file_access(path) or exists(select 1 from storage.objects where name=path) then raise exception 'Draft attachment exposed by broad policy';end if;
 if (public.snacky_company_notices_v1()->>'attention_count')::int<>1 then raise exception 'Targeted update missing';end if;
 perform public.snacky_company_command_v1(gen_random_uuid(),'read',i,revision,1);
 if (public.snacky_company_notices_v1()->>'required_count')::int<>1 then raise exception 'Reading implicitly acknowledged';end if;
 perform public.snacky_company_command_v1(gen_random_uuid(),'ack',i,revision,1);
 if (public.snacky_company_notices_v1()->>'attention_count')::int<>0 then raise exception 'Acknowledgement not reflected';end if;
 perform set_config('request.path','/rpc/snacky_company_workspace_v1',true);perform set_config('request.method','POST',true);perform public.snacky_crm_api_request_guard();
 perform set_config('request.path','/rpc/legacy_finance_function',true);blocked:=false;begin perform public.snacky_crm_api_request_guard();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Legacy CRM finance guard weakened';end if;
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 if (public.snacky_company_workspace_v1(null,'{"section":"guides","q":"Fixture"}')->>'total')::int<>0 then raise exception 'Other role search exposed content';end if;
 if exists(select 1 from storage.objects where name=path) then raise exception 'Other role saw attachment';end if;
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 blocked:=false;begin perform public.snacky_company_command_v1(gen_random_uuid(),'publish',i,revision-1);exception when serialization_failure then blocked:=true;end;if not blocked then raise exception 'Stale version published';end if;
 r:=public.snacky_company_command_v1(gen_random_uuid(),'publish',i,revision);revision:=(r->>'revision')::int;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 if not public.snacky_company_file_access(path) or not exists(select 1 from storage.objects where name=path) then raise exception 'Published attachment inaccessible';end if;
 if (public.snacky_company_notices_v1()->>'required_count')::int<>1 then raise exception 'Old receipt acknowledged new version';end if;
 r:=public.snacky_company_workspace_v1(i,'{"version":1}');if r#>>'{record,data,body_en}'<>'Record the outcome.' then raise exception 'Historical content changed';end if;
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 r:=public.snacky_company_command_v1(gen_random_uuid(),'archive',i,revision);revision:=(r->>'revision')::int;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 if (public.snacky_company_notices_v1()->>'attention_count')::int<>0 or public.snacky_company_file_access(path) then raise exception 'Archived content still accessible';end if;
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 r:=public.snacky_company_command_v1(gen_random_uuid(),'restore',i,revision);revision:=(r->>'revision')::int;
 d:=d||'{"audience":["finance"]}'::jsonb;
 r:=public.snacky_company_command_v1(gen_random_uuid(),'save',i,revision,null,d);revision:=(r->>'revision')::int;
 perform public.snacky_company_command_v1(gen_random_uuid(),'publish',i,revision);
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 blocked:=false;begin perform public.snacky_company_workspace_v1(i,'{"version":1}');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Audience narrowing did not protect historical content';end if;
 perform set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
 blocked:=false;begin perform public.snacky_company_notices_v1();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Investor-only account entered staff hub';end if;
end $$;
reset role;
update public.profiles set active_status='inactive' where id='22222222-2222-4222-8222-222222222222';
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$declare blocked boolean:=false;begin
 begin perform public.snacky_company_workspace_v1();exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Inactive staff access';end if;
end $$;
reset role;
do $$begin
 if exists(select 1 from public.financial_transactions) or exists(select 1 from public.location_pipeline_leads) or exists(select 1 from public.crm_tasks) then raise exception 'Company commands wrote money or live tasks';end if;
 if (select count(*) from company_private.versions)<>3 then raise exception 'Published history duplicated or lost';end if;
 if not exists(select 1 from company_private.receipts where version=1 and ack_at is not null) then raise exception 'Historical receipt lost';end if;
 if has_table_privilege('authenticated','company_private.items','SELECT') then raise exception 'Raw private table grant';end if;
 if has_function_privilege('anon','public.snacky_company_workspace_v1(uuid,jsonb)','EXECUTE') then raise exception 'Anonymous Company RPC';end if;
end $$;
rollback;
\echo 'Company Hub database invariants passed.'
