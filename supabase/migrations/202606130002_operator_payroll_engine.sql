do $$ begin
  create type public.operator_role_level as enum ('junior_operator', 'senior_operator', 'backup_operator');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.route_access_difficulty as enum ('easy', 'normal', 'hard', 'very_hard');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.route_distance_zone as enum ('within_10_km', 'km_11_20', 'km_21_35', 'km_36_50', 'km_51_70', 'km_70_plus');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.route_pay_extra_type as enum (
    'cash_collection_extra',
    'deep_cleaning_extra',
    'simple_fix_extra',
    'emergency_extra',
    'friday_holiday_extra',
    'buying_trip_extra',
    'heavy_load_extra'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payroll_period_status as enum ('draft', 'calculated', 'paid', 'disputed');
exception when duplicate_object then null; end $$;

alter type public.route_status add value if not exists 'verified';
alter type public.route_status add value if not exists 'payroll_pending';
alter type public.route_status add value if not exists 'paid';
alter type public.route_status add value if not exists 'disputed';

alter table public.storage_locations
  add column if not exists latitude numeric(12,8),
  add column if not exists longitude numeric(12,8),
  add column if not exists updated_at timestamptz not null default now();

alter table public.locations
  add column if not exists distance_zone public.route_distance_zone not null default 'within_10_km',
  add column if not exists access_difficulty public.route_access_difficulty not null default 'normal',
  add column if not exists stop_multiplier numeric(6,2) not null default 1.0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_stop_multiplier_positive'
  ) then
    alter table public.locations
      add constraint locations_stop_multiplier_positive
      check (stop_multiplier > 0);
  end if;
end $$;

