-- Database-source finance synchronization for purchases and cash collections.
-- Finance Transactions is the money source of truth: every money-moving source row owns exactly one ledger row.

alter table public.purchase_orders
  add column if not exists currency text default 'LYD';

update public.purchase_orders
set currency = coalesce(nullif(trim(currency), ''), 'LYD')
where currency is null or trim(currency) = '';

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_purchase_id uuid,
  add column if not exists related_cash_collection_id uuid,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists currency text default 'LYD',
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists category text,
  add column if not exists location text,
  add column if not exists notes text,
  add column if not exists payment_method text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists related_location_id uuid,
  add column if not exists receipt_url text,
  add column if not exists transaction_status text default 'active',
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;

create or replace function public.finance_purchase_should_sync(p_purchase public.purchase_orders)
returns boolean
language sql
stable
as $$
  select coalesce(p_purchase.status, '') not in ('cancelled', 'voided')
     and coalesce(p_purchase.payment_status, 'paid') in ('paid', 'confirmed', 'saved')
$$;

create or replace function public.finance_cash_collection_should_sync(p_cash public.cash_collections)
returns boolean
language sql
stable
as $$
  select coalesce(p_cash.review_status, '') <> 'voided'
     and p_cash.actual_cash_collected is not null
$$;

create or replace function public.sync_purchase_to_financial_transaction(p_purchase_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase public.purchase_orders%rowtype;
  v_supplier_name text;
  v_lines_total numeric(12,2);
  v_amount numeric(12,2);
  v_account_key text;
  v_currency text;
  v_notes text;
  v_description text;
  v_transaction_id uuid;
begin
  select * into v_purchase
  from public.purchase_orders
  where id = p_purchase_id;

  if not found then
    raise exception 'Purchase % not found', p_purchase_id using errcode = 'P0002';
  end if;

  select nullif(trim(s.name), '') into v_supplier_name
  from public.suppliers s
  where s.id = v_purchase.supplier_id;

  select coalesce(sum(coalesce(pol.line_total_lyd, pol.line_total, pol.total_units * pol.unit_cost, pol.received_qty * pol.unit_cost, pol.ordered_qty * pol.unit_cost, 0)), 0)::numeric(12,2)
    into v_lines_total
  from public.purchase_order_lines pol
  where pol.purchase_order_id = p_purchase_id;

  v_amount := abs(coalesce(v_purchase.manual_total_lyd, nullif(v_purchase.total_amount, 0), nullif(v_purchase.calculated_total_lyd, 0), v_lines_total, 0))::numeric(12,2);
  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := coalesce(nullif(trim(v_purchase.currency), ''), case when lower(v_account_key) like '%usd%' then 'USD' else 'LYD' end, 'LYD');
  v_notes := concat_ws(' / ', nullif(trim(v_purchase.notes), ''), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);
  v_description := concat_ws(' - ', 'Purchase from ' || coalesce(v_supplier_name, 'supplier'), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or ft.related_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_purchase_should_sync(v_purchase) then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source purchase no longer qualifies for finance sync'),
          source_type = 'purchase',
          source_id = p_purchase_id,
          linked_purchase_id = p_purchase_id,
          related_purchase_id = p_purchase_id,
          updated_at = now()
      where id = v_transaction_id;
    end if;
    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      location, description, notes, amount, signed_amount, currency, account_id, account_key,
      transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
      payment_method, receipt_url, transaction_status, review_status, needs_review, is_void,
      counterparty_text, paid_to_text, payee_text, payer_text, linked_purchase_id, related_purchase_id,
      source_type, source_id, created_by, updated_at
    ) values (
      coalesce(v_purchase.order_date, current_date), coalesce(v_purchase.order_date, current_date)::timestamptz,
      'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', null,
      coalesce(nullif(v_description, ''), 'Purchase'), nullif(v_notes, ''), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      v_purchase.payment_method, v_purchase.receipt_url, 'active', 'confirmed', false, false,
      v_supplier_name, v_supplier_name, v_supplier_name, null, p_purchase_id, p_purchase_id,
      'purchase', p_purchase_id, v_purchase.created_by, now()
    ) returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = coalesce(v_purchase.order_date, current_date),
        transaction_datetime = coalesce(v_purchase.order_date, current_date)::timestamptz,
        direction = 'money_out',
        transaction_kind = 'product_purchase',
        transaction_type = 'Products Restocking',
        category = 'Products Restocking',
        location = null,
        description = coalesce(nullif(v_description, ''), 'Purchase'),
        notes = nullif(v_notes, ''),
        amount = v_amount,
        signed_amount = -abs(v_amount),
        currency = v_currency,
        account_id = v_account_key,
        account_key = v_account_key,
        transaction_effect = 'expense',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Inventory',
        final_bucket = 'Products Restocking',
        payment_method = v_purchase.payment_method,
        receipt_url = v_purchase.receipt_url,
        transaction_status = 'active',
        review_status = 'confirmed',
        needs_review = false,
        is_void = false,
        voided_at = null,
        void_reason = null,
        counterparty_text = v_supplier_name,
        paid_to_text = v_supplier_name,
        payee_text = v_supplier_name,
        payer_text = null,
        linked_purchase_id = p_purchase_id,
        related_purchase_id = p_purchase_id,
        source_type = 'purchase',
        source_id = p_purchase_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by ' || v_transaction_id::text),
      linked_purchase_id = null,
      related_purchase_id = null,
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_purchase_id = p_purchase_id
      or ft.related_purchase_id = p_purchase_id
      or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id));

  return v_transaction_id;
