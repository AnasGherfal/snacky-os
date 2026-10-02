create unique index if not exists idx_inventory_movements_reversed_movement_id_unique
  on public.inventory_movements(reversed_movement_id)
  where reversed_movement_id is not null;

select pg_notify('pgrst', 'reload schema');