alter table public.routes
  add column if not exists storage_location_id uuid references public.storage_locations(id) on delete set null,
  add column if not exists distance_km numeric(10,2),
  add column if not exists distance_zone public.route_distance_zone,
  add column if not exists distance_source text not null default 'manual',
  add column if not exists load_difficulty_pay_lyd numeric(12,2) not null default 0,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references public.team_members(id) on delete set null,
  add column if not exists paid_at timestamptz,
  add column if not exists pay_dispute_reason text,
  add column if not exists pay_disputed_at timestamptz,
  add column if not exists pay_disputed_by uuid references public.team_members(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routes_distance_source_check'
  ) then
    alter table public.routes
      add constraint routes_distance_source_check
      check (distance_source in ('manual', 'location_zone', 'route_zone', 'km_manual', 'map_api'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'routes_load_difficulty_nonnegative'
  ) then
    alter table public.routes
      add constraint routes_load_difficulty_nonnegative
      check (load_difficulty_pay_lyd >= 0);
  end if;
end $$;

create table if not exists public.operator_pay_profiles (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  role_level public.operator_role_level not null default 'junior_operator',
  base_salary_lyd numeric(12,2) not null default 0,
  car_allowance_lyd numeric(12,2) not null default 0,
  phone_allowance_lyd numeric(12,2) not null default 0,
  default_route_base_lyd numeric(12,2) not null default 0,
  default_stop_rate_lyd numeric(12,2) not null default 0,
  default_km_rate_lyd numeric(12,2) not null default 0,
  can_collect_cash boolean not null default false,
  can_buy_stock boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_pay_profiles_team_member_unique unique (team_member_id),
  constraint operator_pay_profiles_nonnegative check (
    base_salary_lyd >= 0
    and car_allowance_lyd >= 0
    and phone_allowance_lyd >= 0
    and default_route_base_lyd >= 0
    and default_stop_rate_lyd >= 0
    and default_km_rate_lyd >= 0
  )
);

create table if not exists public.route_pay_rules (
  id text primary key default 'default',
  distance_pay_mode text not null default 'zone',
  zone_0_10_lyd numeric(12,2) not null default 0,
  zone_11_20_lyd numeric(12,2) not null default 10,
  zone_21_35_lyd numeric(12,2) not null default 20,
  zone_36_50_lyd numeric(12,2) not null default 35,
  zone_51_70_lyd numeric(12,2) not null default 50,
  zone_70_plus_lyd numeric(12,2),
  zone_over_70_requires_approval boolean not null default true,
  cash_collection_extra_lyd numeric(12,2) not null default 20,
  deep_cleaning_extra_lyd numeric(12,2) not null default 0,
  simple_fix_extra_lyd numeric(12,2) not null default 0,
  emergency_extra_lyd numeric(12,2) not null default 40,
  friday_holiday_extra_lyd numeric(12,2) not null default 0,
  buying_trip_extra_lyd numeric(12,2) not null default 90,
  heavy_load_extra_lyd numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pay_rules_distance_mode_check check (distance_pay_mode in ('zone', 'km_rate')),
  constraint route_pay_rules_nonnegative check (
    zone_0_10_lyd >= 0
    and zone_11_20_lyd >= 0
    and zone_21_35_lyd >= 0
    and zone_36_50_lyd >= 0
    and zone_51_70_lyd >= 0
    and coalesce(zone_70_plus_lyd, 0) >= 0
    and cash_collection_extra_lyd >= 0
    and deep_cleaning_extra_lyd >= 0
    and simple_fix_extra_lyd >= 0
    and emergency_extra_lyd >= 0
    and friday_holiday_extra_lyd >= 0
    and buying_trip_extra_lyd >= 0
    and heavy_load_extra_lyd >= 0
  )
);

insert into public.route_pay_rules (
  id,
  distance_pay_mode,
  zone_0_10_lyd,
  zone_11_20_lyd,
  zone_21_35_lyd,
  zone_36_50_lyd,
  zone_51_70_lyd,
  zone_70_plus_lyd,
  zone_over_70_requires_approval,
  cash_collection_extra_lyd,
  deep_cleaning_extra_lyd,
  simple_fix_extra_lyd,
  emergency_extra_lyd,
  friday_holiday_extra_lyd,
  buying_trip_extra_lyd,
  heavy_load_extra_lyd,
  notes
)
values (
  'default',
  'zone',
  0,
  10,
  20,
  35,
  50,
  null,
  true,
  20,
  0,
  0,
  40,
  0,
  90,
  0,
  'Snacky OS default operator route pay rules.'
)
on conflict (id) do nothing;

create table if not exists public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.team_members(id) on delete cascade,
  operator_pay_profile_id uuid references public.operator_pay_profiles(id) on delete set null,
  period_start date not null,
  period_end date not null,
  status public.payroll_period_status not null default 'draft',
  base_salary_lyd numeric(12,2) not null default 0,
  car_allowance_lyd numeric(12,2) not null default 0,
  phone_allowance_lyd numeric(12,2) not null default 0,
  route_pay_total_lyd numeric(12,2) not null default 0,
  buying_trip_total_lyd numeric(12,2) not null default 0,
  emergency_total_lyd numeric(12,2) not null default 0,
  bonus_total_lyd numeric(12,2) not null default 0,
  deduction_total_lyd numeric(12,2) not null default 0,
  gross_total_lyd numeric(12,2) not null default 0,
  net_total_lyd numeric(12,2) not null default 0,
  route_count integer not null default 0,
  notes text,
  paid_at timestamptz,
  paid_by uuid references public.team_members(id) on delete set null,
  finance_transaction_id uuid references public.financial_transactions(id) on delete set null,
  created_by uuid references public.team_members(id) on delete set null,
  updated_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_periods_operator_period_unique unique (operator_id, period_start),
  constraint payroll_periods_period_order check (period_end >= period_start),
  constraint payroll_periods_nonnegative check (
    base_salary_lyd >= 0
    and car_allowance_lyd >= 0
    and phone_allowance_lyd >= 0
    and route_pay_total_lyd >= 0
    and buying_trip_total_lyd >= 0
    and emergency_total_lyd >= 0
    and bonus_total_lyd >= 0
    and deduction_total_lyd >= 0
    and gross_total_lyd >= 0
  )
);

create table if not exists public.route_pay_breakdowns (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  operator_pay_profile_id uuid references public.operator_pay_profiles(id) on delete set null,
  pay_rule_id text not null default 'default' references public.route_pay_rules(id) on delete restrict,
  storage_location_id uuid references public.storage_locations(id) on delete set null,
  payroll_period_id uuid references public.payroll_periods(id) on delete set null,
  route_status text,
  distance_km numeric(10,2),
  distance_zone public.route_distance_zone,
  distance_source text not null default 'manual',
  stop_count integer not null default 0,
  total_stop_multiplier numeric(10,2) not null default 0,
  route_base_lyd numeric(12,2) not null default 0,
  stop_pay_lyd numeric(12,2) not null default 0,
  distance_pay_lyd numeric(12,2) not null default 0,
  load_difficulty_pay_lyd numeric(12,2) not null default 0,
  extras_pay_lyd numeric(12,2) not null default 0,
  manual_adjustment_lyd numeric(12,2) not null default 0,
  manual_adjustment_reason text,
  total_pay_lyd numeric(12,2) not null default 0,
  approval_required boolean not null default false,
  approved_by uuid references public.team_members(id) on delete set null,
  approved_at timestamptz,
  locked_by uuid references public.team_members(id) on delete set null,
  locked_at timestamptz,
  breakdown jsonb not null default '{}'::jsonb,
  recalculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pay_breakdowns_route_unique unique (route_id),
  constraint route_pay_breakdowns_distance_source_check check (distance_source in ('manual', 'location_zone', 'route_zone', 'km_manual', 'map_api')),
  constraint route_pay_breakdowns_nonnegative check (
    coalesce(distance_km, 0) >= 0
    and stop_count >= 0
    and total_stop_multiplier >= 0
    and route_base_lyd >= 0
    and stop_pay_lyd >= 0
    and distance_pay_lyd >= 0
    and load_difficulty_pay_lyd >= 0
    and extras_pay_lyd >= 0
  ),
  constraint route_pay_breakdowns_manual_adjustment_reason_check check (
    manual_adjustment_lyd = 0
    or manual_adjustment_reason is not null
  )
);

