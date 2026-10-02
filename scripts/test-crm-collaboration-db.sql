\set ON_ERROR_STOP on
-- The inherited fixture refuses every database except disposable crm_tests.
\ir test-crm-lead-focus-db.sql
alter table public.profiles add column full_name text not null default 'Fixture user';
\ir ../supabase/migrations/20260920133731_shared_buying_lists.sql
\ir ../supabase/migrations/20260927123856_crm_notes_labels_v1.sql
begin;
create function pg_temp.check_ok(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAIL: %',label;end if;raise notice 'PASS: %',label;end$$;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444'),('55555555-5555-4555-8555-555555555555');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture owner','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture CRM','crm',array['crm']::public.team_role[],'22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Other CRM','crm',array['crm']::public.team_role[],'33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fixture warehouse','warehouse',array['warehouse','operator']::public.team_role[],'44444444-4444-4444-8444-444444444444'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Fixture operator','operator',array['operator']::public.team_role[],'55555555-5555-4555-8555-555555555555');
insert into public.profiles(id,team_member_id,full_name,role,roles) select auth_user_id,id,full_name,role,roles from public.team_members;
insert into public.location_pipeline_leads(id,place_name,assigned_to_user_id,created_by_member_id,visibility)
select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Label fixture '||lpad(n::text,2,'0'),
 case when n=46 then 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' else 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' end::uuid,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','assigned' from generate_series(1,46)n;
create temp table original_leads as select id,md5(to_jsonb(l)::text) digest from public.location_pipeline_leads l;
create function public.collab_forbid_source_write() returns trigger language plpgsql as $$begin raise exception 'Collaboration changed native work or Finance';end$$;
create trigger collab_no_lead_write before update or delete on public.location_pipeline_leads for each row execute function public.collab_forbid_source_write();
create trigger collab_no_task_write before insert or update or delete on public.crm_tasks for each row execute function public.collab_forbid_source_write();
create trigger collab_no_money_write before insert or update or delete on public.financial_transactions for each row execute function public.collab_forbid_source_write();
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$
declare d jsonb;answer jsonb;again jsonb;cmd jsonb;blocked boolean;rid uuid:=gen_random_uuid();
 note uuid:='70000000-0000-4000-8000-000000000001';label uuid:='80000000-0000-4000-8000-000000000001';
 lead uuid:='60000000-0000-4000-8000-000000000041';n integer;
