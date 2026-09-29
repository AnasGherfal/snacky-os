create index if not exists idx_inventory_movements_storage_from_balance
on public.inventory_movements (product_id)
include (quantity)
where from_entity_type = 'storage'::public.inventory_entity_type;

create index if not exists idx_inventory_movements_storage_to_balance
on public.inventory_movements (product_id)
include (quantity)
where to_entity_type = 'storage'::public.inventory_entity_type;

analyze public.inventory_movements;
