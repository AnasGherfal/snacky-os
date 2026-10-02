-- Cash counting is deliberately simple: one combined physical total and the
-- date range that total covers. Denomination breakdowns, count witnesses,
-- evidence uploads, and VMS calculation are not prerequisites for saving it.

alter table public.cash_collections
  add column if not exists cash_period_start date,
  add column if not exists cash_period_end date;

alter table public.cash_collections
  drop constraint if exists cash_collections_cash_period_check,
  add constraint cash_collections_cash_period_check check (
    (cash_period_start is null and cash_period_end is null)
    or (
      cash_period_start is not null
      and cash_period_end is not null
      and cash_period_start <= cash_period_end
    )
  );

comment on column public.cash_collections.cash_period_start is
  'First local calendar date covered by the combined physical cash count.';
comment on column public.cash_collections.cash_period_end is
  'Last local calendar date covered by the combined physical cash count.';
comment on column public.cash_collections.count_witnessed_by is
  'Legacy optional audit field. A witness is not required by the simplified total-count flow.';
comment on column public.cash_collections.count_denominations is
  'Legacy optional audit field. New counts store one combined total in actual_cash_collected.';

create or replace function snacky_private.confirm_cash_count_simple_impl(
  p_collection_id uuid,
  p_total_amount_lyd numeric,
  p_period_start date,
  p_period_end date,
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
  v_total numeric(12,2) := round(p_total_amount_lyd::numeric, 2);
  v_existing_event public.cash_collection_events%rowtype;
  v_collection_date date;
begin
  if auth.uid() is null
     or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can count stored cash' using errcode = '42501';
  end if;
  if v_counter_id is null then
    raise exception 'Your account must be linked to a team member before counting cash' using errcode = '42501';
  end if;
  if p_total_amount_lyd is null or v_total < 0 then
    raise exception 'Total cash counted must be zero or greater' using errcode = '22023';
  end if;
  if p_period_start is null or p_period_end is null then
    raise exception 'Cash period start and end are required' using errcode = '22023';
  end if;
  if p_period_start > p_period_end then
    raise exception 'Cash period start cannot be after its end' using errcode = '22023';
  end if;

  if p_client_submission_id is not null then
    select event.*
    into v_existing_event
    from public.cash_collection_events event
    where event.client_submission_id = p_client_submission_id;

    if found then
      if v_existing_event.cash_collection_id = p_collection_id
         and v_existing_event.event_type = 'counted'
         and v_existing_event.amount_lyd = v_total
         and v_existing_event.metadata ->> 'count_method' = 'combined_total'
         and v_existing_event.metadata ->> 'period_start' = p_period_start::text
         and v_existing_event.metadata ->> 'period_end' = p_period_end::text then
        return p_collection_id;
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

  v_collection_date := (v_cash.collected_at at time zone 'Africa/Tripoli')::date;
  if p_period_end > v_collection_date then
    raise exception 'Cash period cannot end after the cash was removed from the machine' using errcode = '22023';
  end if;

  update public.cash_collections
  set actual_cash_collected = v_total,
      cash_period_start = p_period_start,
      cash_period_end = p_period_end,
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

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'counted',
    now(),
    v_total,
    null,
    null,
    null,
    null,
    jsonb_build_object(
      'count_method', 'combined_total',
      'period_start', p_period_start,
      'period_end', p_period_end,
      'vms_reconciliation_deferred', true
    ),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.confirm_cash_count_simple_impl(uuid, numeric, date, date, uuid)
  from public, anon;
grant execute on function snacky_private.confirm_cash_count_simple_impl(uuid, numeric, date, date, uuid)
  to authenticated, service_role;

create or replace function public.confirm_cash_count_simple(
  p_collection_id uuid,
  p_total_amount_lyd numeric,
  p_period_start date,
  p_period_end date,
  p_client_submission_id uuid
)
returns uuid
language sql
security invoker
set search_path = public, auth, snacky_private
as $$
  select snacky_private.confirm_cash_count_simple_impl(
    p_collection_id,
    p_total_amount_lyd,
    p_period_start,
    p_period_end,
    p_client_submission_id
  );
$$;

revoke all on function public.confirm_cash_count_simple(uuid, numeric, date, date, uuid)
  from public, anon;
grant execute on function public.confirm_cash_count_simple(uuid, numeric, date, date, uuid)
  to authenticated, service_role;

select pg_catalog.pg_notify('pgrst', 'reload schema');