begin
 blocked:=false;begin perform public.snacky_buying_workspace_v1();exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'CRM-only buying workspace denied');
 perform set_config('request.path','/rpc/snacky_buying_workspace_v1',true);perform set_config('request.method','POST',true);
 blocked:=false;begin perform public.snacky_crm_api_request_guard();exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'CRM API buying bypass removed');
 perform set_config('request.path','/rpc/snacky_crm_collaboration_workspace_v1',true);perform public.snacky_crm_api_request_guard();
 perform pg_temp.check_ok(true,'new collaboration RPC accepted by CRM boundary');
 cmd:=jsonb_build_object('request_id',rid,'id',note,'action','note.create','revision',0,'payload',jsonb_build_object('body','Location requests an owner decision','lead_id',lead));
 answer:=public.snacky_crm_collaboration_command_v1(cmd);again:=public.snacky_crm_collaboration_command_v1(cmd);
 perform pg_temp.check_ok(answer=again,'note retry returns exact receipt');
 d:=public.snacky_crm_collaboration_workspace_v1('notes',null,'open',0);
 perform pg_temp.check_ok((d->>'total')::int=1 and d#>>'{rows,0,body}'='Location requests an owner decision','CRM sees saved note after read');
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(cmd||jsonb_build_object('payload',jsonb_build_object('body','Changed','lead_id',lead)));exception when unique_violation then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'same request cannot silently change note');
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',note,'action','note.review','revision',1,'payload','{"status":"done","response":"self approved"}'::jsonb));exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'CRM cannot mark own note reviewed by management');
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 d:=public.snacky_crm_collaboration_workspace_v1('notes',note,'all',0);perform pg_temp.check_ok((d->>'total')::int=0,'other CRM cannot read private management note');
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 d:=public.snacky_crm_collaboration_workspace_v1('notes',null,'open',0);perform pg_temp.check_ok((d->>'total')::int=1,'owner sees CRM management inbox');
 perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',note,'action','note.review','revision',1,'payload','{"status":"seen","response":"Please arrange a visit"}'::jsonb));
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',note,'action','note.review','revision',1,'payload','{"status":"done","response":"stale"}'::jsonb));exception when serialization_failure then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'stale owner review rejected');
 d:=public.snacky_buying_workspace_v1();perform pg_temp.check_ok(not exists(select 1 from jsonb_array_elements(d->'people')x where x->>'id'='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'pure CRM omitted from buying assignee choices');
 perform set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
 d:=public.snacky_buying_workspace_v1();perform pg_temp.check_ok(d->>'me'='dddddddd-dddd-4ddd-8ddd-dddddddddddd','warehouse/operator buying still works');
 blocked:=false;begin perform public.snacky_crm_collaboration_workspace_v1();exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'operational employee cannot read management notes');
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 d:=public.snacky_crm_collaboration_workspace_v1('notes',note,'all',0);
 perform pg_temp.check_ok(d#>>'{rows,0,response}'='Please arrange a visit' and d#>>'{rows,0,status}'='seen','CRM sees owner response and state');
 perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',label,'action','label.create','revision',0,'payload','{"name":"This week","color":"blue"}'::jsonb));
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',gen_random_uuid(),'action','label.create','revision',0,'payload','{"name":" this WEEK ","color":"green"}'::jsonb));exception when unique_violation then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'personal duplicate label names prevented');
 cmd:=jsonb_build_object('request_id',gen_random_uuid(),'id',lead,'action','labels.set','revision',0,'payload',jsonb_build_object('label_ids',jsonb_build_array(label)));
 answer:=public.snacky_crm_collaboration_command_v1(cmd);again:=public.snacky_crm_collaboration_command_v1(cmd);perform pg_temp.check_ok(answer=again,'label assignment retry idempotent');
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(cmd||jsonb_build_object('request_id',gen_random_uuid()));exception when serialization_failure then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'stale label set rejected');
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(cmd||jsonb_build_object('request_id',gen_random_uuid(),'id','60000000-0000-4000-8000-000000000046'));exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'cannot organize another employees private lead');
 d:=public.snacky_crm_lead_desk_v1(jsonb_build_object('label',label));
 perform pg_temp.check_ok((d->>'total')::int=1 and d#>>'{rows,0,id}'=lead::text and d#>>'{rows,0,labels,0,name}'='This week','label filter applies before pagination and enriches lead row');
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 d:=public.snacky_crm_lead_desk_v1(jsonb_build_object('label',label));
 perform pg_temp.check_ok((d->>'total')::int=1 and d#>>'{rows,0,labels,0,owner_name}'='Fixture CRM','owner can see exactly how CRM organized lead');
 blocked:=false;begin perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',label,'action','label.update','revision',1,'payload','{"name":"overwrite","color":"rose","archived":false}'::jsonb));exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'owner inspection does not overwrite employee personal label');
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 d:=public.snacky_crm_collaboration_workspace_v1('labels');perform pg_temp.check_ok(jsonb_array_length(d->'options')=0,'other CRM label library private');
 d:=public.snacky_crm_lead_desk_v1(jsonb_build_object('label',label));perform pg_temp.check_ok((d->>'total')::int=0,'label filter never grants lead access');
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',label,'action','label.update','revision',1,'payload','{"name":"Needs visit","color":"green","archived":false}'::jsonb));
 d:=public.snacky_crm_lead_desk_v1(jsonb_build_object('label',label));perform pg_temp.check_ok(d#>>'{rows,0,labels,0,name}'='Needs visit','label rename persists to lead view');
 perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',label,'action','label.update','revision',2,'payload','{"name":"Needs visit","color":"green","archived":true}'::jsonb));
 d:=public.snacky_crm_lead_desk_v1(jsonb_build_object('label',label));perform pg_temp.check_ok((d->>'total')::int=0,'archiving label removes filter result without deleting lead');
 for n in 1..12 loop perform public.snacky_crm_collaboration_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'id',gen_random_uuid(),'action','note.create','revision',0,'payload',jsonb_build_object('body','Update '||n,'lead_id',null)));end loop;
 d:=public.snacky_crm_collaboration_workspace_v1('notes',null,'all',10);perform pg_temp.check_ok((d->>'total')::int=13 and jsonb_array_length(d->'rows')=3,'notes full total with bounded second page');
 blocked:=false;begin perform count(*) from crm_collab_private.notes;exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.check_ok(blocked,'raw notes inaccessible to signed-in clients');
end $$;
reset role;
update public.profiles set roles=array['crm','warehouse']::public.team_role[] where id='22222222-2222-4222-8222-222222222222';
set local role authenticated;
select pg_temp.check_ok(public.snacky_buying_workspace_v1()->>'me'='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','explicit additional warehouse role preserves buying access');
reset role;
update public.profiles set active_status='inactive' where id='22222222-2222-4222-8222-222222222222';
set local role authenticated;
do $$declare denied boolean:=false;begin begin perform public.snacky_crm_collaboration_workspace_v1();exception when insufficient_privilege then denied:=true;end;perform pg_temp.check_ok(denied,'deactivated account blocked immediately');end$$;
reset role;
select pg_temp.check_ok(not exists(select 1 from public.location_pipeline_leads l join original_leads o using(id) where md5(to_jsonb(l)::text)<>o.digest),'lead stages assignments and timestamps untouched');
select pg_temp.check_ok(not exists(select 1 from public.financial_transactions) and not exists(select 1 from public.crm_tasks) and not exists(select 1 from crm_lead_private.focus),'no money task or management-focus changes');
select pg_temp.check_ok((select count(*) from crm_collab_private.events where action='note.review')=1,'owner review has one audit event after stale retry');
select pg_temp.check_ok(not has_function_privilege('anon','public.snacky_crm_collaboration_workspace_v1(text,uuid,text,integer)','execute'),'anonymous notes access denied');
select pg_temp.check_ok(not exists(select 1 from pg_proc where oid in ('public.snacky_crm_collaboration_workspace_v1(text,uuid,text,integer)'::regprocedure,'public.snacky_crm_collaboration_command_v1(jsonb)'::regprocedure) and prosecdef),'public RPC wrappers security invoker');
rollback;
