create schema if not exists buying_private;
create function buying_private.member() returns uuid language sql stable as $$select null::uuid$$;
\ir ../supabase/migrations/20260923174536_crm_operator_dispatch_v1.sql

begin;
insert into auth.users(id) values
 ('61111111-1111-4111-8111-111111111111'),
 ('62222222-2222-4222-8222-222222222222'),
 ('63333333-3333-4333-8333-333333333333');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Dispatch CRM','crm',array['crm']::public.team_role[],'61111111-1111-4111-8111-111111111111'),
 ('6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Operator A','operator',array['operator']::public.team_role[],'62222222-2222-4222-8222-222222222222'),
 ('6ccccccc-cccc-4ccc-8ccc-cccccccccccc','Operator B','operator',array['operator']::public.team_role[],'63333333-3333-4333-8333-333333333333');
insert into public.profiles(id,team_member_id,role,roles)
select auth_user_id,id,role,roles from public.team_members where id::text like '6%';
insert into public.locations(id,name,location_type,status)
values('69999999-9999-4999-8999-999999999999','Dispatch Fixture Location','office','active');

create function public.qa_dispatch_photo(p_task uuid,p_uploader uuid)
returns void language sql security definer set search_path=public,pg_catalog
as $$insert into public.crm_documents(task_id,object_path,original_name,mime_type,uploaded_by)
values(p_task,'qa/'||p_task::text||'.jpg','proof.jpg','image/jpeg',p_uploader);$$;
grant execute on function public.qa_dispatch_photo(uuid,uuid) to authenticated;

set local role authenticated;
do $$
declare
 issue_id uuid; issue2_id uuid; task_id uuid; task2_id uuid;
 v jsonb; retry jsonb; t public.crm_tasks%rowtype; i public.issues%rowtype;
 blocked boolean; rid uuid;
