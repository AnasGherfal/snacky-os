-- Smart-route machine context is intentionally separate from core machine/location linkage.
-- It gives AI planning a safe exact-machine/location-type context without mutating operational locations.

create table if not exists public.smart_route_machine_context (
  machine_id uuid primary key references public.machines(id) on delete cascade,
  location_type text,
  location_label text,
  notes text,
  updated_at timestamptz not null default now()
);

alter table public.smart_route_machine_context enable row level security;
revoke all on table public.smart_route_machine_context from public, anon, authenticated;
grant select, insert, update, delete on table public.smart_route_machine_context to service_role;

insert into public.smart_route_machine_context (machine_id, location_type, location_label, notes)
values
  ('e750a3b2-3602-48d9-a2e0-0f2fe2a571bd', 'university', 'Attahadi University', 'Seeded from the existing machine identity for smart planning only.'),
  ('b1239bf8-59f0-41f2-9d99-b448340cad0b', 'university', 'Khalij University', 'Seeded from the existing machine identity for smart planning only.'),
  ('448a321b-efb9-4463-9364-c211a5c3e9ad', 'school', 'Elite Future School', 'Seeded from the existing machine identity for smart planning only.'),
  ('615785e2-6f64-4f50-a46e-6fdfb78ec364', 'mall', 'Diplomacy Mall', 'Seeded from the existing machine identity for smart planning only.'),
  ('f7be8b3a-81e2-4691-abbb-2f5e0ce6dcd4', 'mall', 'HT Land', 'Seeded from the existing machine identity for smart planning only.'),
  ('91ddbc7e-8ea1-44c0-b0dc-82e4883a1836', 'mall', 'HT Mall', 'Seeded from the existing machine identity for smart planning only.'),
  ('57b9bef8-7fe4-4620-bf48-0b08f694a998', 'hospital', 'Almouasafat Hospital', 'Seeded from the existing machine identity for smart planning only.'),
  ('436f0318-a742-4e1e-b196-ef950efaf09f', 'hospital', 'Istiklal', 'Seeded from the existing machine identity for smart planning only.')
on conflict (machine_id) do update
set
  location_type = excluded.location_type,
  location_label = excluded.location_label,
  notes = excluded.notes,
  updated_at = now();

alter table public.smart_route_location_product_rules
  add column if not exists machine_id uuid references public.machines(id) on delete cascade;

alter table public.smart_route_location_product_rules
  drop constraint if exists smart_route_location_product_rules_check;

alter table public.smart_route_location_product_rules
  drop constraint if exists smart_route_location_product_rules_target_check;

alter table public.smart_route_location_product_rules
  add constraint smart_route_location_product_rules_target_check
  check (num_nonnulls(machine_id, location_id, location_type) = 1);

create unique index if not exists idx_smart_route_location_product_rules_machine
  on public.smart_route_location_product_rules (machine_id, product_id)
  where machine_id is not null;

create or replace function public.snacky_smart_route_demand_signals(
  p_days integer default 21
)
returns table (
  machine_id uuid,
  location_id uuid,
  location_type text,
  product_id uuid,
  units_proxy bigint,
  observation_count bigint,
  latest_observed_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with ordered as (
    select
      s.machine_id,
      m.location_id,
      coalesce(ctx.location_type, l.location_type::text) as location_type,
      s.slot_code,
      s.product_id,
      s.current_qty,
      s.capacity,
      s.captured_at,
      lag(s.product_id) over (
        partition by s.machine_id, s.slot_code
        order by s.captured_at, s.created_at, s.id
      ) as previous_product_id,
      lag(s.current_qty) over (
        partition by s.machine_id, s.slot_code
        order by s.captured_at, s.created_at, s.id
      ) as previous_qty
    from public.vms_stock_snapshots s
    join public.machines m on m.id = s.machine_id
    left join public.locations l on l.id = m.location_id
    left join public.smart_route_machine_context ctx on ctx.machine_id = s.machine_id
    where s.source_provider = 'xy'
      and s.import_row_status = 'imported'
      and s.product_id is not null
      and s.slot_code is not null
      and s.captured_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 21), 60)))
  ),
  drops as (
    select
      machine_id,
      location_id,
      location_type,
      product_id,
      captured_at,
      case
        when previous_product_id = product_id
          and previous_qty is not null
          and current_qty is not null
          and previous_qty > current_qty
          and previous_qty - current_qty <= greatest(coalesce(capacity, previous_qty), 1)
        then previous_qty - current_qty
        else 0
      end::bigint as drop_units
    from ordered
  )
  select
    machine_id,
    location_id,
    location_type,
    product_id,
    sum(drop_units)::bigint as units_proxy,
    count(*) filter (where drop_units > 0)::bigint as observation_count,
    max(captured_at) filter (where drop_units > 0) as latest_observed_at
  from drops
  group by machine_id, location_id, location_type, product_id
  having sum(drop_units) > 0;
$$;

revoke all on function public.snacky_smart_route_demand_signals(integer) from public, anon, authenticated;
grant execute on function public.snacky_smart_route_demand_signals(integer) to service_role;

comment on table public.smart_route_machine_context is
  'Server-only location-type/label context for route intelligence. Separate from core operational location linkage.';

select pg_notify('pgrst', 'reload schema');
