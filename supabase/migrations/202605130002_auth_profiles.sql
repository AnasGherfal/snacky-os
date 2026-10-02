create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text unique,
  phone text,
  role team_role not null default 'viewer',
  active_status text not null default 'active',
  team_member_id uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_active_status_check check (active_status in ('active', 'inactive'))
);

create index if not exists idx_profiles_role on profiles(role);
create index if not exists idx_profiles_active_status on profiles(active_status);
create index if not exists idx_profiles_team_member_id on profiles(team_member_id);
