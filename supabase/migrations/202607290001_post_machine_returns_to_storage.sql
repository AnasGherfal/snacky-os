-- A product marked "returned from machine" is physically brought back from the
-- machine during the route. The original adjustment RPC records machine ->
-- operator_bag. Complete that same return with operator_bag -> storage so the
-- storage balance increases immediately and the operator bag remains correct.

create or replace function public.snacky_post_machine_return_to_storage()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_storage_id uuid;
  v_idempotency_key text;
begin
  if new.adjustment_type <> 'returned_from_machine'
    or new.status = 'cancelled'
    or new.inventory_movement_id is null then
    return new;
  end if;

  v_storage_id := public.snacky_route_leftover_storage_location_id(new.route_id);
  if v_storage_id is null then
    raise exception 'No active storage location found for returned machine product.';
  end if;

  v_idempotency_key := 'machine-return-storage:' || new.id::text;

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
    created_by,
    notes
  ) values (
    new.product_id,
    new.quantity,
    'operator_bag',
    new.operator_id,
    'storage',
    v_storage_id,
    'operator_bag_to_storage',
    new.route_id,
    new.route_stop_id,
    new.machine_id,
    new.unit_cost_lyd,
    new.total_cost_lyd,
    'inventory_adjustment',
    new.id,
    v_idempotency_key,
    new.operator_id,
    'Returned from machine and posted immediately to storage: ' || coalesce(new.reason, 'No reason supplied')
  )
  on conflict (idempotency_key) do nothing;

  return new;
end;
$$;

drop trigger if exists inventory_adjustments_post_machine_return_to_storage
  on public.inventory_adjustments;

create trigger inventory_adjustments_post_machine_return_to_storage
after insert or update of inventory_movement_id, status
on public.inventory_adjustments
for each row
execute function public.snacky_post_machine_return_to_storage();

-- Repair existing confirmed machine returns that were recorded in the operator
-- bag but never posted onward to storage. The idempotency key prevents doubles.
do $$
declare
  v_adjustment public.inventory_adjustments%rowtype;
  v_storage_id uuid;
begin
  for v_adjustment in
    select ia.*
    from public.inventory_adjustments ia
    where ia.adjustment_type = 'returned_from_machine'
      and ia.status <> 'cancelled'
      and ia.inventory_movement_id is not null
  loop
    v_storage_id := public.snacky_route_leftover_storage_location_id(v_adjustment.route_id);
    if v_storage_id is null then
      continue;
    end if;

    insert into public.inventory_movements (
      product_id, quantity,
      from_entity_type, from_entity_id,
      to_entity_type, to_entity_id,
      reason,
      related_route_id, related_route_stop_id, related_machine_id,
      unit_cost_lyd, line_total_lyd,
      source_type, source_id, idempotency_key,
      created_by, notes
    ) values (
      v_adjustment.product_id, v_adjustment.quantity,
      'operator_bag', v_adjustment.operator_id,
      'storage', v_storage_id,
      'operator_bag_to_storage',
      v_adjustment.route_id, v_adjustment.route_stop_id, v_adjustment.machine_id,
      v_adjustment.unit_cost_lyd, v_adjustment.total_cost_lyd,
      'inventory_adjustment', v_adjustment.id,
      'machine-return-storage:' || v_adjustment.id::text,
      v_adjustment.operator_id,
      'Backfilled machine return into storage: ' || coalesce(v_adjustment.reason, 'No reason supplied')
    )
    on conflict (idempotency_key) do nothing;
  end loop;
end;
$$;
