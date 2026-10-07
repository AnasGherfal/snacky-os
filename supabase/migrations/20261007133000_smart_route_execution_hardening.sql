-- Preserve exact Smart Route lane allocations for operator execution and admin audit.
-- Planning remains non-inventory-mutating: storage is still deducted only by pickup confirmation.

create or replace function public.snacky_apply_smart_route_plan_v1(
  p_route_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_route public.routes%rowtype;
  v_item_count integer := 0;
  v_unit_count integer := 0;
  v_product_count integer := 0;
begin
  select *
  into v_route
  from public.routes
  where id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Smart Route produced no pickup items.';
  end if;

  if exists (
    select 1
    from public.route_stop_items
    where route_id = p_route_id
      and coalesce(picked_quantity, 0) > 0
  ) or exists (
    select 1
    from public.route_stock_lines
    where route_id = p_route_id
      and coalesce(picked_qty, 0) > 0
  ) or exists (
    select 1
    from public.inventory_movements
    where related_route_id = p_route_id
      and reason = 'storage_to_operator_bag'
  ) then
    raise exception 'Smart Route cannot be regenerated after pickup has started.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      machine_id uuid,
      product_id uuid,
      quantity integer,
      machine_slot_id uuid,
      slot_code text,
      notes text,
      slot_allocations jsonb
    )
    left join public.route_stops stop
      on stop.route_id = p_route_id
     and stop.machine_id = item.machine_id
    left join public.products product
      on product.id = item.product_id
     and product.active = true
    where item.machine_id is null
       or item.product_id is null
       or coalesce(item.quantity, 0) <= 0
       or stop.id is null
       or product.id is null
       or (item.slot_allocations is not null and jsonb_typeof(item.slot_allocations) is distinct from 'array')
  ) then
    raise exception 'Smart Route contains an invalid machine, product, quantity, or lane allocation.';
  end if;

  if to_regclass('public.route_pick_list_items') is not null then
    execute 'delete from public.route_pick_list_items where route_id = $1' using p_route_id;
  end if;

  delete from public.refill_order_lines line
  using public.refill_orders refill
  where line.refill_order_id = refill.id
    and refill.route_id = p_route_id;

  delete from public.refill_orders
  where route_id = p_route_id;

  delete from public.route_stop_items
  where route_id = p_route_id;

  delete from public.route_stock_lines
  where route_id = p_route_id;

  insert into public.route_stop_items (
    route_id,
    route_stop_id,
    machine_id,
    product_id,
    machine_slot_id,
    slot_code,
    planned_quantity,
    recommended_take_qty,
    final_take_qty,
    picked_quantity,
    source,
    notes,
    slot_allocations
  )
  select
    p_route_id,
    stop.id,
    item.machine_id,
    item.product_id,
    item.machine_slot_id,
    nullif(btrim(item.slot_code), ''),
    item.quantity,
    item.quantity,
    item.quantity,
    null,
    'smart_ai_plan',
    nullif(left(coalesce(item.notes, ''), 2000), ''),
    coalesce(item.slot_allocations, '[]'::jsonb)
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text,
    slot_allocations jsonb
  )
  join public.route_stops stop
    on stop.route_id = p_route_id
   and stop.machine_id = item.machine_id;

  get diagnostics v_item_count = row_count;

  insert into public.refill_orders (route_id, machine_id, status)
  select distinct
    p_route_id,
    item.machine_id,
    'assigned'
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text,
    slot_allocations jsonb
  );

  insert into public.refill_order_lines (
    refill_order_id,
    machine_slot_id,
    slot_code,
    product_id,
    current_qty_vms,
    par_qty,
    suggested_qty,
    available_storage_qty,
    final_qty_to_take,
    recommended_take_qty,
    final_take_qty,
    source,
    slot_allocations
  )
  select
    refill.id,
    item.machine_slot_id,
    nullif(btrim(item.slot_code), ''),
    item.product_id,
    coalesce((
      select sum(coalesce((allocation->>'current_qty')::integer, 0))::integer
      from jsonb_array_elements(coalesce(item.slot_allocations, '[]'::jsonb)) allocation
    ), 0),
    coalesce((
      select sum(coalesce((allocation->>'target_qty')::integer, 0))::integer
      from jsonb_array_elements(coalesce(item.slot_allocations, '[]'::jsonb)) allocation
    ), item.quantity),
    item.quantity,
    item.quantity,
    item.quantity,
    item.quantity,
    item.quantity,
    'smart_ai_plan',
    coalesce(item.slot_allocations, '[]'::jsonb)
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text,
    slot_allocations jsonb
  )
  join public.refill_orders refill
    on refill.route_id = p_route_id
   and refill.machine_id = item.machine_id;

  insert into public.route_stock_lines (
    route_id,
    product_id,
    planned_qty,
    picked_qty,
    returned_qty
  )
  select
    p_route_id,
    item.product_id,
    sum(item.quantity)::integer,
    0,
    0
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text,
    slot_allocations jsonb
  )
  group by item.product_id;

  select
    coalesce(sum(item.quantity), 0)::integer,
    count(distinct item.product_id)::integer
  into v_unit_count, v_product_count
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text,
    slot_allocations jsonb
  );

  return jsonb_build_object(
    'route_id', p_route_id,
    'planned_item_count', v_item_count,
    'planned_unit_count', v_unit_count,
    'product_count', v_product_count
  );
