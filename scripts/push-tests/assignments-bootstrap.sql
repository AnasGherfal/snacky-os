-- Extends the existing disposable PWA test database, never production.
create table public.team_members(id uuid primary key,auth_user_id uuid,role text,roles text[],active boolean default true,active_status text default 'active');
alter table public.profiles add column role text,add column roles text[],add column team_member_id uuid;
alter table public.routes add column operator_id uuid,add column status text default 'draft',add column route_date date,add column created_by uuid;
create table public.locations(id uuid primary key,name text,status text default 'active');
create table public.location_pipeline_leads(id uuid primary key,place_name text,assigned_to_user_id uuid,status text default 'want_to_contact',is_practice boolean default false,is_archived boolean default false,created_by_member_id uuid,next_action_date date,next_action_time time,priority text default 'normal');
create table public.issues(id uuid primary key,assigned_to uuid,reported_by uuid,status text default 'open',issue_type text default 'machine_unavailable',priority text default 'normal',archived_at timestamptz,is_practice boolean default false);
create table public.crm_tasks(id uuid primary key,title text,assigned_to uuid,created_by uuid,status text default 'open',task_type text default 'follow_up',issue_id uuid,due_date date,due_time time,priority text default 'normal',archived_at timestamptz,is_practice boolean default false);
create table public.location_relationships(location_id uuid primary key,assigned_to uuid,created_by uuid,next_action_date date,next_action_time time);
create table public.location_admin_obligations(id uuid primary key,title text,assigned_to uuid,status text default 'open',due_date date,is_practice boolean default false,created_by uuid);
create table public.operator_instructions(id uuid primary key,title text,operator_id uuid,status text default 'pending',priority text default 'normal',due_at timestamptz,created_by_member_id uuid);
create schema crm_automation_private;
create table crm_automation_private.routines(id uuid primary key,title text,assigned_to uuid,paused boolean default false,created_by uuid);
create schema company_private;
create table company_private.items(id uuid primary key,current_version integer default 0,archived boolean default false);
create table company_private.versions(item_id uuid,version integer,data jsonb,primary key(item_id,version));
