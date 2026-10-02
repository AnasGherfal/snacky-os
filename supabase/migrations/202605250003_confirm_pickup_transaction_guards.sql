alter type public.route_status add value if not exists 'pickup_confirmed';

alter type public.route_stop_status add value if not exists 'picked';
alter type public.route_stop_status add value if not exists 'in_progress';
alter type public.route_stop_status add value if not exists 'canceled';

alter table if exists public.route_pick_list_items
  add column if not exists route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists route_stop_item_id uuid references public.route_stop_items(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

alter table if exists public.inventory_movements
  add column if not exists related_pickup_batch_id uuid;

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null
    and to_regclass('public.inventory_movements') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'inventory_movements_related_pickup_batch_id_fkey'
        and conrelid = 'public.inventory_movements'::regclass
    )
  then
    alter table public.inventory_movements
      add constraint inventory_movements_related_pickup_batch_id_fkey
      foreign key (related_pickup_batch_id)
      references public.route_pickup_batches(id)
      on delete set null;
  end if;
end $$;

drop function if exists public.confirm_route_pickup_batch(
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
  uuid[]
);

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
  v_route record;
  v_pickup_batch_id uuid;
  v_batch_stop_ids uuid[] := case
    when coalesce(array_length(p_batch_stop_ids, 1), 0) > 0 then p_batch_stop_ids
    else coalesce(p_selected_stop_ids, '{}'::uuid[])
  end;
  v_new_stop_item_rows jsonb := coalesce(p_new_stop_item_rows, '[]'::jsonb);
  v_inventory_movements jsonb := coalesce(p_inventory_movements, '[]'::jsonb);
  v_pick_list_rows jsonb := coalesce(p_pick_list_rows, '[]'::jsonb);
  v_stock_line_rows jsonb := coalesce(p_stock_line_rows, '[]'::jsonb);
  v_stop_item_picks jsonb := coalesce(p_stop_item_picks, '[]'::jsonb);
  v_refill_line_picks jsonb := coalesce(p_refill_line_picks, '[]'::jsonb);
  v_expected_stop_count integer := coalesce(array_length(p_selected_stop_ids, 1), 0);
  v_updated_stop_count integer := 0;
  v_pending_after_count integer := 0;
  v_invalid_count integer := 0;
  v_invalid_stops text;
  v_missing_products text;
  v_product_name text;
  v_available integer;
  v_needed integer;
  v_stock record;
  v_next_route_status public.route_status;
  v_has_storage_deductions boolean := false;
