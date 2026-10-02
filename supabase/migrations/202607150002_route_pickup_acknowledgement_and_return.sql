alter table if exists public.route_pickup_batches
  add column if not exists returned_to_assigned_at timestamptz,
  add column if not exists returned_to_assigned_by uuid references public.team_members(id) on delete set null,
  add column if not exists returned_to_assigned_reason text,
  add column if not exists returned_to_assigned_movement_count integer not null default 0,
  add column if not exists returned_to_assigned_quantity integer not null default 0;

create index if not exists idx_route_pickup_batches_returned_to_assigned_at
  on public.route_pickup_batches(route_id, returned_to_assigned_at);

create or replace function public.confirm_route_pickup_batch(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean default false,
  p_pickup_batch jsonb default null,
  p_batch_stop_ids uuid[] default '{}'::uuid[],
  p_new_stop_item_rows jsonb default '[]'::jsonb,
  p_inventory_movements jsonb default '[]'::jsonb,
  p_pick_list_rows jsonb default '[]'::jsonb,
  p_stock_line_rows jsonb default '[]'::jsonb,
  p_stop_item_picks jsonb default '[]'::jsonb,
  p_refill_line_picks jsonb default '[]'::jsonb,
  p_selected_stop_ids uuid[] default '{}'::uuid[],
  p_acknowledged_pickup_line_ids uuid[] default '{}'::uuid[],
  p_selected_machine_ids uuid[] default '{}'::uuid[]
)
returns table(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_stop_ids uuid[],
  pending_stop_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_pick_list_rows jsonb := coalesce(p_pick_list_rows, '[]'::jsonb);
  v_acknowledged_pickup_line_ids uuid[] := coalesce(p_acknowledged_pickup_line_ids, '{}'::uuid[]);
  v_checked_pickup_line_ids uuid[] := '{}'::uuid[];
  v_required_pickup_line_ids uuid[] := '{}'::uuid[];
  v_invalid_count integer := 0;
begin
  if jsonb_typeof(v_pick_list_rows) <> 'array' then
    raise exception 'Pickup checklist payload is invalid.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct x.route_stop_item_id order by x.route_stop_item_id), '{}'::uuid[])
  into v_checked_pickup_line_ids
  from jsonb_to_recordset(v_pick_list_rows) as x(route_stop_item_id uuid, is_checked boolean)
  where x.route_stop_item_id is not null
    and coalesce(x.is_checked, false) = true;

  select coalesce(array_agg(distinct rsi.id order by rsi.id), '{}'::uuid[])
  into v_required_pickup_line_ids
  from public.route_stop_items rsi
  join public.route_stops rs on rs.id = rsi.route_stop_id
  where rs.route_id = p_route_id
    and coalesce(rsi.planned_quantity, 0) > 0
    and (
      coalesce(array_length(p_selected_stop_ids, 1), 0) = 0
      or rsi.route_stop_id = any(p_selected_stop_ids)
    );

  if coalesce(array_length(v_checked_pickup_line_ids, 1), 0) <> coalesce(array_length(v_acknowledged_pickup_line_ids, 1), 0) then
    raise exception 'Pickup checklist acknowledgements do not match the submitted checked lines.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(v_checked_pickup_line_ids) as checked_id
  where not (checked_id = any(v_acknowledged_pickup_line_ids));
  if v_invalid_count > 0 then
    raise exception 'Pickup checklist acknowledgements do not match the submitted checked lines.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(v_required_pickup_line_ids) as required_id
  where not (required_id = any(v_acknowledged_pickup_line_ids));
  if v_invalid_count > 0 then
    raise exception 'Every required pickup line must be checked before confirming pickup.' using errcode = 'P0001';
  end if;

  return query
  select *
  from public.confirm_route_pickup_batch(
    p_route_id,
    p_expected_route_status,
    p_next_route_status,
    p_started_at,
    p_replace_pick_list,
    p_pickup_batch,
    p_batch_stop_ids,
    p_new_stop_item_rows,
    p_inventory_movements,
    p_pick_list_rows,
    p_stock_line_rows,
    p_stop_item_picks,
    p_refill_line_picks,
    p_selected_stop_ids,
    p_selected_machine_ids
  );
end;
$$;

create or replace function public.return_pickup_batch_to_assigned(
  p_route_id uuid,
  p_pickup_batch_id uuid,
  p_reason text default null
)
returns table(
  pickup_batch_id uuid,
  route_id uuid,
  route_status public.route_status,
  compensating_movement_count integer,
  restored_quantity integer,
  already_returned boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile record;
  v_route record;
  v_batch record;
  v_now timestamptz := now();
  v_route_stop_ids uuid[] := '{}'::uuid[];
  v_selected_machine_ids uuid[] := '{}'::uuid[];
  v_blocked_count integer := 0;
  v_restored_quantity integer := 0;
  v_compensating_movement_count integer := 0;
begin
  if p_route_id is null or p_pickup_batch_id is null then
    raise exception 'Route and pickup batch are required.' using errcode = 'P0001';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'User does not have permission to return this pickup batch.' using errcode = '42501';
  end if;

  select pr.id, pr.team_member_id
  into v_profile
  from public.profiles pr
  where pr.id = auth.uid();

  if not found then
    raise exception 'You must be signed in to return this pickup batch.' using errcode = '42501';
  end if;

  select
    b.id,
    b.route_id,
    b.operator_id,
    b.status as batch_status,
    b.selected_stop_ids,
    b.storage_deducted,
    b.confirmed_at,
    b.returned_to_assigned_at,
    b.returned_to_assigned_by,
    b.returned_to_assigned_reason,
    r.status as route_status,
    r.started_at,
    r.completed_at
  into v_batch
  from public.route_pickup_batches b
  join public.routes r on r.id = b.route_id
  where b.id = p_pickup_batch_id
    and b.route_id = p_route_id
  for update of b, r;

  if not found then
    raise exception 'Pickup batch was not found for this route.' using errcode = 'P0001';
  end if;

  if v_batch.returned_to_assigned_at is not null then
    return query
    select
      v_batch.id,
      v_batch.route_id,
      v_batch.route_status::public.route_status,
      0::integer,
      0::integer,
      true;
    return;
  end if;

  if v_batch.route_status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Completed or cancelled routes cannot be returned to Assigned.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_blocked_count
  from public.route_stops rs
  where rs.route_id = p_route_id
    and rs.status = 'completed'::public.route_stop_status;
  if v_blocked_count > 0 then
    raise exception 'Completed machine stops prevent returning this pickup batch to Assigned.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_blocked_count
  from public.route_stop_fill_lines rfl
  where rfl.route_id = p_route_id;
  if v_blocked_count > 0 then
    raise exception 'Route fill history already exists, so this pickup batch cannot be returned to Assigned.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_blocked_count
  from public.cash_collections cc
  where cc.route_id = p_route_id;
  if v_blocked_count > 0 then
    raise exception 'Cash collection history already exists, so this pickup batch cannot be returned to Assigned.' using errcode = 'P0001';
  end if;

  v_route_stop_ids := coalesce(v_batch.selected_stop_ids, '{}'::uuid[]);
  select coalesce(array_agg(distinct rs.machine_id order by rs.machine_id), '{}'::uuid[])
  into v_selected_machine_ids
  from public.route_stops rs
  where rs.route_id = p_route_id
    and rs.id = any(v_route_stop_ids);

  with pickup_movements as (
    select
      im.id,
      im.product_id,
      im.quantity,
      im.from_entity_id as storage_id,
      coalesce(im.to_entity_id, v_batch.operator_id) as operator_id
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.related_pickup_batch_id = p_pickup_batch_id
      and im.reason = 'storage_to_operator_bag'
    order by im.created_at, im.id
  ),
  inserted_movements as (
    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_route_id,
      related_pickup_batch_id,
      source_type,
      source_id,
      idempotency_key,
      created_by,
      notes
    )
    select
      pm.product_id,
      pm.quantity,
      'operator_bag'::public.inventory_entity_type,
      pm.operator_id,
      'storage'::public.inventory_entity_type,
      pm.storage_id,
      'operator_bag_to_storage'::public.movement_reason,
      p_route_id,
      p_pickup_batch_id,
      'route_pickup_return',
      p_pickup_batch_id,
      'route-pickup-return:' || p_pickup_batch_id::text || ':' || pm.id::text,
      v_profile.team_member_id,
      coalesce(nullif(trim(p_reason), ''), 'Returned pickup batch to Assigned')
    from pickup_movements pm
    on conflict (idempotency_key) do nothing
    returning product_id, quantity
  ),
  movement_totals as (
    select product_id, sum(quantity)::integer as quantity
    from public.inventory_movements
    where related_route_id = p_route_id
      and related_pickup_batch_id = p_pickup_batch_id
      and reason = 'storage_to_operator_bag'
    group by product_id
  ),
  stock_upsert as (
    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      returned_qty,
      updated_at
    )
    select
      p_route_id,
      mt.product_id,
      0,
      0,
      mt.quantity,
      v_now
    from movement_totals mt
    on conflict (route_id, product_id) do update
      set returned_qty = public.route_stock_lines.returned_qty + excluded.returned_qty,
          updated_at = excluded.updated_at
    returning product_id, returned_qty
  ),
  reset_route_stops as (
    update public.route_stops
    set status = 'pending'::public.route_stop_status,
        updated_at = v_now
    where route_id = p_route_id
      and id = any(v_route_stop_ids)
      and status = 'picked'::public.route_stop_status
    returning id
  ),
  reset_route_stop_items as (
    update public.route_stop_items rsi
    set picked_quantity = 0,
        updated_at = v_now
    from public.route_stops rs
    where rsi.route_stop_id = rs.id
      and rs.route_id = p_route_id
      and rs.id = any(v_route_stop_ids)
      and coalesce(rsi.picked_quantity, 0) <> 0
    returning rsi.id
  ),
  reset_refill_lines as (
    update public.refill_order_lines rol
    set picked_qty = 0
    from public.refill_orders ro
    where rol.refill_order_id = ro.id
      and ro.route_id = p_route_id
      and (
        coalesce(array_length(v_selected_machine_ids, 1), 0) = 0
        or ro.machine_id = any(v_selected_machine_ids)
      )
      and coalesce(rol.picked_qty, 0) <> 0
    returning rol.id
  ),
  reset_pick_list_items as (
    update public.route_pick_list_items
    set
      is_checked = false,
      checked_at = null,
      checked_by = null,
      is_active = true,
      superseded_at = null,
      superseded_reason = null,
      updated_at = v_now
    where route_id = p_route_id
      and pickup_batch_id = p_pickup_batch_id
    returning id
  ),
  update_route as (
    update public.routes
    set
      status = 'assigned'::public.route_status,
      started_at = null
    where id = p_route_id
    returning status
  ),
  update_batch as (
    update public.route_pickup_batches
    set
      returned_to_assigned_at = v_now,
      returned_to_assigned_by = v_profile.team_member_id,
      returned_to_assigned_reason = coalesce(nullif(trim(p_reason), ''), 'Returned pickup batch to Assigned'),
      returned_to_assigned_movement_count = (select count(*)::integer from inserted_movements),
      returned_to_assigned_quantity = coalesce((select sum(quantity)::integer from inserted_movements), 0),
      updated_at = v_now
    where id = p_pickup_batch_id
    returning id
  )
  select
    v_batch.id,
    v_batch.route_id,
    'assigned'::public.route_status,
    coalesce((select count(*)::integer from inserted_movements), 0),
    coalesce((select sum(quantity)::integer from inserted_movements), 0),
    false
  into
    pickup_batch_id,
    route_id,
    route_status,
    compensating_movement_count,
    restored_quantity,
    already_returned;

  return next;
end;
$$;

revoke all on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[],
  uuid[]
) from public;

grant execute on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[],
  uuid[]
) to authenticated;

grant execute on function public.return_pickup_batch_to_assigned(
  uuid,
  uuid,
  text
) to authenticated;

select pg_notify('pgrst', 'reload schema');
