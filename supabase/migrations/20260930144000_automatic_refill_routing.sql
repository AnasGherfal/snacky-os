-- Automatic threshold-driven refill routing.
-- Machines enter a service queue first, then are batched into one unstarted route.
-- Product quantities remain provisional until the operator opens pickup.

create table if not exists public.refill_route_automation_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  default_operator_id uuid references public.team_members(id) on delete set null,
  evaluation_minutes integer not null default 10 check (evaluation_minutes between 5 and 120),
  batch_window_minutes integer not null default 30 check (batch_window_minutes between 0 and 240),
  max_wait_minutes integer not null default 60 check (max_wait_minutes between 10 and 360),
  min_batch_stops integer not null default 2 check (min_batch_stops between 1 and 20),
  max_batch_stops integer not null default 6 check (max_batch_stops between 1 and 25),
  pickup_refresh_enabled boolean not null default true,
  pickup_refresh_max_age_minutes integer not null default 5 check (pickup_refresh_max_age_minutes between 1 and 60),
  updated_at timestamptz not null default now()
);

insert into public.refill_route_automation_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.refill_service_queue (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null unique references public.machines(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','scheduled','resolved','dismissed')),
  urgency text not null check (urgency in ('fill_now','fill_today','fill_next_open')),
  action_date date not null,
  first_triggered_at timestamptz not null default now(),
  last_triggered_at timestamptz not null default now(),
  last_evaluated_at timestamptz not null default now(),
  latest_snapshot_at timestamptz,
  stock_percent numeric,
  units_to_target integer not null default 0,
  reason text,
  route_id uuid references public.routes(id) on delete set null,
  route_stop_id uuid references public.route_stops(id) on delete set null,
  scheduled_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_refill_service_queue_pending
  on public.refill_service_queue (state, action_date, urgency, first_triggered_at)
  where state = 'pending';

create index if not exists idx_refill_service_queue_route
  on public.refill_service_queue (route_id)
  where route_id is not null;

alter table public.routes
  add column if not exists auto_generated boolean not null default false,
  add column if not exists automation_kind text,
  add column if not exists automation_batch_key text,
  add column if not exists automation_last_planned_at timestamptz;

create unique index if not exists idx_routes_automation_batch_key
  on public.routes (automation_batch_key)
  where automation_batch_key is not null;

alter table public.refill_route_automation_settings enable row level security;
alter table public.refill_service_queue enable row level security;

comment on table public.refill_service_queue is 'Machine service queue used to batch refill triggers before route creation.';
comment on column public.routes.automation_batch_key is 'Stable key for automatically generated refill batches; prevents duplicate routes under concurrent automation runs.';

select pg_notify('pgrst', 'reload schema');
