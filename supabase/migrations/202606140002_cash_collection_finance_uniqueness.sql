-- Makes cash-collection finance sync keep exactly one active linked
-- transaction per cash collection while preserving voided history.

drop index if exists public.financial_transactions_cash_collection_source_uidx;
drop index if exists public.financial_transactions_linked_cash_collection_id_uidx;
drop index if exists public.idx_financial_transactions_cash_collection;
drop index if exists public.financial_transactions_unique_source;
drop index if exists public.financial_transactions_unique_linked_cash_collection_active;
drop index if exists public.idx_financial_transactions_cash_collection_related;

alter table public.financial_transactions
  drop constraint if exists financial_transactions_linked_cash_collection_id_key;

with normalized_cash_links as (
  select
    ft.id,
    coalesce(
      ft.linked_cash_collection_id,
      case when ft.source_type = 'cash_collection' and ft.source_id is not null then ft.source_id end,
      ft.related_cash_collection_id
    ) as cash_collection_id
  from public.financial_transactions ft
  where ft.transaction_kind = 'cash_collection'
     or ft.source_type = 'cash_collection'
     or ft.linked_cash_collection_id is not null
     or ft.related_cash_collection_id is not null
)
update public.financial_transactions ft
set source_type = 'cash_collection',
    source_id = normalized.cash_collection_id,
    linked_cash_collection_id = normalized.cash_collection_id,
    related_cash_collection_id = case
      when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false
        then normalized.cash_collection_id
      else null
    end,
    updated_at = now()
from normalized_cash_links normalized
where normalized.id = ft.id
  and normalized.cash_collection_id is not null
  and (
    ft.source_type is distinct from 'cash_collection'
    or ft.source_id is distinct from normalized.cash_collection_id
    or ft.linked_cash_collection_id is distinct from normalized.cash_collection_id
    or ft.related_cash_collection_id is distinct from case
      when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false
        then normalized.cash_collection_id
      else null
    end
  );

update public.financial_transactions
set is_void = true,
    voided_at = coalesce(voided_at, now()),
    void_reason = coalesce(void_reason, 'Duplicate cash collection finance sync'),
    status_reason = coalesce(status_reason, 'Duplicate cash collection finance sync'),
    related_cash_collection_id = null,
    updated_at = now()
where source_type = 'cash_collection'
  and transaction_status = 'voided'
  and coalesce(is_void, false) = false;

