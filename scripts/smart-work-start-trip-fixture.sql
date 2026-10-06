\set ON_ERROR_STOP on
-- Isolated PostgreSQL database ONLY. This is a contract fixture, not production setup.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public,auth to service_role,authenticated,anon;
create table public.team_members(id uuid primary key,auth_user_id uuid,full_name text,role text,roles text[],active boolean,active_status text,must_change_password boolean default false);
create type public.location_type as enum ('test');
create table public.locations(id uuid primary key,location_type public.location_type);
create table public.machines(id uuid primary key,name text,status text,location_id uuid);
create table public.products(id uuid primary key,name text,active boolean);
create table public.machine_slots(id uuid primary key,machine_id uuid references public.machines,slot_code text,active boolean);
create table public.latest_vms_stock_by_slot(machine_id uuid,slot_code text,product_id uuid,current_qty integer,capacity integer,captured_at timestamptz,source_provider text);
create table public.smart_route_slot_product_rules(machine_slot_id uuid,product_id uuid,rule text,verified_capacity integer check(verified_capacity between 1 and 1000),unique(machine_slot_id,product_id));
create table public.smart_route_location_product_rules(machine_id uuid,location_id uuid,location_type text,product_id uuid,rule text);
create table public.smart_route_machine_context(machine_id uuid primary key,location_type text);
create table public.smart_work_coverage_settings(id uuid default gen_random_uuid(),kind text,machine_id uuid,operator_id uuid,value jsonb,version integer default 1);
create table public.routes(id uuid primary key default gen_random_uuid(),route_date date not null,operator_id uuid references public.team_members,status text not null default 'draft',created_by uuid references public.team_members,notes text,started_at timestamptz);
create table public.route_stops(id uuid primary key default gen_random_uuid(),route_id uuid references public.routes on delete cascade,machine_id uuid references public.machines,stop_order integer,status text default 'pending');
create table public.route_stop_items(id uuid primary key default gen_random_uuid(),route_id uuid references public.routes on delete cascade,route_stop_id uuid references public.route_stops on delete cascade,machine_id uuid references public.machines,product_id uuid references public.products,machine_slot_id uuid references public.machine_slots,slot_code text,planned_quantity integer,recommended_take_qty integer,final_take_qty integer,picked_quantity integer,filled_quantity integer,returned_quantity integer,source text check(source in ('refill_recommendation','manual_admin_assignment')),notes text,slot_allocations jsonb,is_checked boolean default false);
create table public.route_stock_lines(id uuid primary key default gen_random_uuid(),route_id uuid references public.routes on delete cascade,product_id uuid references public.products,planned_qty integer default 0,picked_qty integer default 0,returned_qty integer default 0,updated_at timestamptz default now(),unique(route_id,product_id));
create table public.inventory_movements(id uuid primary key default gen_random_uuid(),product_id uuid references public.products,from_entity_type text,to_entity_type text,quantity integer check(quantity>=0));
create view public.route_storage_stock_by_product as
with movement_deltas as (
 select product_id,-quantity quantity_delta from public.inventory_movements where from_entity_type='storage'
 union all select product_id,quantity from public.inventory_movements where to_entity_type='storage'
) select product_id,sum(quantity_delta)::integer quantity_on_hand from movement_deltas group by product_id having sum(quantity_delta)<>0;
create function public.snacky_route_is_reservation_status(v text) returns boolean language sql stable as $$
select coalesce(v,'')=any(array['draft','assigned','in_progress','pickup_confirmed','available','ready','started','filling','machine_filling','partially_completed','stop_completed']) $$;
create table public.smart_work_duties(id uuid primary key,machine_id uuid references public.machines,service_date date,required_at timestamptz,due_at timestamptz,priority text,state text default 'required',owner_id uuid references public.team_members,assigned_via text,expected_minutes integer,route_stop_id uuid,blocker text,completed_at timestamptz,revision integer default 1,updated_by uuid,updated_at timestamptz default now());
create unique index test_one_outstanding_duty on public.smart_work_duties(machine_id) where completed_at is null;
create table public.smart_work_duty_events(id bigint generated always as identity primary key,duty_id uuid,revision integer,actor_id uuid,after_state jsonb,unique(duty_id,revision));
create function public.test_duty_audit() returns trigger language plpgsql as $$ begin
insert into public.smart_work_duty_events(duty_id,revision,actor_id,after_state) values(new.id,new.revision,new.updated_by,to_jsonb(new));return new;end $$;
create trigger test_duty_audit after insert or update on public.smart_work_duties for each row execute function public.test_duty_audit();
-- Preserve the deployed insertion-upsert trigger that can otherwise hide doubled reservations.
create function public.snacky_pickup_v2_route_stock_line_guard() returns trigger language plpgsql as $$ begin
perform pg_advisory_xact_lock(hashtextextended('snacky:route-stock-line:'||new.route_id::text||':'||new.product_id::text,0));
update public.route_stock_lines set planned_qty=new.planned_qty,picked_qty=new.picked_qty where route_id=new.route_id and product_id=new.product_id;
if found then return null;end if;return new;end $$;
create trigger snacky_pickup_v2_route_stock_line_guard before insert on public.route_stock_lines for each row execute function public.snacky_pickup_v2_route_stock_line_guard();
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
create function public.test_uuid(n integer) returns uuid language sql immutable as $$ select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.test_assert(ok boolean,label text) returns void language plpgsql as $$ begin
if ok is distinct from true then raise exception 'ASSERTION FAILED: %',label;end if;raise notice 'PASS: %',label;end $$;
create function public.test_trip_plan(ids uuid[]) returns jsonb language sql volatile as $$
select jsonb_build_object('status','complete','generatedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '4 minutes',
 'totalUnits',sum(r.capacity-r.current_qty),'emptyAfter',0,'unknownAfter',0,'underfilled',0,'errors','[]'::jsonb,
 'lanes',jsonb_agg(jsonb_build_object(
 'machineId',d.machine_id,'slotId',s.id,'code',lpad(s.slot_code,3,'0'),'originalProductId',r.product_id,'originalName','Original',
 'productId',r.product_id,'productName','Original','current',r.current_qty,'originalCapacity',r.capacity,'target',r.capacity,
 'take',r.capacity-r.current_qty,'removeExpected',0,'after',r.capacity,'action',case when r.capacity=r.current_qty then 'keep' else 'refill' end,
 'reason',case when r.capacity=r.current_qty then 'stocked' else 'top_up' end)))
