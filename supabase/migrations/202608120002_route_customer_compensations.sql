create table if not exists public.route_customer_compensations (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  route_stop_id uuid not null references public.route_stops(id) on delete restrict,
  machine_id uuid not null references public.machines(id) on delete restrict,
  location_id uuid references public.locations(id) on delete set null,
  operator_id uuid references public.team_members(id) on delete set null,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name text not null,
  quantity integer not null,
  claim_type text not null default 'paid_no_product',
  claimed_amount_lyd numeric(12,2),
  notes text,
  compensated_at timestamptz not null default now(),
  client_submission_id text,
  inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  needs_review boolean not null default false,
  review_reason text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_customer_compensations_quantity_positive check (quantity > 0),
  constraint route_customer_compensations_claimed_amount_nonnegative check (claimed_amount_lyd is null or claimed_amount_lyd >= 0),
  constraint route_customer_compensations_claim_type_check check (claim_type in ('paid_no_product', 'wrong_product', 'damaged_or_stuck', 'other'))
);

create unique index if not exists idx_route_customer_compensations_submission
  on public.route_customer_compensations(client_submission_id)
  where client_submission_id is not null;
create index if not exists idx_route_customer_compensations_route_time
  on public.route_customer_compensations(route_id, compensated_at desc);
create index if not exists idx_route_customer_compensations_stop_time
  on public.route_customer_compensations(route_stop_id, compensated_at desc);
create index if not exists idx_route_customer_compensations_machine_time
  on public.route_customer_compensations(machine_id, compensated_at desc);
create index if not exists idx_route_customer_compensations_operator_time
  on public.route_customer_compensations(operator_id, compensated_at desc);

alter table public.route_customer_compensations enable row level security;
grant select, insert on public.route_customer_compensations to authenticated;

drop policy if exists "snacky_route_customer_compensations_select" on public.route_customer_compensations;
create policy "snacky_route_customer_compensations_select"
on public.route_customer_compensations for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  or public.snacky_operator_can_access_route(route_id)
);

drop policy if exists "snacky_route_customer_compensations_insert" on public.route_customer_compensations;
create policy "snacky_route_customer_compensations_insert"
on public.route_customer_compensations for insert
to authenticated
with check (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  or public.snacky_operator_can_access_route(route_id)
);
