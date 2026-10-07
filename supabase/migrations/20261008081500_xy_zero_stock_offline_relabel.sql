-- A simple product-selection request may be queued without declaring that the
-- operator physically replaced stock. Such remote changes always write ZERO
-- sellable units, so an old product cannot be sold under a new label.
alter table public.xy_pending_slot_changes
  add column if not exists zero_stock_relabel boolean not null default false;

alter table public.xy_pending_slot_changes
  drop constraint if exists xy_pending_slot_changes_confirmations;

alter table public.xy_pending_slot_changes
  add constraint xy_pending_slot_changes_confirmations
  check (
    (zero_stock_relabel = true
      and target_stock_qty = 0
      and smart_route_swap = false
      and physical_change_confirmed = false
      and lane_disabled_confirmed = false)
    or (zero_stock_relabel = false
      and physical_change_confirmed = true
      and lane_disabled_confirmed = true)
  );

comment on column public.xy_pending_slot_changes.zero_stock_relabel is
  'Queued requested product mapping without any claim of physical refill. On reconnect XY product/price are changed with sellable stock=0 and verified by readback. No machine inventory movement is implied.';

select pg_notify('pgrst','reload schema');
