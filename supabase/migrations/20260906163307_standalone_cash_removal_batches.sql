-- Cash removal is an auditable operation of its own. It may cover one or
-- several machines, does not require a route, and can be counted later as one
-- physical bag/envelope total.

alter table public.cash_collections
  alter column machine_id drop not null,
  add column if not exists client_submission_id uuid;

create unique index if not exists cash_collections_client_submission_id_uidx
  on public.cash_collections (client_submission_id)
  where client_submission_id is not null;

alter table public.cash_collections enable row level security;
revoke all on table public.cash_collections from public, anon, authenticated;
grant select, insert, update, delete on table public.cash_collections to authenticated;
grant all on table public.cash_collections to service_role;

drop policy if exists "snacky_cash_collections_finance_access" on public.cash_collections;
create policy "snacky_cash_collections_finance_access"
on public.cash_collections for all
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])))
with check ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

create table if not exists public.cash_collection_machines (
  id uuid primary key default gen_random_uuid(),
  cash_collection_id uuid not null references public.cash_collections(id) on delete cascade,
  machine_id uuid not null references public.machines(id) on delete restrict,
  removal_type text not null default 'full',
  created_at timestamptz not null default now(),
  constraint cash_collection_machines_removal_type_check
    check (removal_type in ('full', 'partial')),
  constraint cash_collection_machines_collection_machine_unique
    unique (cash_collection_id, machine_id)
);

create index if not exists idx_cash_collection_machines_machine
  on public.cash_collection_machines (machine_id, cash_collection_id);

-- Every historical one-machine collection remains visible through the new
-- relation. Historical route links are preserved for audit only.
insert into public.cash_collection_machines (cash_collection_id, machine_id, removal_type)
select id, machine_id, 'full'
from public.cash_collections
where machine_id is not null
on conflict (cash_collection_id, machine_id) do nothing;

alter table public.cash_collection_machines enable row level security;
revoke all on table public.cash_collection_machines from public, anon, authenticated;
grant select, insert, update, delete on table public.cash_collection_machines to authenticated;
grant all on table public.cash_collection_machines to service_role;

drop policy if exists "snacky_cash_collection_machines_finance_access" on public.cash_collection_machines;
create policy "snacky_cash_collection_machines_finance_access"
on public.cash_collection_machines for all
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])))
with check ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])));

drop policy if exists "snacky_cash_collections_operator_insert_removal" on public.cash_collections;
create policy "snacky_cash_collections_operator_insert_removal"
on public.cash_collections for insert
to authenticated
with check (
  (select public.snacky_current_profile_has_any_role(array['operator']))
  and operator_id = (select public.snacky_current_team_member_id())
  and route_id is null
  and actual_cash_collected is null
  and vms_expected_cash is null
  and review_status = 'collected_pending_count'
);

drop policy if exists "snacky_cash_collections_operator_read_own" on public.cash_collections;
create policy "snacky_cash_collections_operator_read_own"
on public.cash_collections for select
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(array['operator']))
  and operator_id = (select public.snacky_current_team_member_id())
);

drop policy if exists "snacky_cash_collection_machines_operator_read_own" on public.cash_collection_machines;
create policy "snacky_cash_collection_machines_operator_read_own"
on public.cash_collection_machines for select
to authenticated
using (
  exists (
    select 1
    from public.cash_collections cc
    where cc.id = cash_collection_id
      and cc.operator_id = (select public.snacky_current_team_member_id())
  )
);

drop policy if exists "snacky_cash_collection_machines_operator_insert_own" on public.cash_collection_machines;
create policy "snacky_cash_collection_machines_operator_insert_own"
on public.cash_collection_machines for insert
to authenticated
with check (
  (select public.snacky_current_profile_has_any_role(array['operator']))
  and exists (
    select 1
    from public.cash_collections cc
    where cc.id = cash_collection_id
      and cc.operator_id = (select public.snacky_current_team_member_id())
      and cc.route_id is null
      and cc.review_status = 'collected_pending_count'
  )
);

