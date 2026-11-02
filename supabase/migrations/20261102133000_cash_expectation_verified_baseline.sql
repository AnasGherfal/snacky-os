-- Prevent unsupported XY cash assumptions and ensure verified physical baseline.
create or replace function snacky_private.previous_full_cash_removal_at(
  p_machine_id uuid,p_collection_id uuid,p_before timestamptz
) returns timestamptz
language sql stable security definer
set search_path to public,snacky_private,pg_temp
as $verified_baseline$
  with last_full as (
    select c.id,c.collected_at,c.actual_cash_collected,c.counted_at,
           c.custody_status,c.storage_seal_condition,c.count_seal_condition,
           exists(select 1 from public.route_stop_cash_receipts receipt
             where receipt.collection_id=c.id and receipt.state='collected') as from_verified_refill
    from public.cash_collection_machines line
    join public.cash_collections c on c.id=line.cash_collection_id
    where line.machine_id=p_machine_id and line.removal_type='full'
      and c.id<>p_collection_id and c.collected_at<p_before
      and c.voided_at is null and coalesce(c.review_status,'')<>'voided'
    order by c.collected_at desc,c.id desc
    limit 1
  )
  select case when actual_cash_collected is not null and counted_at is not null
      and custody_status in ('counted','reconciled')
      and storage_seal_condition='intact' and count_seal_condition='intact'
      and from_verified_refill
    then collected_at else null end
  from last_full;
$verified_baseline$;
revoke all on function snacky_private.previous_full_cash_removal_at(uuid,uuid,timestamptz) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION snacky_private.calculate_cash_expectation_impl(p_collection_id uuid, p_client_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'snacky_private', 'pg_temp'
AS $function$
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
  v_manual_cash numeric(12,2):=0;
  v_manual_count bigint:=0;
  v_total_manual_cash numeric(12,2):=0;
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
        v_status := 'missing_verified_full_baseline';
        v_all_ready := false;
      elsif not (coalesce(v_link.compartments, array[]::text[]) @> array['notes','coins']::text[]) then
        -- Unless all cash-collection compartments are documented, cash-only
        -- sales cannot safely be compared to physical removals.
        v_status := 'cash_compartments_unverified';
        v_all_ready := false;
      elsif exists (
        select 1 from public.cash_collection_machines partial_line
        join public.cash_collections partial_cash on partial_cash.id=partial_line.cash_collection_id
        where partial_line.machine_id=v_link.machine_id
          and partial_line.removal_type='partial'
          and partial_cash.collected_at>v_interval_start
          and partial_cash.collected_at<v_cash.collected_at
          and partial_cash.voided_at is null
      ) then
        v_status := 'intervening_partial_cash_removal';
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
          -- An unknown payment method is NEVER evidence of machine cash.
          v_status := 'payment_method_unverified';
          v_all_ready := false;
        else
          v_expected := v_cash_amount;
          v_status := 'ready_exact';
          v_source := 'vms_exact_cash_transactions';
          v_total_expected := v_total_expected + v_expected;
        end if;
      end if;
    end if;

    select amount_lyd,sale_count into v_manual_cash,v_manual_count
    from snacky_private.repair_cashbox_interval_v1(v_link.machine_id,v_interval_start,coalesce(v_link.interval_end_at,v_cash.collected_at));
    v_total_manual_cash:=v_total_manual_cash+v_manual_cash;
    if v_expected is not null then
      v_expected:=v_expected+v_manual_cash;
      v_total_expected:=v_total_expected+v_manual_cash;
    end if;
    update public.cash_collection_machines
    set manual_repair_cash_lyd = v_manual_cash,
        interval_start_at = v_interval_start,
        interval_end_at = coalesce(v_link.interval_end_at, v_cash.collected_at),
        expected_cash_lyd = v_expected,
        vms_sales_count = case when v_status in ('ready_exact', 'ready_cash_only_assumption') then v_row_count else null end,
        expectation_status = v_status,
        expectation_source = v_source,
        expectation_metadata = jsonb_build_object(
          'manual_repair_cash_lyd', v_manual_cash,
          'manual_repair_sale_count', v_manual_count,
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
  set manual_repair_cash_lyd = v_total_manual_cash,
      vms_expected_cash = case when v_all_ready then round(v_total_expected, 2) else null end,
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
    'manual_repair_cash_lyd', v_total_manual_cash,
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
      'vms_sales_count', ccm.vms_sales_count,
      'manual_repair_cash_lyd', ccm.manual_repair_cash_lyd
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
$function$
