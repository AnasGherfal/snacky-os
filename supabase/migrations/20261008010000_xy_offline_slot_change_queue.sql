-- Store intentional offline XY product changes durably, separate from inventory.
-- Enforced physical/lane-vending safety gates prevent silent product mislabelling.
create table if not exists public.xy_pending_slot_changes (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  route_stop_id uuid not null references public.route_stops(id) on delete restrict,
  machine_id uuid not null references public.machines(id) on delete restrict,
  vms_machine_id text not null,
  slot_code text not null,
  previous_vms_product_id text not null,
  previous_stock_qty integer not null check (previous_stock_qty >= 0),
  target_product_id uuid not null references public.products(id) on delete restrict,
  target_vms_product_id text not null,
  target_price_lyd numeric(12,2) not null check (target_price_lyd > 0),
  target_stock_qty integer not null check (target_stock_qty >= 0),
  physical_change_confirmed boolean not null default false,
  lane_disabled_confirmed boolean not null default false,
  smart_route_swap boolean not null default false,
  status text not null default 'pending' check (status in ('pending','verified','conflict','cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  verified_at timestamptz,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint xy_pending_slot_changes_confirmations check (physical_change_confirmed and lane_disabled_confirmed)
);

create unique index if not exists xy_one_pending_change_per_lane
  on public.xy_pending_slot_changes(machine_id,slot_code)
  where status='pending';

create index if not exists xy_pending_slot_changes_due
  on public.xy_pending_slot_changes(next_attempt_at,created_at)
  where status='pending';

create index if not exists xy_pending_slot_changes_route
  on public.xy_pending_slot_changes(route_id,route_stop_id,created_at desc);

alter table public.xy_pending_slot_changes enable row level security;
revoke all on table public.xy_pending_slot_changes from public, anon, authenticated;
grant select, insert, update on table public.xy_pending_slot_changes to service_role;
comment on table public.xy_pending_slot_changes is
 'Operator-acknowledged physical XY lane changes pending safe vendor write after stop completion; no queue item authorizes a machine stock or inventory movement.';

select pg_notify('pgrst','reload schema');
