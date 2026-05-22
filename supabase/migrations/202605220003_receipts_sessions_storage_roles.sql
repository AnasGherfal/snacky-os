-- Receipts, simple storage adjustments, session-safe role metadata, and multi-role access.

alter type team_role add value if not exists 'purchasing';

alter table team_members
  add column if not exists roles team_role[],
  add column if not exists can_add_products boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table profiles
  add column if not exists roles team_role[],
  add column if not exists can_add_products boolean not null default false;

update team_members
set roles = array[role]::team_role[]
where roles is null or array_length(roles, 1) is null;

update profiles
set roles = array[role]::team_role[]
where roles is null or array_length(roles, 1) is null;

update team_members
set can_add_products = true
where role in ('owner', 'admin');

update profiles
set can_add_products = true
where role in ('owner', 'admin');

create index if not exists idx_team_members_roles on team_members using gin (roles);
create index if not exists idx_profiles_roles on profiles using gin (roles);
create index if not exists idx_team_members_can_add_products on team_members(can_add_products);

alter table purchase_orders
  add column if not exists receipt_file_name text,
  add column if not exists receipt_content_type text,
  add column if not exists receipt_storage_path text;

create index if not exists idx_purchase_orders_receipt_storage_path
  on purchase_orders(receipt_storage_path)
  where receipt_storage_path is not null;

create or replace function public.snacky_profile_has_any_role(profile_roles team_role[], primary_role team_role, allowed_roles text[])
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from unnest(coalesce(profile_roles, array[primary_role]::team_role[])) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$$;

create or replace function public.snacky_storage_has_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
  );
$$;

create or replace function public.snacky_storage_can_access_route(route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.routes r on r.id = route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
          and p.team_member_id is not null
          and r.operator_id = p.team_member_id
        )
      )
  );
$$;

grant execute on function public.snacky_profile_has_any_role(team_role[], team_role, text[]) to authenticated;
grant execute on function public.snacky_storage_has_role(text[]) to authenticated;
grant execute on function public.snacky_storage_can_access_route(uuid) to authenticated;
