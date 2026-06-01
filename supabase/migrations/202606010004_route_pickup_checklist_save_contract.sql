alter table if exists public.route_stop_items
  add column if not exists is_checked boolean not null default false,
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by uuid;

alter table if exists public.route_pick_list_items
  add column if not exists is_checked boolean not null default false,
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by uuid;

create index if not exists idx_route_stop_items_pickup_checked
  on public.route_stop_items(route_id, is_checked);

create index if not exists idx_route_pick_list_items_checked
  on public.route_pick_list_items(route_id, is_checked);

update public.route_stop_items rsi
set
  is_checked = true,
  checked_at = coalesce(rsi.checked_at, rpli.checked_at, rpli.updated_at, now()),
  checked_by = coalesce(rsi.checked_by, rpli.checked_by)
from public.route_pick_list_items rpli
where rpli.route_stop_item_id = rsi.id
  and rpli.route_id = rsi.route_id
  and coalesce(rpli.is_checked, false) = true
  and coalesce(rsi.is_checked, false) = false;

create or replace function public.save_route_pickup_checklist_item(
  p_route_id uuid,
  p_route_stop_item_id uuid,
  p_is_checked boolean
)
returns table (
  id uuid,
  route_id uuid,
  route_stop_item_id uuid,
  product_id uuid,
  is_checked boolean,
  checked_at timestamptz,
  checked_by uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_route record;
  v_item record;
  v_stop_status text;
  v_checked_at timestamptz;
  v_checked_by uuid;
begin
  if p_route_id is null then
    raise exception 'Route id is required.' using errcode = 'P0001';
  end if;

  if p_route_stop_item_id is null then
    raise exception 'Route stop item is required.' using errcode = 'P0001';
  end if;

  select r.id, r.operator_id, r.status
  into v_route
  from public.routes r
  where r.id = p_route_id;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Completed or cancelled routes cannot be edited.' using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'User does not have permission to update this pickup checklist item.' using errcode = '42501';
  end if;

  select rsi.id, rsi.route_id, rsi.route_stop_id, rsi.product_id
  into v_item
  from public.route_stop_items rsi
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id;

  if not found then
    raise exception 'Pickup item not found.' using errcode = 'P0001';
  end if;

  select rs.status::text
  into v_stop_status
  from public.route_stops rs
  where rs.id = v_item.route_stop_id
    and rs.route_id = p_route_id;

  if v_stop_status is not null and v_stop_status <> 'pending' then
    raise exception 'Only pending pickup items can be checked.' using errcode = 'P0001';
  end if;

  v_checked_at := case when coalesce(p_is_checked, false) then now() else null end;
  v_checked_by := case when coalesce(p_is_checked, false) then auth.uid() else null end;

  update public.route_stop_items rsi
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = v_checked_at,
    checked_by = v_checked_by,
    updated_at = now()
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id;

  update public.route_pick_list_items rpli
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = v_checked_at,
    checked_by = v_checked_by,
    updated_at = now()
  where rpli.route_id = p_route_id
    and rpli.route_stop_item_id = p_route_stop_item_id
    and rpli.action_type = 'planned_pick';

  return query
  select
    rsi.id,
    rsi.route_id,
    rsi.id as route_stop_item_id,
    rsi.product_id,
    rsi.is_checked,
    rsi.checked_at,
    rsi.checked_by
  from public.route_stop_items rsi
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id;
end;
$$;

grant execute on function public.save_route_pickup_checklist_item(uuid, uuid, boolean) to authenticated;

drop policy if exists "snacky_route_stop_items_update_pickup_checklist_access" on public.route_stop_items;

create policy "snacky_route_stop_items_update_pickup_checklist_access"
on public.route_stop_items for update
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
)
with check (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
);

grant update (is_checked, checked_at, checked_by) on public.route_stop_items to authenticated;
grant update (is_checked, checked_at, checked_by) on public.route_pick_list_items to authenticated;

select pg_notify('pgrst', 'reload schema');
