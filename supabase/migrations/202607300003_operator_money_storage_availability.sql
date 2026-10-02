-- Restore the storage availability RPC used by operator personal purchases.
create or replace function public.operator_money_available_storage(p_product_id uuid)
returns table(storage_location_id uuid, storage_name text, on_hand_qty integer, reserved_qty integer, available_qty integer)
language sql
stable
security definer
set search_path=public,auth
as $$
  with reserved as (
    select public.operator_money_reserved_qty(p_product_id) as qty
  )
  select
    sl.id as storage_location_id,
    sl.name as storage_name,
    coalesce(ci.quantity_on_hand, 0)::integer as on_hand_qty,
    least(coalesce(ci.quantity_on_hand, 0)::integer, reserved.qty)::integer as reserved_qty,
    greatest(coalesce(ci.quantity_on_hand, 0)::integer - reserved.qty, 0)::integer as available_qty
  from public.storage_locations sl
  cross join reserved
  left join public.current_inventory_by_location ci
    on ci.location_type = 'storage'
   and ci.location_id = sl.id
   and ci.product_id = p_product_id
  where coalesce(sl.active, true) = true
  order by greatest(coalesce(ci.quantity_on_hand, 0)::integer - reserved.qty, 0) desc, sl.name;
$$;

grant execute on function public.operator_money_available_storage(uuid) to authenticated;
notify pgrst, 'reload schema';