end;
$$;

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
  v_notes := concat_ws(' - ', 'Cash collection', coalesce(v_machine_name, v_machine_code, p_cash_collection_id::text), v_location_name, case when nullif(trim(v_cash.cash_bag_id), '') is not null then 'Bag ' || v_cash.cash_bag_id end);

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or ft.related_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_cash_collection_should_sync(v_cash) then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source cash collection no longer qualifies for finance sync'),
          source_type = 'cash_collection',
          source_id = p_cash_collection_id,
          linked_cash_collection_id = p_cash_collection_id,
          related_cash_collection_id = p_cash_collection_id,
          updated_at = now()
      where id = v_transaction_id;
    end if;
    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      location, description, notes, amount, signed_amount, currency, account_id, account_key,
      transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
      payment_method, transaction_status, review_status, needs_review, is_void,
      counterparty_text, payer_text, paid_to_text, payee_text, related_cash_collection_id,
      linked_cash_collection_id, related_route_id, related_machine_id, source_type, source_id,
      created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_location, v_notes, v_notes, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'cash', 'active', 'confirmed', false, false,
      'Cash customers', 'Cash customers', null, null, p_cash_collection_id, p_cash_collection_id,
      v_cash.route_id, v_cash.machine_id, 'cash_collection', p_cash_collection_id, v_cash.operator_id, now()
    ) returning id into v_transaction_id;
  else
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
        transaction_status = 'active',
        review_status = 'confirmed',
        needs_review = false,
        is_void = false,
        voided_at = null,
        void_reason = null,
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
  end if;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance transaction superseded by ' || v_transaction_id::text),
      linked_cash_collection_id = null,
      related_cash_collection_id = null,
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_cash_collection_id = p_cash_collection_id
      or ft.related_cash_collection_id = p_cash_collection_id
      or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id));

  return v_transaction_id;
end;
$$;

create or replace function public.ensure_purchase_finance_transaction(p_purchase_id uuid)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select public.sync_purchase_to_financial_transaction(p_purchase_id)
$$;

create or replace function public.ensure_cash_collection_finance_transaction(p_cash_collection_id uuid)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select public.sync_cash_collection_to_financial_transaction(p_cash_collection_id)
$$;

create or replace function public.snacky_purchase_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.sync_purchase_to_financial_transaction(new.id);
  return new;
end;
$$;

create or replace function public.snacky_cash_collection_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.sync_cash_collection_to_financial_transaction(new.id);
  return new;
end;
$$;

