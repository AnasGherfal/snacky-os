-- Repair the lightweight location pipeline in environments where the first
-- rollout was missed, and add additive machine/site naming fields.

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
create index if not exists idx_location_pipeline_leads_converted_location on public.location_pipeline_leads(converted_location_id);
create index if not exists idx_location_pipeline_leads_search_name on public.location_pipeline_leads(lower(place_name));
create index if not exists idx_location_pipeline_leads_search_area on public.location_pipeline_leads(lower(area));
create index if not exists idx_location_pipeline_leads_search_contact_name on public.location_pipeline_leads(lower(contact_person_name));
create index if not exists idx_location_pipeline_leads_search_phone on public.location_pipeline_leads(lower(contact_phone));
create index if not exists idx_location_pipeline_leads_search_whatsapp on public.location_pipeline_leads(lower(contact_whatsapp));
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

alter table public.locations
  add column if not exists site_name text,
  add column if not exists area text,
  add column if not exists city text,
  add column if not exists address_text text,
  add column if not exists google_maps_url text,
  add column if not exists contact_person_name text,
  add column if not exists contact_person_phone text,
  add column if not exists source_location_lead_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_source_location_lead_id_fkey'
      and conrelid = 'public.locations'::regclass
  ) then
    alter table public.locations
      add constraint locations_source_location_lead_id_fkey
      foreign key (source_location_lead_id) references public.location_pipeline_leads(id) on delete set null;
  end if;
end $$;

alter table public.machines
  add column if not exists machine_display_name text;

update public.locations
set site_name = coalesce(nullif(site_name, ''), nullif(name, '')),
    address_text = coalesce(nullif(address_text, ''), nullif(address, '')),
    contact_person_name = coalesce(nullif(contact_person_name, ''), nullif(contact_name, '')),
    contact_person_phone = coalesce(nullif(contact_person_phone, ''), nullif(contact_phone, '')),
    updated_at = now()
where site_name is null
   or site_name = ''
   or address_text is null
   or address_text = ''
   or contact_person_name is null
   or contact_person_name = ''
   or contact_person_phone is null
   or contact_person_phone = '';

update public.machines
set machine_display_name = coalesce(nullif(machine_display_name, ''), nullif(machine_code, ''), nullif(name, '')),
    updated_at = now()
where machine_display_name is null or machine_display_name = '';

create index if not exists idx_locations_site_name on public.locations(lower(site_name));
create index if not exists idx_locations_area on public.locations(lower(area));
create index if not exists idx_locations_source_location_lead on public.locations(source_location_lead_id);
create index if not exists idx_machines_machine_display_name on public.machines(lower(machine_display_name));

select pg_notify('pgrst', 'reload schema');
