\set ON_ERROR_STOP on
-- Isolated CI database ONLY. Never run against production.
create role anon;
create role authenticated;
create role service_role bypassrls;
-- Reproduce Supabase default service grants so the migration must remove extras.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
create table public.team_members(id uuid primary key,role text,roles text[],active boolean,active_status text,must_change_password boolean default false);
create table public.machines(id uuid primary key,status text);
grant usage on schema public to service_role;
grant select on public.team_members,public.machines to service_role;
insert into public.team_members values
 ('00000000-0000-0000-0000-000000000001','owner','{owner}',true,'active',false),
 ('00000000-0000-0000-0000-000000000002','operator','{operator}',true,'active',false),
 ('00000000-0000-0000-0000-000000000004','viewer','{viewer}',true,'active',false),
 ('00000000-0000-0000-0000-000000000005','operator','{operator}',false,'inactive',false);
insert into public.machines values ('00000000-0000-0000-0000-000000000003','active');
