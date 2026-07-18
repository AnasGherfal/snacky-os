begin;

create table if not exists public.route_stop_safety_checks (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  route_stop_id uuid not null references public.route_stops(id) on delete cascade,
  machine_id uuid not null references public.machines(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  compressor_confirmed boolean not null default false,
  proof_photo_url text,
  proof_photo_path text,
  proof_photo_original_name text,
  confirmed_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_stop_safety_checks_stop_unique unique (route_stop_id),
  constraint route_stop_safety_checks_proof_required check (
    compressor_confirmed = false
    or nullif(btrim(coalesce(proof_photo_url, '')), '') is not null
    or nullif(btrim(coalesce(proof_photo_path, '')), '') is not null
  )
);

create index if not exists idx_route_stop_safety_checks_route
  on public.route_stop_safety_checks(route_id, confirmed_at desc);
create index if not exists idx_route_stop_safety_checks_machine
  on public.route_stop_safety_checks(machine_id, confirmed_at desc);
create index if not exists idx_route_stop_safety_checks_operator
  on public.route_stop_safety_checks(operator_id, confirmed_at desc);

alter table public.route_stop_safety_checks enable row level security;

drop policy if exists route_stop_safety_checks_authenticated_read on public.route_stop_safety_checks;
create policy route_stop_safety_checks_authenticated_read
  on public.route_stop_safety_checks
  for select
  to authenticated
  using (true);

drop policy if exists route_stop_safety_checks_authenticated_write on public.route_stop_safety_checks;
create policy route_stop_safety_checks_authenticated_write
  on public.route_stop_safety_checks
  for all
  to authenticated
  using (true)
  with check (true);

grant select, insert, update on public.route_stop_safety_checks to authenticated;
grant all on public.route_stop_safety_checks to service_role;

select pg_notify('pgrst', 'reload schema');

commit;
