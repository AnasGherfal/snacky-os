\set ON_ERROR_STOP on
-- Disposable PostgreSQL fixture; never run against a Snacky project database.
create role anon; create role authenticated; create role service_role;
create schema auth; create schema snacky_private; create schema buying_private; create schema stocktake_private; create schema snacky_notice_private;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table public.team_members(id uuid primary key,full_name text,auth_user_id uuid,active_status text default 'active',active boolean default true,role text,roles text[]);
create table public.profiles(id uuid primary key,full_name text,team_member_id uuid,active_status text default 'active',role text,roles text[]);
create function public.snacky_profile_has_any_role(roles text[],role text,allowed text[]) returns boolean language sql immutable as $$select (coalesce(roles,'{}')||array[role])&&allowed$$;
create function public.snacky_current_profile_has_any_role(allowed text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.profiles p left join public.team_members tm on tm.id=p.team_member_id where p.id=auth.uid() and p.active_status='active' and (public.snacky_profile_has_any_role(p.roles,p.role,allowed) or public.snacky_profile_has_any_role(tm.roles,tm.role,allowed)))$$;
create table public.locations(id uuid primary key,name text);
create table public.machines(id uuid primary key,name text,machine_code text,location_id uuid);
create table public.cash_collections(id uuid primary key,cash_bag_id text,machine_id uuid,operator_id uuid,actual_cash_collected numeric,voided_at timestamptz,custody_status text,collected_at timestamptz default now(),storage_received_at timestamptz);
create table public.cash_collection_machines(cash_collection_id uuid,machine_id uuid);
create table snacky_private.cash_handovers(collection_id uuid primary key,stage text,assigned_to uuid,picked_up_by uuid,picked_up_at timestamptz,deposited_at timestamptz);
create table buying_private.lists(id uuid primary key,title text,assigned_to uuid,status text,due_on date,created_at timestamptz default now());
create table buying_private.items(list_id uuid,outcome text);
create table buying_private.purchase_links(purchase_id uuid primary key,list_id uuid,buyer_id uuid,created_at timestamptz default now(),retired_at timestamptz);
create table public.purchase_orders(id uuid primary key,receipt_number text,supplier_id uuid,status text,received_at timestamptz,voided_at timestamptz,expected_delivery_date date);
create table public.suppliers(id uuid primary key,name text);
create table public.storage_locations(id uuid primary key,name text);
create table stocktake_private.assignments(id uuid primary key,title text,storage_location_id uuid,assigned_to uuid,status text,created_at timestamptz default now(),submitted_at timestamptz,due_on date);
create table public.issues(id uuid primary key,machine_id uuid,location_id uuid,issue_type text,assigned_to uuid,priority text,status text,created_at timestamptz default now(),sla_due_at timestamptz,field_completed_at timestamptz,archived_at timestamptz,is_practice boolean default false,is_historical boolean default false);
create table public.crm_tasks(id uuid primary key,issue_id uuid,task_type text,assigned_to uuid,status text,dispatch_state text,ack_due_at timestamptz,blocked_at timestamptz,fixed_at timestamptz,created_at timestamptz default now(),archived_at timestamptz,is_practice boolean default false);
create table public.push_subscriptions(id uuid primary key,user_id uuid,is_active boolean);
create table snacky_notice_private.settings(singleton boolean primary key,enabled boolean);
create table snacky_notice_private.dispatch_escalation_settings(singleton boolean primary key,enabled boolean,last_scan_at timestamptz);
\ir ../supabase/migrations/20260926104413_owner_operations_overview_v1.sql

