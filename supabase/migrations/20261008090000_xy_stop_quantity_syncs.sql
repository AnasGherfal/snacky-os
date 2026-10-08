-- Final sellable quantities entered from the physical XY vending layout.
-- These records are SYNC INSTRUCTIONS only; they never mutate product stock,
-- storage, operator bags, or the route refill ledger.
create table if not exists public.xy_stop_quantity_syncs (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  route_stop_id uuid not null references public.route_stops(id) on delete restrict,
  machine_id uuid not null references public.machines(id) on delete restrict,
  vms_machine_id text not null,
  slot_code text not null,
  expected_vms_product_id text not null,
  expected_xy_qty integer not null check (expected_xy_qty >= 0),
  target_qty integer not null check (target_qty >= 0),
  max_capacity integer not null check (max_capacity > 0),
  status text not null default 'pending'
    check (status in ('pending','verified','conflict','cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  verified_at timestamptz,
  last_error text,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (route_stop_id, slot_code),
  constraint xy_stop_quantity_syncs_target_below_capacity check(target_qty <= max_capacity)
);
create index if not exists xy_stop_quantity_syncs_pending_idx
 on public.xy_stop_quantity_syncs(next_attempt_at,created_at) where status='pending';
create index if not exists xy_stop_quantity_syncs_machine_idx
 on public.xy_stop_quantity_syncs(machine_id,slot_code) where status='pending';

alter table public.xy_stop_quantity_syncs enable row level security;
revoke all on table public.xy_stop_quantity_syncs from public,anon,authenticated;
grant select,insert,update on table public.xy_stop_quantity_syncs to service_role;

comment on table public.xy_stop_quantity_syncs is
 'Exact physical final lane quantities, queued at Complete Stop and written into XY asynchronously with product and stock-baseline conflict checks. Never infers operator pickup/refill inventory movements.';

select pg_notify('pgrst','reload schema');
