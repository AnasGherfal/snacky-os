do $$ begin
  create type public.operator_incident_mistake_type as enum (
    'missed_cleaning',
    'missing_photo',
    'wrong_product_slot',
    'wrong_prices',
    'machine_left_unusable',
    'customer_money_issue',
    'cash_mismatch',
    'poor_machine_presentation',
    'location_complaint',
    'ignored_customer_issue',
    'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.operator_incident_severity as enum (
    'level_1_small',
    'level_2_medium',
    'level_3_serious',
    'level_4_critical'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.operator_incident_status as enum (
    'pending',
    'approved',
    'cancelled',
    'applied_to_payroll'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payroll_run_status as enum (
    'draft',
    'approved',
    'paid',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.operator_pay_profile_versions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.team_members(id) on delete cascade,
  base_monthly_salary_lyd numeric(12,2) not null default 0,
  pay_per_route_lyd numeric(12,2) not null default 0,
  pay_per_stop_lyd numeric(12,2) not null default 0,
  pay_per_km_lyd numeric(12,2) not null default 0,
  fuel_allowance_per_km_lyd numeric(12,2) not null default 0,
  is_active boolean not null default true,
  active_from date not null default current_date,
  active_to date,
  notes text,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  updated_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'operator_pay_profile_versions_nonnegative'
      and conrelid = 'public.operator_pay_profile_versions'::regclass
  ) then
    alter table public.operator_pay_profile_versions
      add constraint operator_pay_profile_versions_nonnegative
      check (
        base_monthly_salary_lyd >= 0
        and pay_per_route_lyd >= 0
        and pay_per_stop_lyd >= 0
        and pay_per_km_lyd >= 0
        and fuel_allowance_per_km_lyd >= 0
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'operator_pay_profile_versions_active_window_valid'
      and conrelid = 'public.operator_pay_profile_versions'::regclass
  ) then
    alter table public.operator_pay_profile_versions
      add constraint operator_pay_profile_versions_active_window_valid
      check (active_to is null or active_to >= active_from);
  end if;
end $$;

create unique index if not exists operator_pay_profile_versions_active_one_per_operator
  on public.operator_pay_profile_versions(operator_id)
  where is_active = true;

create index if not exists idx_operator_pay_profile_versions_operator_window
  on public.operator_pay_profile_versions(operator_id, active_from desc, updated_at desc);

insert into public.operator_pay_profile_versions (
  operator_id,
  base_monthly_salary_lyd,
  pay_per_route_lyd,
  pay_per_stop_lyd,
  pay_per_km_lyd,
  fuel_allowance_per_km_lyd,
  is_active,
  active_from,
  active_to,
  notes,
  created_at,
  updated_at
)
select
  opp.team_member_id,
  coalesce(opp.base_monthly_salary_lyd, opp.base_salary_lyd, 0),
  coalesce(opp.pay_per_route_lyd, opp.default_route_base_lyd, 0),
  coalesce(opp.pay_per_stop_lyd, opp.default_stop_rate_lyd, 0),
  coalesce(opp.pay_per_km_lyd, opp.default_km_rate_lyd, 0),
  coalesce(opp.fuel_allowance_per_km_lyd, 0),
  coalesce(opp.is_active, opp.active, true),
  coalesce(opp.active_from, opp.created_at::date, current_date),
  opp.active_to,
  opp.notes,
  coalesce(opp.created_at, now()),
  coalesce(opp.updated_at, now())
from public.operator_pay_profiles opp
where not exists (
  select 1
  from public.operator_pay_profile_versions oppv
  where oppv.operator_id = opp.team_member_id
);

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.team_members(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  pay_profile_id uuid references public.operator_pay_profile_versions(id) on delete set null,
  completed_routes_count integer not null default 0,
  completed_stops_count integer not null default 0,
  total_payroll_distance_km numeric(12,2) not null default 0,
  base_salary_amount_lyd numeric(12,2) not null default 0,
  route_pay_amount_lyd numeric(12,2) not null default 0,
  stop_pay_amount_lyd numeric(12,2) not null default 0,
  distance_pay_amount_lyd numeric(12,2) not null default 0,
  fuel_allowance_amount_lyd numeric(12,2) not null default 0,
  bonus_amount_lyd numeric(12,2) not null default 0,
  deduction_amount_lyd numeric(12,2) not null default 0,
  gross_pay_lyd numeric(12,2) not null default 0,
  net_pay_lyd numeric(12,2) not null default 0,
  status public.payroll_run_status not null default 'draft',
  calculation_snapshot jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  approved_by_user_id uuid references public.profiles(id) on delete set null,
  paid_by_user_id uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  finance_transaction_id uuid references public.financial_transactions(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_runs_operator_period_unique unique (operator_id, period_start, period_end)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payroll_runs_period_order'
      and conrelid = 'public.payroll_runs'::regclass
  ) then
    alter table public.payroll_runs
      add constraint payroll_runs_period_order
      check (period_end >= period_start);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'payroll_runs_nonnegative'
      and conrelid = 'public.payroll_runs'::regclass
  ) then
    alter table public.payroll_runs
      add constraint payroll_runs_nonnegative
      check (
        completed_routes_count >= 0
        and completed_stops_count >= 0
        and total_payroll_distance_km >= 0
        and base_salary_amount_lyd >= 0
        and route_pay_amount_lyd >= 0
        and stop_pay_amount_lyd >= 0
        and distance_pay_amount_lyd >= 0
        and fuel_allowance_amount_lyd >= 0
        and bonus_amount_lyd >= 0
        and deduction_amount_lyd >= 0
        and gross_pay_lyd >= 0
        and net_pay_lyd >= 0
      );
  end if;
end $$;

create index if not exists idx_payroll_runs_operator_period
  on public.payroll_runs(operator_id, period_start desc, period_end desc);

create index if not exists idx_payroll_runs_status_paid_at
  on public.payroll_runs(status, paid_at desc nulls last, created_at desc);

create table if not exists public.operator_incidents (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.team_members(id) on delete cascade,
  route_id uuid references public.routes(id) on delete set null,
  stop_id uuid references public.route_stops(id) on delete set null,
  machine_id uuid references public.machines(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  incident_date date not null default current_date,
  mistake_type public.operator_incident_mistake_type not null default 'other',
  severity public.operator_incident_severity not null default 'level_1_small',
  description text not null,
  evidence_photo_url text,
  deduction_amount_lyd numeric(12,2) not null default 0,
  status public.operator_incident_status not null default 'pending',
  approved_by_user_id uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  cancelled_by_user_id uuid references public.profiles(id) on delete set null,
  cancelled_at timestamptz,
  applied_payroll_run_id uuid references public.payroll_runs(id) on delete set null,
  notes text,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'operator_incidents_deduction_nonnegative'
      and conrelid = 'public.operator_incidents'::regclass
  ) then
    alter table public.operator_incidents
      add constraint operator_incidents_deduction_nonnegative
      check (deduction_amount_lyd >= 0);
  end if;
end $$;

create index if not exists idx_operator_incidents_operator_status
  on public.operator_incidents(operator_id, status, incident_date desc, created_at desc);

create index if not exists idx_operator_incidents_payroll_run
  on public.operator_incidents(applied_payroll_run_id, status, incident_date desc);

create unique index if not exists financial_transactions_payroll_source_uidx
  on public.financial_transactions(source_type, source_id)
  where source_type = 'payroll' and source_id is not null;

do $$
begin
  execute 'alter table public.operator_pay_profile_versions enable row level security';
  execute 'alter table public.payroll_runs enable row level security';
  execute 'alter table public.operator_incidents enable row level security';

  execute 'drop policy if exists "snacky_operator_pay_profile_versions_select" on public.operator_pay_profile_versions';
  execute 'drop policy if exists "snacky_operator_pay_profile_versions_insert" on public.operator_pay_profile_versions';
  execute 'drop policy if exists "snacky_operator_pay_profile_versions_update" on public.operator_pay_profile_versions';
  execute 'drop policy if exists "snacky_payroll_runs_select" on public.payroll_runs';
  execute 'drop policy if exists "snacky_payroll_runs_insert" on public.payroll_runs';
  execute 'drop policy if exists "snacky_payroll_runs_update" on public.payroll_runs';
  execute 'drop policy if exists "snacky_operator_incidents_select" on public.operator_incidents';
  execute 'drop policy if exists "snacky_operator_incidents_insert" on public.operator_incidents';
  execute 'drop policy if exists "snacky_operator_incidents_update" on public.operator_incidents';

  execute $sql$
    create policy "snacky_operator_pay_profile_versions_select"
    on public.operator_pay_profile_versions for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin'])
      or operator_id = public.snacky_current_team_member_id()
    )
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profile_versions_insert"
    on public.operator_pay_profile_versions for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profile_versions_update"
    on public.operator_pay_profile_versions for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_runs_select"
    on public.payroll_runs for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin'])
      or operator_id = public.snacky_current_team_member_id()
    )
  $sql$;

  execute $sql$
    create policy "snacky_payroll_runs_insert"
    on public.payroll_runs for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_payroll_runs_update"
    on public.payroll_runs for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_incidents_select"
    on public.operator_incidents for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin'])
      or operator_id = public.snacky_current_team_member_id()
    )
  $sql$;

  execute $sql$
    create policy "snacky_operator_incidents_insert"
    on public.operator_incidents for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_incidents_update"
    on public.operator_incidents for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;
end $$;

select pg_notify('pgrst', 'reload schema');
