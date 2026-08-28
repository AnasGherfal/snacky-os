-- Schedule-aware machine refill policy. These fields belong to the machine so
-- forecasting still works when an XY machine has not yet been linked to a
-- Snacky location record.

alter table public.machines
  add column if not exists refill_open_days smallint[] not null default array[1, 2, 3, 4, 5, 6, 7]::smallint[],
  add column if not exists refill_critical_percent numeric(5, 2) not null default 15,
  add column if not exists refill_today_percent numeric(5, 2) not null default 30,
  add column if not exists refill_target_percent numeric(5, 2) not null default 90,
  add column if not exists refill_minimum_units integer not null default 10,
  add column if not exists refill_manual_daily_units numeric(8, 2),
  add column if not exists refill_policy_notes text;

alter table public.machines
  drop constraint if exists machines_refill_open_days_check,
  add constraint machines_refill_open_days_check check (
    cardinality(refill_open_days) between 1 and 7
    and refill_open_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
  ),
  drop constraint if exists machines_refill_percent_order_check,
  add constraint machines_refill_percent_order_check check (
    refill_critical_percent between 0 and 100
    and refill_today_percent between refill_critical_percent and 100
    and refill_target_percent between refill_today_percent and 100
  ),
  drop constraint if exists machines_refill_minimum_units_check,
  add constraint machines_refill_minimum_units_check check (refill_minimum_units >= 0),
  drop constraint if exists machines_refill_manual_daily_units_check,
  add constraint machines_refill_manual_daily_units_check check (
    refill_manual_daily_units is null or refill_manual_daily_units >= 0
  );

create index if not exists idx_vms_stock_snapshots_imported_captured
  on public.vms_stock_snapshots (captured_at desc)
  where import_row_status = 'imported';

create index if not exists idx_route_stop_fill_lines_machine_product_created
  on public.route_stop_fill_lines (machine_id, product_id, created_at desc);

comment on column public.machines.refill_open_days is 'ISO weekdays when the site operates: Monday=1 through Sunday=7.';
comment on column public.machines.refill_manual_daily_units is 'Optional owner override for expected machine units sold per operating day.';

select pg_notify('pgrst', 'reload schema');
