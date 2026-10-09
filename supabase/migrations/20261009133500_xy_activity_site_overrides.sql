-- Optional owner-configurable exclusions and sensitivity per XY location.
-- No browser/data-API access: privileged server action checks owner role.
create table if not exists public.xy_stock_activity_site_overrides (
  machine_id uuid primary key references public.machines(id) on delete cascade,
  excluded_dates date[] not null default '{}'::date[],
  pause_through date,
  min_window_hours integer check (min_window_hours between 2 and 8),
  min_expected_units integer check (min_expected_units between 1 and 100),
  updated_at timestamptz not null default now()
);
alter table public.xy_stock_activity_site_overrides enable row level security;
revoke all on public.xy_stock_activity_site_overrides from public,anon,authenticated;
grant select,insert,update,delete on public.xy_stock_activity_site_overrides to service_role;
comment on table public.xy_stock_activity_site_overrides is
'Owner-controlled per-venue stock activity alert exceptions. No machine commands, no transaction data.';