begin
  if p_route_id is null then
    raise exception 'Route id is required for pickup confirmation.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_new_stop_item_rows) <> 'array'
    or jsonb_typeof(v_inventory_movements) <> 'array'
    or jsonb_typeof(v_pick_list_rows) <> 'array'
    or jsonb_typeof(v_stock_line_rows) <> 'array'
    or jsonb_typeof(v_stop_item_picks) <> 'array'
    or jsonb_typeof(v_refill_line_picks) <> 'array'
  then
    raise exception 'Pickup confirmation payload is invalid.' using errcode = 'P0001';
  end if;

  if p_pickup_batch is not null and jsonb_typeof(p_pickup_batch) <> 'object' then
    raise exception 'Pickup batch payload is invalid.' using errcode = 'P0001';
  end if;

  select r.id, r.operator_id, r.status, r.started_at
  into v_route
  from public.routes r
  where r.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0001';
  end if;

  if v_route.operator_id is null then
    raise exception 'Route must be assigned to an operator before pickup can be confirmed.' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Route status does not allow pickup confirmation: %.', v_route.status::text using errcode = 'P0001';
  end if;

  if v_route.status::text not in ('draft', 'assigned', 'in_progress', 'pickup_confirmed') then
    raise exception 'Route status does not allow pickup confirmation: %.', v_route.status::text using errcode = 'P0001';
  end if;

  if p_expected_route_status is not null and v_route.status <> p_expected_route_status then
    raise exception 'Route status changed from % to %. Refresh the route before confirming pickup.', p_expected_route_status::text, v_route.status::text
      using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'User does not have permission to confirm pickup for this route.' using errcode = '42501';
  end if;

  if p_pickup_batch is not null then
    if nullif(p_pickup_batch->>'route_id', '') is not null and nullif(p_pickup_batch->>'route_id', '')::uuid <> p_route_id then
      raise exception 'Pickup batch route does not match the selected route.' using errcode = 'P0001';
    end if;

    if nullif(p_pickup_batch->>'operator_id', '') is not null and nullif(p_pickup_batch->>'operator_id', '')::uuid <> v_route.operator_id then
      raise exception 'Pickup batch operator does not match the route operator.' using errcode = 'P0001';
    end if;

    if p_pickup_batch ? 'product_summary' and jsonb_typeof(p_pickup_batch->'product_summary') <> 'array' then
      raise exception 'Pickup batch product summary is invalid.' using errcode = 'P0001';
    end if;
  end if;

  if v_expected_stop_count > 0 then
    select count(*)
    into v_invalid_count
    from unnest(p_selected_stop_ids) as selected_stop_id
    left join public.route_stops rs
      on rs.id = selected_stop_id
     and rs.route_id = p_route_id
    where rs.id is null;

    if v_invalid_count > 0 then
      raise exception 'Selected pickup stop does not belong to this route.' using errcode = 'P0001';
    end if;

    select string_agg(format('stop %s is %s', rs.id, rs.status::text), '; ')
    into v_invalid_stops
    from public.route_stops rs
    where rs.route_id = p_route_id
      and rs.id = any(p_selected_stop_ids)
      and rs.status <> 'pending'::public.route_stop_status;

    if v_invalid_stops is not null then
      raise exception 'Stop status does not allow pickup confirmation: %.', v_invalid_stops using errcode = 'P0001';
    end if;
  end if;

  with product_ids as (
    select product_id from jsonb_to_recordset(v_inventory_movements) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_pick_list_rows) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_stock_line_rows) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_new_stop_item_rows) as x(product_id uuid)
  )
  select string_agg(product_id::text, ', ')
  into v_missing_products
  from (
    select distinct product_id
    from product_ids
    where product_id is not null
  ) ids
  left join public.products p on p.id = ids.product_id
  where p.id is null;

  if v_missing_products is not null then
    raise exception 'Product is missing from inventory/product catalog: %.', v_missing_products using errcode = 'P0001';
  end if;

  if jsonb_array_length(v_inventory_movements) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    )
    where x.product_id is null
      or coalesce(x.quantity, 0) <= 0
      or x.reason not in ('storage_to_operator_bag', 'operator_bag_to_storage')
      or (
        x.reason = 'storage_to_operator_bag'
        and (
          x.from_entity_type <> 'storage'
          or x.from_entity_id is null
          or x.to_entity_type <> 'operator_bag'
          or x.to_entity_id is distinct from v_route.operator_id
        )
      )
      or (
        x.reason = 'operator_bag_to_storage'
        and (
          x.from_entity_type <> 'operator_bag'
          or x.from_entity_id is distinct from v_route.operator_id
          or x.to_entity_type <> 'storage'
          or x.to_entity_id is null
        )
      );

    if v_invalid_count > 0 then
      raise exception 'Inventory movement could not be created because the movement payload is invalid.' using errcode = 'P0001';
    end if;

    select exists (
      select 1
      from jsonb_to_recordset(v_inventory_movements) as x(reason text)
      where x.reason = 'storage_to_operator_bag'
    )
    into v_has_storage_deductions;

    for v_stock in
      select x.product_id, x.from_entity_id, sum(x.quantity)::integer as needed_qty
      from jsonb_to_recordset(v_inventory_movements) as x(
        product_id uuid,
        quantity integer,
        from_entity_type text,
        from_entity_id uuid,
        to_entity_type text,
        to_entity_id uuid,
        reason text
      )
      where x.reason = 'storage_to_operator_bag'
      group by x.product_id, x.from_entity_id
    loop
      perform pg_advisory_xact_lock(hashtext(v_stock.product_id::text), hashtext(v_stock.from_entity_id::text));

      select p.name
      into v_product_name
      from public.products p
      where p.id = v_stock.product_id;

      select coalesce(sum(cibl.quantity_on_hand), 0)::integer
      into v_available
      from public.current_inventory_by_location cibl
      where cibl.location_type = 'storage'
        and cibl.product_id = v_stock.product_id
        and cibl.location_id = v_stock.from_entity_id;

      v_needed := coalesce(v_stock.needed_qty, 0);
      if v_available is null or v_available <= 0 then
        raise exception 'Product % is missing from inventory at the selected storage location.', coalesce(v_product_name, v_stock.product_id::text)
          using errcode = 'P0001';
      end if;

      if v_available < v_needed then
        raise exception 'Not enough storage stock for %. Needed %, available %.', coalesce(v_product_name, v_stock.product_id::text), v_needed, v_available
          using errcode = 'P0001';
      end if;
    end loop;
  end if;

  if jsonb_array_length(v_new_stop_item_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    )
    left join public.route_stops rs
      on rs.id = x.route_stop_id
     and rs.route_id = p_route_id
    where x.id is null
      or x.route_stop_id is null
      or x.machine_id is null
      or x.product_id is null
      or coalesce(x.planned_quantity, 0) < 0
      or coalesce(x.picked_quantity, 0) < 0
      or x.source not in ('refill_recommendation', 'manual_admin_assignment')
      or rs.id is null
      or rs.machine_id <> x.machine_id
      or (v_expected_stop_count > 0 and x.route_stop_id <> all(p_selected_stop_ids));

    if v_invalid_count > 0 then
      raise exception 'Added pickup product is not linked to a valid selected stop.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_array_length(v_stop_item_picks) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_stop_item_picks) as x(id uuid, picked_quantity integer)
    left join public.route_stop_items rsi
      on rsi.id = x.id
     and rsi.route_id = p_route_id
    left join jsonb_to_recordset(v_new_stop_item_rows) as new_rsi(id uuid)
      on new_rsi.id = x.id
    where x.id is null
      or x.picked_quantity is null
      or x.picked_quantity < 0
      or coalesce(rsi.id, new_rsi.id) is null;

    if v_invalid_count > 0 then
      raise exception 'Route pick item is missing from this route.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_array_length(v_refill_line_picks) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_refill_line_picks) as x(id uuid, picked_qty integer)
    left join public.refill_order_lines rol on rol.id = x.id
    left join public.refill_orders ro
      on ro.id = rol.refill_order_id
     and ro.route_id = p_route_id
    where x.id is null
      or x.picked_qty is null
      or x.picked_qty < 0
      or ro.id is null;

    if v_invalid_count > 0 then
      raise exception 'Refill order line is missing from this route.' using errcode = 'P0001';
    end if;
  end if;

  if p_pickup_batch is not null or coalesce(array_length(v_batch_stop_ids, 1), 0) > 0 then
    v_pickup_batch_id := coalesce(nullif(p_pickup_batch->>'id', '')::uuid, gen_random_uuid());

    insert into public.route_pickup_batches (
      id,
      route_id,
      operator_id,
      status,
      selected_stop_ids,
      product_summary,
      storage_deducted,
      confirmed_at
    )
    values (
      v_pickup_batch_id,
      p_route_id,
      coalesce(nullif(p_pickup_batch->>'operator_id', '')::uuid, v_route.operator_id),
      coalesce(nullif(p_pickup_batch->>'status', ''), 'confirmed'),
      coalesce(v_batch_stop_ids, '{}'::uuid[]),
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb),
      coalesce((p_pickup_batch->>'storage_deducted')::boolean, v_has_storage_deductions),
      coalesce(nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz, now())
    );

    if coalesce(array_length(v_batch_stop_ids, 1), 0) > 0 then
      insert into public.route_pickup_batch_stops (pickup_batch_id, route_stop_id)
      select v_pickup_batch_id, unnest(v_batch_stop_ids)
      on conflict do nothing;
    end if;
  end if;

  if jsonb_array_length(v_new_stop_item_rows) > 0 then
    insert into public.route_stop_items (
      id,
      route_id,
      route_stop_id,
      machine_id,
      product_id,
      machine_slot_id,
      slot_code,
      planned_quantity,
      picked_quantity,
      source,
      notes
    )
    select
      x.id,
      p_route_id,
      x.route_stop_id,
      x.machine_id,
      x.product_id,
      x.machine_slot_id,
      x.slot_code,
      x.planned_quantity,
      x.picked_quantity,
      x.source,
      x.notes
    from jsonb_to_recordset(v_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    );
  end if;

  if p_replace_pick_list then
    delete from public.route_pick_list_items
    where route_id = p_route_id;
  end if;

  if jsonb_array_length(v_pick_list_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_pick_list_rows) as x(
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid
    )
    left join public.route_stops rs
      on rs.id = x.route_stop_id
     and rs.route_id = p_route_id
    left join public.route_stop_items rsi
      on rsi.id = x.route_stop_item_id
     and rsi.route_id = p_route_id
    where x.product_id is null
      or x.planned_qty is null
      or x.picked_qty is null
      or x.planned_qty < 0
      or x.picked_qty < 0
      or x.action_type not in ('planned_pick', 'extra_product', 'substitution')
      or (x.route_stop_id is not null and rs.id is null)
      or (x.route_stop_id is not null and v_expected_stop_count > 0 and x.route_stop_id <> all(p_selected_stop_ids))
      or (x.route_stop_item_id is not null and rsi.id is null)
      or (x.route_stop_item_id is not null and x.route_stop_id is not null and rsi.route_stop_id <> x.route_stop_id)
      or (x.route_stop_id is not null and x.machine_id is not null and rs.machine_id <> x.machine_id);

    if v_invalid_count > 0 then
      raise exception 'Pick list row is not valid for the selected route stops.' using errcode = 'P0001';
    end if;

    insert into public.route_pick_list_items (
      route_id,
      route_stop_id,
      route_stop_item_id,
      machine_id,
      product_id,
      planned_qty,
      picked_qty,
      action_type,
      pickup_batch_id,
      reason,
      notes,
      needs_review,
      created_by
    )
    select
      p_route_id,
      x.route_stop_id,
      x.route_stop_item_id,
      x.machine_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      x.action_type,
      coalesce(x.pickup_batch_id, v_pickup_batch_id),
      x.reason,
      x.notes,
      coalesce(x.needs_review, false),
      x.created_by
    from jsonb_to_recordset(v_pick_list_rows) as x(
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid
    );
  end if;

  if jsonb_array_length(v_inventory_movements) > 0 then
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
      created_by,
      notes
    )
    select
      x.product_id,
      x.quantity,
      x.from_entity_type::public.inventory_entity_type,
      x.from_entity_id,
      x.to_entity_type::public.inventory_entity_type,
      x.to_entity_id,
      x.reason::public.movement_reason,
      p_route_id,
      case
        when x.reason = 'storage_to_operator_bag' then coalesce(x.related_pickup_batch_id, v_pickup_batch_id)
        else x.related_pickup_batch_id
      end,
      x.created_by,
      x.notes
    from jsonb_to_recordset(v_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    );
  end if;

  if jsonb_array_length(v_stock_line_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    where x.product_id is null
      or x.planned_qty is null
      or x.picked_qty is null
      or x.planned_qty < 0
      or x.picked_qty < 0;

    if v_invalid_count > 0 then
      raise exception 'Route stock line payload is invalid.' using errcode = 'P0001';
    end if;

    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      updated_at
    )
    select
      p_route_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(v_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    on conflict (route_id, product_id)
    do update set
      planned_qty = excluded.planned_qty,
      picked_qty = excluded.picked_qty,
      updated_at = excluded.updated_at;
  end if;

  if jsonb_array_length(v_stop_item_picks) > 0 then
    update public.route_stop_items rsi
    set picked_quantity = x.picked_quantity,
        updated_at = now()
    from jsonb_to_recordset(v_stop_item_picks) as x(id uuid, picked_quantity integer)
    where rsi.id = x.id
      and rsi.route_id = p_route_id;
  end if;

  if jsonb_array_length(v_refill_line_picks) > 0 then
    update public.refill_order_lines rol
    set picked_qty = x.picked_qty
    from jsonb_to_recordset(v_refill_line_picks) as x(id uuid, picked_qty integer),
      public.refill_orders ro
    where rol.id = x.id
      and ro.id = rol.refill_order_id
      and ro.route_id = p_route_id;
  end if;

  if v_expected_stop_count > 0 then
    update public.route_stops
    set status = 'picked'::public.route_stop_status
    where route_id = p_route_id
      and id = any(p_selected_stop_ids)
      and status = 'pending'::public.route_stop_status;

    get diagnostics v_updated_stop_count = row_count;
    if v_updated_stop_count <> v_expected_stop_count then
      raise exception 'Stop status does not allow pickup confirmation: only pending stops can be picked for this route.'
        using errcode = 'P0001';
    end if;
  end if;

  select count(*)
  into v_pending_after_count
  from public.route_stops
  where route_id = p_route_id
    and status = 'pending'::public.route_stop_status;

  if v_pending_after_count = 0 then
    v_next_route_status := 'pickup_confirmed'::public.route_status;
  else
    v_next_route_status := 'in_progress'::public.route_status;
  end if;

  update public.routes
  set status = v_next_route_status,
      started_at = coalesce(started_at, p_started_at, now())
  where id = p_route_id;

  update public.refill_orders
  set status = 'picked'::public.refill_status
  where route_id = p_route_id
    and status in ('assigned'::public.refill_status, 'in_progress'::public.refill_status, 'picked'::public.refill_status)
    and (
      coalesce(array_length(p_selected_machine_ids, 1), 0) = 0
      or machine_id = any(p_selected_machine_ids)
    );

  return query select
    v_pickup_batch_id,
    v_next_route_status,
    coalesce(p_selected_stop_ids, '{}'::uuid[]),
    v_pending_after_count;
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
  uuid[]
) to authenticated;

