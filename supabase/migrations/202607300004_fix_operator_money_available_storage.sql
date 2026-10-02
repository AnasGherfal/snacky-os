-- Deduct route reservations once across all storage locations instead of once per location.
create or replace function public.operator_money_available_storage(p_product_id uuid)
returns table(storage_location_id uuid, storage_name text, on_hand_qty integer, reserved_qty integer, available_qty integer)
language sql
stable
security definer
set search_path=public,auth
as $$
  with stock as (
    select
      sl.id as storage_location_id,
      sl.name as storage_name,
      coalesce(ci.quantity_on_hand, 0)::integer as on_hand_qty
    from public.storage_locations sl
    left join public.current_inventory_by_location ci
      on ci.location_type = 'storage'
     and ci.location_id = sl.id
     and ci.product_id = p_product_id
    where coalesce(sl.active, true) = true
  ), ranked as (
    select
      stock.*,
      coalesce(sum(on_hand_qty) over (
        order by on_hand_qty desc, storage_name, storage_location_id
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as stock_before,
      public.operator_money_reserved_qty(p_product_id)::integer as total_reserved
    from stock
  )
  select
    storage_location_id,
    storage_name,
    on_hand_qty,
    least(on_hand_qty, greatest(total_reserved - stock_before, 0))::integer as reserved_qty,
    greatest(on_hand_qty - greatest(total_reserved - stock_before, 0), 0)::integer as available_qty
  from ranked
  order by available_qty desc, storage_name;
$$;

grant execute on function public.operator_money_available_storage(uuid) to authenticated;
notify pgrst, 'reload schema';
