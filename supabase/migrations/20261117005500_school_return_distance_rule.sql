-- Owner-only route return distance.
-- Snacky normally measures storage -> ordered machine stops, without assuming
-- any trip back to storage. The one exception supplied by management is an
-- approximate 25 km return from Elite Future School, *only when the school is
-- the last completed stop on a completed route*.
create table if not exists public.route_return_distance_rules (
  id uuid primary key default gen_random_uuid(),
  from_machine_id uuid not null unique references public.machines(id) on delete cascade,
  to_storage_location_id uuid not null references public.storage_locations(id) on delete cascade,
  distance_km numeric(10,2) not null check (distance_km >= 0 and distance_km < 10000),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_route_return_distance_storage
  on public.route_return_distance_rules(to_storage_location_id);

alter table public.route_return_distance_rules enable row level security;
revoke all on public.route_return_distance_rules from anon, authenticated;

comment on table public.route_return_distance_rules is
  'Owner/admin-only optional return trip from final completed route stop to MAIN storage; no default returns for other machines.';

insert into public.route_return_distance_rules
  (from_machine_id, to_storage_location_id, distance_km, notes)
select m.id, s.id, 25.00,
       'Approximate 25 km return to storage only when school is last completed stop; management request 2026-11-17'
from public.machines m
cross join public.storage_locations s
where m.name = 'Elite Future School'
  and s.name = 'MAIN'
  and s.active = true
on conflict (from_machine_id) do nothing;
