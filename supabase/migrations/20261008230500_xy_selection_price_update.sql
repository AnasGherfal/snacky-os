-- Reuse the protected per-selection background queue for stock and/or price.
-- Price-only updates must preserve the LIVE stock at write time.
alter table public.xy_stop_quantity_syncs
  add column if not exists expected_price_lyd numeric(12,2),
  add column if not exists target_price_lyd numeric(12,2),
  add column if not exists update_stock boolean not null default true;

alter table public.xy_stop_quantity_syncs
  drop constraint if exists xy_selection_price_valid;
alter table public.xy_stop_quantity_syncs
  add constraint xy_selection_price_valid
  check (
    (expected_price_lyd is null or expected_price_lyd > 0)
    and (target_price_lyd is null or target_price_lyd > 0)
    and (update_stock or target_price_lyd is not null)
    and (target_price_lyd is null or target_price_lyd <= 1000)
  );

comment on column public.xy_stop_quantity_syncs.update_stock is
  'False means price-only: preserve live XY current quantity instead of resending old snapshot stock.';
select pg_notify('pgrst','reload schema');
