-- Additive, opt-in cash handover. No existing records are enrolled or rewritten.
-- Generated with Supabase CLI 2.117.0: migration new cash_handover_coordinator_v1.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table snacky_private.cash_handover_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into snacky_private.cash_handover_settings(singleton) values (true);
create table snacky_private.cash_handover_counters (
  user_id uuid primary key references public.profiles(id),
  enabled boolean not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now()
);
create table snacky_private.cash_handovers (
  collection_id uuid primary key references public.cash_collections(id),
  assigned_to uuid not null references public.profiles(id),
  stage text not null check(stage in ('assigned','dropped','picked_up')),
  revision integer not null default 1 check(revision > 0),
  deposited_at timestamptz,
  deposited_by uuid references public.profiles(id),
  storage_location text,
  drop_photo_path text,
  picked_up_at timestamptz,
  picked_up_by uuid references public.profiles(id),
  pickup_seal text check(pickup_seal in ('intact','broken','mismatch')),
  pickup_note text,
  cash_kept_at text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(stage <> 'dropped' or (deposited_at is not null and deposited_by is not null and storage_location is not null)),
  check(stage <> 'picked_up' or (picked_up_at is not null and picked_up_by is not null and pickup_seal is not null))
);
create index cash_handovers_assignee_idx on snacky_private.cash_handovers(assigned_to,updated_at desc,collection_id);
create table snacky_private.cash_handover_events (
  id bigint generated always as identity primary key,
  collection_id uuid references public.cash_collections(id),
  event_type text not null,
  actor_user_id uuid not null references public.profiles(id),
  event_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
create index cash_handover_events_collection_idx on snacky_private.cash_handover_events(collection_id,event_at,id);
create table snacky_private.cash_handover_requests (
  request_id uuid primary key,
  actor_user_id uuid not null references public.profiles(id),
  collection_id uuid references public.cash_collections(id),
  command jsonb not null,
  execution_xid xid8 not null default pg_current_xact_id(),
  result jsonb,
  created_at timestamptz not null default now()
);
create index cash_handover_requests_collection_idx on snacky_private.cash_handover_requests(collection_id,actor_user_id) where result is null;

alter table snacky_private.cash_handover_settings enable row level security;
alter table snacky_private.cash_handover_counters enable row level security;
alter table snacky_private.cash_handovers enable row level security;
alter table snacky_private.cash_handover_events enable row level security;
alter table snacky_private.cash_handover_requests enable row level security;
revoke all on table snacky_private.cash_handover_settings, snacky_private.cash_handover_counters,
  snacky_private.cash_handovers, snacky_private.cash_handover_events, snacky_private.cash_handover_requests
  from public,anon,authenticated;
revoke all on sequence snacky_private.cash_handover_events_id_seq from public,anon,authenticated;

-- This is an additional permission, not an app role and not a Finance permission.
create function snacky_private.cash_handover_counter_v1(p_user_id uuid)
returns boolean language sql security definer set search_path = pg_catalog,public,snacky_private
as $$
  select exists (
    select 1 from public.profiles p join public.team_members t on t.id=p.team_member_id
    where p.id=p_user_id and p.active_status='active'
      and coalesce(t.active_status,'active')='active' and coalesce(t.active,true)
      and (
        public.snacky_profile_has_any_role(p.roles,p.role,array['owner','admin'])
        or public.snacky_profile_has_any_role(t.roles,t.role,array['owner','admin'])
        or (exists(select 1 from snacky_private.cash_handover_counters g where g.user_id=p.id and g.enabled)
          and (public.snacky_profile_has_any_role(p.roles,p.role,array['operator','warehouse','purchasing','finance','supervisor'])
            or public.snacky_profile_has_any_role(t.roles,t.role,array['operator','warehouse','purchasing','finance','supervisor'])))
      )
  );
$$;
revoke all on function snacky_private.cash_handover_counter_v1(uuid) from public,anon,authenticated;

-- A delegated count is authorized only INSIDE the authenticated command's own
-- transaction, for the specific picked-up box. Browser calls to the old counting
-- or Finance posting functions cannot manufacture this context.
create function snacky_private.cash_handover_count_context_v1(p_collection_id uuid)
returns boolean language sql volatile security definer
set search_path = pg_catalog,public,auth,snacky_private
as $$
  select auth.uid() is not null
    and snacky_private.cash_handover_counter_v1(auth.uid())
    and exists(select 1 from snacky_private.cash_handovers h
      where h.collection_id=p_collection_id and h.stage='picked_up'
        and h.assigned_to=auth.uid() and h.picked_up_by=auth.uid())
    and exists(select 1 from snacky_private.cash_handover_requests r
      where r.collection_id=p_collection_id and r.actor_user_id=auth.uid()
        and r.command->>'action'='count' and r.result is null
        and r.execution_xid=pg_current_xact_id());
$$;
revoke all on function snacky_private.cash_handover_count_context_v1(uuid) from public,anon,authenticated;

-- Existing records are unaffected. Enrolled boxes cannot be counted through a
-- legacy form without the explicit pickup and audited command; owner voiding
-- and later VMS reconciliation continue to use their existing functions.
create function snacky_private.cash_handover_count_guard_v1()
returns trigger language plpgsql security definer
set search_path = pg_catalog,public,auth,snacky_private
as $$
begin
  if exists(select 1 from snacky_private.cash_handovers where collection_id=old.id) then
    if new.actual_cash_collected is distinct from old.actual_cash_collected then
      if old.actual_cash_collected is not null or not snacky_private.cash_handover_count_context_v1(old.id) then
        raise exception 'Use Cash handling to count this picked-up box; confirmed amounts require the existing owner reversal process' using errcode='42501';
      end if;
    end if;
    if old.custody_status='removed' and new.custody_status='in_storage'
      and not exists(select 1 from snacky_private.cash_handovers where collection_id=old.id and stage='dropped') then
      raise exception 'Record the actual drop-off in Cash handling' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function snacky_private.cash_handover_count_guard_v1() from public,anon,authenticated;
create trigger cash_handover_count_guard_v1 before update on public.cash_collections
  for each row execute function snacky_private.cash_handover_count_guard_v1();

-- Existing automatic-period count: restricted authorization extension only.
create or replace function snacky_private.confirm_cash_count_auto_period_v1_impl(
  p_collection_id uuid,
  p_total_amount_lyd numeric,
  p_client_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_counter_id uuid := public.snacky_current_team_member_id();
  v_total numeric(12,2) := round(p_total_amount_lyd::numeric, 2);
  v_existing_event public.cash_collection_events%rowtype;
  v_period_start date;
  v_period_end date;
  v_machine_count integer := 0;
  v_missing_start_count integer := 0;
  v_machine_intervals jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if auth.uid() is null
     or not (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance'])
       or snacky_private.cash_handover_count_context_v1(p_collection_id)) then
    raise exception 'Only owner, admin, or finance can count stored cash' using errcode = '42501';
  end if;
  if v_counter_id is null then
    raise exception 'Your account must be linked to a team member before counting cash' using errcode = '42501';
  end if;
  if p_total_amount_lyd is null or v_total is null or v_total < 0
     or p_total_amount_lyd::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Total cash counted must be zero or greater' using errcode = '22023';
  end if;

  if p_client_submission_id is not null then
    select event.*
    into v_existing_event
    from public.cash_collection_events event
    where event.client_submission_id = p_client_submission_id;

    if found then
      if v_existing_event.cash_collection_id = p_collection_id
         and v_existing_event.event_type = 'counted'
         and v_existing_event.amount_lyd is not distinct from v_total
         and v_existing_event.metadata ->> 'count_method' = 'combined_total_auto_period'
      then
        return v_existing_event.metadata;
      end if;
      raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
    end if;
  end if;

  select *
  into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status <> 'in_storage'
     and not (v_cash.custody_status='removed' and snacky_private.cash_handover_count_context_v1(p_collection_id)) then
    raise exception 'Cash must be received into storage before it can be counted' using errcode = '23514';
  end if;

  v_period_end := (v_cash.collected_at at time zone 'Africa/Tripoli')::date;

  update public.cash_collection_machines ccm
  set
    interval_start_at = snacky_private.previous_full_cash_removal_at(
      ccm.machine_id,
      p_collection_id,
      v_cash.collected_at
    ),
    interval_end_at = v_cash.collected_at
  where ccm.cash_collection_id = p_collection_id;

  select
    count(*)::integer,
    count(*) filter (
      where ccm.removal_type <> 'full'
         or ccm.interval_start_at is null
    )::integer,
    min((ccm.interval_start_at at time zone 'Africa/Tripoli')::date)
  into v_machine_count, v_missing_start_count, v_period_start
  from public.cash_collection_machines ccm
  where ccm.cash_collection_id = p_collection_id;

  if v_machine_count = 0 then
    raise exception 'Cash collection has no linked machines' using errcode = '23514';
  end if;

  if v_missing_start_count > 0 then
    v_period_start := null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'machine_id', ccm.machine_id,
        'removal_type', ccm.removal_type,
        'interval_start_at', ccm.interval_start_at,
        'interval_end_at', ccm.interval_end_at
      )
      order by ccm.machine_id
    ),
    '[]'::jsonb
  )
  into v_machine_intervals
  from public.cash_collection_machines ccm
  where ccm.cash_collection_id = p_collection_id;

  update public.cash_collections
  set
    actual_cash_collected = v_total,
    cash_period_start = v_period_start,
    cash_period_end = case when v_period_start is null then null else v_period_end end,
    counted_at = now(),
    counted_by = v_counter_id,
    count_seal_condition = null,
    count_witnessed_by = null,
    count_denominations = '{}'::jsonb,
    count_other_amount_lyd = 0,
    custody_status = 'counted',
    review_status = 'counted_pending_reconciliation',
    reconciliation_status = 'pending',
    updated_at = now()
  where id = p_collection_id;

  update public.cash_removal_receipts
  set custody_status = 'counted',
      updated_at = now()
  where cash_collection_id = p_collection_id;

  v_result := jsonb_build_object(
    'count_method', 'combined_total_auto_period',
    'period_source', 'previous_full_cash_removal',
    'period_start', v_period_start,
    'period_end', v_period_end,
    'period_complete', v_missing_start_count = 0,
    'missing_interval_start_count', v_missing_start_count,
    'machine_intervals', v_machine_intervals,
    'vms_reconciliation_deferred', true
  );

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'counted',
    now(),
    v_total,
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