begin
 perform set_config('request.jwt.claim.sub','61111111-1111-4111-8111-111111111111',true);
 v:=public.snacky_crm_command_v1(gen_random_uuid(),'issue.save',null,
   '{"customer_phone":"0910000000","location_id":"69999999-9999-4999-8999-999999999999","issue_type":"machine_unavailable","description":"Dispatch acceptance","priority":"critical","contact_channel":"whatsapp"}');
 issue_id:=(v->>'id')::uuid;
 v:=public.snacky_crm_command_v1(gen_random_uuid(),'task.save',null,jsonb_build_object(
   'kind','issue','related_id',issue_id,'title','Restore machine','task_type','field_action',
   'assigned_to','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','due_date',current_date,'priority','urgent'));
 task_id:=(v->>'id')::uuid;
 select * into t from public.crm_tasks where id=task_id;
 if t.dispatch_state<>'assigned' or t.status<>'open' or t.ack_due_at is null
    or t.ack_due_at-t.created_at not between interval '9 minutes' and interval '11 minutes'
 then raise exception 'Dispatch initialization failed';end if;

 perform set_config('request.jwt.claim.sub','63333333-3333-4333-8333-333333333333',true);
 blocked:=false;
 begin perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','accept','version',t.updated_at::text));
 exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Wrong operator accepted';end if;

 perform set_config('request.jwt.claim.sub','62222222-2222-4222-8222-222222222222',true);
 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','accept','version',t.updated_at::text));
 select * into t from public.crm_tasks where id=task_id;
 if t.dispatch_state<>'accepted' or t.status<>'in_progress' then raise exception 'Accept failed';end if;

 blocked:=false;
 begin perform public.snacky_crm_command_v1(gen_random_uuid(),'task.save',task_id,
   jsonb_build_object('version',t.updated_at::text,'status','completed','result','bypass'));
 exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Generic completion bypassed dispatch';end if;

 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','en_route','version',t.updated_at::text));
 select * into t from public.crm_tasks where id=task_id;
 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','start','version',t.updated_at::text));
 select * into t from public.crm_tasks where id=task_id;
 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','block','version',t.updated_at::text,'note','Power disconnected'));
 select * into t from public.crm_tasks where id=task_id;
 if t.dispatch_state<>'blocked' then raise exception 'Blocked failed';end if;
 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','start','version',t.updated_at::text));
 select * into t from public.crm_tasks where id=task_id;

 blocked:=false;
 begin perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task_id,'action','fix','version',t.updated_at::text,'note','Machine restored'));
 exception when check_violation then blocked:=true;end;
 if not blocked then raise exception 'Fixed without photo';end if;

 perform public.qa_dispatch_photo(task_id,'6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 rid:=gen_random_uuid();
 v:=public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',rid,'task_id',task_id,'action','fix','version',t.updated_at::text,'note','Machine restored and tested'));
 retry:=public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',rid,'task_id',task_id,'action','fix','version',t.updated_at::text,'note','Machine restored and tested'));
 if retry is distinct from v then raise exception 'Retry receipt changed';end if;
 select * into t from public.crm_tasks where id=task_id;
 if t.dispatch_state<>'fixed' or t.status<>'completed' then raise exception 'Fix failed';end if;
 select * into i from public.issues where id=issue_id;
 if i.status='resolved' or i.field_completed_at is null then raise exception 'Field work auto-closed issue';end if;

 perform set_config('request.jwt.claim.sub','61111111-1111-4111-8111-111111111111',true);
 perform public.snacky_crm_command_v1(gen_random_uuid(),'issue.save',issue_id,jsonb_build_object(
   'version',i.updated_at::text,'status','resolved','resolution','Customer confirmed normal operation'));
 select * into i from public.issues where id=issue_id;
 if i.status<>'resolved' then raise exception 'CRM could not close verified issue';end if;

 v:=public.snacky_crm_command_v1(gen_random_uuid(),'issue.save',null,
   '{"customer_phone":"0910000001","location_id":"69999999-9999-4999-8999-999999999999","issue_type":"screen_keypad","description":"Reassignment test","priority":"high","contact_channel":"phone"}');
 issue2_id:=(v->>'id')::uuid;
 v:=public.snacky_crm_command_v1(gen_random_uuid(),'task.save',null,jsonb_build_object(
   'kind','issue','related_id',issue2_id,'title','Check screen','task_type','field_action',
   'assigned_to','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','due_date',current_date,'priority','high'));
 task2_id:=(v->>'id')::uuid;
 select * into t from public.crm_tasks where id=task2_id;
 perform set_config('request.jwt.claim.sub','62222222-2222-4222-8222-222222222222',true);
 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task2_id,'action','accept','version',t.updated_at::text));
 select * into t from public.crm_tasks where id=task2_id;
 perform set_config('request.jwt.claim.sub','61111111-1111-4111-8111-111111111111',true);
 perform public.snacky_crm_command_v1(gen_random_uuid(),'task.save',task2_id,jsonb_build_object(
   'version',t.updated_at::text,'assigned_to','6ccccccc-cccc-4ccc-8ccc-cccccccccccc'));
 select * into t from public.crm_tasks where id=task2_id;
 if t.assigned_to<>'6ccccccc-cccc-4ccc-8ccc-cccccccccccc'
    or t.dispatch_state<>'assigned' or t.status<>'open' or t.acknowledged_at is not null
 then raise exception 'Reassignment did not reset handoff';end if;
 perform set_config('request.jwt.claim.sub','62222222-2222-4222-8222-222222222222',true);
 blocked:=false;
 begin perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task2_id,'action','accept','version',t.updated_at::text));
 exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Old assignee retained access';end if;
 perform set_config('request.jwt.claim.sub','63333333-3333-4333-8333-333333333333',true);
 perform public.snacky_issue_dispatch_command_v1(jsonb_build_object(
   'request_id',gen_random_uuid(),'task_id',task2_id,'action','accept','version',t.updated_at::text));

 raise notice 'PASS: CRM operator dispatch lifecycle';
end $$;
reset role;

do $$
begin
 if has_table_privilege('authenticated','crm_dispatch_private.requests','SELECT')
 then raise exception 'Private dispatch receipts leaked';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='snacky_issue_dispatch_command_v1' and not p.prosecdef)
 then raise exception 'Dispatch wrapper must be security invoker';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.crm_tasks'::regclass
   and tgname='crm_dispatch_guard_v1' and tgenabled='O')
 then raise exception 'Dispatch guard missing';end if;
end $$;
rollback;