end;
$$;

revoke all on function public.snacky_apply_smart_route_plan_v1(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.snacky_apply_smart_route_plan_v1(uuid, jsonb) to service_role;

comment on function public.snacky_apply_smart_route_plan_v1(uuid, jsonb) is
  'Atomically replaces an unpicked route plan with exact Smart Route lane allocations. Does not deduct storage; pickup confirmation remains authoritative.';

select pg_notify('pgrst', 'reload schema');


-- Smart Route swap returns stay with the route operator until normal route finalization.
-- This prevents the system from reporting stock back in storage before it is physically there.
create or replace function public.snacky_record_smart_route_return_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_machine_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_slot_code text,
  p_actor_user_id uuid,
  p_actor_team_member_id uuid,
  p_client_submission_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_product public.products%rowtype;
  v_existing public.inventory_adjustments%rowtype;
  v_existing_movement public.inventory_movements%rowtype;
  v_adjustment_id uuid;
  v_movement_id uuid;
  v_machine_qty bigint := 0;
  v_unit_cost numeric(12,4) := 0;
  v_total_cost numeric(12,2) := 0;
  v_submission_id text := nullif(btrim(coalesce(p_client_submission_id, '')), '');
  v_slot_code text := nullif(btrim(coalesce(p_slot_code, '')), '');
  v_notes text;
  v_idempotency_key text;
  v_payload jsonb;
begin
  if p_route_id is null or p_route_stop_id is null or p_machine_id is null or p_product_id is null then
    raise exception 'Route, stop, machine and product are required.';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Returned quantity must be greater than zero.';
  end if;
  if v_submission_id is null or length(v_submission_id) > 200 then
    raise exception 'A stable Smart Route return submission id is required.';
  end if;
  if p_actor_user_id is null or p_actor_team_member_id is null then
    raise exception 'Smart Route return actor is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('snacky:route-inventory:' || p_route_id::text, 0));

  select route_row.*
  into v_route
  from public.routes route_row
  where route_row.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.';
  end if;
  if v_route.operator_id is null then
    raise exception 'Route must have an assigned operator before a Smart Route return.';
  end if;
  if v_route.status::text in ('completed', 'reviewed', 'cancelled', 'canceled') then
    raise exception 'A terminal route cannot receive a Smart Route return.';
  end if;

  select stop_row.*
  into v_stop
  from public.route_stops stop_row
  where stop_row.id = p_route_stop_id
  for update;

  if not found
     or v_stop.route_id is distinct from p_route_id
     or v_stop.machine_id is distinct from p_machine_id then
    raise exception 'Smart Route return stop does not match this route and machine.';
  end if;
  if v_stop.status::text in ('completed', 'skipped', 'cancelled', 'canceled') then
    raise exception 'A closed stop cannot receive a Smart Route return.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('snacky:operator-custody:' || v_route.operator_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('snacky:operator-bag:' || v_route.operator_id::text || ':' || p_product_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('snacky:machine-stock:' || p_machine_id::text || ':' || p_product_id::text, 0));

  select adjustment.*
  into v_existing
  from public.inventory_adjustments adjustment
  where adjustment.client_submission_id = v_submission_id
  for update;

  if found then
    if v_existing.adjustment_type is distinct from 'returned_from_machine'
       or v_existing.route_id is distinct from p_route_id
       or v_existing.route_stop_id is distinct from p_route_stop_id
       or v_existing.machine_id is distinct from p_machine_id
       or v_existing.product_id is distinct from p_product_id
       or v_existing.quantity is distinct from p_quantity
       or v_existing.reason is distinct from 'Product replaced'
       or v_existing.operator_id is distinct from v_route.operator_id
       or v_existing.status is distinct from 'confirmed'
       or v_existing.inventory_movement_id is null
       or v_existing.storage_movement_id is not null then
      raise exception 'Smart Route return retry does not match its committed record.';
    end if;

    select movement.*
    into v_existing_movement
    from public.inventory_movements movement
    where movement.id = v_existing.inventory_movement_id
    for update;

    if not found
       or v_existing_movement.product_id is distinct from p_product_id
       or v_existing_movement.quantity is distinct from p_quantity
       or v_existing_movement.from_entity_type::text <> 'machine'
       or v_existing_movement.from_entity_id is distinct from p_machine_id
       or v_existing_movement.to_entity_type::text <> 'operator_bag'
       or v_existing_movement.to_entity_id is distinct from v_route.operator_id
       or v_existing_movement.reason::text <> 'returned_from_machine' then
      raise exception 'Smart Route return retry no longer matches its inventory movement.';
    end if;

    return jsonb_build_object(
      'id', v_existing.id,
      'adjustment_type', v_existing.adjustment_type,
      'product_id', v_existing.product_id,
      'product_name', v_existing.product_name,
      'machine_id', v_existing.machine_id,
      'route_id', v_existing.route_id,
      'route_stop_id', v_existing.route_stop_id,
      'operator_id', v_existing.operator_id,
      'quantity', v_existing.quantity,
      'reason', v_existing.reason,
      'notes', v_existing.notes,
      'status', v_existing.status,
      'inventory_movement_id', v_existing.inventory_movement_id,
      'created_at', v_existing.created_at,
      'already_recorded', true
    );
  end if;

  select product_row.*
  into v_product
  from public.products product_row
  where product_row.id = p_product_id
    and product_row.active = true
  for update;

  if not found then
    raise exception 'Returned Smart Route product is missing or inactive.';
  end if;

  select coalesce(sum(
    case
      when movement.to_entity_type::text = 'machine'
       and movement.to_entity_id = p_machine_id then movement.quantity::bigint
      else 0::bigint
    end
    +
    case
      when movement.from_entity_type::text = 'machine'
       and movement.from_entity_id = p_machine_id then -movement.quantity::bigint
      else 0::bigint
    end
  ), 0::bigint)
  into v_machine_qty
  from public.inventory_movements movement
  where movement.product_id = p_product_id;

  if v_machine_qty < p_quantity::bigint then
    raise exception 'Returned quantity exceeds verified machine stock for this product.';
  end if;

  v_unit_cost := coalesce(
    nullif(v_product.average_cost_lyd, 0),
    nullif(v_product.last_purchase_cost_lyd, 0),
    nullif(v_product.current_cost_price_lyd, 0),
    nullif(v_product.cost_price, 0),
    0
  )::numeric(12,4);
  v_total_cost := round((v_unit_cost * p_quantity)::numeric, 2);
  v_adjustment_id := gen_random_uuid();
  v_notes := concat(
    'Smart Route product swap',
    case when v_slot_code is null then '' else ' — lane ' || v_slot_code end,
    '. Returned to operator custody; route finalization returns remaining bag stock to storage.'
  );
  v_idempotency_key := 'smart-route-swap-return:v1:' || v_submission_id;
  v_payload := jsonb_build_object(
    'contract_version', 1,
    'adjustment_id', v_adjustment_id,
    'route_id', p_route_id,
    'route_stop_id', p_route_stop_id,
    'machine_id', p_machine_id,
    'operator_id', v_route.operator_id,
    'product_id', p_product_id,
    'quantity', p_quantity,
    'slot_code', v_slot_code,
    'client_submission_id', v_submission_id
  );

  insert into public.inventory_adjustments (
    id,
    adjustment_type,
    product_id,
    product_name,
    machine_id,
    location_id,
    route_id,
    route_stop_id,
    operator_id,
    quantity,
    unit_cost_lyd,
    total_cost_lyd,
    reason,
    notes,
    status,
    created_by_user_id,
    client_submission_id
  )
  select
    v_adjustment_id,
    'returned_from_machine',
    p_product_id,
    v_product.name,
    p_machine_id,
    machine.location_id,
    p_route_id,
    p_route_stop_id,
    v_route.operator_id,
    p_quantity,
    v_unit_cost,
    v_total_cost,
    'Product replaced',
    v_notes,
    'confirmed',
    p_actor_user_id,
    v_submission_id
  from public.machines machine
  where machine.id = p_machine_id;

  if not found then
    raise exception 'Smart Route return machine was not found.';
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
    related_route_stop_id,
    related_machine_id,
    unit_cost_lyd,
    line_total_lyd,
    source_type,
    source_id,
    idempotency_key,
    idempotency_payload,
    created_by,
    notes
  ) values (
    p_product_id,
    p_quantity,
    'machine'::public.inventory_entity_type,
    p_machine_id,
    'operator_bag'::public.inventory_entity_type,
    v_route.operator_id,
    'returned_from_machine'::public.movement_reason,
    p_route_id,
    p_route_stop_id,
    p_machine_id,
    v_unit_cost,
    v_total_cost,
    'inventory_adjustment',
    v_adjustment_id,
    v_idempotency_key,
    v_payload,
    p_actor_team_member_id,
    v_notes
  )
  returning id into v_movement_id;

  update public.inventory_adjustments adjustment
  set inventory_movement_id = v_movement_id,
      updated_at = now()
  where adjustment.id = v_adjustment_id
    and adjustment.inventory_movement_id is null
    and adjustment.storage_movement_id is null;

  if not found then
    raise exception 'Smart Route return movement could not be linked atomically.';
  end if;

  return jsonb_build_object(
    'id', v_adjustment_id,
    'adjustment_type', 'returned_from_machine',
    'product_id', p_product_id,
    'product_name', v_product.name,
    'machine_id', p_machine_id,
    'route_id', p_route_id,
    'route_stop_id', p_route_stop_id,
    'operator_id', v_route.operator_id,
    'quantity', p_quantity,
    'reason', 'Product replaced',
    'notes', v_notes,
    'status', 'confirmed',
    'inventory_movement_id', v_movement_id,
    'created_at', now(),
    'already_recorded', false
  );
end;
$$;

revoke all on function public.snacky_record_smart_route_return_v1(uuid, uuid, uuid, uuid, integer, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.snacky_record_smart_route_return_v1(uuid, uuid, uuid, uuid, integer, text, uuid, uuid, text)
  to service_role;

comment on function public.snacky_record_smart_route_return_v1(uuid, uuid, uuid, uuid, integer, text, uuid, uuid, text) is
  'Records a Smart Route product-swap return as machine to operator bag custody. Route finalization later returns remaining operator bag stock to physical storage.';

select pg_notify('pgrst', 'reload schema');
