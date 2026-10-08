-- Explicitly saved machine-selection edits may sync without closing the refill stop.
-- Default remains false for the existing Complete Stop workflow.
alter table public.xy_stop_quantity_syncs
  add column if not exists apply_immediately boolean not null default false;

create index if not exists xy_stop_quantity_syncs_due_immediate_idx
  on public.xy_stop_quantity_syncs(next_attempt_at,created_at)
  where status='pending' and apply_immediately;

comment on column public.xy_stop_quantity_syncs.apply_immediately is
  'Operator explicitly confirmed real XY stock/price at the selection editor; sync may start before Complete Stop, without altering storage or bag ledger.';

select pg_notify('pgrst','reload schema');