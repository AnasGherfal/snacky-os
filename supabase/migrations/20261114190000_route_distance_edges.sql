-- Manual, directional inter-site road distance for Snacky operators.
-- Used only in owner/admin distance reports. Ordinary operators must not see KM.
-- All route history is evaluated from existing ordered route_stops without modifying routes.
create table if not exists public.route_distance_edges (
  id uuid primary key default gen_random_uuid(),
  from_storage_location_id uuid references public.storage_locations(id) on delete cascade,
  from_machine_id uuid references public.machines(id) on delete cascade,
  to_machine_id uuid not null references public.machines(id) on delete cascade,
  distance_km numeric(10,2) not null check (distance_km >= 0 and distance_km < 10000),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_distance_origin_exactly_one check (num_nonnulls(from_storage_location_id, from_machine_id) = 1),
  constraint route_distance_different_machines check (from_machine_id is null or from_machine_id <> to_machine_id)
);

create unique index if not exists route_distance_storage_to_machine_unique
  on public.route_distance_edges(from_storage_location_id, to_machine_id)
  where from_storage_location_id is not null;
create unique index if not exists route_distance_machine_to_machine_unique
  on public.route_distance_edges(from_machine_id, to_machine_id)
  where from_machine_id is not null;
create index if not exists route_distance_edges_destination_idx
  on public.route_distance_edges(to_machine_id);

alter table public.route_distance_edges enable row level security;
-- No public/authenticated policies: even a logged-in operator is denied by RLS.
-- Server actions and owner-only reports check roles, then use the service-role client.
revoke all on public.route_distance_edges from anon, authenticated;

comment on table public.route_distance_edges is
  'Owner-only directional road-km between MAIN storage/machines. Does not include an assumed return leg.';

-- Seed only the distances supplied by Snacky management.
-- Look up production records by name; do NOT persist environment-specific generated IDs.
with seed(from_machine, to_machine, km) as (
  values
    (null::text, 'Khalij University', 22.00::numeric),
    (null::text, 'HospAlmoa', 16.00::numeric),
    (null::text, 'HTMall', 3.50::numeric),
    (null::text, 'Elite Future School', 39.00::numeric),
    (null::text, 'Deplomacy Mall', 15.00::numeric),
    (null::text, 'Attahadi Universty', 9.70::numeric),
    (null::text, 'Istiklal', 4.60::numeric),
    ('Khalij University', 'Elite Future School', 22.00::numeric),
    ('Elite Future School', 'Khalij University', 20.00::numeric),
    ('Attahadi Universty', 'HospAlmoa', 10.00::numeric),
    ('Istiklal', 'Attahadi Universty', 12.00::numeric),
    ('HTMall', 'Attahadi Universty', 13.00::numeric),
    ('HTMall', 'HospAlmoa', 19.00::numeric)
)
insert into public.route_distance_edges
  (from_storage_location_id, from_machine_id, to_machine_id, distance_km, notes)
select
  case when seed.from_machine is null then warehouse.id else null end,
  origin.id,
  destination.id,
  seed.km,
  'Management supplied 2026-11-14'
from seed
left join public.storage_locations warehouse
  on seed.from_machine is null and warehouse.name = 'MAIN' and warehouse.active = true
left join public.machines origin
  on seed.from_machine is not null and origin.name = seed.from_machine
join public.machines destination on destination.name = seed.to_machine
where (seed.from_machine is null and warehouse.id is not null)
   or (seed.from_machine is not null and origin.id is not null)
on conflict do nothing;
