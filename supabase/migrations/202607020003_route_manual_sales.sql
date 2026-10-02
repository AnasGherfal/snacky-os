do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'inventory_entity_type'
      and e.enumlabel = 'customer'
  ) then
    alter type public.inventory_entity_type add value 'customer';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'movement_reason'
      and e.enumlabel = 'manual_sale'
  ) then
    alter type public.movement_reason add value 'manual_sale';
  end if;
end $$;

create table if not exists public.route_manual_sales (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  route_stop_id uuid not null references public.route_stops(id) on delete restrict,
  machine_id uuid not null references public.machines(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete restrict,
  operator_id uuid not null references public.team_members(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null,
  unit_sale_price_lyd numeric(12,2) not null,
  total_amount_lyd numeric(12,2) generated always as ((quantity::numeric * unit_sale_price_lyd)::numeric(12,2)) stored,
  payment_method text not null default 'cash',
  notes text,
  sale_time timestamptz not null default now(),
  status text not null default 'confirmed',
  client_submission_id text,
  inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  cash_collection_id uuid references public.cash_collections(id) on delete set null,
  cancellation_reason text,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid references auth.users(id) on delete set null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_manual_sales_quantity_positive check (quantity > 0),
  constraint route_manual_sales_unit_sale_price_positive check (unit_sale_price_lyd > 0),
  constraint route_manual_sales_payment_method_check check (payment_method in ('cash', 'card', 'other')),
  constraint route_manual_sales_status_check check (status in ('confirmed', 'cancelled'))
);

alter table public.route_manual_sales
  add column if not exists client_submission_id text,
  add column if not exists inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  add column if not exists cash_collection_id uuid references public.cash_collections(id) on delete set null,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_route_manual_sales_route_time
  on public.route_manual_sales(route_id, sale_time desc);

create index if not exists idx_route_manual_sales_stop_time
  on public.route_manual_sales(route_stop_id, sale_time desc);

create index if not exists idx_route_manual_sales_machine_time
  on public.route_manual_sales(machine_id, sale_time desc);

create index if not exists idx_route_manual_sales_product_time
  on public.route_manual_sales(product_id, sale_time desc);

create index if not exists idx_route_manual_sales_status_time
  on public.route_manual_sales(status, sale_time desc);

create unique index if not exists idx_route_manual_sales_client_submission
  on public.route_manual_sales(client_submission_id)
  where client_submission_id is not null;

alter table public.route_manual_sales enable row level security;

grant select, insert, update on public.route_manual_sales to authenticated;

drop policy if exists "snacky_route_manual_sales_select_by_route_access" on public.route_manual_sales;
create policy "snacky_route_manual_sales_select_by_route_access"
on public.route_manual_sales for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  or (route_id is not null and public.snacky_operator_can_access_route(route_id))
);

drop policy if exists "snacky_route_manual_sales_insert_by_route_access" on public.route_manual_sales;
create policy "snacky_route_manual_sales_insert_by_route_access"
on public.route_manual_sales for insert
to authenticated
with check (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  or (
    route_id is not null
    and public.snacky_operator_can_access_route(route_id)
    and status = 'confirmed'
    and payment_method in ('cash', 'card', 'other')
    and quantity > 0
    and unit_sale_price_lyd > 0
  )
);

drop policy if exists "snacky_route_manual_sales_update_by_manager" on public.route_manual_sales;
create policy "snacky_route_manual_sales_update_by_manager"
on public.route_manual_sales for update
to authenticated
using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']));

drop policy if exists "snacky_route_manual_sales_update_by_route_access" on public.route_manual_sales;
create policy "snacky_route_manual_sales_update_by_route_access"
on public.route_manual_sales for update
to authenticated
using (
  route_id is not null
  and public.snacky_operator_can_access_route(route_id)
  and exists (
    select 1
    from public.routes route_row
    where route_row.id = route_id
      and (
        route_row.status is null
        or route_row.status::text not in ('completed', 'cancelled', 'canceled')
      )
  )
)
with check (
  route_id is not null
  and public.snacky_operator_can_access_route(route_id)
  and status in ('confirmed', 'cancelled')
  and exists (
    select 1
    from public.routes route_row
    where route_row.id = route_id
      and (
        route_row.status is null
        or route_row.status::text not in ('completed', 'cancelled', 'canceled')
      )
  )
);





