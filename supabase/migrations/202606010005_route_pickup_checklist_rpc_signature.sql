alter table if exists public.route_stop_items
  add column if not exists is_checked boolean not null default false,
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by uuid;

do $$
begin
  if to_regclass('public.route_stop_items') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.route_stop_items'::regclass
         and conname = 'route_stop_items_checked_by_fkey'
     ) then
    alter table public.route_stop_items
      add constraint route_stop_items_checked_by_fkey
      foreign key (checked_by) references auth.users(id) on delete set null not valid;
  end if;
end $$;

drop function if exists public.save_route_pickup_checklist_item(uuid, uuid, boolean);

create or replace function public.save_route_pickup_checklist_item(
  p_is_checked boolean,
  p_route_id uuid,
  p_route_stop_item_id uuid
)
returns public.route_stop_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_item public.route_stop_items;
  v_route record;
  v_has_access boolean := false;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select r.id, r.operator_id, r.status
  into v_route
  from public.routes r
  where r.id = p_route_id;

  if not found then
    raise exception 'Route not found' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Completed or cancelled routes cannot be edited' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = v_user_id
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or (
          v_route.operator_id = coalesce(p.team_member_id, tm.id)
          and (
            public.snacky_profile_has_any_role(p.roles, p.role, array['operator', 'warehouse'])
            or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator', 'warehouse'])
          )
        )
      )
  )
  into v_has_access;

  if not coalesce(v_has_access, false) then
    raise exception 'User does not have permission to update this pickup checklist item' using errcode = '42501';
  end if;

  select rsi.*
  into v_item
  from public.route_stop_items rsi
  join public.route_stops rs
    on rs.id = rsi.route_stop_id
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id
    and rs.route_id = p_route_id;

  if not found then
    raise exception 'Checklist item not found for this route' using errcode = 'P0001';
  end if;

  update public.route_stop_items rsi
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = case when coalesce(p_is_checked, false) then now() else null end,
    checked_by = case when coalesce(p_is_checked, false) then v_user_id else null end,
    updated_at = now()
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id
  returning rsi.* into v_item;

  update public.route_pick_list_items rpli
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = case when coalesce(p_is_checked, false) then v_item.checked_at else null end,
    checked_by = case when coalesce(p_is_checked, false) then v_user_id else null end,
    updated_at = now()
  where rpli.route_id = p_route_id
    and rpli.route_stop_item_id = p_route_stop_item_id
    and rpli.action_type = 'planned_pick';

  return v_item;
end;
$$;

grant execute on function public.save_route_pickup_checklist_item(boolean, uuid, uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
