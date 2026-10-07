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
