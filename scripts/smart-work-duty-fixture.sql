-- Isolated CI only. Never run this fixture on Snacky production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to service_role;
create table public.team_members(id uuid primary key,full_name text,role text,roles text[] default '{}',active boolean default true,active_status text default 'active',must_change_password boolean default false);
create table public.machines(id uuid primary key,name text,machine_code text,status text default 'active');
create table public.machine_slots(id uuid primary key default gen_random_uuid(),machine_id uuid,slot_code text,active boolean default true);
create table public.latest_vms_stock_by_slot(machine_id uuid,slot_code text,product_id uuid,current_qty integer,capacity integer,captured_at timestamptz,source_provider text default 'xy');
create table public.routes(id uuid primary key,operator_id uuid,status text,route_date date);
create table public.route_stops(id uuid primary key,route_id uuid,machine_id uuid,status text,completed_at timestamptz);
create table public.route_stop_inventory_commits(id uuid primary key,route_id uuid,route_stop_id uuid,machine_id uuid,operator_id uuid,committed_at timestamptz,workflow_completed_at timestamptz,inventory_needs_review boolean default false);
create table public.route_stop_quantity_confirmations(route_stop_id uuid,machine_id uuid,verification_status text);
create table public.route_stop_fill_lines(route_stop_id uuid,actual_qty integer,needs_review boolean default false);
grant select on all tables in schema public to service_role;
