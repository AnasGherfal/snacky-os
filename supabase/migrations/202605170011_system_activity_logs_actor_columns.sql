create table if not exists system_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles(id) on delete set null,
  actor_team_member_id uuid references team_members(id) on delete set null,
  actor_name text,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb default '{}'::jsonb,
  ip_address text,
  user_agent text,
  summary text,
  created_at timestamptz not null default now()
);

alter table system_activity_logs
  add column if not exists actor_user_id uuid references profiles(id) on delete set null,
  add column if not exists actor_team_member_id uuid references team_members(id) on delete set null,
  add column if not exists actor_name text,
  add column if not exists actor_role text,
  add column if not exists entity_label text,
  add column if not exists before_data jsonb,
  add column if not exists after_data jsonb,
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists summary text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'system_activity_logs'
      and column_name = 'actor_id'
  ) then
    execute 'update system_activity_logs set actor_team_member_id = coalesce(actor_team_member_id, actor_id) where actor_team_member_id is null';
  end if;
end $$;

update system_activity_logs
set metadata = '{}'::jsonb
where metadata is null;

create index if not exists idx_system_activity_logs_actor_team_member
  on system_activity_logs(actor_team_member_id, created_at desc);

create index if not exists idx_system_activity_logs_actor_user
  on system_activity_logs(actor_user_id, created_at desc);

create index if not exists idx_system_activity_logs_actor_role
  on system_activity_logs(actor_role, created_at desc);

create index if not exists idx_system_activity_logs_action
  on system_activity_logs(action, created_at desc);

create index if not exists idx_system_activity_logs_entity
  on system_activity_logs(entity_type, entity_id);

create index if not exists idx_system_activity_logs_created
  on system_activity_logs(created_at desc);
