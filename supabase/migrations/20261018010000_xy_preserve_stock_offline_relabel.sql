-- A catalog relabel must never silently erase a real machine lane count.
-- Permit queueing a relabel without physical-replacement confirmations ONLY
-- when the requested quantity is exactly the last verified lane quantity.
-- The retry worker will additionally require the original product AND the
-- exact same quantity on XY at replay time; any drift becomes a conflict.
-- Legacy zero-stock relabels and physical-confirmed Smart Route swaps remain
-- valid and unchanged.
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
    or (zero_stock_relabel = false
      and smart_route_swap = false
      and physical_change_confirmed = false
      and lane_disabled_confirmed = false
      and target_stock_qty = previous_stock_qty)
  );

comment on column public.xy_pending_slot_changes.zero_stock_relabel is
  'Legacy mode sets sellable stock to zero. Normal new product-label changes instead preserve the verified XY quantity exactly; retry blocks if stock/product drifts. Physical Smart Route changes still require explicit confirmations.';

select pg_notify('pgrst','reload schema');
