-- Complete cash chain of custody.
--
-- New cash must follow an immutable, route-independent workflow:
-- removed and sealed -> received in storage -> counted -> reconciled -> banked.
-- Financial amounts stay in cash_collections; operators and warehouse receivers
-- use cash_removal_receipts, which deliberately contains no counted/expected cash.

create schema if not exists snacky_private;
revoke all on schema snacky_private from public, anon, authenticated;
grant usage on schema snacky_private to authenticated, service_role;

alter table public.cash_collections
  add column if not exists custody_status text,
  add column if not exists storage_received_at timestamptz,
  add column if not exists storage_received_by uuid references public.team_members(id) on delete set null,
  add column if not exists storage_location text,
  add column if not exists storage_seal_condition text,
  add column if not exists storage_notes text,
  add column if not exists count_seal_condition text,
  add column if not exists count_witnessed_by uuid references public.team_members(id) on delete set null,
  add column if not exists count_denominations jsonb,
  add column if not exists count_other_amount_lyd numeric(12,2) not null default 0,
  add column if not exists expected_source text,
  add column if not exists expected_calculated_at timestamptz,
  add column if not exists expected_calculated_by uuid references public.team_members(id) on delete set null,
  add column if not exists reconciliation_status text,
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by uuid references public.team_members(id) on delete set null,
  add column if not exists reconciliation_note text,
  add column if not exists variance_resolution text,
  add column if not exists banked_amount_lyd numeric(12,2) not null default 0,
  add column if not exists updated_at timestamptz not null default now();

update public.cash_collections
set custody_status = case
      when review_status = 'voided' then 'voided'
      when actual_cash_collected is not null then 'counted'
      else 'removed'
    end,
    reconciliation_status = case
      when review_status = 'voided' then 'voided'
      when review_status = 'variance_review' then 'variance_review'
      when actual_cash_collected is not null and vms_expected_cash is not null and abs(actual_cash_collected - vms_expected_cash) < 10 then 'matched'
      when actual_cash_collected is not null and vms_expected_cash is not null then 'variance_review'
      else 'pending'
    end
where custody_status is null or reconciliation_status is null;

alter table public.cash_collections
  alter column custody_status set default 'removed',
  alter column custody_status set not null,
  alter column reconciliation_status set default 'pending',
  alter column reconciliation_status set not null,
  drop constraint if exists cash_collections_review_status_check,
  add constraint cash_collections_review_status_check
    check (review_status in (
      'pending_collection', 'collected_pending_count', 'counted_pending_reconciliation',
      'counted_confirmed', 'variance_review', 'voided'
    )),
  drop constraint if exists cash_collections_custody_status_check,
  add constraint cash_collections_custody_status_check
    check (custody_status in ('removed', 'in_storage', 'counted', 'reconciled', 'banked', 'voided')),
  drop constraint if exists cash_collections_reconciliation_status_check,
  add constraint cash_collections_reconciliation_status_check
    check (reconciliation_status in ('pending', 'matched', 'variance_review', 'resolved', 'voided')),
  drop constraint if exists cash_collections_storage_seal_condition_check,
  add constraint cash_collections_storage_seal_condition_check
    check (storage_seal_condition is null or storage_seal_condition in ('intact', 'broken', 'mismatch')),
  drop constraint if exists cash_collections_count_seal_condition_check,
  add constraint cash_collections_count_seal_condition_check
    check (count_seal_condition is null or count_seal_condition in ('intact', 'broken', 'mismatch')),
  drop constraint if exists cash_collections_count_other_amount_check,
  add constraint cash_collections_count_other_amount_check check (count_other_amount_lyd >= 0),
  drop constraint if exists cash_collections_banked_amount_check,
  add constraint cash_collections_banked_amount_check check (banked_amount_lyd >= 0);

create unique index if not exists cash_collections_cash_bag_id_uidx
  on public.cash_collections (lower(trim(cash_bag_id)))
  where nullif(trim(cash_bag_id), '') is not null;

create index if not exists idx_cash_collections_custody_status_date
  on public.cash_collections (custody_status, collected_at desc);
create index if not exists idx_cash_collections_storage_received_by
  on public.cash_collections (storage_received_by) where storage_received_by is not null;
create index if not exists idx_cash_collections_expected_calculated_by
  on public.cash_collections (expected_calculated_by) where expected_calculated_by is not null;
create index if not exists idx_cash_collections_count_witnessed_by
  on public.cash_collections (count_witnessed_by) where count_witnessed_by is not null;
create index if not exists idx_cash_collections_reconciled_by
  on public.cash_collections (reconciled_by) where reconciled_by is not null;

alter table public.cash_collection_machines
  add column if not exists compartments text[] not null default array['legacy_unknown']::text[],
  add column if not exists cash_left_lyd numeric(12,2),
  add column if not exists interval_start_at timestamptz,
  add column if not exists interval_end_at timestamptz,
  add column if not exists expected_cash_lyd numeric(12,2),
  add column if not exists vms_sales_count integer,
  add column if not exists expectation_status text not null default 'pending',
  add column if not exists expectation_source text,
  add column if not exists expectation_metadata jsonb not null default '{}'::jsonb;

update public.cash_collection_machines ccm
set interval_end_at = cc.collected_at
from public.cash_collections cc
where cc.id = ccm.cash_collection_id
  and ccm.interval_end_at is null;

alter table public.cash_collection_machines
  drop constraint if exists cash_collection_machines_compartments_check,
  add constraint cash_collection_machines_compartments_check check (
    cardinality(compartments) > 0
    and compartments <@ array['notes', 'coins', 'recycler', 'change_float', 'legacy_unknown']::text[]
  ),
  drop constraint if exists cash_collection_machines_cash_left_check,
  add constraint cash_collection_machines_cash_left_check check (cash_left_lyd is null or cash_left_lyd >= 0),
  drop constraint if exists cash_collection_machines_expected_cash_check,
  add constraint cash_collection_machines_expected_cash_check check (expected_cash_lyd is null or expected_cash_lyd >= 0),
  drop constraint if exists cash_collection_machines_vms_sales_count_check,
  add constraint cash_collection_machines_vms_sales_count_check check (vms_sales_count is null or vms_sales_count >= 0),
  drop constraint if exists cash_collection_machines_expectation_status_check,
  add constraint cash_collection_machines_expectation_status_check check (
    expectation_status in (
      'pending', 'ready_exact', 'ready_cash_only_assumption', 'missing_start',
      'partial_removal', 'no_exact_vms_data', 'payment_split_incomplete', 'manual_override'
    )
  );

