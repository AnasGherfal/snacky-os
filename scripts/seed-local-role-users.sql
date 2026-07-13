with deleted_profiles as (
  delete from public.profiles
  where email in ('anas@snacky.local', 'test@snacky.local')
  returning 1
),
deleted_team_members as (
  delete from public.team_members
  where email in ('anas@snacky.local', 'test@snacky.local')
  returning 1
),
user_defs(email, full_name, role, roles, can_add_products) as (
  values
    ('anas@snacky.local', 'Anas Snacky', 'owner'::public.team_role, array['owner', 'admin']::public.team_role[], true),
    ('test@snacky.local', 'Snacky Operator', 'operator'::public.team_role, array['operator']::public.team_role[], false)
),
auth_users as (
  select
    u.id as auth_user_id,
    u.email,
    d.full_name,
    d.role,
    d.roles,
    d.can_add_products
  from user_defs d
  join auth.users u on u.email = d.email
),
inserted_team_members as (
  insert into public.team_members (
    full_name,
    email,
    role,
    roles,
    active,
    active_status,
    auth_user_id,
    can_add_products,
    must_change_password
  )
  select
    full_name,
    email,
    role,
    roles,
    true,
    'active',
    auth_user_id,
    can_add_products,
    false
  from auth_users
  returning id, email
)
insert into public.profiles (
  id,
  full_name,
  email,
  role,
  roles,
  active_status,
  team_member_id,
  can_add_products,
  must_change_password
)
select
  auth_users.auth_user_id,
  auth_users.full_name,
  auth_users.email,
  auth_users.role,
  auth_users.roles,
  'active',
  inserted_team_members.id,
  auth_users.can_add_products,
  false
from auth_users
join inserted_team_members on inserted_team_members.email = auth_users.email;
