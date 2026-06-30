-- Ensure route-related upserts have matching unique keys in production.

create unique index if not exists route_stock_lines_route_id_product_id_key
  on public.route_stock_lines(route_id, product_id);

create unique index if not exists machine_refill_history_legacy_refill_id_unique
  on public.machine_refill_history(legacy_refill_id);

create unique index if not exists idx_inventory_movements_idempotency_key
  on public.inventory_movements(idempotency_key)
  where idempotency_key is not null;

select pg_notify('pgrst', 'reload schema');