create or replace function public.record_standalone_cash_removal(
  p_machine_ids uuid[],
  p_removed_at timestamptz,
  p_removal_type text,
  p_cash_bag_id text default null,
  p_notes text default null,
  p_client_submission_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  v_collection_id uuid;
  v_machine_ids uuid[];
  v_collector_id uuid := public.snacky_current_team_member_id();
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance', 'operator']) then
    raise exception 'Not authorized to record cash removal' using errcode = '42501';
  end if;

  select array_agg(distinct u.machine_id)
  into v_machine_ids
  from unnest(coalesce(p_machine_ids, array[]::uuid[])) as u(machine_id);

  if coalesce(array_length(v_machine_ids, 1), 0) = 0 then
    raise exception 'Select at least one machine' using errcode = '22023';
  end if;

  if p_removal_type not in ('full', 'partial') then
    raise exception 'Removal type must be full or partial' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_machine_ids) as selected(selected_id)
    where not exists (select 1 from public.machines m where m.id = selected.selected_id)
  ) then
    raise exception 'One or more selected machines do not exist' using errcode = '23503';
  end if;

  if p_client_submission_id is not null then
    select id into v_collection_id
    from public.cash_collections
    where client_submission_id = p_client_submission_id;
    if v_collection_id is not null then
      return v_collection_id;
    end if;
  end if;

  insert into public.cash_collections (
    route_id,
    machine_id,
    operator_id,
    vms_expected_cash,
    actual_cash_collected,
    review_status,
    collected_at,
    cash_bag_id,
    notes,
    client_submission_id
  ) values (
    null,
    case when array_length(v_machine_ids, 1) = 1 then v_machine_ids[1] else null end,
    v_collector_id,
    null,
    null,
    'collected_pending_count',
    coalesce(p_removed_at, now()),
    nullif(trim(coalesce(p_cash_bag_id, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    p_client_submission_id
  )
  returning id into v_collection_id;

  insert into public.cash_collection_machines (cash_collection_id, machine_id, removal_type)
  select v_collection_id, selected.machine_id, p_removal_type
  from unnest(v_machine_ids) as selected(machine_id);

  return v_collection_id;
end;
$$;

revoke all on function public.record_standalone_cash_removal(uuid[], timestamptz, text, text, text, uuid) from public, anon;
grant execute on function public.record_standalone_cash_removal(uuid[], timestamptz, text, text, text, uuid) to authenticated, service_role;

-- Keep one finance transaction for the whole counted batch. Mixed boxes are
-- described together and never assigned to an arbitrary machine.
create or replace function public.ensure_cash_collection_finance_transaction(p_cash_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_cash record;
  v_amount numeric;
  v_datetime timestamptz;
  v_description text;
  v_location text;
  v_machine_names text;
  v_transaction_id uuid;
begin
  select cc.*, m.name as machine_name, m.machine_code, l.name as location_name
    into v_cash
  from public.cash_collections cc
  left join public.machines m on m.id = cc.machine_id
  left join public.locations l on l.id = m.location_id
  where cc.id = p_cash_collection_id;

  if not found then
    raise exception 'Cash collection % not found', p_cash_collection_id using errcode = 'P0002';
  end if;

  if v_cash.actual_cash_collected is null or coalesce(v_cash.review_status, '') = 'voided' then
    return null;
  end if;

  if auth.uid() is not null
     and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']) then
    raise exception 'Not authorized to post counted cash to finance' using errcode = '42501';
  end if;

  select string_agg(coalesce(nullif(trim(m.name), ''), nullif(trim(m.machine_code), ''), m.id::text), ', ' order by m.machine_code)
    into v_machine_names
  from public.cash_collection_machines ccm
  join public.machines m on m.id = ccm.machine_id
  where ccm.cash_collection_id = p_cash_collection_id;

  v_amount := abs(coalesce(v_cash.actual_cash_collected, 0));
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := case
    when v_cash.machine_id is null and v_machine_names is not null then 'Multiple machines'
    else coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''))
  end;
  v_description := 'Cash collection from ' || coalesce(nullif(trim(v_machine_names), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''), nullif(trim(v_cash.location_name), ''), p_cash_collection_id::text);
  if nullif(trim(coalesce(v_cash.cash_bag_id, '')), '') is not null then
    v_description := v_description || ' - Bag ' || v_cash.cash_bag_id;
  end if;

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or ft.related_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review,
      transaction_status, is_void, voided_at, void_reason, payment_method, payer_text, payee_text,
      paid_to_text, counterparty_text, related_cash_collection_id, linked_cash_collection_id,
      related_route_id, related_machine_id, location, source_type, source_id, created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_description, v_description, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'confirmed', false, 'active', false, null, null,
      'cash', 'Cash customers', null, null, 'Cash customers', p_cash_collection_id, p_cash_collection_id,
      null, v_cash.machine_id, v_location, 'cash_collection', p_cash_collection_id,
      v_cash.operator_id, now()
    )
    returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = v_datetime::date,
        transaction_datetime = v_datetime,
        direction = 'money_in',
        transaction_kind = 'cash_collection',
        transaction_type = 'Revenue',
        category = 'Revenue',
        description = v_description,
        notes = v_description,
        amount = v_amount,
        signed_amount = abs(v_amount),
        currency = 'LYD',
        account_id = 'snacky_lyd',
        account_key = 'snacky_lyd',
        transaction_effect = 'income',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Revenue',
        final_bucket = 'Revenue',
        review_status = 'confirmed',
        needs_review = false,
        transaction_status = 'active',
        is_void = false,
        voided_at = null,
        void_reason = null,
        payment_method = 'cash',
        payer_text = 'Cash customers',
        payee_text = null,
        paid_to_text = null,
        counterparty_text = 'Cash customers',
        related_cash_collection_id = p_cash_collection_id,
        linked_cash_collection_id = p_cash_collection_id,
        related_route_id = null,
        related_machine_id = v_cash.machine_id,
        location = v_location,
        source_type = 'cash_collection',
        source_id = p_cash_collection_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

revoke all on function public.ensure_cash_collection_finance_transaction(uuid) from public, anon;
grant execute on function public.ensure_cash_collection_finance_transaction(uuid) to authenticated, service_role;

create or replace function public.snacky_cash_collection_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Preserve the existing sync function's deduplication and voiding behavior,
  -- then apply the batch-aware description and route-independent linkage.
  perform public.sync_cash_collection_to_financial_transaction(new.id);
  perform public.ensure_cash_collection_finance_transaction(new.id);
  return new;
end;
$$;

revoke all on function public.snacky_cash_collection_finance_sync_trigger() from public, anon, authenticated;
grant execute on function public.snacky_cash_collection_finance_sync_trigger() to service_role;

select pg_notify('pgrst', 'reload schema');