create or replace function public.validate_route_workflow_schema(
  p_route_statuses text[] default array[
    'draft',
    'assigned',
    'in_progress',
    'pickup_confirmed',
    'completed',
    'reviewed',
    'cancelled'
  ],
  p_route_stop_statuses text[] default array[
    'pending',
    'picked',
    'in_progress',
    'completed',
    'skipped',
    'canceled',
    'arrived',
    'refilling',
    'cash_collected',
    'issue_reported'
  ]
)
returns table(enum_name text, missing_values text[])
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with route_values as (
    select enumlabel::text as value
    from pg_catalog.pg_enum
    where enumtypid = 'public.route_status'::regtype
  ),
  route_stop_values as (
    select enumlabel::text as value
    from pg_catalog.pg_enum
    where enumtypid = 'public.route_stop_status'::regtype
  ),
  route_missing as (
    select array_agg(required order by ord) as values
    from unnest(p_route_statuses) with ordinality as required_status(required, ord)
    where not exists (select 1 from route_values where value = required_status.required)
  ),
  route_stop_missing as (
    select array_agg(required order by ord) as values
    from unnest(p_route_stop_statuses) with ordinality as required_status(required, ord)
    where not exists (select 1 from route_stop_values where value = required_status.required)
  )
  select 'route_status'::text, coalesce(values, '{}'::text[]) from route_missing where coalesce(array_length(values, 1), 0) > 0
  union all
  select 'route_stop_status'::text, coalesce(values, '{}'::text[]) from route_stop_missing where coalesce(array_length(values, 1), 0) > 0;
$$;

revoke all on function public.validate_route_workflow_schema(text[], text[]) from public;
grant execute on function public.validate_route_workflow_schema(text[], text[]) to authenticated;

select pg_notify('pgrst', 'reload schema');