create table if not exists public.route_pay_extra_items (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  route_stop_id uuid references public.route_stops(id) on delete cascade,
  extra_type public.route_pay_extra_type not null,
  amount_lyd numeric(12,2) not null default 0,
  notes text,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pay_extra_items_amount_nonnegative check (amount_lyd >= 0)
);

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.payroll_periods(id) on delete cascade,
  adjustment_type text not null,
  label text not null,
  amount_lyd numeric(12,2) not null,
  reason text not null,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_adjustments_type_check check (adjustment_type in ('bonus', 'deduction')),
  constraint payroll_adjustments_amount_positive check (amount_lyd > 0)
);

insert into public.operator_pay_profiles (
  team_member_id,
  role_level,
  base_salary_lyd,
  car_allowance_lyd,
  phone_allowance_lyd,
  default_route_base_lyd,
  default_stop_rate_lyd,
  default_km_rate_lyd,
  can_collect_cash,
  can_buy_stock,
  active,
  notes
)
select
  tm.id,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 'senior_operator'::public.operator_role_level
    else 'junior_operator'::public.operator_role_level
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 1300
    else 900
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 400
    else 250
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 50
    else 0
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 30
    else 20
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 30
    else 25
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then 0.50
    else 0.40
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then true
    else false
  end,
  case
    when tm.role in ('owner', 'admin', 'supervisor')
      or coalesce(tm.roles, '{}'::public.team_role[]) && array['owner', 'admin', 'supervisor']::public.team_role[]
    then true
    else false
  end,
  coalesce(tm.active, true),
  'Seeded by payroll engine migration.'
from public.team_members tm
where coalesce(tm.active, true)
  and (
    tm.role = 'operator'
    or coalesce(tm.roles, '{}'::public.team_role[]) && array['operator']::public.team_role[]
  )
  and not exists (
    select 1
    from public.operator_pay_profiles opp
    where opp.team_member_id = tm.id
  );

create index if not exists idx_routes_storage_location on public.routes(storage_location_id);
create index if not exists idx_routes_payroll_status on public.routes(status, verified_at desc, paid_at desc);
create index if not exists idx_locations_distance_zone on public.locations(distance_zone);
create index if not exists idx_operator_pay_profiles_active on public.operator_pay_profiles(active, role_level);
create index if not exists idx_route_pay_breakdowns_operator on public.route_pay_breakdowns(operator_id, recalculated_at desc);
create index if not exists idx_route_pay_breakdowns_period on public.route_pay_breakdowns(payroll_period_id);
create index if not exists idx_route_pay_extra_items_route on public.route_pay_extra_items(route_id, created_at desc);
create index if not exists idx_route_pay_extra_items_stop on public.route_pay_extra_items(route_stop_id);
create index if not exists idx_payroll_periods_operator_period on public.payroll_periods(operator_id, period_start desc);
create index if not exists idx_payroll_periods_status on public.payroll_periods(status, paid_at desc);
create index if not exists idx_payroll_adjustments_period on public.payroll_adjustments(payroll_period_id, created_at desc);

create or replace function public.snacky_current_team_member_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  with profile_ctx as (
    select coalesce(p.team_member_id, tm.id) as team_member_id
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
  ),
  team_member_ctx as (
    select tm.id as team_member_id
    from public.team_members tm
    where tm.auth_user_id = auth.uid()
      and coalesce(tm.active_status = 'active', case when tm.active is false then false else true end)
      and not exists (select 1 from profile_ctx)
  )
  select team_member_id
  from (
    select * from profile_ctx
    union all
    select * from team_member_ctx
  ) ctx
  limit 1;
$$;

grant execute on function public.snacky_current_team_member_id() to authenticated;

