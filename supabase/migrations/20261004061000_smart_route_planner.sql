-- Smart route planner: rule tables, audit trail, and compact XY demand/fit signals.
-- The planner remains review-only. Final route creation keeps existing storage validation/reservations.

create table if not exists public.smart_route_product_profiles (
  product_id uuid primary key references public.products(id) on delete cascade,
  fit_profile text,
  substitution_group text,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.smart_route_slot_product_rules (
  id uuid primary key default gen_random_uuid(),
  machine_slot_id uuid not null references public.machine_slots(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  rule text not null check (rule in ('allowed', 'prohibited')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (machine_slot_id, product_id)
);

create table if not exists public.smart_route_location_product_rules (
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.locations(id) on delete cascade,
  location_type text,
  product_id uuid not null references public.products(id) on delete cascade,
  rule text not null check (rule in ('preferred', 'allowed', 'avoid', 'prohibited')),
  score_adjustment integer not null default 0 check (score_adjustment between -100 and 100),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(location_id, location_type) = 1)
);

create unique index if not exists idx_smart_route_location_product_rules_location
  on public.smart_route_location_product_rules (location_id, product_id)
  where location_id is not null;

create unique index if not exists idx_smart_route_location_product_rules_type
  on public.smart_route_location_product_rules (location_type, product_id)
  where location_type is not null;

create index if not exists idx_smart_route_slot_product_rules_slot
  on public.smart_route_slot_product_rules (machine_slot_id, rule);

create table if not exists public.smart_route_plan_audits (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references public.team_members(id) on delete set null,
  route_date date not null,
  operator_id uuid references public.team_members(id) on delete set null,
  machine_ids uuid[] not null default '{}',
  planner_mode text not null check (planner_mode in ('ai', 'deterministic_fallback')),
  model text,
  demand_source text not null default 'xy_stock_depletion',
  data_freshness jsonb not null default '{}',
  plan jsonb not null default '{}',
  warnings jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index if not exists idx_smart_route_plan_audits_created
  on public.smart_route_plan_audits (created_at desc);

create index if not exists idx_vms_stock_snapshots_smart_demand
  on public.vms_stock_snapshots (captured_at desc, machine_id, slot_code)
  where source_provider = 'xy' and import_row_status = 'imported';

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
      l.location_type::text as location_type,
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

create or replace function public.snacky_smart_route_slot_fit_history(
  p_machine_ids uuid[],
  p_days integer default 180
)
returns table (
  machine_id uuid,
  slot_code text,
  product_id uuid,
  observations bigint,
  last_seen_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    s.machine_id,
    s.slot_code,
    s.product_id,
    count(*)::bigint as observations,
    max(s.captured_at) as last_seen_at
  from public.vms_stock_snapshots s
  where s.source_provider = 'xy'
    and s.import_row_status = 'imported'
    and s.product_id is not null
    and s.slot_code is not null
    and s.machine_id = any(coalesce(p_machine_ids, '{}'::uuid[]))
    and s.captured_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 180), 365)))
  group by s.machine_id, s.slot_code, s.product_id;
$$;

alter table public.smart_route_product_profiles enable row level security;
alter table public.smart_route_slot_product_rules enable row level security;
alter table public.smart_route_location_product_rules enable row level security;
alter table public.smart_route_plan_audits enable row level security;

revoke all on table public.smart_route_product_profiles from public, anon, authenticated;
revoke all on table public.smart_route_slot_product_rules from public, anon, authenticated;
revoke all on table public.smart_route_location_product_rules from public, anon, authenticated;
revoke all on table public.smart_route_plan_audits from public, anon, authenticated;

grant select, insert, update, delete on table public.smart_route_product_profiles to service_role;
grant select, insert, update, delete on table public.smart_route_slot_product_rules to service_role;
grant select, insert, update, delete on table public.smart_route_location_product_rules to service_role;
grant select, insert on table public.smart_route_plan_audits to service_role;

revoke all on function public.snacky_smart_route_demand_signals(integer) from public, anon, authenticated;
revoke all on function public.snacky_smart_route_slot_fit_history(uuid[], integer) from public, anon, authenticated;
grant execute on function public.snacky_smart_route_demand_signals(integer) to service_role;
grant execute on function public.snacky_smart_route_slot_fit_history(uuid[], integer) to service_role;

comment on table public.smart_route_product_profiles is
  'Server-only overrides for smart route fit/substitution classification.';
comment on table public.smart_route_slot_product_rules is
  'Explicit slot-product allow/prohibit rules. These override inferred fit profiles.';
comment on table public.smart_route_location_product_rules is
  'Location or location-type product preferences/blocks used by smart route planning.';
comment on table public.smart_route_plan_audits is
  'Immutable-style audit snapshots of generated smart route drafts; route/inventory rows are not created here.';
comment on function public.snacky_smart_route_demand_signals(integer) is
  'Demand proxy from verified XY stock decreases. Refill increases are ignored.';
comment on function public.snacky_smart_route_slot_fit_history(uuid[], integer) is
  'Products historically observed in each exact XY slot, used as compatibility evidence.';

select pg_notify('pgrst', 'reload schema');
