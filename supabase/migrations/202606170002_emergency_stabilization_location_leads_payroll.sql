-- Emergency stabilization for production environments that missed the
-- location pipeline and payroll v2 migrations. This keeps the current
-- canonical tables, adds compatibility views for legacy names, and avoids
-- destructive changes.

create table if not exists public.location_pipeline_leads (
  id uuid primary key default gen_random_uuid(),
  place_name text not null,
  place_type public.location_type not null default 'other',
  city text,
  area text,
  address_text text,
  google_maps_url text,
  contact_person_name text,
  contact_person_job_title text,
  contact_phone text,
  contact_whatsapp text,
  contacted_by_user_id uuid references public.team_members(id) on delete set null,
  first_contact_date date,
  last_contact_date date,
  next_follow_up_date date,
  status text not null default 'want_to_contact',
  notes text,
  estimated_traffic integer,
  rent_expectation numeric(12,2),
  rejection_reason text,
  converted_location_id uuid references public.locations(id) on delete set null,
  converted_at timestamptz,
  converted_by_user_id uuid references public.team_members(id) on delete set null,
  is_archived boolean not null default false,
  archived_at timestamptz,
  archived_by_user_id uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.location_pipeline_leads
  add column if not exists place_name text,
  add column if not exists place_type public.location_type not null default 'other',
  add column if not exists city text,
  add column if not exists area text,
  add column if not exists address_text text,
  add column if not exists google_maps_url text,
  add column if not exists contact_person_name text,
  add column if not exists contact_person_job_title text,
  add column if not exists contact_phone text,
  add column if not exists contact_whatsapp text,
  add column if not exists contacted_by_user_id uuid references public.team_members(id) on delete set null,
  add column if not exists first_contact_date date,
  add column if not exists last_contact_date date,
  add column if not exists next_follow_up_date date,
  add column if not exists status text not null default 'want_to_contact',
  add column if not exists notes text,
  add column if not exists estimated_traffic integer,
  add column if not exists rent_expectation numeric(12,2),
  add column if not exists rejection_reason text,
  add column if not exists converted_location_id uuid references public.locations(id) on delete set null,
  add column if not exists converted_at timestamptz,
  add column if not exists converted_by_user_id uuid references public.team_members(id) on delete set null,
  add column if not exists is_archived boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id uuid references public.team_members(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  update public.location_pipeline_leads
  set place_name = coalesce(nullif(place_name, ''), 'Unnamed lead')
  where place_name is null or place_name = '';

  update public.location_pipeline_leads
  set place_type = 'other'
  where place_type is null
    or place_type::text not in ('school', 'hospital', 'university', 'office', 'mall', 'gym', 'other');

  update public.location_pipeline_leads
  set status = 'want_to_contact'
  where status is null
    or status not in (
      'want_to_contact',
      'contacted',
      'interested',
      'meeting_needed',
      'offer_sent',
      'accepted',
      'rejected',
      'follow_up_later',
      'machine_placed'
    );

  update public.location_pipeline_leads
  set is_archived = coalesce(is_archived, false) or archived_at is not null
  where is_archived is distinct from (coalesce(is_archived, false) or archived_at is not null);
end $$;

alter table public.location_pipeline_leads
  alter column place_name set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'location_pipeline_leads_status_check'
      and conrelid = 'public.location_pipeline_leads'::regclass
  ) then
    alter table public.location_pipeline_leads
      add constraint location_pipeline_leads_status_check
      check (
        status in (
          'want_to_contact',
          'contacted',
          'interested',
          'meeting_needed',
          'offer_sent',
          'accepted',
          'rejected',
          'follow_up_later',
          'machine_placed'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'location_pipeline_leads_place_type_check'
      and conrelid = 'public.location_pipeline_leads'::regclass
  ) then
    alter table public.location_pipeline_leads
      add constraint location_pipeline_leads_place_type_check
      check (
        place_type::text in (
          'school',
          'hospital',
          'university',
          'office',
          'mall',
          'gym',
          'other'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'location_pipeline_leads_estimated_traffic_check'
      and conrelid = 'public.location_pipeline_leads'::regclass
  ) then
    alter table public.location_pipeline_leads
      add constraint location_pipeline_leads_estimated_traffic_check
      check (estimated_traffic is null or estimated_traffic >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'location_pipeline_leads_rent_expectation_check'
      and conrelid = 'public.location_pipeline_leads'::regclass
  ) then
    alter table public.location_pipeline_leads
      add constraint location_pipeline_leads_rent_expectation_check
      check (rent_expectation is null or rent_expectation >= 0);
  end if;
end $$;

create index if not exists idx_location_pipeline_leads_status on public.location_pipeline_leads(status);
create index if not exists idx_location_pipeline_leads_place_type on public.location_pipeline_leads(place_type);
create index if not exists idx_location_pipeline_leads_follow_up on public.location_pipeline_leads(next_follow_up_date);
create index if not exists idx_location_pipeline_leads_updated_at on public.location_pipeline_leads(updated_at desc);
create index if not exists idx_location_pipeline_leads_archived on public.location_pipeline_leads(is_archived, updated_at desc);

create or replace function public.snacky_current_profile_can_manage_location_pipeline()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

grant execute on function public.snacky_current_profile_can_manage_location_pipeline() to authenticated;

do $$
begin
  execute 'alter table public.location_pipeline_leads enable row level security';
  execute 'drop policy if exists "snacky_location_pipeline_leads_select" on public.location_pipeline_leads';
  execute 'drop policy if exists "snacky_location_pipeline_leads_insert" on public.location_pipeline_leads';
  execute 'drop policy if exists "snacky_location_pipeline_leads_update" on public.location_pipeline_leads';

  execute $sql$
    create policy "snacky_location_pipeline_leads_select"
    on public.location_pipeline_leads for select
    to authenticated
    using (public.snacky_current_profile_can_manage_location_pipeline())
  $sql$;

  execute $sql$
    create policy "snacky_location_pipeline_leads_insert"
    on public.location_pipeline_leads for insert
    to authenticated
    with check (public.snacky_current_profile_can_manage_location_pipeline())
  $sql$;

  execute $sql$
    create policy "snacky_location_pipeline_leads_update"
    on public.location_pipeline_leads for update
    to authenticated
    using (public.snacky_current_profile_can_manage_location_pipeline())
    with check (public.snacky_current_profile_can_manage_location_pipeline())
  $sql$;
end $$;

create or replace view public.location_leads as
select
  lead.id,
  lead.place_name,
  lead.place_type::text as place_type,
  lead.city,
  lead.area,
  lead.address_text,
  lead.google_maps_url,
  lead.contact_person_name,
  lead.contact_person_job_title,
  lead.contact_phone,
  lead.contact_whatsapp,
  lead.contacted_by_user_id,
  lead.first_contact_date,
  lead.last_contact_date,
  lead.next_follow_up_date,
  lead.status,
  lead.notes,
  case when lead.estimated_traffic is null then null else lead.estimated_traffic::text end as estimated_traffic,
  lead.rent_expectation,
  lead.rejection_reason,
  lead.converted_location_id,
  lead.converted_location_id as converted_site_id,
  lead.is_archived,
  lead.created_at,
  lead.updated_at
from public.location_pipeline_leads lead;

grant select on public.location_leads to authenticated;

alter table public.locations
  add column if not exists payroll_storage_location_id uuid references public.storage_locations(id) on delete set null,
  add column if not exists distance_from_storage_km numeric(10,2),
  add column if not exists use_round_trip_distance boolean not null default false,
  add column if not exists payroll_distance_notes text;

create or replace view public.location_payroll_distances as
select
  location.id,
  null::uuid as machine_id,
  location.id as location_id,
  coalesce(location.distance_from_storage_km, 0)::numeric(10,2) as distance_from_storage_km,
  coalesce(location.use_round_trip_distance, true) as use_round_trip_distance,
  storage.name as storage_location_name,
  location.payroll_distance_notes as notes,
  location.created_at,
  location.updated_at
from public.locations location
left join public.storage_locations storage
  on storage.id = location.payroll_storage_location_id;

grant select on public.location_payroll_distances to authenticated;

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

do $$ begin
  create type public.operator_role_level as enum ('junior_operator', 'senior_operator', 'backup_operator');
exception when duplicate_object then null; end $$;

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

create table if not exists public.operator_pay_profiles (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete cascade,
  role_level public.operator_role_level not null default 'junior_operator',
  base_salary_lyd numeric(12,2) not null default 0,
  base_monthly_salary_lyd numeric(12,2) not null default 0,
  default_route_base_lyd numeric(12,2) not null default 0,
  pay_per_route_lyd numeric(12,2) not null default 0,
  default_stop_rate_lyd numeric(12,2) not null default 0,
  pay_per_stop_lyd numeric(12,2) not null default 0,
  default_km_rate_lyd numeric(12,2) not null default 0,
  pay_per_km_lyd numeric(12,2) not null default 0,
  fuel_allowance_per_km_lyd numeric(12,2) not null default 0,
  active boolean not null default true,
  active_from date not null default current_date,
  active_to date,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_pay_profiles_team_member_unique unique (team_member_id)
);

alter table public.operator_pay_profiles
  add column if not exists operator_id uuid references public.team_members(id) on delete cascade,
  add column if not exists base_monthly_salary_lyd numeric(12,2) not null default 0,
  add column if not exists pay_per_route_lyd numeric(12,2) not null default 0,
  add column if not exists pay_per_stop_lyd numeric(12,2) not null default 0,
  add column if not exists pay_per_km_lyd numeric(12,2) not null default 0,
  add column if not exists fuel_allowance_per_km_lyd numeric(12,2) not null default 0,
  add column if not exists active_from date not null default current_date,
  add column if not exists active_to date,
  add column if not exists is_active boolean not null default true,
  add column if not exists notes text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.operator_pay_profiles
set operator_id = coalesce(operator_id, team_member_id),
    base_monthly_salary_lyd = coalesce(base_monthly_salary_lyd, base_salary_lyd, 0),
    pay_per_route_lyd = coalesce(pay_per_route_lyd, default_route_base_lyd, 0),
    pay_per_stop_lyd = coalesce(pay_per_stop_lyd, default_stop_rate_lyd, 0),
    pay_per_km_lyd = coalesce(pay_per_km_lyd, default_km_rate_lyd, 0),
    fuel_allowance_per_km_lyd = coalesce(fuel_allowance_per_km_lyd, 0),
    active_from = coalesce(active_from, created_at::date, current_date),
    is_active = coalesce(is_active, active, true),
    updated_at = now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'operator_pay_profiles_nonnegative'
      and conrelid = 'public.operator_pay_profiles'::regclass
  ) then
    alter table public.operator_pay_profiles
      add constraint operator_pay_profiles_nonnegative check (
        coalesce(base_salary_lyd, 0) >= 0
        and coalesce(base_monthly_salary_lyd, 0) >= 0
        and coalesce(default_route_base_lyd, 0) >= 0
        and coalesce(pay_per_route_lyd, 0) >= 0
        and coalesce(default_stop_rate_lyd, 0) >= 0
        and coalesce(pay_per_stop_lyd, 0) >= 0
        and coalesce(default_km_rate_lyd, 0) >= 0
        and coalesce(pay_per_km_lyd, 0) >= 0
        and coalesce(fuel_allowance_per_km_lyd, 0) >= 0
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'operator_pay_profiles_active_window_valid'
      and conrelid = 'public.operator_pay_profiles'::regclass
  ) then
    alter table public.operator_pay_profiles
      add constraint operator_pay_profiles_active_window_valid
      check (active_to is null or active_to >= active_from);
  end if;

  if not exists (select 1 from public.operator_pay_profiles where operator_id is null) then
    alter table public.operator_pay_profiles
      alter column operator_id set not null;
  end if;
end $$;

do $$
begin
  execute 'alter table public.operator_pay_profiles enable row level security';
  execute 'drop policy if exists "snacky_operator_pay_profiles_select" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_operator_pay_profiles_insert" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_operator_pay_profiles_update" on public.operator_pay_profiles';
  execute 'drop policy if exists "snacky_operator_pay_profiles_delete" on public.operator_pay_profiles';

  execute $sql$
    create policy "snacky_operator_pay_profiles_select"
    on public.operator_pay_profiles for select
    to authenticated
    using (
      public.snacky_current_profile_has_any_role(array['owner', 'admin'])
      or coalesce(operator_id, team_member_id) = public.snacky_current_team_member_id()
    )
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profiles_insert"
    on public.operator_pay_profiles for insert
    to authenticated
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profiles_update"
    on public.operator_pay_profiles for update
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_operator_pay_profiles_delete"
    on public.operator_pay_profiles for delete
    to authenticated
    using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
  $sql$;
end $$;

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

alter table public.operator_pay_profile_versions
  add column if not exists base_monthly_salary_lyd numeric(12,2) not null default 0,
  add column if not exists pay_per_route_lyd numeric(12,2) not null default 0,
  add column if not exists pay_per_stop_lyd numeric(12,2) not null default 0,
  add column if not exists pay_per_km_lyd numeric(12,2) not null default 0,
  add column if not exists fuel_allowance_per_km_lyd numeric(12,2) not null default 0,
  add column if not exists is_active boolean not null default true,
  add column if not exists active_from date not null default current_date,
  add column if not exists active_to date,
  add column if not exists notes text,
  add column if not exists created_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists updated_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

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
  coalesce(opp.operator_id, opp.team_member_id),
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
where coalesce(opp.operator_id, opp.team_member_id) is not null
  and not exists (
    select 1
    from public.operator_pay_profile_versions oppv
    where oppv.operator_id = coalesce(opp.operator_id, opp.team_member_id)
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

alter table public.payroll_runs
  add column if not exists pay_profile_id uuid references public.operator_pay_profile_versions(id) on delete set null,
  add column if not exists completed_routes_count integer not null default 0,
  add column if not exists completed_stops_count integer not null default 0,
  add column if not exists total_payroll_distance_km numeric(12,2) not null default 0,
  add column if not exists base_salary_amount_lyd numeric(12,2) not null default 0,
  add column if not exists route_pay_amount_lyd numeric(12,2) not null default 0,
  add column if not exists stop_pay_amount_lyd numeric(12,2) not null default 0,
  add column if not exists distance_pay_amount_lyd numeric(12,2) not null default 0,
  add column if not exists fuel_allowance_amount_lyd numeric(12,2) not null default 0,
  add column if not exists bonus_amount_lyd numeric(12,2) not null default 0,
  add column if not exists deduction_amount_lyd numeric(12,2) not null default 0,
  add column if not exists gross_pay_lyd numeric(12,2) not null default 0,
  add column if not exists net_pay_lyd numeric(12,2) not null default 0,
  add column if not exists status public.payroll_run_status not null default 'draft',
  add column if not exists calculation_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists created_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists approved_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists paid_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists paid_at timestamptz,
  add column if not exists finance_transaction_id uuid references public.financial_transactions(id) on delete set null,
  add column if not exists notes text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

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
  description text not null default '',
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

alter table public.operator_incidents
  add column if not exists route_id uuid references public.routes(id) on delete set null,
  add column if not exists stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists location_id uuid references public.locations(id) on delete set null,
  add column if not exists incident_date date not null default current_date,
  add column if not exists mistake_type public.operator_incident_mistake_type not null default 'other',
  add column if not exists severity public.operator_incident_severity not null default 'level_1_small',
  add column if not exists description text not null default '',
  add column if not exists evidence_photo_url text,
  add column if not exists deduction_amount_lyd numeric(12,2) not null default 0,
  add column if not exists status public.operator_incident_status not null default 'pending',
  add column if not exists approved_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists cancelled_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists cancelled_at timestamptz,
  add column if not exists applied_payroll_run_id uuid references public.payroll_runs(id) on delete set null,
  add column if not exists notes text,
  add column if not exists created_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

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
