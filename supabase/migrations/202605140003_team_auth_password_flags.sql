alter table team_members
add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
add column if not exists active_status text not null default 'active',
add column if not exists must_change_password boolean not null default false;

alter table profiles
add column if not exists must_change_password boolean not null default false;

create index if not exists idx_team_members_auth_user_id on team_members(auth_user_id);
create index if not exists idx_team_members_active_status on team_members(active_status);

update team_members
set active_status = case when active then 'active' else 'inactive' end
where active_status is null or active_status not in ('active', 'inactive');
