create table if not exists public.xy_pending_selection_prices (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id),
  route_stop_id uuid not null references public.route_stops(id),
  machine_id uuid not null references public.machines(id),
  vms_machine_id text not null,
  slot_code text not null,
  vms_product_id text not null,
  original_price_lyd numeric(12,2) not null check(original_price_lyd > 0),
  requested_price_lyd numeric(12,2) not null check(requested_price_lyd > 0),
  status text not null default 'pending' check(status in ('pending','verified','conflict','cancelled')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique(route_stop_id,slot_code)
);
create index if not exists xy_pending_selection_prices_due_idx on public.xy_pending_selection_prices(next_attempt_at) where status='pending';
alter table public.xy_pending_selection_prices enable row level security;
revoke all on table public.xy_pending_selection_prices from public,anon,authenticated;
grant select,insert,update on table public.xy_pending_selection_prices to service_role;