-- Existing Finance posting: restricted authorization extension only.
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
     and not (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
       or snacky_private.cash_handover_count_context_v1(p_cash_collection_id)) then
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


create function snacky_private.cash_handover_validate_v1(p_command jsonb)
returns void language plpgsql set search_path=pg_catalog
as $$
declare p jsonb; a text; k text; allowed text[];
begin
  if jsonb_typeof(p_command) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_command))<>5
    or exists(select 1 from jsonb_object_keys(p_command) k where k not in ('request_id','collection_id','action','revision','payload'))
    or coalesce(p_command->>'request_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_command->'revision') is distinct from 'number'
    or coalesce(p_command->>'revision','') !~ '^(0|[1-9][0-9]{0,8})$'
    or jsonb_typeof(p_command->'payload') is distinct from 'object'
    or length(p_command::text)>10000 then
    raise exception 'Invalid cash handover command' using errcode='22023';
  end if;
  p:=p_command->'payload'; a:=p_command->>'action';
  case a
    when 'enable' then allowed:=array['enabled'];
    when 'counter' then allowed:=array['user_id','enabled'];
    when 'assign' then allowed:=array['assigned_to'];
    when 'dropoff' then allowed:=array['assigned_to','storage_location','seal_condition','notes'];
    when 'pickup','direct_pickup','takeover' then allowed:=array['confirm_bag_id','seal_condition','notes'];
    when 'count' then allowed:=array['amount','cash_location'];
    else raise exception 'Invalid cash handover action' using errcode='22023';
  end case;
  if exists(select 1 from jsonb_object_keys(p) k where not k=any(allowed))
    or (select count(*) from jsonb_object_keys(p))<>cardinality(allowed) then
    raise exception 'Invalid action fields' using errcode='22023';
  end if;
  if a in ('enable','counter') then
    if jsonb_typeof(p->'enabled') is distinct from 'boolean' or p_command->'collection_id' is distinct from 'null'::jsonb or (p_command->>'revision')::int<>0 then
      raise exception 'Invalid management command' using errcode='22023';
    end if;
  elsif coalesce(p_command->>'collection_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'A collection reference is required' using errcode='22023';
  end if;
  foreach k in array allowed loop
    if k<>'enabled' and jsonb_typeof(p->k) is distinct from 'string' then
      raise exception 'Invalid text field' using errcode='22023';
    end if;
  end loop;
  if a='counter' and (p->>'user_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid counter' using errcode='22023';
  end if;
  if a in ('assign','dropoff') and (p->>'assigned_to') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Select a cash coordinator' using errcode='22023';
  end if;
  if a in ('dropoff','pickup','direct_pickup','takeover') then
    if (p->>'seal_condition') not in ('intact','broken','mismatch') or length(p->>'notes')>1000
      or ((a='takeover' or p->>'seal_condition'<>'intact') and length(trim(p->>'notes'))<3) then
      raise exception 'Record the seal and explain any exception or custody takeover' using errcode='22023';
    end if;
  end if;
  if a='dropoff' and length(trim(p->>'storage_location')) not between 2 and 180 then
    raise exception 'Specify the exact safe or storage location' using errcode='22023';
  end if;
  if a in ('pickup','direct_pickup','takeover') and length(trim(p->>'confirm_bag_id')) not between 1 and 120 then
    raise exception 'Confirm the physical box reference' using errcode='22023';
  end if;
  if a='count' and ((p->>'amount') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$'
    or length(trim(p->>'cash_location')) not between 2 and 180) then
    raise exception 'Enter one valid LYD total and where the counted cash will be kept' using errcode='22023';
  end if;
end;
$$;
revoke all on function snacky_private.cash_handover_validate_v1(jsonb) from public,anon,authenticated;

create function snacky_private.cash_handover_command_v1_impl(p_command jsonb,p_evidence_path text default null)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,auth,snacky_private
as $$
declare
  v_actor uuid:=auth.uid(); v_team uuid; v_owner boolean; v_counter boolean; v_enabled boolean;
  v_request uuid; v_id uuid; v_action text; p jsonb; v_revision integer;
  v_cash public.cash_collections%rowtype; h snacky_private.cash_handovers%rowtype;
  r snacky_private.cash_handover_requests%rowtype; v_has_handover boolean;
  v_target uuid; v_now timestamptz:=clock_timestamp(); v_result jsonb; v_amount numeric;
  v_finance_count integer; v_finance_amount numeric; v_event_detail jsonb:='{}'::jsonb;
begin
  perform snacky_private.cash_handover_validate_v1(p_command);
  if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing','finance']) then
    raise exception 'Not authorized for cash handling' using errcode='42501';
  end if;
  select p0.team_member_id into v_team from public.profiles p0
    where p0.id=v_actor and p0.active_status='active' for share;
  if v_team is null then raise exception 'Link this active account to a team member first' using errcode='42501'; end if;
  perform 1 from public.team_members t where t.id=v_team and coalesce(t.active_status,'active')='active' and coalesce(t.active,true) for share;
  if not found then raise exception 'The team member is inactive' using errcode='42501'; end if;
  -- Serialize grant revocation against an in-flight counter action.
  perform 1 from snacky_private.cash_handover_counters where user_id=v_actor for share;
  v_owner:=public.snacky_current_profile_has_any_role(array['owner','admin']);
  v_counter:=snacky_private.cash_handover_counter_v1(v_actor);
  v_request:=(p_command->>'request_id')::uuid; v_id:=(p_command->>'collection_id')::uuid;
  v_action:=p_command->>'action'; p:=p_command->'payload'; v_revision:=(p_command->>'revision')::integer;
  if v_action in ('enable','counter','assign','takeover') and not v_owner then
    raise exception 'Only the owner or admin can manage cash responsibility' using errcode='42501';
  end if;
  if v_action in ('pickup','direct_pickup','count') and not v_counter then
    raise exception 'Cash coordinator permission is required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cash-handover:'||v_request::text,0));
  select * into r from snacky_private.cash_handover_requests where request_id=v_request;
  if found then
    if r.actor_user_id<>v_actor or r.command<>p_command then
      raise exception 'This request reference was used for different work' using errcode='23505';
    end if;
    if r.result is null then raise exception 'Save not confirmed; retry the same request' using errcode='40001'; end if;
    return r.result;
  end if;
  select enabled into v_enabled from snacky_private.cash_handover_settings where singleton;

  if v_id is not null then
    -- All cash commands and the original count function lock the same parent.
    select * into v_cash from public.cash_collections where id=v_id for update;
    if not found then raise exception 'Collection unavailable' using errcode='42501'; end if;
    select * into h from snacky_private.cash_handovers where collection_id=v_id for update;
    v_has_handover:=found;
    if not (v_owner or v_cash.operator_id=v_team or (v_has_handover and h.assigned_to=v_actor)) then
      raise exception 'Collection unavailable' using errcode='42501';
    end if;
    if v_cash.custody_status not in ('removed','in_storage') or v_cash.actual_cash_collected is not null or v_cash.voided_at is not null then
      raise exception 'This collection is already counted or closed' using errcode='23514';
    end if;
    if coalesce(h.revision,0)<>v_revision then
      raise exception 'The box changed on another device; reload before continuing' using errcode='40001';
    end if;
    if not v_has_handover and not v_enabled then
      raise exception 'New handovers are paused; existing boxes can still be completed' using errcode='23514';
    end if;
  end if;

  insert into snacky_private.cash_handover_requests(request_id,actor_user_id,collection_id,command)
    values(v_request,v_actor,v_id,p_command);

  case v_action
    when 'enable' then
      update snacky_private.cash_handover_settings set enabled=(p->>'enabled')::boolean,updated_by=v_actor,updated_at=v_now where singleton;
      v_event_detail:=p;
    when 'counter' then
      v_target:=(p->>'user_id')::uuid;
      perform 1 from public.profiles t where t.id=v_target and t.active_status='active' and t.team_member_id is not null
        and (public.snacky_profile_has_any_role(t.roles,t.role,array['operator','warehouse','purchasing','finance','supervisor'])
          or exists(select 1 from public.team_members tm where tm.id=t.team_member_id and public.snacky_profile_has_any_role(tm.roles,tm.role,array['operator','warehouse','purchasing','finance','supervisor']))) for share;
      if (p->>'enabled')::boolean and not found then raise exception 'Choose an active operational account linked to a team member' using errcode='22023'; end if;
      insert into snacky_private.cash_handover_counters(user_id,enabled,updated_by,updated_at)
        values(v_target,(p->>'enabled')::boolean,v_actor,v_now)
        on conflict(user_id) do update set enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
      v_event_detail:=p;
    when 'assign' then
      v_target:=(p->>'assigned_to')::uuid;
      if not snacky_private.cash_handover_counter_v1(v_target) then raise exception 'The selected coordinator is not active or authorized' using errcode='22023'; end if;
      if v_has_handover and h.stage='picked_up' then raise exception 'Record an actual custody takeover instead of reassigning a box someone holds' using errcode='23514'; end if;
      insert into snacky_private.cash_handovers(collection_id,assigned_to,stage)
        values(v_id,v_target,'assigned') on conflict(collection_id) do update
        set assigned_to=excluded.assigned_to,revision=cash_handovers.revision+1,updated_at=v_now;
      v_event_detail:=jsonb_build_object('assigned_to',v_target);
    when 'dropoff' then
      if v_cash.operator_id is distinct from v_team or v_cash.custody_status<>'removed' or (v_has_handover and h.stage<>'assigned') then
        raise exception 'Only the recorded collector can record this first unattended drop-off' using errcode='42501';
      end if;
      v_target:=(p->>'assigned_to')::uuid;
      if (v_has_handover and h.assigned_to<>v_target) or not snacky_private.cash_handover_counter_v1(v_target) then
        raise exception 'Use the assigned active coordinator; an owner can change the assignment' using errcode='22023';
      end if;
      if p_evidence_path is null or p_evidence_path not like ('cash-handover-'||v_actor::text||'-'||v_request::text||'/%')
        or not exists(select 1 from storage.objects where bucket_id='cash-evidence' and name=p_evidence_path) then
        raise exception 'Upload a photo of this box in its storage location' using errcode='22023';
      end if;
      insert into snacky_private.cash_handovers(collection_id,assigned_to,stage,deposited_at,deposited_by,storage_location,drop_photo_path)
        values(v_id,v_target,'dropped',v_now,v_actor,trim(p->>'storage_location'),p_evidence_path)
        on conflict(collection_id) do update set stage='dropped',deposited_at=v_now,deposited_by=v_actor,
          storage_location=excluded.storage_location,drop_photo_path=excluded.drop_photo_path,
          revision=cash_handovers.revision+1,updated_at=v_now;
      -- Physical arrival, NOT acknowledgment by another person.
      update public.cash_collections set custody_status='in_storage',storage_received_at=v_now,storage_received_by=null,
        storage_location=trim(p->>'storage_location'),storage_seal_condition=p->>'seal_condition',
        storage_notes='Unattended drop-off; pickup must be acknowledged in Cash handling. '||trim(p->>'notes'),updated_at=v_now where id=v_id;
      update public.cash_removal_receipts set custody_status='in_storage',storage_received_at=v_now,storage_received_by=null,
        storage_location=trim(p->>'storage_location'),updated_at=v_now where cash_collection_id=v_id;
      perform snacky_private.append_cash_collection_event(v_id,'stored',v_now,null,p->>'seal_condition',p_evidence_path,null,
        'Unattended drop-off; no independent receipt claimed. '||trim(p->>'notes'),
        jsonb_build_object('handover_mode','unattended_dropoff','receiver_confirmed',false),v_request);
      v_event_detail:=jsonb_build_object('location',trim(p->>'storage_location'),'seal',p->>'seal_condition','notes',trim(p->>'notes'),'assigned_to',v_target);
    when 'pickup','direct_pickup','takeover' then
      if upper(trim(p->>'confirm_bag_id'))<>upper(trim(v_cash.cash_bag_id)) then raise exception 'The physical box reference does not match' using errcode='22023'; end if;
      if v_action='pickup' and (not v_has_handover or h.assigned_to<>v_actor or h.stage not in ('assigned','dropped') or v_cash.custody_status<>'in_storage') then
        raise exception 'This box is not waiting for your pickup' using errcode='42501';
      end if;
      if v_action='direct_pickup' and (v_cash.operator_id is distinct from v_team or v_cash.custody_status<>'removed' or (v_has_handover and (h.assigned_to<>v_actor or h.stage<>'assigned'))) then
        raise exception 'Direct counting is only for your own collected box' using errcode='42501';
      end if;
      if v_action='takeover' and (not v_has_handover or h.stage<>'picked_up' or h.picked_up_by=v_actor) then
        raise exception 'There is no other custodian to take over from' using errcode='23514';
      end if;
      insert into snacky_private.cash_handovers(collection_id,assigned_to,stage,picked_up_at,picked_up_by,pickup_seal,pickup_note)
        values(v_id,v_actor,'picked_up',v_now,v_actor,p->>'seal_condition',trim(p->>'notes'))
        on conflict(collection_id) do update set assigned_to=v_actor,stage='picked_up',picked_up_at=v_now,picked_up_by=v_actor,
          pickup_seal=excluded.pickup_seal,pickup_note=excluded.pickup_note,revision=cash_handovers.revision+1,updated_at=v_now;
      v_event_detail:=jsonb_build_object('seal',p->>'seal_condition','notes',trim(p->>'notes'),'previous_holder',h.picked_up_by);
    when 'count' then
      if not v_has_handover or h.stage<>'picked_up' or h.assigned_to<>v_actor or h.picked_up_by<>v_actor then
        raise exception 'Acknowledge physical pickup before counting' using errcode='42501';
      end if;
      v_amount:=(p->>'amount')::numeric;
      perform public.confirm_cash_count_auto_period_v1(v_id,v_amount,v_request);
      -- Keep pickup-seal exceptions visible to the owner's existing cash audit.
      update public.cash_collections set count_seal_condition=h.pickup_seal,
        reconciliation_status=case when h.pickup_seal<>'intact' or coalesce(storage_seal_condition,'intact')<>'intact' then 'variance_review' else reconciliation_status end,
        review_status=case when h.pickup_seal<>'intact' or coalesce(storage_seal_condition,'intact')<>'intact' then 'variance_review' else review_status end
        where id=v_id;
      -- Verify the existing trigger actually posted once; any failure rolls back
      -- count, evidence reference, audit event, and Finance together.
      select count(*)::integer,min(ft.amount) into v_finance_count,v_finance_amount from public.financial_transactions ft
        where (ft.linked_cash_collection_id=v_id or ft.related_cash_collection_id=v_id or (ft.source_type='cash_collection' and ft.source_id=v_id))
          and coalesce(ft.transaction_status,'active')='active' and not coalesce(ft.is_void,false);
      if v_finance_count<>1 or v_finance_amount is distinct from v_amount then
        raise exception 'Finance posting was not verified; no count was saved' using errcode='23514';
      end if;
      update snacky_private.cash_handovers set cash_kept_at=trim(p->>'cash_location'),revision=revision+1,updated_at=v_now where collection_id=v_id;
      v_event_detail:=jsonb_build_object('location',trim(p->>'cash_location'),'finance_posted',true);
  end case;

  insert into snacky_private.cash_handover_events(collection_id,event_type,actor_user_id,event_at,detail)
    values(v_id,v_action,v_actor,v_now,v_event_detail);
  v_result:=jsonb_build_object('ok',true,'request_id',v_request,'collection_id',v_id,'action',v_action,
    'revision',case when v_id is null then 0 else (select revision from snacky_private.cash_handovers where collection_id=v_id) end);
  if v_action='count' then v_result:=v_result||jsonb_build_object('amount',v_amount::text,'finance_posted',true); end if;
  update snacky_private.cash_handover_requests set result=v_result where request_id=v_request;
  return v_result;
end;
$$;
revoke all on function snacky_private.cash_handover_command_v1_impl(jsonb,text) from public,anon;
grant execute on function snacky_private.cash_handover_command_v1_impl(jsonb,text) to authenticated;

create function public.snacky_cash_handover_command_v1(p_command jsonb,p_evidence_path text default null)
returns jsonb language sql security invoker set search_path=pg_catalog,snacky_private
as $$ select snacky_private.cash_handover_command_v1_impl(p_command,p_evidence_path); $$;
revoke all on function public.snacky_cash_handover_command_v1(jsonb,text) from public,anon;
grant execute on function public.snacky_cash_handover_command_v1(jsonb,text) to authenticated;

-- Purpose-built projection: no raw Finance access, expected sales, or company totals.
create function snacky_private.cash_handover_workspace_v1_impl(
  p_id uuid default null,p_status text default 'open',p_offset integer default 0
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,auth,snacky_private
as $$
declare
  v_actor uuid:=auth.uid(); v_team uuid; v_owner boolean; v_counter boolean;
  v_enabled boolean; v_rows jsonb; v_total integer; v_people jsonb; v_counters jsonb;
begin
  if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing','finance']) then
    raise exception 'Cash handling access denied' using errcode='42501';
  end if;
  select p.team_member_id into v_team from public.profiles p join public.team_members t on t.id=p.team_member_id
    where p.id=v_actor and p.active_status='active' and coalesce(t.active_status,'active')='active' and coalesce(t.active,true);
  if v_team is null then raise exception 'An active linked team account is required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('open','counted','all') or p_offset is null or p_offset<0 or p_offset>100000 then
    raise exception 'Invalid cash queue filter' using errcode='22023';
  end if;
  v_owner:=public.snacky_current_profile_has_any_role(array['owner','admin']);
  v_counter:=snacky_private.cash_handover_counter_v1(v_actor);
  select enabled into v_enabled from snacky_private.cash_handover_settings where singleton;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) order by p.full_name,p.id),'[]'::jsonb)
    into v_counters from public.profiles p where snacky_private.cash_handover_counter_v1(p.id);
  if v_owner then
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,
      'enabled',coalesce(g.enabled,false),'can_count',snacky_private.cash_handover_counter_v1(p.id),
      'owner',public.snacky_profile_has_any_role(p.roles,p.role,array['owner','admin']) or public.snacky_profile_has_any_role(t.roles,t.role,array['owner','admin']),
      'finance_access',public.snacky_profile_has_any_role(p.roles,p.role,array['owner','admin','supervisor','finance']) or public.snacky_profile_has_any_role(t.roles,t.role,array['owner','admin','supervisor','finance'])) order by p.full_name,p.id),'[]'::jsonb)
      into v_people from public.profiles p join public.team_members t on t.id=p.team_member_id
      left join snacky_private.cash_handover_counters g on g.user_id=p.id
      where p.active_status='active' and coalesce(t.active_status,'active')='active' and coalesce(t.active,true)
        and (public.snacky_profile_has_any_role(p.roles,p.role,array['owner','admin','supervisor','operator','warehouse','purchasing','finance'])
          or public.snacky_profile_has_any_role(t.roles,t.role,array['owner','admin','supervisor','operator','warehouse','purchasing','finance']));
  end if;

  with scoped as (
    select c.*,h.collection_id as handover_id,h.revision,h.stage,h.assigned_to,h.deposited_at,h.deposited_by,
      h.picked_up_at,h.picked_up_by,h.pickup_seal,h.pickup_note,h.drop_photo_path,h.cash_kept_at,
      coalesce(h.storage_location,c.storage_location) as physical_storage,
      collector.full_name as collector_name,assignee.full_name as assignee_name,custodian.full_name as custodian_name,
      depositor.full_name as depositor_name,counter.full_name as counter_name,
      c.actual_cash_collected is null and c.voided_at is null and c.custody_status in ('removed','in_storage') as pending
    from public.cash_collections c
    left join snacky_private.cash_handovers h on h.collection_id=c.id
    left join public.team_members collector on collector.id=c.operator_id
    left join public.team_members counter on counter.id=c.counted_by
    left join public.profiles assignee on assignee.id=h.assigned_to
    left join public.profiles custodian on custodian.id=h.picked_up_by
    left join public.profiles depositor on depositor.id=h.deposited_by
    where (v_owner or c.operator_id=v_team or (v_counter and h.assigned_to=v_actor))
      and (h.collection_id is not null or (c.actual_cash_collected is null and c.custody_status in ('removed','in_storage')))
      and (p_id is null or c.id=p_id)
  ), filtered as (
    select * from scoped where p_id is not null or p_status='all'
      or (p_status='open' and pending) or (p_status='counted' and actual_cash_collected is not null and voided_at is null and custody_status<>'voided')
  ), page as (
    select * from filtered order by collected_at desc,id limit 25 offset p_offset
  )
  select (select count(*)::integer from filtered),coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'bag',c.cash_bag_id,'revision',coalesce(c.revision,0),'collected_at',c.collected_at,
    'collector',c.collector_name,'assigned_to',c.assigned_to,'assignee',c.assignee_name,
    'assignee_active',case when c.assigned_to is null then false else snacky_private.cash_handover_counter_v1(c.assigned_to) end,
    'state',case when c.voided_at is not null or c.custody_status='voided' then 'voided'
      when c.actual_cash_collected is not null then 'counted' when c.stage='picked_up' then 'picked_up'
      when c.stage='dropped' then 'dropped' when c.custody_status='in_storage' then 'stored'
      when c.stage='assigned' then 'assigned' else 'collected' end,
    'storage',c.physical_storage,'deposited_at',c.deposited_at,'depositor',c.depositor_name,
    'picked_up_at',c.picked_up_at,'custodian',c.custodian_name,'cash_location',c.cash_kept_at,
    'counted_at',c.counted_at,'counter',c.counter_name,
    'amount',case when v_owner or (v_counter and c.assigned_to=v_actor and c.counted_by=v_team) then c.actual_cash_collected::text else null end,
    'seal_exception',coalesce(c.pickup_seal,'intact')<>'intact' or coalesce(c.storage_seal_condition,'intact')<>'intact',
    'evidence_path',case when p_id is not null then c.drop_photo_path else null end,
    'machines',(select coalesce(jsonb_agg(jsonb_build_object('name',coalesce(nullif(m.name,''),m.machine_code),'location',l.name) order by m.name,m.id),'[]'::jsonb)
      from public.cash_collection_machines cm join public.machines m on m.id=cm.machine_id
      left join public.locations l on l.id=m.location_id where cm.cash_collection_id=c.id),
    'actions',to_jsonb(array_remove(array[
      case when c.pending and (v_enabled or c.handover_id is not null) and v_owner and coalesce(c.stage,'assigned')<>'picked_up' then 'assign' end,
      case when c.pending and (v_enabled or c.handover_id is not null) and c.operator_id=v_team and c.custody_status='removed' and coalesce(c.stage,'assigned')='assigned' then 'dropoff' end,
      case when c.pending and v_counter and c.assigned_to=v_actor and c.custody_status='in_storage' and c.stage in ('assigned','dropped') then 'pickup' end,
      case when c.pending and (v_enabled or c.handover_id is not null) and v_counter and c.operator_id=v_team and c.custody_status='removed'
        and (c.handover_id is null or (c.assigned_to=v_actor and c.stage='assigned')) then 'direct_pickup' end,
      case when c.pending and v_owner and c.stage='picked_up' and c.picked_up_by<>v_actor then 'takeover' end,
      case when c.pending and v_counter and c.assigned_to=v_actor and c.picked_up_by=v_actor and c.stage='picked_up' then 'count' end
    ],null)),
    'events',case when p_id is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object(
      'id',e.id::text,'action',e.event_type,'at',e.event_at,'by',p.full_name,'detail',e.detail) order by e.event_at,e.id),'[]'::jsonb)
      from snacky_private.cash_handover_events e join public.profiles p on p.id=e.actor_user_id where e.collection_id=c.id) end
  ) order by c.collected_at desc,c.id),'[]'::jsonb) into v_total,v_rows from page c;
  if p_id is not null and v_total=0 then raise exception 'Cash box not found or not accessible' using errcode='42501'; end if;
  return jsonb_build_object('me',v_actor,'owner',v_owner,'can_count',v_counter,'enabled',v_enabled,
    'can_remove',public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','finance']),
    'people',coalesce(v_people,'[]'::jsonb),'counters',v_counters,'rows',v_rows,'total',v_total,'offset',p_offset);
