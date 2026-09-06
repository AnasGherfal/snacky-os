-- Reconcile the customer-compensation schema before the terminal route ledger
-- migrations compile. Production can legitimately be missing the older August
-- migrations, so this dependency is intentionally idempotent and self-contained.

do $$
begin
  if to_regtype('public.movement_reason') is null then
    raise exception 'Required enum public.movement_reason is missing.' using errcode = '42P01';
  end if;

  if not exists (
    select 1
    from pg_enum enum_value
    join pg_type enum_type on enum_type.oid = enum_value.enumtypid
    join pg_namespace enum_schema on enum_schema.oid = enum_type.typnamespace
    where enum_schema.nspname = 'public'
      and enum_type.typname = 'movement_reason'
      and enum_value.enumlabel = 'customer_compensation'
  ) then
    alter type public.movement_reason add value 'customer_compensation';
  end if;
end
$$;

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
  constraint route_customer_compensations_quantity_positive
    check (quantity > 0),
  constraint route_customer_compensations_claimed_amount_nonnegative
    check (claimed_amount_lyd is null or claimed_amount_lyd >= 0),
  constraint route_customer_compensations_claim_type_check
    check (claim_type in ('paid_no_product', 'wrong_product', 'damaged_or_stuck', 'other')),
  constraint route_customer_compensations_product_name_nonblank
    check (btrim(product_name) <> ''),
  constraint route_customer_compensations_submission_nonblank
    check (client_submission_id is null or btrim(client_submission_id) <> ''),
  constraint route_customer_compensations_review_reason_required
    check (not needs_review or nullif(btrim(coalesce(review_reason, '')), '') is not null)
);

-- If the older August table migration was installed in another environment,
-- CREATE TABLE IF NOT EXISTS above intentionally leaves its rows untouched.
-- Add the newer write-time checks without validating historical rows; PostgreSQL
-- still enforces NOT VALID checks for every new or changed row.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.route_customer_compensations'::regclass
      and conname = 'route_customer_compensations_product_name_nonblank'
  ) then
    alter table public.route_customer_compensations
      add constraint route_customer_compensations_product_name_nonblank
      check (btrim(product_name) <> '') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.route_customer_compensations'::regclass
      and conname = 'route_customer_compensations_submission_nonblank'
  ) then
    alter table public.route_customer_compensations
      add constraint route_customer_compensations_submission_nonblank
      check (client_submission_id is null or btrim(client_submission_id) <> '') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.route_customer_compensations'::regclass
      and conname = 'route_customer_compensations_review_reason_required'
  ) then
    alter table public.route_customer_compensations
      add constraint route_customer_compensations_review_reason_required
      check (not needs_review or nullif(btrim(coalesce(review_reason, '')), '') is not null) not valid;
  end if;
end
$$;

create unique index if not exists idx_route_customer_compensations_submission
  on public.route_customer_compensations(client_submission_id)
  where client_submission_id is not null;

create unique index if not exists idx_route_customer_compensations_inventory_movement
  on public.route_customer_compensations(inventory_movement_id)
  where inventory_movement_id is not null;

create index if not exists idx_route_customer_compensations_route_time
  on public.route_customer_compensations(route_id, compensated_at desc);

create index if not exists idx_route_customer_compensations_stop_time
  on public.route_customer_compensations(route_stop_id, compensated_at desc);

create index if not exists idx_route_customer_compensations_machine_time
  on public.route_customer_compensations(machine_id, compensated_at desc);

create index if not exists idx_route_customer_compensations_location_time
  on public.route_customer_compensations(location_id, compensated_at desc)
  where location_id is not null;

create index if not exists idx_route_customer_compensations_operator_time
  on public.route_customer_compensations(operator_id, compensated_at desc)
  where operator_id is not null;

create index if not exists idx_route_customer_compensations_product_time
  on public.route_customer_compensations(product_id, compensated_at desc);

create index if not exists idx_route_customer_compensations_creator
  on public.route_customer_compensations(created_by_user_id)
  where created_by_user_id is not null;

alter table public.route_customer_compensations enable row level security;

-- This is an internal table. Anonymous callers and inherited PUBLIC privileges
-- must never expose it through the Data API. Authenticated callers receive only
-- the operations protected by the policies below; the server client performs
-- review/link updates after its own route authorization checks.
revoke all privileges on table public.route_customer_compensations
  from public, anon, authenticated;
grant select, insert on table public.route_customer_compensations to authenticated;
grant select, insert, update on table public.route_customer_compensations to service_role;

drop policy if exists "snacky_route_customer_compensations_select"
  on public.route_customer_compensations;
create policy "snacky_route_customer_compensations_select"
on public.route_customer_compensations
for select
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
  or (select public.snacky_operator_can_access_route(route_id))
);

drop policy if exists "snacky_route_customer_compensations_insert"
  on public.route_customer_compensations;
create policy "snacky_route_customer_compensations_insert"
on public.route_customer_compensations
for insert
to authenticated
with check (
  (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
  or (select public.snacky_operator_can_access_route(route_id))
);

select pg_notify('pgrst', 'reload schema');
