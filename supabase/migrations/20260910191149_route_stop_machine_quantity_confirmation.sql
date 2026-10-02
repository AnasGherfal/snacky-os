begin;

create table if not exists public.route_stop_quantity_confirmations (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  route_stop_id uuid not null references public.route_stops(id) on delete cascade,
  machine_id uuid not null references public.machines(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  quantity_rows jsonb not null default '[]'::jsonb,
  confirmation_key text not null,
  confirmed_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_stop_quantity_confirmations_stop_unique unique (route_stop_id),
  constraint route_stop_quantity_confirmations_rows_array check (jsonb_typeof(quantity_rows) = 'array'),
  constraint route_stop_quantity_confirmations_key_required check (btrim(confirmation_key) <> '')
);

create index if not exists idx_route_stop_quantity_confirmations_route
  on public.route_stop_quantity_confirmations(route_id, confirmed_at desc);

create index if not exists idx_route_stop_quantity_confirmations_machine
  on public.route_stop_quantity_confirmations(machine_id, confirmed_at desc);

alter table public.route_stop_quantity_confirmations enable row level security;

revoke all on public.route_stop_quantity_confirmations from public, anon, authenticated;
grant all on public.route_stop_quantity_confirmations to service_role;

select pg_notify('pgrst', 'reload schema');

commit;