create table if not exists public.cash_removal_receipts (
  cash_collection_id uuid primary key references public.cash_collections(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  cash_bag_id text not null,
  collected_at timestamptz not null,
  custody_status text not null default 'removed',
  storage_received_at timestamptz,
  storage_received_by uuid references public.team_members(id) on delete set null,
  storage_location text,
  removal_evidence_path text,
  removal_evidence_file_name text,
  removal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_removal_receipts_custody_status_check
    check (custody_status in ('removed', 'in_storage', 'counted', 'reconciled', 'banked', 'voided'))
);

insert into public.cash_removal_receipts (
  cash_collection_id, operator_id, cash_bag_id, collected_at, custody_status, created_at, updated_at
)
select
  cc.id,
  cc.operator_id,
  coalesce(nullif(trim(cc.cash_bag_id), ''), 'LEGACY-' || upper(left(cc.id::text, 8))),
  cc.collected_at,
  cc.custody_status,
  cc.collected_at,
  now()
from public.cash_collections cc
on conflict (cash_collection_id) do nothing;

create index if not exists idx_cash_removal_receipts_operator_date
  on public.cash_removal_receipts (operator_id, collected_at desc);
create index if not exists idx_cash_removal_receipts_custody_date
  on public.cash_removal_receipts (custody_status, collected_at desc);
create index if not exists idx_cash_removal_receipts_storage_received_by
  on public.cash_removal_receipts (storage_received_by) where storage_received_by is not null;

-- Keep the machine list usable by the collector and storage receiver without
-- exposing the financial expectation columns on cash_collection_machines.
create table if not exists public.cash_removal_receipt_machines (
  cash_collection_id uuid not null references public.cash_removal_receipts(cash_collection_id) on delete cascade,
  machine_id uuid not null references public.machines(id) on delete restrict,
  removal_type text not null,
  compartments text[] not null,
  created_at timestamptz not null default now(),
  primary key (cash_collection_id, machine_id),
  constraint cash_removal_receipt_machines_type_check check (removal_type in ('full', 'partial')),
  constraint cash_removal_receipt_machines_compartments_check check (
    cardinality(compartments) > 0
    and compartments <@ array['notes', 'coins', 'recycler', 'change_float', 'legacy_unknown']::text[]
  )
);

insert into public.cash_removal_receipt_machines (
  cash_collection_id, machine_id, removal_type, compartments, created_at
)
select
  ccm.cash_collection_id,
  ccm.machine_id,
  ccm.removal_type,
  ccm.compartments,
  ccm.created_at
from public.cash_collection_machines ccm
join public.cash_removal_receipts receipt on receipt.cash_collection_id = ccm.cash_collection_id
on conflict (cash_collection_id, machine_id) do nothing;

create index if not exists idx_cash_removal_receipt_machines_machine
  on public.cash_removal_receipt_machines (machine_id, cash_collection_id);

create table if not exists public.cash_collection_events (
  id uuid primary key default gen_random_uuid(),
  cash_collection_id uuid not null references public.cash_collections(id) on delete restrict,
  event_type text not null,
  event_at timestamptz not null default now(),
  actor_user_id uuid,
  actor_team_member_id uuid references public.team_members(id) on delete set null,
  amount_lyd numeric(12,2),
  seal_condition text,
  evidence_storage_path text,
  evidence_file_name text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  client_submission_id uuid,
  created_at timestamptz not null default now(),
  constraint cash_collection_events_type_check check (event_type in (
    'removed', 'stored', 'counted', 'expectation_calculated', 'reconciled',
    'variance_flagged', 'variance_resolved', 'banked', 'bank_deposit_voided', 'voided'
  )),
  constraint cash_collection_events_amount_check check (amount_lyd is null or amount_lyd >= 0),
  constraint cash_collection_events_seal_check check (seal_condition is null or seal_condition in ('intact', 'broken', 'mismatch')),
  constraint cash_collection_events_submission_unique unique (client_submission_id)
);

create index if not exists idx_cash_collection_events_collection_date
  on public.cash_collection_events (cash_collection_id, event_at, created_at);
create index if not exists idx_cash_collection_events_actor_team_member
  on public.cash_collection_events (actor_team_member_id) where actor_team_member_id is not null;

create table if not exists public.cash_bank_deposits (
  id uuid primary key default gen_random_uuid(),
  deposited_at timestamptz not null,
  amount_lyd numeric(12,2) not null check (amount_lyd > 0),
  deposit_reference text not null,
  destination_account text not null default 'Snacky bank account',
  receipt_storage_path text not null,
  receipt_file_name text,
  notes text,
  status text not null default 'banked' check (status in ('banked', 'voided')),
  recorded_by uuid references public.team_members(id) on delete set null,
  client_submission_id uuid not null unique,
  voided_at timestamptz,
  voided_by uuid references public.team_members(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cash_bank_deposits_active_reference_uidx
  on public.cash_bank_deposits (lower(trim(deposit_reference)))
  where status = 'banked';
create index if not exists idx_cash_bank_deposits_recorded_by
  on public.cash_bank_deposits (recorded_by) where recorded_by is not null;
create index if not exists idx_cash_bank_deposits_voided_by
  on public.cash_bank_deposits (voided_by) where voided_by is not null;

create table if not exists public.cash_bank_deposit_allocations (
  id uuid primary key default gen_random_uuid(),
  cash_bank_deposit_id uuid not null references public.cash_bank_deposits(id) on delete restrict,
  cash_collection_id uuid not null references public.cash_collections(id) on delete restrict,
  amount_lyd numeric(12,2) not null check (amount_lyd > 0),
  created_at timestamptz not null default now(),
  constraint cash_bank_deposit_allocation_unique unique (cash_bank_deposit_id, cash_collection_id)
);

create index if not exists idx_cash_bank_allocations_collection
  on public.cash_bank_deposit_allocations (cash_collection_id, cash_bank_deposit_id);

-- New cash evidence is private and served only through Snacky OS's authenticated
-- signed-URL endpoint. The browser never receives a service-role key.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Supabase Storage schema unavailable; skipping cash-evidence bucket setup.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'cash-evidence',
    'cash-evidence',
    false,
    10485760,
    array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
  )
  on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = now();
end $$;

-- Financial tables are readable only by financial/custody managers. Operators
-- and warehouse receivers use the amount-free receipt table instead.
alter table public.cash_collections enable row level security;
revoke all on table public.cash_collections from public, anon, authenticated;
grant select on table public.cash_collections to authenticated;
grant all on table public.cash_collections to service_role;

drop policy if exists "snacky_cash_collections_finance_access" on public.cash_collections;
drop policy if exists "snacky_cash_collections_operator_insert_removal" on public.cash_collections;
drop policy if exists "snacky_cash_collections_operator_read_own" on public.cash_collections;
create policy "snacky_cash_collections_finance_read"
on public.cash_collections for select
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

alter table public.cash_collection_machines enable row level security;
revoke all on table public.cash_collection_machines from public, anon, authenticated;
grant select on table public.cash_collection_machines to authenticated;
grant all on table public.cash_collection_machines to service_role;

drop policy if exists "snacky_cash_collection_machines_finance_access" on public.cash_collection_machines;
drop policy if exists "snacky_cash_collection_machines_operator_read_own" on public.cash_collection_machines;
drop policy if exists "snacky_cash_collection_machines_operator_insert_own" on public.cash_collection_machines;
create policy "snacky_cash_collection_machines_manager_read"
on public.cash_collection_machines for select
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

alter table public.cash_removal_receipts enable row level security;
revoke all on table public.cash_removal_receipts from public, anon, authenticated;
grant select on table public.cash_removal_receipts to authenticated;
grant all on table public.cash_removal_receipts to service_role;
create policy "snacky_cash_removal_receipts_read"
on public.cash_removal_receipts for select
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance', 'warehouse']))
  or operator_id = (select public.snacky_current_team_member_id())
);

alter table public.cash_removal_receipt_machines enable row level security;
revoke all on table public.cash_removal_receipt_machines from public, anon, authenticated;
grant select on table public.cash_removal_receipt_machines to authenticated;
grant all on table public.cash_removal_receipt_machines to service_role;
create policy "snacky_cash_removal_receipt_machines_read"
on public.cash_removal_receipt_machines for select
to authenticated
using (
  exists (
    select 1
    from public.cash_removal_receipts receipt
    where receipt.cash_collection_id = cash_removal_receipt_machines.cash_collection_id
      and (
        (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance', 'warehouse']))
        or receipt.operator_id = (select public.snacky_current_team_member_id())
      )
  )
);

alter table public.cash_collection_events enable row level security;
revoke all on table public.cash_collection_events from public, anon, authenticated;
grant select on table public.cash_collection_events to authenticated;
grant all on table public.cash_collection_events to service_role;
create policy "snacky_cash_collection_events_finance_read"
on public.cash_collection_events for select
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

alter table public.cash_bank_deposits enable row level security;
revoke all on table public.cash_bank_deposits from public, anon, authenticated;
grant select on table public.cash_bank_deposits to authenticated;
grant all on table public.cash_bank_deposits to service_role;
create policy "snacky_cash_bank_deposits_finance_read"
on public.cash_bank_deposits for select
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

alter table public.cash_bank_deposit_allocations enable row level security;
revoke all on table public.cash_bank_deposit_allocations from public, anon, authenticated;
grant select on table public.cash_bank_deposit_allocations to authenticated;
grant all on table public.cash_bank_deposit_allocations to service_role;
create policy "snacky_cash_bank_allocations_finance_read"
on public.cash_bank_deposit_allocations for select
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

create or replace function snacky_private.append_cash_collection_event(
  p_collection_id uuid,
  p_event_type text,
  p_event_at timestamptz,
  p_amount_lyd numeric,
  p_seal_condition text,
  p_evidence_path text,
  p_evidence_file_name text,
  p_notes text,
  p_metadata jsonb,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_event_id uuid;
begin
  insert into public.cash_collection_events (
    cash_collection_id,
    event_type,
    event_at,
    actor_user_id,
    actor_team_member_id,
    amount_lyd,
    seal_condition,
    evidence_storage_path,
    evidence_file_name,
    notes,
    metadata,
    client_submission_id
  ) values (
    p_collection_id,
    p_event_type,
    coalesce(p_event_at, now()),
    auth.uid(),
    public.snacky_current_team_member_id(),
    p_amount_lyd,
    p_seal_condition,
    nullif(trim(coalesce(p_evidence_path, '')), ''),
    nullif(trim(coalesce(p_evidence_file_name, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    coalesce(p_metadata, '{}'::jsonb),
    p_client_submission_id
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function snacky_private.append_cash_collection_event(uuid, text, timestamptz, numeric, text, text, text, text, jsonb, uuid) from public, anon, authenticated;

create or replace function snacky_private.record_standalone_cash_removal_impl(
  p_machine_ids uuid[],
  p_removed_at timestamptz,
  p_removal_type text,
  p_cash_bag_id text,
  p_compartments text[],
  p_removal_evidence_path text,
  p_removal_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_collection_id uuid;
  v_machine_ids uuid[];
  v_compartments text[];
  v_collector_id uuid := public.snacky_current_team_member_id();
  v_removed_at timestamptz := coalesce(p_removed_at, now());
  v_bag_id text := upper(nullif(trim(coalesce(p_cash_bag_id, '')), ''));
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance', 'operator']) then
    raise exception 'Not authorized to record cash removal' using errcode = '42501';
  end if;
  if v_collector_id is null then
    raise exception 'Your account must be linked to a team member before handling cash' using errcode = '42501';
  end if;

  if p_client_submission_id is not null then
    select id into v_collection_id
    from public.cash_collections
    where client_submission_id = p_client_submission_id;
    if v_collection_id is not null then
      return v_collection_id;
    end if;
  end if;

  select array_agg(distinct selected.machine_id order by selected.machine_id)
  into v_machine_ids
  from unnest(coalesce(p_machine_ids, array[]::uuid[])) as selected(machine_id);

  select array_agg(distinct lower(trim(selected.compartment)) order by lower(trim(selected.compartment)))
  into v_compartments
  from unnest(coalesce(p_compartments, array[]::text[])) as selected(compartment)
  where nullif(trim(selected.compartment), '') is not null;

  if coalesce(cardinality(v_machine_ids), 0) = 0 then
    raise exception 'Select at least one machine' using errcode = '22023';
  end if;
  if p_removal_type not in ('full', 'partial') then
    raise exception 'Removal type must be full or partial' using errcode = '22023';
  end if;
  if coalesce(cardinality(v_compartments), 0) = 0
     or not (v_compartments <@ array['notes', 'coins', 'recycler', 'change_float']::text[]) then
    raise exception 'Select every cash compartment handled' using errcode = '22023';
  end if;
  if v_bag_id is null then
    raise exception 'A unique tamper-evident bag or seal ID is required' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_removal_evidence_path, '')), '') is null then
    raise exception 'A sealed-bag removal photo is required' using errcode = '22023';
  end if;
  if p_removal_type = 'partial' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Explain what cash remained for a partial removal' using errcode = '22023';
  end if;
  if v_removed_at > now() + interval '10 minutes' then
    raise exception 'Removal time cannot be in the future' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(v_machine_ids) selected(machine_id)
    where not exists (select 1 from public.machines m where m.id = selected.machine_id)
  ) then
    raise exception 'One or more selected machines do not exist' using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.cash_collections cc
    where lower(trim(cc.cash_bag_id)) = lower(v_bag_id)
  ) then
    raise exception 'This bag or seal ID has already been used' using errcode = '23505';
  end if;

  insert into public.cash_collections (
    route_id,
    machine_id,
    operator_id,
    vms_expected_cash,
    actual_cash_collected,
    review_status,
    custody_status,
    reconciliation_status,
    collected_at,
    cash_bag_id,
    notes,
    client_submission_id,
    updated_at
  ) values (
    null,
    case when cardinality(v_machine_ids) = 1 then v_machine_ids[1] else null end,
    v_collector_id,
    null,
    null,
    'collected_pending_count',
    'removed',
    'pending',
    v_removed_at,
    v_bag_id,
    nullif(trim(coalesce(p_notes, '')), ''),
    p_client_submission_id,
    now()
  )
  returning id into v_collection_id;

  insert into public.cash_collection_machines (
    cash_collection_id,
    machine_id,
    removal_type,
    compartments,
    interval_end_at
  )
  select v_collection_id, selected.machine_id, p_removal_type, v_compartments, v_removed_at
  from unnest(v_machine_ids) as selected(machine_id);

  insert into public.cash_removal_receipts (
    cash_collection_id,
    operator_id,
    cash_bag_id,
    collected_at,
    custody_status,
    removal_evidence_path,
    removal_evidence_file_name,
    removal_notes,
    created_at,
    updated_at
  ) values (
    v_collection_id,
    v_collector_id,
    v_bag_id,
    v_removed_at,
    'removed',
    p_removal_evidence_path,
    nullif(trim(coalesce(p_removal_evidence_file_name, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    now(),
    now()
  );

  insert into public.cash_removal_receipt_machines (
    cash_collection_id, machine_id, removal_type, compartments
  )
  select v_collection_id, selected.machine_id, p_removal_type, v_compartments
  from unnest(v_machine_ids) as selected(machine_id);

  perform snacky_private.append_cash_collection_event(
    v_collection_id,
    'removed',
    v_removed_at,
    null,
    'intact',
    p_removal_evidence_path,
    p_removal_evidence_file_name,
    p_notes,
    jsonb_build_object(
      'machine_ids', to_jsonb(v_machine_ids),
      'machine_count', cardinality(v_machine_ids),
      'removal_type', p_removal_type,
      'compartments', to_jsonb(v_compartments),
      'route_id', null,
      'cash_bag_id', v_bag_id
    ),
    p_client_submission_id
  );

  return v_collection_id;
end;
$$;

revoke all on function snacky_private.record_standalone_cash_removal_impl(uuid[], timestamptz, text, text, text[], text, text, text, uuid) from public, anon;
grant execute on function snacky_private.record_standalone_cash_removal_impl(uuid[], timestamptz, text, text, text[], text, text, text, uuid) to authenticated, service_role;

drop function if exists public.record_standalone_cash_removal(uuid[], timestamptz, text, text, text, uuid);
create or replace function public.record_standalone_cash_removal(
  p_machine_ids uuid[],
  p_removed_at timestamptz,
  p_removal_type text,
  p_cash_bag_id text,
  p_compartments text[],
  p_removal_evidence_path text,
  p_removal_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.record_standalone_cash_removal_impl(
    p_machine_ids,
    p_removed_at,
    p_removal_type,
    p_cash_bag_id,
    p_compartments,
    p_removal_evidence_path,
    p_removal_evidence_file_name,
    p_notes,
    p_client_submission_id
  );
$$;

revoke all on function public.record_standalone_cash_removal(uuid[], timestamptz, text, text, text[], text, text, text, uuid) from public, anon;
grant execute on function public.record_standalone_cash_removal(uuid[], timestamptz, text, text, text[], text, text, text, uuid) to authenticated, service_role;

create or replace function snacky_private.receive_cash_into_storage_impl(
  p_collection_id uuid,
  p_received_at timestamptz,
  p_storage_location text,
  p_seal_condition text,
  p_evidence_path text,
  p_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_receiver_id uuid := public.snacky_current_team_member_id();
  v_received_at timestamptz := coalesce(p_received_at, now());
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance', 'warehouse']) then
    raise exception 'Not authorized to receive cash into storage' using errcode = '42501';
  end if;
  if v_receiver_id is null then
    raise exception 'Your account must be linked to a team member before receiving cash' using errcode = '42501';
  end if;

  if p_client_submission_id is not null and exists (
    select 1 from public.cash_collection_events where client_submission_id = p_client_submission_id
  ) then
    if exists (
      select 1 from public.cash_collection_events
      where client_submission_id = p_client_submission_id
        and cash_collection_id = p_collection_id
        and event_type = 'stored'
    ) then
      return p_collection_id;
    end if;
    raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status <> 'removed' then
    raise exception 'Only a removed bag can be received into storage' using errcode = '23514';
  end if;
  if v_cash.operator_id = v_receiver_id then
    raise exception 'The collector cannot acknowledge their own storage handoff' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_storage_location, '')), '') is null then
    raise exception 'Storage or safe location is required' using errcode = '22023';
  end if;
  if p_seal_condition not in ('intact', 'broken', 'mismatch') then
    raise exception 'Record whether the bag seal is intact, broken, or mismatched' using errcode = '22023';
  end if;
  if p_seal_condition <> 'intact' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Explain every broken or mismatched seal' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_evidence_path, '')), '') is null then
    raise exception 'A storage handoff photo is required' using errcode = '22023';
  end if;
  if v_received_at < v_cash.collected_at or v_received_at > now() + interval '10 minutes' then
    raise exception 'Storage receipt time must be after removal and cannot be in the future' using errcode = '22023';
  end if;

  update public.cash_collections
  set custody_status = 'in_storage',
      storage_received_at = v_received_at,
      storage_received_by = v_receiver_id,
      storage_location = trim(p_storage_location),
      storage_seal_condition = p_seal_condition,
      storage_notes = nullif(trim(coalesce(p_notes, '')), ''),
      updated_at = now()
  where id = p_collection_id;

  update public.cash_removal_receipts
  set custody_status = 'in_storage',
      storage_received_at = v_received_at,
      storage_received_by = v_receiver_id,
      storage_location = trim(p_storage_location),
      updated_at = now()
  where cash_collection_id = p_collection_id;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'stored',
    v_received_at,
    null,
    p_seal_condition,
    p_evidence_path,
    p_evidence_file_name,
    p_notes,
    jsonb_build_object('storage_location', trim(p_storage_location), 'cash_bag_id', v_cash.cash_bag_id),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.receive_cash_into_storage_impl(uuid, timestamptz, text, text, text, text, text, uuid) from public, anon;
grant execute on function snacky_private.receive_cash_into_storage_impl(uuid, timestamptz, text, text, text, text, text, uuid) to authenticated, service_role;

create or replace function public.receive_cash_into_storage(
  p_collection_id uuid,
  p_received_at timestamptz,
  p_storage_location text,
  p_seal_condition text,
  p_evidence_path text,
  p_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.receive_cash_into_storage_impl(
    p_collection_id, p_received_at, p_storage_location, p_seal_condition,
    p_evidence_path, p_evidence_file_name, p_notes, p_client_submission_id
  );
$$;

revoke all on function public.receive_cash_into_storage(uuid, timestamptz, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.receive_cash_into_storage(uuid, timestamptz, text, text, text, text, text, uuid) to authenticated, service_role;

create or replace function snacky_private.confirm_cash_count_impl(
  p_collection_id uuid,
  p_counted_at timestamptz,
  p_seal_condition text,
  p_count_witness_id uuid,
  p_denominations jsonb,
  p_other_amount_lyd numeric,
  p_evidence_path text,
  p_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_counter_id uuid := public.snacky_current_team_member_id();
  v_counted_at timestamptz := coalesce(p_counted_at, now());
  v_denominations jsonb := coalesce(p_denominations, '{}'::jsonb);
  v_other numeric(12,2) := round(coalesce(p_other_amount_lyd, 0)::numeric, 2);
  v_total numeric(12,2);
  v_invalid_line boolean;
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can count stored cash' using errcode = '42501';
  end if;
  if v_counter_id is null then
    raise exception 'Your account must be linked to a team member before counting cash' using errcode = '42501';
  end if;

  if p_client_submission_id is not null and exists (
    select 1 from public.cash_collection_events where client_submission_id = p_client_submission_id
  ) then
    if exists (
      select 1 from public.cash_collection_events
      where client_submission_id = p_client_submission_id
        and cash_collection_id = p_collection_id
        and event_type = 'counted'
    ) then
      return p_collection_id;
    end if;
    raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status <> 'in_storage' then
    raise exception 'Cash must be received into storage before it can be counted' using errcode = '23514';
  end if;
  if p_seal_condition not in ('intact', 'broken', 'mismatch') then
    raise exception 'Record the seal condition before opening the bag' using errcode = '22023';
  end if;
  if p_seal_condition <> 'intact' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Explain every broken or mismatched seal' using errcode = '22023';
  end if;
  if p_count_witness_id is null then
    raise exception 'A second person must witness every cash count' using errcode = '22023';
  end if;
  if p_count_witness_id = v_counter_id then
    raise exception 'The person counting cash cannot also be the count witness' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.team_members witness
    where witness.id = p_count_witness_id
      and coalesce(
        witness.active_status = 'active',
        case when witness.active is false then false else true end
      )
  ) then
    raise exception 'Select an active team member as the count witness' using errcode = '23503';
  end if;
  if nullif(trim(coalesce(p_evidence_path, '')), '') is null then
    raise exception 'A count sheet or count photo is required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_denominations) <> 'object' then
    raise exception 'Denominations must be a JSON object' using errcode = '22023';
  end if;
  if v_other < 0 then
    raise exception 'Other counted cash cannot be negative' using errcode = '22023';
  end if;
  if v_counted_at < v_cash.storage_received_at or v_counted_at > now() + interval '10 minutes' then
    raise exception 'Count time must be after storage receipt and cannot be in the future' using errcode = '22023';
  end if;

  select coalesce(bool_or(
    key !~ '^[0-9]+([.][0-9]+)?$'
    or value !~ '^[0-9]+$'
    or case when key ~ '^[0-9]+([.][0-9]+)?$' then key::numeric <= 0 else true end
    or key not in ('0.25', '0.5', '1', '5', '10', '20', '50')
  ), false)
  into v_invalid_line
  from jsonb_each_text(v_denominations);

  if v_invalid_line then
    raise exception 'Every denomination and quantity must be a non-negative number' using errcode = '22023';
  end if;

  select round(coalesce(sum(key::numeric * value::integer), 0) + v_other, 2)
  into v_total
  from jsonb_each_text(v_denominations)
  where value::integer > 0;

  if v_total = 0 and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Explain why an emptied cash bag counted as zero' using errcode = '22023';
  end if;
  if v_other > 0 and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Explain every amount entered outside the standard denomination list' using errcode = '22023';
  end if;

  update public.cash_collections
  set actual_cash_collected = v_total,
      counted_at = v_counted_at,
      counted_by = v_counter_id,
      count_seal_condition = p_seal_condition,
      count_witnessed_by = p_count_witness_id,
      count_denominations = v_denominations,
      count_other_amount_lyd = v_other,
      custody_status = 'counted',
      review_status = 'counted_pending_reconciliation',
      reconciliation_status = 'pending',
      updated_at = now()
  where id = p_collection_id;

  update public.cash_removal_receipts
  set custody_status = 'counted', updated_at = now()
  where cash_collection_id = p_collection_id;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'counted',
    v_counted_at,
    v_total,
    p_seal_condition,
    p_evidence_path,
    p_evidence_file_name,
    p_notes,
    jsonb_build_object('denominations', v_denominations, 'other_amount_lyd', v_other, 'witness_team_member_id', p_count_witness_id),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.confirm_cash_count_impl(uuid, timestamptz, text, uuid, jsonb, numeric, text, text, text, uuid) from public, anon;
grant execute on function snacky_private.confirm_cash_count_impl(uuid, timestamptz, text, uuid, jsonb, numeric, text, text, text, uuid) to authenticated, service_role;

create or replace function public.confirm_cash_count(
  p_collection_id uuid,
  p_counted_at timestamptz,
  p_seal_condition text,
  p_count_witness_id uuid,
  p_denominations jsonb,
  p_other_amount_lyd numeric,
  p_evidence_path text,
  p_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.confirm_cash_count_impl(
    p_collection_id, p_counted_at, p_seal_condition, p_count_witness_id, p_denominations,
    p_other_amount_lyd, p_evidence_path, p_evidence_file_name, p_notes,
    p_client_submission_id
  );
$$;

revoke all on function public.confirm_cash_count(uuid, timestamptz, text, uuid, jsonb, numeric, text, text, text, uuid) from public, anon;
grant execute on function public.confirm_cash_count(uuid, timestamptz, text, uuid, jsonb, numeric, text, text, text, uuid) to authenticated, service_role;

create or replace function snacky_private.calculate_cash_expectation_impl(
  p_collection_id uuid,
  p_client_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_actor_id uuid := public.snacky_current_team_member_id();
  v_link record;
  v_interval_start timestamptz;
  v_row_count integer;
  v_cash_count integer;
  v_card_count integer;
  v_unknown_count integer;
  v_cash_amount numeric(12,2);
  v_total_amount numeric(12,2);
  v_expected numeric(12,2);
  v_status text;
  v_source text;
  v_all_ready boolean := true;
  v_any_assumption boolean := false;
  v_total_expected numeric(12,2) := 0;
  v_result jsonb;
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can calculate cash expectation' using errcode = '42501';
  end if;
  if v_actor_id is null then
    raise exception 'Your account must be linked to a team member' using errcode = '42501';
  end if;

  if p_client_submission_id is not null then
    select metadata into v_result
    from public.cash_collection_events
    where client_submission_id = p_client_submission_id
      and cash_collection_id = p_collection_id
      and event_type = 'expectation_calculated';
    if found then
      return v_result;
    end if;
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status not in ('counted', 'reconciled') then
    raise exception 'Count the stored cash before calculating expectation' using errcode = '23514';
  end if;

  for v_link in
    select ccm.id, ccm.machine_id, ccm.removal_type, ccm.interval_end_at
    from public.cash_collection_machines ccm
    where ccm.cash_collection_id = p_collection_id
    order by ccm.machine_id
    for update
  loop
    v_interval_start := null;
    v_expected := null;
    v_status := 'pending';
    v_source := null;
    v_row_count := 0;
    v_cash_count := 0;
    v_card_count := 0;
    v_unknown_count := 0;
    v_cash_amount := 0;
    v_total_amount := 0;

    if v_link.removal_type = 'partial' then
      v_status := 'partial_removal';
      v_all_ready := false;
    else
      select max(previous_cash.collected_at)
      into v_interval_start
      from public.cash_collection_machines previous_link
      join public.cash_collections previous_cash on previous_cash.id = previous_link.cash_collection_id
      where previous_link.machine_id = v_link.machine_id
        and previous_link.removal_type = 'full'
        and previous_cash.id <> p_collection_id
        and previous_cash.collected_at < v_cash.collected_at
        and previous_cash.custody_status in ('reconciled', 'banked')
        and previous_cash.review_status <> 'voided';

      if v_interval_start is null then
        v_status := 'missing_start';
        v_all_ready := false;
      else
        with ranked_transactions as (
          select
            greatest(coalesce(tx.payment_amount, 0), 0)::numeric(12,2) as payment_amount,
            public.snacky_vms_normalize_payment_method(tx.raw_row, tx.normalized_row) as payment_method,
            row_number() over (
              partition by coalesce(
                nullif(trim(tx.third_party_transaction_number), ''),
                nullif(concat_ws('|', nullif(trim(tx.machine_code), ''), nullif(trim(tx.order_number), '')), '|'),
                nullif(trim(tx.duplicate_hash), ''),
                tx.id::text
              )
              order by coalesce(batch.imported_at, batch.updated_at, batch.created_at) desc, tx.created_at desc, tx.id desc
            ) as duplicate_rank
          from public.vms_transactions_raw tx
          join public.vms_import_batches batch on batch.id = tx.import_batch_id
          where tx.mapped_machine_id = v_link.machine_id
            and tx.transaction_status = 'successful_sale'
            and coalesce(tx.payment_time, tx.delivery_time) > v_interval_start
            and coalesce(tx.payment_time, tx.delivery_time) <= coalesce(v_link.interval_end_at, v_cash.collected_at)
            and batch.status in ('imported', 'imported_with_warnings', 'partially_imported')
            and batch.deleted_at is null
        )
        select
          count(*)::integer,
          count(*) filter (where payment_method = 'cash')::integer,
          count(*) filter (where payment_method = 'card')::integer,
          count(*) filter (where payment_method not in ('cash', 'card'))::integer,
          coalesce(sum(payment_amount) filter (where payment_method = 'cash'), 0)::numeric(12,2),
          coalesce(sum(payment_amount), 0)::numeric(12,2)
        into v_row_count, v_cash_count, v_card_count, v_unknown_count, v_cash_amount, v_total_amount
        from ranked_transactions
        where duplicate_rank = 1;

        if v_row_count = 0 then
          v_status := 'no_exact_vms_data';
          v_all_ready := false;
        elsif v_unknown_count > 0 and (v_cash_count > 0 or v_card_count > 0) then
          v_status := 'payment_split_incomplete';
          v_all_ready := false;
        elsif v_unknown_count = v_row_count then
          v_expected := v_total_amount;
          v_status := 'ready_cash_only_assumption';
          v_source := 'vms_total_cash_assumption';
          v_any_assumption := true;
          v_total_expected := v_total_expected + v_expected;
        else
          v_expected := v_cash_amount;
          v_status := 'ready_exact';
          v_source := 'vms_exact_cash_transactions';
          v_total_expected := v_total_expected + v_expected;
        end if;
      end if;
    end if;

    update public.cash_collection_machines
    set interval_start_at = v_interval_start,
        interval_end_at = coalesce(v_link.interval_end_at, v_cash.collected_at),
        expected_cash_lyd = v_expected,
        vms_sales_count = case when v_status in ('ready_exact', 'ready_cash_only_assumption') then v_row_count else null end,
        expectation_status = v_status,
        expectation_source = v_source,
        expectation_metadata = jsonb_build_object(
          'cash_rows', v_cash_count,
          'card_rows', v_card_count,
          'unknown_payment_rows', v_unknown_count,
          'deduplicated_successful_rows', v_row_count,
          'cash_amount_lyd', v_cash_amount,
          'total_amount_lyd', v_total_amount
        )
    where id = v_link.id;
  end loop;

  if not exists (
    select 1 from public.cash_collection_machines where cash_collection_id = p_collection_id
  ) then
    raise exception 'Cash collection has no linked machines' using errcode = '23514';
  end if;

  update public.cash_collections
  set vms_expected_cash = case when v_all_ready then round(v_total_expected, 2) else null end,
      expected_source = case
        when not v_all_ready then 'manual_required'
        when v_any_assumption then 'vms_cash_only_assumption'
        else 'vms_exact'
      end,
      expected_calculated_at = now(),
      expected_calculated_by = v_actor_id,
      updated_at = now()
  where id = p_collection_id;

  select jsonb_build_object(
    'cash_collection_id', p_collection_id,
    'ready', v_all_ready,
    'expected_cash_lyd', case when v_all_ready then round(v_total_expected, 2) else null end,
    'source', case
      when not v_all_ready then 'manual_required'
      when v_any_assumption then 'vms_cash_only_assumption'
      else 'vms_exact'
    end,
    'machines', coalesce(jsonb_agg(jsonb_build_object(
      'machine_id', ccm.machine_id,
      'status', ccm.expectation_status,
      'source', ccm.expectation_source,
      'interval_start_at', ccm.interval_start_at,
      'interval_end_at', ccm.interval_end_at,
      'expected_cash_lyd', ccm.expected_cash_lyd,
      'vms_sales_count', ccm.vms_sales_count
    ) order by ccm.machine_id), '[]'::jsonb)
  )
  into v_result
  from public.cash_collection_machines ccm
  where ccm.cash_collection_id = p_collection_id;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'expectation_calculated',
    now(),
    case when v_all_ready then round(v_total_expected, 2) else null end,
    null,
    null,
    null,
    null,
    v_result,
    p_client_submission_id
  );

  return v_result;
end;
$$;

revoke all on function snacky_private.calculate_cash_expectation_impl(uuid, uuid) from public, anon;
grant execute on function snacky_private.calculate_cash_expectation_impl(uuid, uuid) to authenticated, service_role;

create or replace function public.calculate_cash_collection_expectation(
  p_collection_id uuid,
  p_client_submission_id uuid
)
returns jsonb
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.calculate_cash_expectation_impl(p_collection_id, p_client_submission_id);
$$;

revoke all on function public.calculate_cash_collection_expectation(uuid, uuid) from public, anon;
grant execute on function public.calculate_cash_collection_expectation(uuid, uuid) to authenticated, service_role;

create or replace function snacky_private.reconcile_cash_collection_impl(
  p_collection_id uuid,
  p_manual_expected_cash_lyd numeric,
  p_override_reason text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_actor_id uuid := public.snacky_current_team_member_id();
  v_variance numeric(12,2);
  v_requires_review boolean;
  v_event_type text;
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can reconcile counted cash' using errcode = '42501';
  end if;
  if v_actor_id is null then
    raise exception 'Your account must be linked to a team member' using errcode = '42501';
  end if;
  if p_client_submission_id is not null and exists (
    select 1 from public.cash_collection_events where client_submission_id = p_client_submission_id
  ) then
    if exists (
      select 1 from public.cash_collection_events
      where client_submission_id = p_client_submission_id
        and cash_collection_id = p_collection_id
        and event_type in ('reconciled', 'variance_flagged')
    ) then
      return p_collection_id;
    end if;
    raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status <> 'counted' or v_cash.actual_cash_collected is null then
    raise exception 'Cash must be stored and counted before reconciliation' using errcode = '23514';
  end if;

  if p_manual_expected_cash_lyd is not null then
    if p_manual_expected_cash_lyd < 0 then
      raise exception 'Manual expected cash cannot be negative' using errcode = '22023';
    end if;
    if nullif(trim(coalesce(p_override_reason, '')), '') is null then
      raise exception 'A reason and source are required for a manual VMS expectation' using errcode = '22023';
    end if;

    update public.cash_collection_machines
    set expected_cash_lyd = null,
        expectation_status = 'manual_override',
        expectation_source = 'manual_batch_total',
        expectation_metadata = expectation_metadata || jsonb_build_object(
          'manual_batch_total_lyd', round(p_manual_expected_cash_lyd, 2),
          'override_reason', trim(p_override_reason)
        )
    where cash_collection_id = p_collection_id;

    update public.cash_collections
    set vms_expected_cash = round(p_manual_expected_cash_lyd, 2),
        expected_source = 'manual_override',
        expected_calculated_at = now(),
        expected_calculated_by = v_actor_id,
        reconciliation_note = concat_ws(' | ', nullif(trim(coalesce(p_notes, '')), ''), 'Expected override: ' || trim(p_override_reason)),
        updated_at = now()
    where id = p_collection_id;
  else
    perform snacky_private.calculate_cash_expectation_impl(p_collection_id, null);
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if v_cash.vms_expected_cash is null then
    raise exception 'Exact VMS expectation is unavailable. Enter the verified combined VMS total and its source.' using errcode = '23514';
  end if;

  v_variance := round(v_cash.actual_cash_collected - v_cash.vms_expected_cash, 2);
  v_requires_review :=
    abs(v_variance) >= 10
    or coalesce(v_cash.storage_seal_condition, 'missing') <> 'intact'
    or coalesce(v_cash.count_seal_condition, 'missing') <> 'intact'
    or coalesce(v_cash.expected_source, '') in ('manual_override', 'vms_cash_only_assumption', 'manual_required');

  if v_requires_review then
    update public.cash_collections
    set reconciliation_status = 'variance_review',
        review_status = 'variance_review',
        reconciliation_note = concat_ws(' | ', reconciliation_note, nullif(trim(coalesce(p_notes, '')), '')),
        updated_at = now()
    where id = p_collection_id;
    v_event_type := 'variance_flagged';
  else
    update public.cash_collections
    set custody_status = 'reconciled',
        reconciliation_status = 'matched',
        review_status = 'counted_confirmed',
        reconciled_at = now(),
        reconciled_by = v_actor_id,
        reconciliation_note = nullif(trim(coalesce(p_notes, '')), ''),
        updated_at = now()
    where id = p_collection_id;

    update public.cash_removal_receipts
    set custody_status = 'reconciled', updated_at = now()
    where cash_collection_id = p_collection_id;
    v_event_type := 'reconciled';
  end if;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    v_event_type,
    now(),
    v_cash.vms_expected_cash,
    null,
    null,
    null,
    p_notes,
    jsonb_build_object(
      'actual_cash_lyd', v_cash.actual_cash_collected,
      'expected_cash_lyd', v_cash.vms_expected_cash,
      'variance_lyd', v_variance,
      'expected_source', v_cash.expected_source,
      'requires_owner_review', v_requires_review,
      'override_reason', nullif(trim(coalesce(p_override_reason, '')), '')
    ),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.reconcile_cash_collection_impl(uuid, numeric, text, text, uuid) from public, anon;
grant execute on function snacky_private.reconcile_cash_collection_impl(uuid, numeric, text, text, uuid) to authenticated, service_role;

create or replace function public.reconcile_cash_collection(
  p_collection_id uuid,
  p_manual_expected_cash_lyd numeric,
  p_override_reason text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.reconcile_cash_collection_impl(
    p_collection_id, p_manual_expected_cash_lyd, p_override_reason, p_notes, p_client_submission_id
  );
$$;

revoke all on function public.reconcile_cash_collection(uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.reconcile_cash_collection(uuid, numeric, text, text, uuid) to authenticated, service_role;

create or replace function snacky_private.resolve_cash_variance_impl(
  p_collection_id uuid,
  p_resolution text,
  p_reason text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_actor_id uuid := public.snacky_current_team_member_id();
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only owner or admin can resolve a cash variance or evidence exception' using errcode = '42501';
  end if;
  if v_actor_id is null then
    raise exception 'Your account must be linked to a team member' using errcode = '42501';
  end if;
  if p_client_submission_id is not null and exists (
    select 1 from public.cash_collection_events where client_submission_id = p_client_submission_id
  ) then
    if exists (
      select 1 from public.cash_collection_events
      where client_submission_id = p_client_submission_id
        and cash_collection_id = p_collection_id
        and event_type = 'variance_resolved'
    ) then
      return p_collection_id;
    end if;
    raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
  end if;
  if p_resolution not in (
    'counting_error', 'vms_timing', 'cash_left_in_machine', 'vms_data_gap',
    'documented_business_use', 'custody_loss', 'other'
  ) then
    raise exception 'Choose a valid variance resolution' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A detailed variance resolution is required' using errcode = '22023';
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status <> 'counted' or v_cash.reconciliation_status <> 'variance_review' then
    raise exception 'This collection is not awaiting variance resolution' using errcode = '23514';
  end if;

  update public.cash_collections
  set custody_status = 'reconciled',
      reconciliation_status = 'resolved',
      review_status = 'counted_confirmed',
      reconciled_at = now(),
      reconciled_by = v_actor_id,
      variance_resolution = p_resolution,
      reconciliation_note = concat_ws(' | ', reconciliation_note, trim(p_reason)),
      updated_at = now()
  where id = p_collection_id;

  update public.cash_removal_receipts
  set custody_status = 'reconciled', updated_at = now()
  where cash_collection_id = p_collection_id;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'variance_resolved',
    now(),
    v_cash.vms_expected_cash,
    null,
    null,
    null,
    p_reason,
    jsonb_build_object(
      'resolution', p_resolution,
      'actual_cash_lyd', v_cash.actual_cash_collected,
      'expected_cash_lyd', v_cash.vms_expected_cash,
      'variance_lyd', v_cash.actual_cash_collected - v_cash.vms_expected_cash
    ),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.resolve_cash_variance_impl(uuid, text, text, uuid) from public, anon;
grant execute on function snacky_private.resolve_cash_variance_impl(uuid, text, text, uuid) to authenticated, service_role;

create or replace function public.resolve_cash_variance(
  p_collection_id uuid,
  p_resolution text,
  p_reason text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.resolve_cash_variance_impl(p_collection_id, p_resolution, p_reason, p_client_submission_id);
$$;

revoke all on function public.resolve_cash_variance(uuid, text, text, uuid) from public, anon;
grant execute on function public.resolve_cash_variance(uuid, text, text, uuid) to authenticated, service_role;

create or replace function snacky_private.record_cash_bank_deposit_impl(
  p_collection_ids uuid[],
  p_deposited_at timestamptz,
  p_amount_lyd numeric,
  p_deposit_reference text,
  p_destination_account text,
  p_receipt_storage_path text,
  p_receipt_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_deposit_id uuid;
  v_collection_ids uuid[];
  v_actor_id uuid := public.snacky_current_team_member_id();
  v_expected_count integer;
  v_ready_count integer;
  v_outstanding numeric(12,2);
  v_collection_id uuid;
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can record a bank deposit' using errcode = '42501';
  end if;
  if v_actor_id is null then
    raise exception 'Your account must be linked to a team member' using errcode = '42501';
  end if;

  if p_client_submission_id is null then
    raise exception 'Deposit submission ID is required' using errcode = '22023';
  end if;
  select id into v_deposit_id
  from public.cash_bank_deposits
  where client_submission_id = p_client_submission_id;
  if found then
    return v_deposit_id;
  end if;

  select array_agg(distinct selected.collection_id order by selected.collection_id)
  into v_collection_ids
  from unnest(coalesce(p_collection_ids, array[]::uuid[])) selected(collection_id);
  v_expected_count := coalesce(cardinality(v_collection_ids), 0);

  if v_expected_count = 0 then
    raise exception 'Select at least one reconciled cash batch' using errcode = '22023';
  end if;
  if p_amount_lyd is null or p_amount_lyd <= 0 then
    raise exception 'Bank deposit amount must be greater than zero' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_deposit_reference, '')), '') is null then
    raise exception 'Bank deposit reference is required' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_receipt_storage_path, '')), '') is null then
    raise exception 'Bank deposit receipt is required' using errcode = '22023';
  end if;
  if coalesce(p_deposited_at, now()) > now() + interval '10 minutes' then
    raise exception 'Bank deposit time cannot be in the future' using errcode = '22023';
  end if;

  perform 1
  from public.cash_collections cc
  where cc.id = any(v_collection_ids)
  order by cc.id
  for update;

  select
    count(*) filter (
      where custody_status = 'reconciled'
        and review_status <> 'voided'
        and actual_cash_collected is not null
        and actual_cash_collected - banked_amount_lyd > 0
        and coalesce(p_deposited_at, now()) >= reconciled_at
    )::integer,
    round(coalesce(sum(actual_cash_collected - banked_amount_lyd), 0), 2)
  into v_ready_count, v_outstanding
  from public.cash_collections
  where id = any(v_collection_ids);

  if v_ready_count <> v_expected_count then
    raise exception 'Every selected batch must be reconciled, unvoided, not previously banked, and reconciled before the deposit time' using errcode = '23514';
  end if;
  if abs(v_outstanding - round(p_amount_lyd, 2)) > 0.01 then
    raise exception 'Deposit amount must equal the selected batches total of % LYD', v_outstanding using errcode = '23514';
  end if;

  insert into public.cash_bank_deposits (
    deposited_at,
    amount_lyd,
    deposit_reference,
    destination_account,
    receipt_storage_path,
    receipt_file_name,
    notes,
    recorded_by,
    client_submission_id,
    created_at,
    updated_at
  ) values (
    coalesce(p_deposited_at, now()),
    round(p_amount_lyd, 2),
    trim(p_deposit_reference),
    coalesce(nullif(trim(coalesce(p_destination_account, '')), ''), 'Snacky bank account'),
    trim(p_receipt_storage_path),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_actor_id,
    p_client_submission_id,
    now(),
    now()
  )
  returning id into v_deposit_id;

  insert into public.cash_bank_deposit_allocations (
    cash_bank_deposit_id, cash_collection_id, amount_lyd
  )
  select v_deposit_id, cc.id, round(cc.actual_cash_collected - cc.banked_amount_lyd, 2)
  from public.cash_collections cc
  where cc.id = any(v_collection_ids);

  update public.cash_collections
  set banked_amount_lyd = actual_cash_collected,
      custody_status = 'banked',
      updated_at = now()
  where id = any(v_collection_ids);

  update public.cash_removal_receipts
  set custody_status = 'banked', updated_at = now()
  where cash_collection_id = any(v_collection_ids);

  foreach v_collection_id in array v_collection_ids
  loop
    perform snacky_private.append_cash_collection_event(
      v_collection_id,
      'banked',
      coalesce(p_deposited_at, now()),
      (
        select allocation.amount_lyd
        from public.cash_bank_deposit_allocations allocation
        where allocation.cash_bank_deposit_id = v_deposit_id
          and allocation.cash_collection_id = v_collection_id
      ),
      null,
      p_receipt_storage_path,
      p_receipt_file_name,
      p_notes,
      jsonb_build_object(
        'cash_bank_deposit_id', v_deposit_id,
        'deposit_reference', trim(p_deposit_reference),
        'destination_account', coalesce(nullif(trim(coalesce(p_destination_account, '')), ''), 'Snacky bank account')
      ),
      null
    );
  end loop;

  return v_deposit_id;
end;
$$;

revoke all on function snacky_private.record_cash_bank_deposit_impl(uuid[], timestamptz, numeric, text, text, text, text, text, uuid) from public, anon;
grant execute on function snacky_private.record_cash_bank_deposit_impl(uuid[], timestamptz, numeric, text, text, text, text, text, uuid) to authenticated, service_role;

create or replace function public.record_cash_bank_deposit(
  p_collection_ids uuid[],
  p_deposited_at timestamptz,
  p_amount_lyd numeric,
  p_deposit_reference text,
  p_destination_account text,
  p_receipt_storage_path text,
  p_receipt_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.record_cash_bank_deposit_impl(
    p_collection_ids, p_deposited_at, p_amount_lyd, p_deposit_reference,
    p_destination_account, p_receipt_storage_path, p_receipt_file_name,
    p_notes, p_client_submission_id
  );
$$;

revoke all on function public.record_cash_bank_deposit(uuid[], timestamptz, numeric, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.record_cash_bank_deposit(uuid[], timestamptz, numeric, text, text, text, text, text, uuid) to authenticated, service_role;

create or replace function snacky_private.void_cash_bank_deposit_impl(
  p_deposit_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_deposit public.cash_bank_deposits%rowtype;
  v_actor_id uuid := public.snacky_current_team_member_id();
  v_allocation record;
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only owner or admin can void a bank deposit' using errcode = '42501';
  end if;
  if v_actor_id is null then
    raise exception 'Your account must be linked to a team member' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to void a bank deposit' using errcode = '22023';
  end if;

  select * into v_deposit
  from public.cash_bank_deposits
  where id = p_deposit_id
  for update;

  if not found then
    raise exception 'Bank deposit not found' using errcode = 'P0002';
  end if;
  if v_deposit.status = 'voided' then
    return p_deposit_id;
  end if;

  perform 1
  from public.cash_collections cc
  join public.cash_bank_deposit_allocations allocation on allocation.cash_collection_id = cc.id
  where allocation.cash_bank_deposit_id = p_deposit_id
  order by cc.id
  for update of cc;

  for v_allocation in
    select cash_collection_id, amount_lyd
    from public.cash_bank_deposit_allocations
    where cash_bank_deposit_id = p_deposit_id
  loop
    update public.cash_collections
    set banked_amount_lyd = greatest(banked_amount_lyd - v_allocation.amount_lyd, 0),
        custody_status = case when greatest(banked_amount_lyd - v_allocation.amount_lyd, 0) = 0 then 'reconciled' else custody_status end,
        updated_at = now()
    where id = v_allocation.cash_collection_id;

    update public.cash_removal_receipts
    set custody_status = 'reconciled', updated_at = now()
    where cash_collection_id = v_allocation.cash_collection_id;

    perform snacky_private.append_cash_collection_event(
      v_allocation.cash_collection_id,
      'bank_deposit_voided',
      now(),
      v_allocation.amount_lyd,
      null,
      null,
      null,
      p_reason,
      jsonb_build_object('cash_bank_deposit_id', p_deposit_id, 'deposit_reference', v_deposit.deposit_reference),
      null
    );
  end loop;

  update public.cash_bank_deposits
  set status = 'voided',
      voided_at = now(),
      voided_by = v_actor_id,
      void_reason = trim(p_reason),
      updated_at = now()
  where id = p_deposit_id;

  return p_deposit_id;
end;
$$;

revoke all on function snacky_private.void_cash_bank_deposit_impl(uuid, text) from public, anon;
grant execute on function snacky_private.void_cash_bank_deposit_impl(uuid, text) to authenticated, service_role;

create or replace function public.void_cash_bank_deposit(p_deposit_id uuid, p_reason text)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.void_cash_bank_deposit_impl(p_deposit_id, p_reason);
$$;

revoke all on function public.void_cash_bank_deposit(uuid, text) from public, anon;
grant execute on function public.void_cash_bank_deposit(uuid, text) to authenticated, service_role;

create or replace function snacky_private.void_cash_collection_impl(
  p_collection_id uuid,
  p_reason text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_actor_id uuid := public.snacky_current_team_member_id();
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only owner or admin can void cash custody records' using errcode = '42501';
  end if;
  if v_actor_id is null then
    raise exception 'Your account must be linked to a team member' using errcode = '42501';
  end if;
  if p_client_submission_id is not null and exists (
    select 1 from public.cash_collection_events where client_submission_id = p_client_submission_id
  ) then
    if exists (
      select 1 from public.cash_collection_events
      where client_submission_id = p_client_submission_id
        and cash_collection_id = p_collection_id
        and event_type = 'voided'
    ) then
      return p_collection_id;
    end if;
    raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to void a cash batch' using errcode = '22023';
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.review_status = 'voided' then
    return p_collection_id;
  end if;
  if coalesce(v_cash.banked_amount_lyd, 0) > 0 then
    raise exception 'Void the linked bank deposit before voiding this cash batch' using errcode = '23514';
  end if;

  update public.cash_collections
  set review_status = 'voided',
      custody_status = 'voided',
      reconciliation_status = 'voided',
      voided_at = now(),
      voided_by = v_actor_id,
      void_reason = trim(p_reason),
      updated_at = now()
  where id = p_collection_id;

  update public.cash_removal_receipts
  set custody_status = 'voided', updated_at = now()
  where cash_collection_id = p_collection_id;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'voided',
    now(),
    v_cash.actual_cash_collected,
    null,
    null,
    null,
    p_reason,
    jsonb_build_object('previous_custody_status', v_cash.custody_status),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.void_cash_collection_impl(uuid, text, uuid) from public, anon;
grant execute on function snacky_private.void_cash_collection_impl(uuid, text, uuid) to authenticated, service_role;

create or replace function public.void_cash_collection(
  p_collection_id uuid,
  p_reason text,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.void_cash_collection_impl(p_collection_id, p_reason, p_client_submission_id);
$$;

revoke all on function public.void_cash_collection(uuid, text, uuid) from public, anon;
grant execute on function public.void_cash_collection(uuid, text, uuid) to authenticated, service_role;

-- Historical finance triggers stay in place. New count/reconcile/bank updates
-- therefore preserve the existing exactly-one cash revenue transaction contract.
select pg_notify('pgrst', 'reload schema');