from public.smart_work_duties d join public.machine_slots s on s.machine_id=d.machine_id and s.active
join public.latest_vms_stock_by_slot r on r.machine_id=s.machine_id and r.slot_code=s.slot_code where d.id=any(ids) $$;
-- Fixture values only, unrelated to Snacky's real IDs, schedules or quantities.
insert into public.team_members values(test_uuid(201),test_uuid(101),'Operator A','operator',array['operator'],true,'active',false),(test_uuid(202),test_uuid(102),'Operator B','operator',array['operator'],true,'active',false);
insert into public.products values(test_uuid(21),'Original',true),(test_uuid(22),'Replacement',true);
insert into public.machines select test_uuid(i),'Machine '||i,'active',null from generate_series(1,3) i;
insert into public.machine_slots select test_uuid(i+10),test_uuid(i),'001',true from generate_series(1,3) i;
insert into public.latest_vms_stock_by_slot select test_uuid(i),'001',test_uuid(21),1,6,clock_timestamp(),'xy' from generate_series(1,3) i;
insert into public.inventory_movements(product_id,from_entity_type,to_entity_type,quantity) values(test_uuid(21),'supplier','storage',30),(test_uuid(22),'supplier','storage',30);
insert into public.smart_work_coverage_settings(kind,operator_id,value) select 'operator',test_uuid(i),jsonb_build_object('enabled',true,'windows',jsonb_build_array(jsonb_build_object('day',extract(isodow from now() at time zone 'Africa/Tripoli')::integer,'start','00:00','end','23:59','minutes',960))) from generate_series(201,202) i;
insert into public.smart_work_coverage_settings(kind,machine_id,value) select 'machine',test_uuid(i),jsonb_build_object('enabled',true,'primaryId',test_uuid(201),'backupId',test_uuid(202),'days',jsonb_build_array(1,2,3,4,5,6,7),'accessStart','00:00','accessEnd','23:59','travelMinutes',0,'serviceMinutes',1) from generate_series(1,3) i;
insert into public.smart_work_duties(id,machine_id,service_date,required_at,due_at,priority,owner_id,assigned_via,expected_minutes,updated_by)
select test_uuid(i+300),test_uuid(i),(now() at time zone 'Africa/Tripoli')::date,now()-interval '10 minutes',now()+interval '2 hours','urgent',test_uuid(201),'primary',1,test_uuid(201) from generate_series(1,3) i;
