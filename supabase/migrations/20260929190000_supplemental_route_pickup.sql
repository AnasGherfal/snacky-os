-- Supplemental route pickup after an already-confirmed pickup.
--
-- A route edit may increase a machine's planned quantity after the operator has
-- already picked the original stock. This function moves only the incremental
-- units from storage to the assigned operator bag, appends a new pickup batch,
-- and updates cumulative picked quantities without changing route or stop state.

create or replace function public.snacky_confirm_supplemental_route_pickup_v1(
  p_route_id uuid,
  p_items jsonb,
  p_submission_id uuid
)
returns table(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_units integer,
  remaining_additional_units integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_route record;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_payload_hash text;
  v_normalized_items jsonb;
  v_existing_batch public.route_pickup_batches%rowtype;
  v_product_summary jsonb := '[]'::jsonb;
  v_selected_stop_ids uuid[] := '{}'::uuid[];
  v_item record;
  v_product record;
  v_storage record;
  v_available integer;
  v_take integer;
  v_remaining integer;
  v_total_picked integer := 0;
  v_remaining_after integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to confirm an additional pickup.'
      using errcode = '42501';
  end if;

  if p_route_id is null or p_submission_id is null then
    raise exception 'Route id and pickup submission id are required.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Add at least one additional pickup item.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'object'
      or coalesce(item.value->>'route_stop_item_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(item.value->>'quantity', '') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(coalesce(item.value->>'quantity', '')) > 6
  ) then
    raise exception 'Additional pickup items are invalid.'
      using errcode = '22023';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  ) <> (
    select pg_catalog.count(distinct (item.value->>'route_stop_item_id')::uuid)
    from pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) item(value)
  ) then
    raise exception 'Each route item may appear only once in an additional pickup.'
      using errcode = '22023';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'route_stop_item_id', normalized.route_stop_item_id,
      'quantity', normalized.quantity
    )
    order by normalized.route_stop_item_id
  )
  into v_normalized_items
  from pg_catalog.jsonb_to_recordset(p_items)
    normalized(route_stop_item_id uuid, quantity integer);

  v_payload_hash := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'route_id', p_route_id,
      'items', v_normalized_items
    )::text
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('snacky:supplemental-route-pickup'),
    pg_catalog.hashtext(p_route_id::text)
  );

  select route_row.id,
         route_row.operator_id,
         route_row.status,
         route_row.started_at
  into v_route
  from public.routes route_row
  where route_row.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.'
      using errcode = 'P0001';
  end if;

  if v_route.operator_id is null then
    raise exception 'Route must be assigned to an operator before additional pickup.'
      using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled', 'canceled') then
    raise exception 'Completed or cancelled routes cannot receive an additional pickup.'
      using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'You do not have permission to confirm an additional pickup for this route.'
      using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to a team member.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.inventory_movements movement
    where movement.related_route_id = p_route_id
      and movement.reason = 'storage_to_operator_bag'::public.movement_reason
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversed_movement_id = movement.id
      )
  ) then
    raise exception 'Confirm the original route pickup before an additional pickup.'
      using errcode = '23514';
  end if;

  select batch_row.*
  into v_existing_batch
  from public.route_pickup_batches batch_row
  where batch_row.id = p_submission_id
  for update;

  if found then
    if v_existing_batch.route_id is distinct from p_route_id
       or v_existing_batch.operator_id is distinct from v_route.operator_id then
      raise exception 'Additional pickup submission id belongs to another route or operator.'
        using errcode = '23505';
    end if;

    if v_existing_batch.confirmation_payload_hash is distinct from v_payload_hash then
      raise exception 'Additional pickup retry does not match the original submission.'
        using errcode = '23514';
    end if;

    if v_existing_batch.confirmed_at is null then
      raise exception 'Additional pickup has an incomplete prior attempt; manual review is required.'
        using errcode = '23514';
    end if;

    return query
    select
      v_existing_batch.id,
      v_route.status,
      coalesce((v_existing_batch.confirmation_result->>'picked_units')::integer, 0),
      coalesce((v_existing_batch.confirmation_result->>'remaining_additional_units')::integer, 0);
    return;
  end if;

  -- Validate and lock every route item before touching inventory.
  for v_item in
    select
      submitted.route_stop_item_id,
      submitted.quantity,
      route_item.route_stop_id,
      route_item.machine_id,
      route_item.product_id,
      route_item.planned_quantity,
      coalesce(route_item.picked_quantity, 0) as picked_quantity,
      stop_row.status as stop_status
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
    join public.route_stop_items route_item
      on route_item.id = submitted.route_stop_item_id
     and route_item.route_id = p_route_id
    join public.route_stops stop_row
      on stop_row.id = route_item.route_stop_id
     and stop_row.route_id = p_route_id
    order by submitted.route_stop_item_id
    for update of route_item, stop_row
  loop
    if v_item.stop_status::text = 'pending' then
      raise exception 'Pending stops must use the normal route pickup flow.'
        using errcode = '23514';
    end if;

    if v_item.stop_status::text in ('completed', 'skipped', 'canceled') then
      raise exception 'A completed or skipped machine stop cannot receive an additional pickup.'
        using errcode = '23514';
    end if;

    if v_item.quantity <= 0 then
      raise exception 'Additional pickup quantity must be greater than zero.'
        using errcode = '22023';
    end if;

    if v_item.quantity > greatest(v_item.planned_quantity - v_item.picked_quantity, 0) then
      raise exception 'Additional pickup quantity exceeds the remaining route plan.'
        using errcode = '23514';
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
  ) <> (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
    join public.route_stop_items route_item
      on route_item.id = submitted.route_stop_item_id
     and route_item.route_id = p_route_id
  ) then
    raise exception 'One or more additional pickup items do not belong to this route.'
      using errcode = '23514';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'product_id', grouped.product_id,
        'product_name', product_row.name,
        'quantity', grouped.quantity
      )
      order by product_row.name, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_product_summary
  from (
    select route_item.product_id, pg_catalog.sum(submitted.quantity)::integer as quantity
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
    join public.route_stop_items route_item
      on route_item.id = submitted.route_stop_item_id
     and route_item.route_id = p_route_id
    group by route_item.product_id
  ) grouped
  join public.products product_row on product_row.id = grouped.product_id;

  select coalesce(
    pg_catalog.array_agg(distinct route_item.route_stop_id order by route_item.route_stop_id),
    '{}'::uuid[]
  )
  into v_selected_stop_ids
  from pg_catalog.jsonb_to_recordset(v_normalized_items)
    submitted(route_stop_item_id uuid, quantity integer)
  join public.route_stop_items route_item
    on route_item.id = submitted.route_stop_item_id
   and route_item.route_id = p_route_id;

  insert into public.route_pickup_batches (
    id,
    route_id,
    operator_id,
    status,
    selected_stop_ids,
    product_summary,
    storage_deducted,
    confirmed_at,
    confirmation_payload_hash,
    confirmation_result
  )
  values (
    p_submission_id,
    p_route_id,
    v_route.operator_id,
    'confirmed',
    v_selected_stop_ids,
    v_product_summary,
    true,
    v_now,
    v_payload_hash,
    '{}'::jsonb
  );

  insert into public.route_pickup_batch_stops (pickup_batch_id, route_stop_id)
  select p_submission_id, selected_stop_id
  from pg_catalog.unnest(v_selected_stop_ids) selected_stop_id
  on conflict do nothing;

  -- Move only the incremental product quantities out of physical storage.
  for v_product in
    select
      route_item.product_id,
      pg_catalog.sum(submitted.quantity)::integer as quantity
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
    join public.route_stop_items route_item
      on route_item.id = submitted.route_stop_item_id
     and route_item.route_id = p_route_id
    group by route_item.product_id
    order by route_item.product_id
  loop
    v_remaining := v_product.quantity;

    for v_storage in
      select storage_row.id as storage_id
      from public.storage_locations storage_row
      join public.current_inventory_by_location inventory_row
        on inventory_row.location_type = 'storage'
       and inventory_row.location_id = storage_row.id
       and inventory_row.product_id = v_product.product_id
      where storage_row.active = true
        and storage_row.location_type::text in ('main_storage', 'vehicle', 'temporary', 'other')
        and inventory_row.quantity_on_hand > 0
      order by inventory_row.quantity_on_hand desc, storage_row.id
    loop
      exit when v_remaining <= 0;

      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(v_product.product_id::text),
        pg_catalog.hashtext(v_storage.storage_id::text)
      );

      select coalesce(pg_catalog.sum(inventory_row.quantity_on_hand), 0)::integer
      into v_available
      from public.current_inventory_by_location inventory_row
      where inventory_row.location_type = 'storage'
        and inventory_row.location_id = v_storage.storage_id
        and inventory_row.product_id = v_product.product_id;

      v_take := least(v_remaining, greatest(v_available, 0));
      if v_take <= 0 then
        continue;
      end if;

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
      values (
        v_product.product_id,
        v_take,
        'storage'::public.inventory_entity_type,
        v_storage.storage_id,
        'operator_bag'::public.inventory_entity_type,
        v_route.operator_id,
        'storage_to_operator_bag'::public.movement_reason,
        p_route_id,
        p_submission_id,
        'route_supplemental_pickup',
        p_submission_id,
        pg_catalog.format(
          'route-supplemental:%s:%s:%s',
          p_submission_id,
          v_product.product_id,
          v_storage.storage_id
        ),
        v_actor_team_member_id,
        pg_catalog.format('Additional pickup after route plan change for route %s', p_route_id)
      );

      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'Not enough physical storage stock for additional pickup. Needed %, short by %.',
        v_product.quantity,
        v_remaining
        using errcode = '23514';
    end if;
  end loop;

  -- Append one pick-list row per changed machine/product line and advance only
  -- cumulative picked quantities. Existing pickup rows are never replaced.
  for v_item in
    select
      submitted.route_stop_item_id,
      submitted.quantity,
      route_item.route_stop_id,
      route_item.machine_id,
      route_item.product_id
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
    join public.route_stop_items route_item
      on route_item.id = submitted.route_stop_item_id
     and route_item.route_id = p_route_id
    order by submitted.route_stop_item_id
  loop
    insert into public.route_pick_list_items (
      id,
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
      created_by,
      is_checked,
      checked_at,
      checked_by,
      is_active
    )
    values (
      pg_catalog.gen_random_uuid(),
      p_route_id,
      v_item.route_stop_id,
      v_item.route_stop_item_id,
      v_item.machine_id,
      v_item.product_id,
      0,
      v_item.quantity,
      'extra_product',
      p_submission_id,
      'Route plan increased after pickup',
      'Additional pickup after route edit',
      false,
      v_actor_team_member_id,
      true,
      v_now,
      v_actor_user_id,
      true
    );

    update public.route_stop_items route_item
    set picked_quantity = coalesce(route_item.picked_quantity, 0) + v_item.quantity,
        updated_at = v_now
    where route_item.id = v_item.route_stop_item_id
      and route_item.route_id = p_route_id;

    v_total_picked := v_total_picked + v_item.quantity;
  end loop;

  for v_product in
    select
      route_item.product_id,
      pg_catalog.sum(submitted.quantity)::integer as quantity
    from pg_catalog.jsonb_to_recordset(v_normalized_items)
      submitted(route_stop_item_id uuid, quantity integer)
    join public.route_stop_items route_item
      on route_item.id = submitted.route_stop_item_id
     and route_item.route_id = p_route_id
    group by route_item.product_id
    order by route_item.product_id
  loop
    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      updated_at
    )
    select
      p_route_id,
      v_product.product_id,
      coalesce(pg_catalog.sum(route_item.planned_quantity), 0)::integer,
      v_product.quantity,
      v_now
    from public.route_stop_items route_item
    where route_item.route_id = p_route_id
      and route_item.product_id = v_product.product_id
    on conflict (route_id, product_id)
    do update set
      planned_qty = excluded.planned_qty,
      picked_qty = public.route_stock_lines.picked_qty + excluded.picked_qty,
      updated_at = excluded.updated_at;
  end loop;

  select coalesce(
    pg_catalog.sum(
      greatest(route_item.planned_quantity - coalesce(route_item.picked_quantity, 0), 0)
    ),
    0
  )::integer
  into v_remaining_after
  from public.route_stop_items route_item
  join public.route_stops stop_row on stop_row.id = route_item.route_stop_id
  where route_item.route_id = p_route_id
    and stop_row.status::text not in ('pending', 'completed', 'skipped', 'canceled');

  update public.route_pickup_batches batch_row
  set confirmation_result = pg_catalog.jsonb_build_object(
        'picked_units', v_total_picked,
        'remaining_additional_units', v_remaining_after,
        'workflow_kind', 'supplemental_route_pickup'
      ),
      updated_at = v_now
  where batch_row.id = p_submission_id;

  -- Intentionally do not update public.routes or public.route_stops here.
  -- Additional pickup is a stock/custody event, not a route-state transition.
  return query
  select p_submission_id, v_route.status, v_total_picked, v_remaining_after;
end;
$function$;

revoke all on function public.snacky_confirm_supplemental_route_pickup_v1(uuid, jsonb, uuid)
  from public, anon, authenticated;

grant execute on function public.snacky_confirm_supplemental_route_pickup_v1(uuid, jsonb, uuid)
  to authenticated;

grant execute on function public.snacky_confirm_supplemental_route_pickup_v1(uuid, jsonb, uuid)
  to service_role;

comment on function public.snacky_confirm_supplemental_route_pickup_v1(uuid, jsonb, uuid) is
  'Atomically confirms only incremental stock added to an already-picked route. Appends pickup history and inventory movements without changing route or stop workflow state.';

select pg_catalog.pg_notify('pgrst', 'reload schema');
