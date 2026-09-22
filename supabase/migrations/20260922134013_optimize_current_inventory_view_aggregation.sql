create or replace view public.current_inventory_by_location
with (security_invoker = true)
as
with movement_locations as (
  select
    product_id,
    from_entity_type as location_type,
    from_entity_id as location_id,
    -quantity as quantity_delta
  from public.inventory_movements
  where from_entity_type = any (
    array['storage','operator_bag','machine']::public.inventory_entity_type[]
  )

  union all

  select
    product_id,
    to_entity_type as location_type,
    to_entity_id as location_id,
    quantity as quantity_delta
  from public.inventory_movements
  where to_entity_type = any (
    array['storage','operator_bag','machine']::public.inventory_entity_type[]
  )
),
balances as (
  select
    product_id,
    location_type,
    location_id,
    sum(quantity_delta)::integer as quantity_on_hand
  from movement_locations
  group by product_id, location_type, location_id
  having sum(quantity_delta) <> 0
)
select
  p.id as product_id,
  p.name as product_name,
  b.location_type::text as location_type,
  b.location_id,
  coalesce(sl.name, tm.full_name, m.name, 'Unknown'::text) as location_name,
  b.quantity_on_hand
from balances b
join public.products p
  on p.id = b.product_id
left join public.storage_locations sl
  on b.location_type = 'storage'::public.inventory_entity_type
 and sl.id = b.location_id
left join public.team_members tm
  on b.location_type = 'operator_bag'::public.inventory_entity_type
 and tm.id = b.location_id
left join public.machines m
  on b.location_type = 'machine'::public.inventory_entity_type
 and m.id = b.location_id;

revoke all on table public.current_inventory_by_location from public, anon;
grant select on table public.current_inventory_by_location to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