begin;
insert into public.team_members(id,auth_user_id,full_name,role,roles) select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic '||r,r,array[r] from (values(1,'owner'),(2,'admin'),(3,'operator'),(4,'warehouse'),(5,'crm'),(6,'supervisor'),(7,'owner')) roles(n,r);
insert into public.profiles select auth_user_id,full_name,id,case when full_name='Synthetic owner' and id::text like '%000000000007' then 'inactive' else 'active' end,role,roles from public.team_members;
insert into public.locations values('30000000-0000-4000-8000-000000000001','Test location');
insert into public.machines values('31000000-0000-4000-8000-000000000001','Test machine','QA','30000000-0000-4000-8000-000000000001');
insert into public.cash_collections(id,cash_bag_id,machine_id,operator_id,custody_status) select ('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,case when n=4 then '  ' else 'QA-'||n end,'31000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003',case when n in (2,3) then 'in_storage' else 'removed' end from generate_series(1,30) n;
insert into snacky_private.cash_handovers(collection_id,stage,assigned_to,picked_up_by,picked_up_at,deposited_at) values
 ('40000000-0000-4000-8000-000000000002','dropped','20000000-0000-4000-8000-000000000004',null,null,now()-interval '2 hours'),
 ('40000000-0000-4000-8000-000000000003','picked_up','20000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '2 hours');
insert into public.cash_collections(id,cash_bag_id,actual_cash_collected,custody_status) values('40000000-0000-4000-8000-000000000031','Counted-zero',0,'removed'),('40000000-0000-4000-8000-000000000032','Old-pending',null,'pending_collection');
insert into buying_private.lists(id,title,assigned_to,status,due_on) values
 ('50000000-0000-4000-8000-000000000001','Open shopping','10000000-0000-4000-8000-000000000004','open','2026-09-26'),
 ('50000000-0000-4000-8000-000000000002','Unavailable report','10000000-0000-4000-8000-000000000004','completed','2026-09-26'),
 ('50000000-0000-4000-8000-000000000003','Cancelled list','10000000-0000-4000-8000-000000000004','cancelled','2026-09-26');
insert into buying_private.items values('50000000-0000-4000-8000-000000000002','unavailable'),('50000000-0000-4000-8000-000000000003','unavailable');
insert into public.purchase_orders(id,status) values('51000000-0000-4000-8000-000000000001','draft'),('51000000-0000-4000-8000-000000000002','received'),('51000000-0000-4000-8000-000000000003','draft');
insert into buying_private.purchase_links(purchase_id,list_id,buyer_id) select id,'50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004' from public.purchase_orders where id::text not like '%000000000003';
insert into stocktake_private.assignments(id,title,assigned_to,status,submitted_at,due_on) select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Test count '||n,'20000000-0000-4000-8000-000000000004',s,now(),'2026-09-26' from (values(1,'assigned'),(2,'submitted'),(3,'approved'),(4,'cancelled')) states(n,s);
insert into public.issues(id,machine_id,issue_type,assigned_to,priority,status,field_completed_at,is_practice,is_historical) select ('70000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'31000000-0000-4000-8000-000000000001','machine_unavailable',case when n=7 then null::uuid else '10000000-0000-4000-8000-000000000005'::uuid end,'high',case when n=4 then 'resolved' else 'open' end,case when n=3 then now() else null end,n=5,n=6 from generate_series(1,7) n;
insert into public.crm_tasks(id,issue_id,task_type,assigned_to,status,dispatch_state,ack_due_at,blocked_at,fixed_at) select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('70000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'field_action','10000000-0000-4000-8000-000000000003',case when n=3 then 'completed' else 'open' end,case when n=1 then 'assigned' when n=2 then 'blocked' else 'fixed' end,now()-interval '1 minute',now(),now() from generate_series(1,3) n;
insert into public.crm_tasks(id,issue_id,task_type,assigned_to,status,dispatch_state) values('71000000-0000-4000-8000-000000000099','70000000-0000-4000-8000-000000000002','field_action','10000000-0000-4000-8000-000000000003','completed','fixed');
insert into public.push_subscriptions values('80000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003',true);
insert into snacky_notice_private.settings values(true,true);
insert into snacky_notice_private.dispatch_escalation_settings values(true,false,null);

-- Any unexpected business DML during a read fails this acceptance test.
create function public.qa_reject_overview_write() returns trigger language plpgsql as $$begin raise exception 'Overview attempted a business write';end$$;
do $$declare r record;begin for r in select schemaname,tablename from pg_tables where schemaname in ('public','snacky_private','buying_private','stocktake_private','snacky_notice_private') loop execute format('create trigger qa_no_overview_write before insert or update or delete on %I.%I for each statement execute function public.qa_reject_overview_write()',r.schemaname,r.tablename);end loop;end$$;
set local role authenticated;
do $$declare v jsonb; p2 jsonb; n integer; denied boolean;begin
 for n in 1..7 loop
  perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-'||lpad(n::text,12,'0'),true);
  if n in (1,2) then perform public.snacky_owner_operations_section_v1('cash',0);
  else denied:=false;begin perform public.snacky_owner_operations_section_v1('cash',0);exception when insufficient_privilege then denied:=true;end;if not denied then raise exception 'Staff/inactive overview leak for account %',n;end if;end if;
 end loop;
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
 v:=public.snacky_owner_operations_section_v1('cash',0);
 if (v->>'total')::integer<>30 or (v->'counts'->>'cash_reference')::integer<>1 or jsonb_array_length(v->'rows')<>25 then raise exception 'Cash scope/pagination mismatch: %',v;end if;
 p2:=public.snacky_owner_operations_section_v1('cash',25);
 if jsonb_array_length(p2->'rows')<>5 or (p2->>'total')::integer<>30 then raise exception 'Cash page two missing';end if;
 if exists(select 1 from jsonb_array_elements(v->'rows') a join jsonb_array_elements(p2->'rows') b on a.value->>'id'=b.value->>'id') then raise exception 'Cash pages overlap';end if;
 v:=public.snacky_owner_operations_section_v1('buying',0);
 if (v->>'total')::integer<>3 or (v->'counts'->>'storage_pending')::integer<>1 then raise exception 'Buying/receiving scope wrong: %',v;end if;
 if (select (r->>'due_at')::timestamptz from jsonb_array_elements(v->'rows') r where r->>'state'='buying_open')<>'2026-09-26 22:00:00+00'::timestamptz then raise exception 'Libya due date boundary incorrect';end if;
 v:=public.snacky_owner_operations_section_v1('stocktakes',0);
 if (v->>'total')::integer<>2 or (v->'counts'->>'stock_review')::integer<>1 then raise exception 'Stocktake review wrong';end if;
 v:=public.snacky_owner_operations_section_v1('issues',0);
 if (v->>'total')::integer<>4 or (v->'counts'->>'crm_blocked')::integer<>1 or (v->'counts'->>'crm_verify')::integer<>1 or (v->'counts'->>'crm_acceptance')::integer<>1 then raise exception 'Issue scope, dedupe or CRM verification wrong: %',v;end if;
 v:=public.snacky_owner_operations_section_v1('notifications',0);
 if (v->>'total')::integer<>3 or (v->'counts'->>'no_device')::integer<>2 or v->'diagnostics'->>'escalation_enabled'<>'false' then raise exception 'Notification readiness wrong';end if;
 if v::text like '%endpoint%' or v::text like '%p256dh%' then raise exception 'Device secrets exposed';end if;
 denied:=false;begin perform public.snacky_owner_operations_section_v1('finance',0);exception when invalid_parameter_value then denied:=true;end;if not denied then raise exception 'Unsupported section accepted';end if;
 denied:=false;begin perform public.snacky_owner_operations_section_v1('cash',1);exception when invalid_parameter_value then denied:=true;end;if not denied then raise exception 'Invalid offset accepted';end if;
 raise notice 'PASS: owner/admin-only, staff/inactive denial, cash reference exclusion, zero-count, buying receipt scope, stock approval, issue dedupe, readiness, Libya dates and pagination';
end$$;
reset role;
do $$begin
 if has_function_privilege('anon','public.snacky_owner_operations_section_v1(text,integer)','execute') then raise exception 'Anonymous reader exposed';end if;
 if (select prosecdef from pg_proc where oid='public.snacky_owner_operations_section_v1(text,integer)'::regprocedure) then raise exception 'Public wrapper must be invoker';end if;
end$$;
drop table public.push_subscriptions;
set local role authenticated;
do $$declare missing boolean:=false;begin
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
 begin perform public.snacky_owner_operations_section_v1('notifications',0);exception when undefined_table then missing:=true;end;
 if not missing then raise exception 'Missing source looked like a valid queue';end if;
 perform public.snacky_owner_operations_section_v1('cash',0);
 raise notice 'PASS: one missing source fails its section without breaking cash';
end$$;
reset role;
rollback;
