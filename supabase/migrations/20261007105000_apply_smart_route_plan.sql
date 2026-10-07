-- Atomically replace an unpicked route's ordinary refill plan with a Smart Route plan.
-- Storage is NOT deducted here. The existing pickup-confirmation workflow remains the
-- single place that verifies/deducts physical warehouse stock.

create or replace function public.snacky_apply_smart_route_plan_v1(
  p_route_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
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

  -- A generated plan may be replaced only before the operator has physically
  -- picked anything. This keeps route-plan regeneration separate from inventory movement.
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

  -- Every item must target a real stop on this route, an active product and
  -- a positive unit quantity. Product/slot compatibility has already been
  -- checked by the Smart Route planner.
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      machine_id uuid,
      product_id uuid,
      quantity integer,
      machine_slot_id uuid,
      slot_code text,
      notes text
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
  ) then
    raise exception 'Smart Route contains an invalid machine, product or quantity.';
  end if;

  -- Remove only planning/checklist rows. No inventory movement is touched.
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
    picked_quantity,
    source,
    notes
  )
  select
    p_route_id,
    stop.id,
    item.machine_id,
    item.product_id,
    item.machine_slot_id,
    nullif(btrim(item.slot_code), ''),
    item.quantity,
    null,
    'smart_ai_plan',
    nullif(left(coalesce(item.notes, ''), 2000), '')
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text
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
    notes text
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
    source
  )
  select
    refill.id,
    item.machine_slot_id,
    nullif(btrim(item.slot_code), ''),
    item.product_id,
    0,
    item.quantity,
    item.quantity,
    item.quantity,
    item.quantity,
    'smart_ai_plan'
  from jsonb_to_recordset(p_items) as item(
    machine_id uuid,
    product_id uuid,
    quantity integer,
    machine_slot_id uuid,
    slot_code text,
    notes text
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
    notes text
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
    notes text
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
  'Atomically replaces an unpicked route plan with slot-level Smart Route assignments. Does not deduct storage; pickup confirmation remains authoritative.';

select pg_notify('pgrst', 'reload schema');
