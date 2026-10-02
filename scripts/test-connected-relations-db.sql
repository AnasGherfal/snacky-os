\set ON_ERROR_STOP on
select current_database()='crm_tests' as isolated \gset
\if :isolated
\else
 \echo 'Refusing fixtures outside crm_tests'
 \quit 2
\endif
create role authenticator nologin;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;create schema storage;
grant usage on schema auth,storage,public to authenticated,service_role;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create type public.team_role as enum('owner','admin','supervisor','crm','operator','finance','warehouse','purchasing','investor','viewer');
create type public.location_type as enum('school','hospital','mall','university','office','gym','other');
create type public.issue_priority as enum('critical','high','normal','low');
create type public.issue_status as enum('open','assigned','in_progress','resolved','closed');
create table public.team_members(id uuid primary key,full_name text,role public.team_role,roles public.team_role[],active boolean default true,active_status text default 'active',auth_user_id uuid);
create table public.profiles(id uuid primary key,team_member_id uuid,role public.team_role,roles public.team_role[],active_status text default 'active');
create function public.snacky_current_team_member_id() returns uuid language sql stable security definer set search_path=public,pg_catalog as $$select team_member_id from public.profiles where id=auth.uid() and active_status='active'$$;
create function public.snacky_current_profile_has_any_role(allowed text[]) returns boolean language sql stable security definer set search_path=public,pg_catalog as $$select exists(select 1 from public.profiles where id=auth.uid() and active_status='active' and (role::text=any(allowed) or coalesce(roles::text[],'{}')&&allowed))$$;
create table public.locations(id uuid primary key default gen_random_uuid(),name text not null,location_type public.location_type default 'other',address text,contact_name text,contact_phone text,rent_amount numeric,rent_type text,contract_start date,contract_end date,status text default 'active',notes text,metadata jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now());
create table public.machines(id uuid primary key default gen_random_uuid(),name text,machine_code text,location_id uuid references public.locations,status text default 'active',vms_online_status text,last_vms_status_at timestamptz,installed_date date,vms_cash_balance_lyd numeric);
create table public.products(id uuid primary key default gen_random_uuid(),name text);
create table public.location_pipeline_leads(id uuid primary key default gen_random_uuid(),place_name text not null,place_type public.location_type default 'other',city text,area text,address_text text,google_maps_url text,contact_person_name text,contact_person_job_title text,contact_phone text,contact_whatsapp text,contacted_by_user_id uuid,first_contact_date date,last_contact_date date,next_follow_up_date date,status text default 'want_to_contact',notes text,estimated_traffic integer,rent_expectation numeric,rejection_reason text,converted_location_id uuid references public.locations,converted_at timestamptz,converted_by_user_id uuid,is_archived boolean default false,archived_at timestamptz,archived_by_user_id uuid,created_at timestamptz default now(),updated_at timestamptz default now(),source text default 'manual',priority text default 'normal',assigned_to_user_id uuid references public.team_members,next_action text,next_action_date date,last_activity_at timestamptz,imported_source text,imported_category text);
create table public.location_pipeline_activities(id uuid primary key default gen_random_uuid(),lead_id uuid references public.location_pipeline_leads on delete cascade,activity_type text,summary text,outcome text,occurred_at timestamptz default now(),next_action text,next_action_date date,created_by_user_id uuid,created_at timestamptz default now());
create table public.issues(id uuid primary key default gen_random_uuid(),machine_id uuid references public.machines on delete cascade,reported_by uuid,assigned_to uuid,issue_type text not null,priority public.issue_priority default 'normal',status public.issue_status default 'open',description text,photo_url text,created_at timestamptz default now(),resolved_at timestamptz,sla_due_at timestamptz,customer_name text,customer_phone text,contact_channel text default 'other');
create table public.financial_transactions(id uuid primary key default gen_random_uuid(),direction text,transaction_effect text,currency text,amount numeric,related_location_id uuid references public.locations,transaction_date date,transaction_status text,is_void boolean,voided_at timestamptz,needs_review boolean,review_status text,notes text,description text,updated_at timestamptz default now());
create table public.finance_opening_balances(id uuid primary key default gen_random_uuid(),balance numeric);
create table public.system_activity_logs(id uuid primary key default gen_random_uuid(),actor_user_id uuid,actor_team_member_id uuid,actor_name text,action text,entity_type text,entity_id uuid,summary text,before_data jsonb,after_data jsonb,metadata jsonb,created_at timestamptz default now());
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,name text,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert on storage.objects to authenticated;
grant select,insert,update,delete on all tables in schema public to authenticated;
alter table public.location_pipeline_leads enable row level security;
alter table public.location_pipeline_activities enable row level security;
alter table public.issues enable row level security;
alter table public.profiles enable row level security;
create policy fixture_self on public.profiles for select to authenticated using(id=auth.uid());
\ir ../supabase/migrations/20260915200000_connected_relations_schema.sql
\ir ../supabase/migrations/20260915200100_connected_relations_commands.sql
\ir ../supabase/migrations/20260915200200_connected_relations_reads.sql
\ir ../supabase/migrations/20260915200300_connected_relations_guards.sql
\ir ../supabase/migrations/20260915200400_connected_relations_api_boundary.sql
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444'),('55555555-5555-4555-8555-555555555555');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture manager','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture relations','crm',array['crm']::public.team_role[],'22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Fixture colleague','crm',array['crm']::public.team_role[],'33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fixture operator','operator',array['operator']::public.team_role[],'44444444-4444-4444-8444-444444444444'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Fixture investor','investor',array['investor']::public.team_role[],'55555555-5555-4555-8555-555555555555');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members;
insert into public.locations(id,name) values('99999999-9999-4999-8999-999999999999','Fixture location');
insert into public.machines(id,name,machine_code,location_id,vms_cash_balance_lyd) values('88888888-8888-4888-8888-888888888888','Fixture machine','F1','99999999-9999-4999-8999-999999999999',12345);
insert into public.finance_opening_balances(balance) values(98765);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$
declare lead uuid;issue uuid;task uuid;contact uuid;site uuid;rent uuid;res jsonb;again jsonb;payload jsonb;version text;blocked boolean;count_before int;history_first jsonb;history_next jsonb;j integer;
begin
 payload:=jsonb_build_object('place_name','Fixture university','place_type','university','assigned_to','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','visibility','assigned','next_action','Call manager','next_action_date',current_date-1);
 res:=public.snacky_crm_command_v1('10000000-0000-4000-8000-000000000001','lead.save',null,payload);lead:=(res->>'id')::uuid;
 again:=public.snacky_crm_command_v1('10000000-0000-4000-8000-000000000001','lead.save',null,payload);
 if res<>again then raise exception 'Lead retry duplicated';end if;
 blocked:=false;begin perform public.snacky_crm_command_v1('10000000-0000-4000-8000-000000000001','lead.save',null,payload||'{"place_name":"Different"}');exception when unique_violation then blocked:=true;end;if not blocked then raise exception 'Changed payload reused command';end if;
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 if public.snacky_crm_allowed('lead',lead) then raise exception 'Private lead leaked to unrelated colleague';end if;
 blocked:=false;begin perform public.snacky_crm_workspace_v1('lead',lead);exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Private lead projection leaked';end if;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 res:=public.snacky_crm_workspace_v1('work',null,'{"scope":"mine","window":"overdue"}');
 if (res->>'total')::int<>1 then raise exception 'Overdue lead missing from My Work: %',res;end if;
 if exists(select 1 from public.finance_opening_balances) or exists(select 1 from public.machines) or exists(select 1 from public.locations) then raise exception 'CRM can access unfiltered raw balances/machine/location records';end if;
 if (select count(*) from public.team_members)<>1 then raise exception 'CRM raw directory is not self-only';end if;
 perform public.snacky_crm_command_v1(gen_random_uuid(),'note.add',lead,'{"kind":"lead","activity_type":"call","summary":"Manager interested; meeting requested."}');
 perform set_config('request.path','/rpc/snacky_crm_workspace_v1',true);perform set_config('request.method','POST',true);
 perform public.snacky_crm_api_request_guard();
 perform set_config('request.path','/rpc/legacy_finance_function',true);
 blocked:=false;begin perform public.snacky_crm_api_request_guard();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'CRM legacy RPC boundary failed';end if;
 perform set_config('request.path','/profiles',true);perform set_config('request.method','PATCH',true);
 blocked:=false;begin perform public.snacky_crm_api_request_guard();exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'CRM raw profile edit boundary failed';end if;
 perform set_config('request.path','/rpc/snacky_crm_command_v1',true);perform set_config('request.method','POST',true);
 for j in 1..45 loop
  perform public.snacky_crm_command_v1(gen_random_uuid(),'note.add',lead,jsonb_build_object('kind','lead','activity_type','note','summary','Timeline fixture '||j));
 end loop;
 history_first:=public.snacky_crm_timeline_v1('lead',lead,0);history_next:=public.snacky_crm_timeline_v1('lead',lead,40);
 if jsonb_array_length(history_first->'rows')<>40 or jsonb_array_length(history_next->'rows')=0 then raise exception 'Older history is not accessible';end if;
 if exists(select 1 from jsonb_array_elements(history_first->'rows') a join jsonb_array_elements(history_next->'rows') b on a->>'id'=b->>'id') then raise exception 'History pages overlap';end if;

 res:=public.snacky_crm_command_v1(gen_random_uuid(),'contact.save',null,jsonb_build_object('name','Fixture manager contact','phone','0911234567','kind','lead','related_id',lead));contact:=(res->>'id')::uuid;
 again:=public.snacky_crm_command_v1(gen_random_uuid(),'contact.save',null,jsonb_build_object('name','Same person','phone','+218911234567','kind','lead','related_id',lead));
 if again->>'id'<>contact::text then raise exception 'Contact phone normalization duplicated person';end if;
 res:=public.snacky_crm_workspace_v1('lead',lead);version:=res#>>'{record,data,version}';
 perform public.snacky_crm_command_v1(gen_random_uuid(),'lead.save',lead,jsonb_build_object('version',version,'status','accepted'));
 res:=public.snacky_crm_command_v1(gen_random_uuid(),'lead.convert',lead,'{}');site:=(res->>'id')::uuid;
 again:=public.snacky_crm_command_v1(gen_random_uuid(),'lead.convert',lead,'{}');if again->>'id'<>site::text then raise exception 'Conversion created duplicate location';end if;
 res:=public.snacky_crm_workspace_v1('location',site);
 if jsonb_array_length(res->'contacts')<>1 or jsonb_array_length(res->'activities')<2 then raise exception 'Conversion lost contacts or timeline';end if;
 res:=public.snacky_crm_command_v1(gen_random_uuid(),'issue.save',null,'{"customer_phone":"0917654321","location_id":"99999999-9999-4999-8999-999999999999","machine_id":"88888888-8888-4888-8888-888888888888","description":"Fixture product jam","issue_type":"product_stuck","status":"waiting","waiting_on":"Operator inspection","next_action_date":"2020-01-01"}');issue:=(res->>'id')::uuid;
 res:=public.snacky_crm_command_v1(gen_random_uuid(),'task.save',null,jsonb_build_object('kind','issue','related_id',issue,'title','Inspect fixture machine','task_type','field_action','assigned_to','dddddddd-dddd-4ddd-8ddd-dddddddddddd','due_date',current_date));task:=(res->>'id')::uuid;
 perform set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
 res:=public.snacky_crm_workspace_v1('task',task);version:=res#>>'{record,data,version}';
 perform public.snacky_crm_command_v1(gen_random_uuid(),'task.save',task,jsonb_build_object('version',version,'status','completed','result','Cleared jam and tested vend.'));
 blocked:=false;begin perform public.snacky_crm_command_v1(gen_random_uuid(),'issue.save',issue,'{"status":"resolved"}');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Operator closed customer complaint';end if;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 res:=public.snacky_crm_workspace_v1('issue',issue);
 if res#>>'{record,status}'='resolved' or res#>>'{record,data,field_completed_at}' is null or res#>>'{tasks,0,result}'<>'Cleared jam and tested vend.' then raise exception 'Operator handoff not reflected on issue: %',res;end if;
 version:=res#>>'{record,data,version}';
 perform public.snacky_crm_command_v1(gen_random_uuid(),'issue.save',issue,jsonb_build_object('version',version,'status','resolved','resolution','Customer notified and issue resolved.','refund_amount_lyd',0));
 res:=public.snacky_crm_workspace_v1('issue',issue);
 if res#>>'{record,status}'<>'resolved' then raise exception 'Resolution failed';end if;
 if jsonb_array_length(res->'activities')<4 then raise exception 'Issue audit history missing';end if;
 blocked:=false;begin delete from public.crm_activities where issue_id=issue;exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'CRM can delete audit history';end if;
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 res:=public.snacky_crm_command_v1(gen_random_uuid(),'obligation.create',null,'{"location_id":"99999999-9999-4999-8999-999999999999","title":"Fixture rent","amount_lyd":100,"due_date":"2020-02-01","frequency":"monthly","assigned_to":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}');rent:=(res->>'id')::uuid;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 blocked:=false;begin perform public.snacky_crm_command_v1(gen_random_uuid(),'obligation.paid',rent,'{"payment_date":"2020-01-31","payment_method":"cash"}');exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'Rent reported paid without proof';end if;
 insert into storage.objects(bucket_id,name) values('crm-documents',auth.uid()::text||'/obligation/'||rent::text||'/fixture.pdf');
 perform public.snacky_crm_command_v1(gen_random_uuid(),'document.register',rent,jsonb_build_object('kind','obligation','object_path',auth.uid()::text||'/obligation/'||rent::text||'/fixture.pdf','original_name','fixture.pdf','mime_type','application/pdf'));
 perform public.snacky_crm_command_v1(gen_random_uuid(),'obligation.paid',rent,'{"payment_date":"2020-01-31","payment_method":"cash"}');
 res:=public.snacky_crm_workspace_v1('obligation',rent);
 if res#>>'{record,status}'<>'paid' or res#>>'{record,data,finance_verified_at}' is not null then raise exception 'Administrative paid state confused with Finance';end if;
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 if exists(select 1 from public.location_admin_obligations) then raise exception 'Unassigned rent leaked';end if;
 if exists(select 1 from public.crm_activities where obligation_id=rent) then raise exception 'Rent amount leaked through location activity';end if;
 res:=public.snacky_crm_workspace_v1('location','99999999-9999-4999-8999-999999999999');
 if (res->'activities')::text like '%Fixture rent%' then raise exception 'Rent leaked through location timeline';end if;
 res:=public.snacky_crm_workspace_v1('search',null,'{"q":"Fixture rent"}');
 if (res->>'total')::int<>0 then raise exception 'Private rent found through global search';end if;

 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 if exists(select 1 from public.financial_transactions) then raise exception 'CRM workflow invented a payment';end if;
 res:=public.snacky_crm_workspace_v1('management');
 if jsonb_array_length(res->'performance')<3 then raise exception 'Management cannot see team metrics';end if;
 perform set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
 blocked:=false;begin perform public.snacky_crm_workspace_v1('work');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Investor entered CRM workspace';end if;
 raise notice 'PASS: scoped ownership, private leads, unified overdue work, retained conversion history, reusable contacts, operator handoff, retained resolution, rent proof, no Finance writes, investor isolation';
end $$;
reset role;
-- Restricted inactive accounts must remain restricted, not gain legacy access.
update public.profiles set active_status='inactive' where id='22222222-2222-4222-8222-222222222222';
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$declare blocked boolean:=false;begin
 if not public.snacky_crm_is_limited() then raise exception 'Deactivation bypasses limited-role boundary';end if;
 if exists(select 1 from public.finance_opening_balances) then raise exception 'Inactive CRM can read balances';end if;
 begin perform public.snacky_crm_api_request_guard();exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Inactive CRM passed API request guard';end if;
end $$;
reset role;
rollback;