drop trigger if exists trg_snacky_purchase_finance_sync on public.purchase_orders;
create trigger trg_snacky_purchase_finance_sync
after insert or update on public.purchase_orders
for each row
execute function public.snacky_purchase_finance_sync_trigger();

drop trigger if exists trg_snacky_cash_collection_finance_sync on public.cash_collections;
create trigger trg_snacky_cash_collection_finance_sync
after insert or update on public.cash_collections
for each row
execute function public.snacky_cash_collection_finance_sync_trigger();

drop function if exists public.backfill_missing_finance_transactions();

create function public.backfill_missing_finance_transactions()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_cash record;
  v_purchase_checked integer := 0;
  v_purchase_synced integer := 0;
  v_cash_checked integer := 0;
  v_cash_synced integer := 0;
  v_transaction_id uuid;
begin
  for v_purchase in
    select po.*
    from public.purchase_orders po
    where public.finance_purchase_should_sync(po)
  loop
    v_purchase_checked := v_purchase_checked + 1;
    v_transaction_id := public.sync_purchase_to_financial_transaction(v_purchase.id);
    if v_transaction_id is not null then
      v_purchase_synced := v_purchase_synced + 1;
    end if;
  end loop;

  for v_cash in
    select cc.*
    from public.cash_collections cc
    where public.finance_cash_collection_should_sync(cc)
  loop
    v_cash_checked := v_cash_checked + 1;
    v_transaction_id := public.sync_cash_collection_to_financial_transaction(v_cash.id);
    if v_transaction_id is not null then
      v_cash_synced := v_cash_synced + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'purchase_records_checked', v_purchase_checked,
    'purchase_finance_transactions_synced', v_purchase_synced,
    'cash_collections_checked', v_cash_checked,
    'cash_collection_finance_transactions_synced', v_cash_synced
  );
end;
$$;

-- Backfill all existing qualifying records; no recency window.
select public.backfill_missing_finance_transactions();

-- Collapse duplicate source links before adding hard uniqueness guarantees.
with duplicate_source_rows as (
  select id,
         row_number() over (partition by source_type, source_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where source_type is not null
    and source_id is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate finance source link removed by finance sync hardening'),
    source_type = 'manual',
    source_id = null,
    linked_purchase_id = null,
    related_purchase_id = null,
    linked_cash_collection_id = null,
    related_cash_collection_id = null,
    updated_at = now()
from duplicate_source_rows d
where ft.id = d.id
  and d.rn > 1;

with duplicate_purchase_rows as (
  select id,
         row_number() over (partition by linked_purchase_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_purchase_id is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance link removed by finance sync hardening'),
    source_type = 'manual',
    source_id = null,
    linked_purchase_id = null,
    related_purchase_id = null,
    updated_at = now()
from duplicate_purchase_rows d
where ft.id = d.id
  and d.rn > 1;

with duplicate_cash_rows as (
  select id,
         row_number() over (partition by linked_cash_collection_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_cash_collection_id is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance link removed by finance sync hardening'),
    source_type = 'manual',
    source_id = null,
    linked_cash_collection_id = null,
    related_cash_collection_id = null,
    updated_at = now()
from duplicate_cash_rows d
where ft.id = d.id
  and d.rn > 1;

create unique index if not exists financial_transactions_source_type_source_id_uidx
  on public.financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;

create unique index if not exists financial_transactions_linked_purchase_id_uidx
  on public.financial_transactions(linked_purchase_id)
  where linked_purchase_id is not null;

create unique index if not exists financial_transactions_linked_cash_collection_id_uidx
  on public.financial_transactions(linked_cash_collection_id)
  where linked_cash_collection_id is not null;

revoke all on function public.sync_purchase_to_financial_transaction(uuid) from public;
grant execute on function public.sync_purchase_to_financial_transaction(uuid) to authenticated;
revoke all on function public.sync_cash_collection_to_financial_transaction(uuid) from public;
grant execute on function public.sync_cash_collection_to_financial_transaction(uuid) to authenticated;
revoke all on function public.backfill_missing_finance_transactions() from public;
grant execute on function public.backfill_missing_finance_transactions() to authenticated;

select pg_notify('pgrst', 'reload schema');