with ranked_cash_rows as (
  select
    ft.id,
    coalesce(
      ft.linked_cash_collection_id,
      case when ft.source_type = 'cash_collection' and ft.source_id is not null then ft.source_id end,
      ft.related_cash_collection_id
    ) as cash_collection_id,
    row_number() over (
      partition by coalesce(
        ft.linked_cash_collection_id,
        case when ft.source_type = 'cash_collection' and ft.source_id is not null then ft.source_id end,
        ft.related_cash_collection_id
      )
      order by
        case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
        ft.created_at desc nulls last,
        ft.id desc
    ) as rn
  from public.financial_transactions ft
  where (
      ft.transaction_kind = 'cash_collection'
      or ft.source_type = 'cash_collection'
      or ft.linked_cash_collection_id is not null
      or ft.related_cash_collection_id is not null
    )
    and coalesce(
      ft.linked_cash_collection_id,
      case when ft.source_type = 'cash_collection' and ft.source_id is not null then ft.source_id end,
      ft.related_cash_collection_id
    ) is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance sync'),
    status_reason = coalesce(ft.status_reason, 'Duplicate cash collection finance sync'),
    source_type = 'cash_collection',
    source_id = ranked.cash_collection_id,
    linked_cash_collection_id = ranked.cash_collection_id,
    related_cash_collection_id = null,
    updated_at = now()
from ranked_cash_rows ranked
where ranked.id = ft.id
  and ranked.rn > 1
  and (coalesce(ft.transaction_status, 'active') = 'active' or coalesce(ft.is_void, false) = false);

create unique index if not exists financial_transactions_unique_source
  on public.financial_transactions(source_type, source_id)
  where source_type = 'cash_collection'
    and source_id is not null
    and coalesce(transaction_status, 'active') = 'active'
    and coalesce(is_void, false) = false;

create unique index if not exists financial_transactions_unique_linked_cash_collection_active
  on public.financial_transactions(linked_cash_collection_id)
  where linked_cash_collection_id is not null
    and coalesce(transaction_status, 'active') = 'active'
    and coalesce(is_void, false) = false;

create index if not exists idx_financial_transactions_cash_collection_related
  on public.financial_transactions(related_cash_collection_id)
  where related_cash_collection_id is not null;

create or replace function public.sync_cash_collection_to_financial_transaction(p_cash_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_machine_name text;
  v_machine_code text;
  v_location_name text;
  v_amount numeric(12,2);
  v_datetime timestamptz;
  v_location text;
  v_notes text;
  v_transaction_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('cash_collection_finance_sync'), hashtext(p_cash_collection_id::text));

  select * into v_cash
  from public.cash_collections
  where id = p_cash_collection_id;

  if not found then
    raise exception 'Cash collection % not found', p_cash_collection_id using errcode = 'P0002';
  end if;

  select nullif(trim(m.name), ''), nullif(trim(m.machine_code), ''), nullif(trim(l.name), '')
    into v_machine_name, v_machine_code, v_location_name
  from public.machines m
  left join public.locations l on l.id = m.location_id
  where m.id = v_cash.machine_id;

  v_amount := abs(coalesce(v_cash.actual_cash_collected, 0))::numeric(12,2);
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(v_location_name, v_machine_name, v_machine_code);
  v_notes := concat_ws(
    ' - ',
    'Cash collection',
    coalesce(v_machine_name, v_machine_code, p_cash_collection_id::text),
    v_location_name,
    case when nullif(trim(v_cash.cash_bag_id), '') is not null then 'Bag ' || v_cash.cash_bag_id end
  );

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
     or ft.related_cash_collection_id = p_cash_collection_id
  order by
    case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
    ft.created_at desc nulls last,
    ft.id desc
  limit 1;

  if not public.finance_cash_collection_should_sync(v_cash) then
    update public.financial_transactions ft
    set transaction_status = 'voided',
        is_void = true,
        voided_at = coalesce(ft.voided_at, now()),
        void_reason = coalesce(ft.void_reason, 'Source cash collection no longer qualifies for finance sync'),
        status_reason = coalesce(ft.status_reason, 'Source cash collection no longer qualifies for finance sync'),
        source_type = 'cash_collection',
        source_id = p_cash_collection_id,
        linked_cash_collection_id = p_cash_collection_id,
        related_cash_collection_id = null,
        import_status = 'confirmed',
        updated_at = now()
    where ft.linked_cash_collection_id = p_cash_collection_id
       or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
       or ft.related_cash_collection_id = p_cash_collection_id;

    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    begin
      insert into public.financial_transactions (
        transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
        location, description, notes, amount, signed_amount, currency, account_id, account_key,
        transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
        payment_method, import_status, transaction_status, review_status, needs_review, is_void,
        counterparty_text, payer_text, paid_to_text, payee_text,
        related_cash_collection_id, linked_cash_collection_id, related_route_id, related_machine_id, source_type, source_id,
        created_by, updated_at
      ) values (
        v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
        v_location, v_notes, v_notes, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
        'income', null, null, 'Revenue', 'Revenue', 'cash', 'confirmed', 'active', 'confirmed', false, false,
        'Cash customers', 'Cash customers', null, null,
        p_cash_collection_id, p_cash_collection_id, v_cash.route_id, v_cash.machine_id, 'cash_collection', p_cash_collection_id,
        v_cash.operator_id, now()
      )
      returning id into v_transaction_id;
    exception
      when unique_violation then
        select ft.id into v_transaction_id
        from public.financial_transactions ft
        where ft.linked_cash_collection_id = p_cash_collection_id
           or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
           or ft.related_cash_collection_id = p_cash_collection_id
        order by
          case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
          ft.created_at desc nulls last,
          ft.id desc
        limit 1;
    end;
  end if;

  update public.financial_transactions
  set transaction_date = v_datetime::date,
      transaction_datetime = v_datetime,
      direction = 'money_in',
      transaction_kind = 'cash_collection',
      transaction_type = 'Revenue',
      category = 'Revenue',
      location = v_location,
      description = v_notes,
      notes = v_notes,
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
      payment_method = 'cash',
      import_status = 'confirmed',
      transaction_status = 'active',
      review_status = 'confirmed',
      needs_review = false,
      is_void = false,
      voided_at = null,
      void_reason = null,
      status_reason = null,
      counterparty_text = 'Cash customers',
      payer_text = 'Cash customers',
      paid_to_text = null,
      payee_text = null,
      related_cash_collection_id = p_cash_collection_id,
      linked_cash_collection_id = p_cash_collection_id,
      related_route_id = v_cash.route_id,
      related_machine_id = v_cash.machine_id,
      source_type = 'cash_collection',
      source_id = p_cash_collection_id,
      updated_at = now()
  where id = v_transaction_id;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance sync'),
      status_reason = coalesce(ft.status_reason, 'Duplicate cash collection finance sync'),
      source_type = 'cash_collection',
      source_id = p_cash_collection_id,
      linked_cash_collection_id = p_cash_collection_id,
      related_cash_collection_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (
      ft.linked_cash_collection_id = p_cash_collection_id
      or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
      or ft.related_cash_collection_id = p_cash_collection_id
    )
    and (coalesce(ft.transaction_status, 'active') = 'active' or coalesce(ft.is_void, false) = false);

  return v_transaction_id;
end;
$$;

revoke all on function public.sync_cash_collection_to_financial_transaction(uuid) from public;
grant execute on function public.sync_cash_collection_to_financial_transaction(uuid) to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
