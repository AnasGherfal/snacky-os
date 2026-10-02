-- Derive cash collection intervals from recorded removals instead of asking
-- finance users to type a "from" date. The physical removal timestamp remains
-- the authoritative end of the interval.

create or replace function snacky_private.previous_full_cash_removal_at(
  p_machine_id uuid,
  p_collection_id uuid,
  p_before timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = public, snacky_private, pg_temp
as $$
  select max(previous_cash.collected_at)
  from public.cash_collection_machines previous_link
  join public.cash_collections previous_cash
    on previous_cash.id = previous_link.cash_collection_id
  where previous_link.machine_id = p_machine_id
    and previous_link.removal_type = 'full'
    and previous_cash.id <> p_collection_id
    and previous_cash.collected_at < p_before
    and coalesce(previous_cash.custody_status, '') <> 'voided'
    and coalesce(previous_cash.review_status, '') <> 'voided';
$$;

revoke all on function snacky_private.previous_full_cash_removal_at(uuid, uuid, timestamptz)
  from public, anon, authenticated;

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
     or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can count stored cash' using errcode = '42501';
  end if;
  if v_counter_id is null then
    raise exception 'Your account must be linked to a team member before counting cash' using errcode = '42501';
  end if;
  if p_total_amount_lyd is null or v_total is null or v_total < 0 then
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
  if v_cash.custody_status <> 'in_storage' then
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

revoke all on function snacky_private.confirm_cash_count_auto_period_v1_impl(uuid, numeric, uuid)
  from public, anon;
grant execute on function snacky_private.confirm_cash_count_auto_period_v1_impl(uuid, numeric, uuid)
  to authenticated, service_role;

create or replace function public.confirm_cash_count_auto_period_v1(
  p_collection_id uuid,
  p_total_amount_lyd numeric,
  p_client_submission_id uuid
)
returns jsonb
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.confirm_cash_count_auto_period_v1_impl(
    p_collection_id,
    p_total_amount_lyd,
    p_client_submission_id
  );
$$;

revoke all on function public.confirm_cash_count_auto_period_v1(uuid, numeric, uuid)
  from public, anon;
grant execute on function public.confirm_cash_count_auto_period_v1(uuid, numeric, uuid)
  to authenticated, service_role;

comment on function public.confirm_cash_count_auto_period_v1(uuid, numeric, uuid) is
  'Counts one stored cash batch. The period is derived from each machine previous full removal and the current removal timestamp; users do not enter a from/to range.';

-- Reconciliation uses the same automatic interval rule. A previous full
-- removal resets the machine cash interval as soon as it is recorded, even if
-- that earlier bag has not yet completed office reconciliation.
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
    v_interval_start := snacky_private.previous_full_cash_removal_at(
      v_link.machine_id,
      p_collection_id,
      v_cash.collected_at
    );
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

select pg_catalog.pg_notify('pgrst', 'reload schema');
