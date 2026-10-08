-- Reuse the existing per-stop XY selection queue for BOTH stock and price edits.
-- A price-only edit preserves the live stock read at write time and never
-- changes physical inventory custody. Stored price is per selection, not per SKU.
alter table public.xy_stop_quantity_syncs
  add column if not exists expected_price_lyd numeric(12,2),
  add column if not exists target_price_lyd numeric(12,2),
  add column if not exists update_stock boolean not null default true;

alter table public.xy_stop_quantity_syncs
  drop constraint if exists xy_stop_quantity_syncs_price_safe;
alter table public.xy_stop_quantity_syncs
  add constraint xy_stop_quantity_syncs_price_safe check (
    (expected_price_lyd is null or expected_price_lyd > 0)
    and (target_price_lyd is null or (target_price_lyd > 0 and target_price_lyd <= 1000))
    and (update_stock or target_price_lyd is not null)
  );

comment on column public.xy_stop_quantity_syncs.update_stock is
  'False for price-only updates. The worker preserves current physical XY quantity and never infers a refill.';

select pg_notify('pgrst','reload schema');