end;
$$;
revoke all on function snacky_private.cash_handover_workspace_v1_impl(uuid,text,integer) from public,anon;
grant execute on function snacky_private.cash_handover_workspace_v1_impl(uuid,text,integer) to authenticated;
create function public.snacky_cash_handover_workspace_v1(p_id uuid default null,p_status text default 'open',p_offset integer default 0)
returns jsonb language sql security invoker set search_path=pg_catalog,snacky_private
as $$ select snacky_private.cash_handover_workspace_v1_impl(p_id,p_status,p_offset); $$;
revoke all on function public.snacky_cash_handover_workspace_v1(uuid,text,integer) from public,anon;
grant execute on function public.snacky_cash_handover_workspace_v1(uuid,text,integer) to authenticated;

-- Recover an uncertain submission WITHOUT uploading the same photo again.
-- The actor and the exact original payload are bound to the saved receipt.
create function snacky_private.cash_handover_receipt_v1_impl(p_command jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth,snacky_private
as $$
declare v_result jsonb; r snacky_private.cash_handover_requests%rowtype;
begin
  perform snacky_private.cash_handover_validate_v1(p_command);
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing','finance'])
    or public.snacky_current_team_member_id() is null then raise exception 'Access denied' using errcode='42501'; end if;
  select * into r from snacky_private.cash_handover_requests where request_id=(p_command->>'request_id')::uuid;
  if not found then return null; end if;
  if r.actor_user_id<>auth.uid() or r.command<>p_command then raise exception 'Submission belongs to a different action' using errcode='23505'; end if;
  if p_command->>'action'='count' and not snacky_private.cash_handover_counter_v1(auth.uid()) then raise exception 'Counting access revoked' using errcode='42501'; end if;
  return r.result;
end;
$$;
revoke all on function snacky_private.cash_handover_receipt_v1_impl(jsonb) from public,anon;
grant execute on function snacky_private.cash_handover_receipt_v1_impl(jsonb) to authenticated;
create function public.snacky_cash_handover_receipt_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog,snacky_private
as $$ select snacky_private.cash_handover_receipt_v1_impl(p_command); $$;
revoke all on function public.snacky_cash_handover_receipt_v1(jsonb) from public,anon;
grant execute on function public.snacky_cash_handover_receipt_v1(jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