do $$
begin
  execute 'alter table public.operator_pay_profiles enable row level security';
  execute 'alter table public.route_pay_rules enable row level security';
  execute 'alter table public.route_pay_breakdowns enable row level security';
  execute 'alter table public.route_pay_extra_items enable row level security';
  execute 'alter table public.payroll_periods enable row level security';
  execute 'alter table public.payroll_adjustments enable row level security';

  execute 'drop policy if exists "snacky_operator_pay_profiles_select" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_operator_pay_profiles_insert" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_operator_pay_profiles_update" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_operator_pay_profiles_delete" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_route_pay_rules_select" on public.route_pay_rules';
  execute 'drop policy if exists "snacky_route_pay_rules_insert" on public.route_pay_rules';
  execute 'drop policy if exists "snacky_route_pay_rules_update" on public.route_pay_rules';
  execute 'drop policy if exists "snacky_route_pay_rules_delete" on public.route_pay_rules';
  execute 'drop policy if exists "snacky_route_pay_breakdowns_select" on public.route_pay_breakdowns';
  execute 'drop policy if exists "snacky_route_pay_breakdowns_insert" on public.route_pay_breakdowns';
  execute 'drop policy if exists "snacky_route_pay_breakdowns_update" on public.route_pay_breakdowns';
  execute 'drop policy if exists "snacky_route_pay_breakdowns_delete" on public.route_pay_breakdowns';
  execute 'drop policy if exists "snacky_route_pay_extra_items_select" on public.route_pay_extra_items';
  execute 'drop policy if exists "snacky_route_pay_extra_items_insert" on public.route_pay_extra_items';
  execute 'drop policy if exists "snacky_route_pay_extra_items_update" on public.route_pay_extra_items';
  execute 'drop policy if exists "snacky_route_pay_extra_items_delete" on public.route_pay_extra_items';
  execute 'drop policy if exists "snacky_payroll_periods_select" on public.payroll_periods';
  execute 'drop policy if exists "snacky_payroll_periods_insert" on public.payroll_periods';
  execute 'drop policy if exists "snacky_payroll_periods_update" on public.payroll_periods';
  execute 'drop policy if exists "snacky_payroll_periods_delete" on public.payroll_periods';
  execute 'drop policy if exists "snacky_payroll_adjustments_select" on public.payroll_adjustments';
  execute 'drop policy if exists "snacky_payroll_adjustments_insert" on public.payroll_adjustments';
  execute 'drop policy if exists "snacky_payroll_adjustments_update" on public.payroll_adjustments';
  execute 'drop policy if exists "snacky_payroll_adjustments_delete" on public.payroll_adjustments';

  execute $sql$
    create policy "snacky_operator_pay_profiles_select"
    on public.operator_pay_profiles for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
      or team_member_id = public.snacky_current_team_member_id()
    )
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profiles_insert"
    on public.operator_pay_profiles for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profiles_update"
    on public.operator_pay_profiles for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profiles_delete"
    on public.operator_pay_profiles for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_rules_select"
    on public.route_pay_rules for select
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_rules_insert"
    on public.route_pay_rules for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_rules_update"
    on public.route_pay_rules for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_rules_delete"
    on public.route_pay_rules for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_breakdowns_select"
    on public.route_pay_breakdowns for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
      or exists (
        select 1
        from public.routes r
        where r.id = route_id
          and r.operator_id = public.snacky_current_team_member_id()
      )
    )
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_breakdowns_insert"
    on public.route_pay_breakdowns for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_breakdowns_update"
    on public.route_pay_breakdowns for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_breakdowns_delete"
    on public.route_pay_breakdowns for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_extra_items_select"
    on public.route_pay_extra_items for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
      or exists (
        select 1
        from public.routes r
        where r.id = route_id
          and r.operator_id = public.snacky_current_team_member_id()
      )
    )
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_extra_items_insert"
    on public.route_pay_extra_items for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_extra_items_update"
    on public.route_pay_extra_items for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_route_pay_extra_items_delete"
    on public.route_pay_extra_items for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_periods_select"
    on public.payroll_periods for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
      or operator_id = public.snacky_current_team_member_id()
    )
  $sql$;

  execute $sql$
    create policy "snacky_payroll_periods_insert"
    on public.payroll_periods for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_periods_update"
    on public.payroll_periods for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_periods_delete"
    on public.payroll_periods for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_adjustments_select"
    on public.payroll_adjustments for select
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_adjustments_insert"
    on public.payroll_adjustments for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_adjustments_update"
    on public.payroll_adjustments for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_adjustments_delete"
    on public.payroll_adjustments for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;
end $$;

select pg_notify('pgrst', 'reload schema');
