-- Harden the live finance sync pipeline for new purchases and cash collections.
-- Backfills repair old data; these RPCs/triggers protect every new save.

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists source_sheet text,
  add column if not exists source_row integer,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_purchase_id uuid,
  add column if not exists related_cash_collection_id uuid,
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists category text,
  add column if not exists direction text,
  add column if not exists location text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists payment_method text,
  add column if not exists receipt_url text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists currency text default 'LYD',
  add column if not exists notes text,
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists status_reason text,
  add column if not exists transaction_status text default 'active';

create or replace function public.snacky_finance_account_currency(p_account_key text)
returns text
language sql
immutable
as $$
  select case when lower(coalesce(p_account_key, '')) like '%usd%' then 'USD' else 'LYD' end
$$;

create or replace function public.ensure_purchase_finance_transaction(p_purchase_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_supplier_name text;
  v_description text;
  v_transaction_id uuid;
begin
  select po.*, s.name as supplier_name
    into v_purchase
  from public.purchase_orders po
  left join public.suppliers s on s.id = po.supplier_id
  where po.id = p_purchase_id;

  if not found then
    raise exception 'Purchase % not found', p_purchase_id using errcode = 'P0002';
  end if;

  if coalesce(v_purchase.status, '') in ('cancelled', 'voided') then
    return null;
  end if;

  v_amount := abs(coalesce(v_purchase.manual_total_lyd, v_purchase.total_amount, v_purchase.calculated_total_lyd, 0));
  if v_amount <= 0 then
    return null;
  end if;

  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := public.snacky_finance_account_currency(v_account_key);
  v_supplier_name := nullif(trim(coalesce(v_purchase.supplier_name, '')), '');
  v_description := concat_ws(
    ' - ',
    'Purchase from ' || coalesce(v_supplier_name, 'supplier'),
    case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || v_purchase.receipt_number end,
    case when nullif(trim(coalesce(v_purchase.payment_status, '')), '') is not null then 'Payment ' || v_purchase.payment_status end,
    nullif(trim(coalesce(v_purchase.notes, '')), '')
  );

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or ft.related_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review,
      transaction_status, is_void, voided_at, void_reason, payment_method, receipt_url, payer_text,
      paid_to_text, payee_text, counterparty_text, linked_purchase_id, related_purchase_id, source_type,
      source_id, created_by, updated_at
    ) values (
      coalesce(v_purchase.order_date, now()::date), coalesce(v_purchase.order_date, now()::date)::timestamptz,
      'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', v_description,
      coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      'confirmed', false, 'active', false, null, null, v_purchase.payment_method, v_purchase.receipt_url,
      null, v_supplier_name, v_supplier_name, v_supplier_name, p_purchase_id, p_purchase_id, 'purchase',
      p_purchase_id, v_purchase.created_by, now()
    )
    returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = coalesce(v_purchase.order_date, now()::date),
        transaction_datetime = coalesce(v_purchase.order_date, now()::date)::timestamptz,
        direction = 'money_out',
        transaction_kind = 'product_purchase',
        transaction_type = 'Products Restocking',
        category = 'Products Restocking',
        description = v_description,
        notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
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
        review_status = 'confirmed',
        needs_review = false,
        transaction_status = 'active',
        is_void = false,
        voided_at = null,
        void_reason = null,
        payment_method = v_purchase.payment_method,
        receipt_url = v_purchase.receipt_url,
        payer_text = null,
        paid_to_text = v_supplier_name,
        payee_text = v_supplier_name,
        counterparty_text = v_supplier_name,
        linked_purchase_id = p_purchase_id,
        related_purchase_id = p_purchase_id,
        source_type = 'purchase',
        source_id = p_purchase_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

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

  v_amount := abs(coalesce(v_cash.actual_cash_collected, 0));
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''));
  v_description := 'Cash collection from ' || coalesce(nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''), nullif(trim(v_cash.location_name), ''), p_cash_collection_id::text);
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
      v_cash.route_id, v_cash.machine_id, v_location, 'cash_collection', p_cash_collection_id,
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
        related_route_id = v_cash.route_id,
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

create or replace function public.snacky_purchase_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.ensure_purchase_finance_transaction(new.id);
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
  perform public.ensure_cash_collection_finance_transaction(new.id);
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

update public.financial_transactions
set source_type = 'manual', updated_at = now()
where source_type is null
  and source_sheet is null
  and linked_purchase_id is null
  and linked_cash_collection_id is null
  and related_purchase_id is null
  and related_cash_collection_id is null;

update public.financial_transactions
set source_type = 'import', updated_at = now()
where source_type is null
  and source_sheet is not null;

create or replace function public.finance_health_report()
returns jsonb
language plpgsql
security definer
set search_path = public, information_schema, pg_catalog
as $$
declare
  v_expected text[] := array[
    'id', 'transaction_date', 'transaction_datetime', 'direction', 'transaction_kind', 'transaction_type',
    'location', 'description', 'notes', 'amount', 'signed_amount', 'currency', 'account_id', 'account_key',
    'transaction_effect', 'source_account_id', 'destination_account_id', 'import_status', 'category', 'bucket',
    'final_bucket', 'payment_method', 'transaction_status', 'review_status', 'needs_review', 'source_sheet',
    'source_row', 'related_purchase_id', 'linked_purchase_id', 'source_type', 'source_id',
    'related_cash_collection_id', 'linked_cash_collection_id', 'related_route_id', 'related_machine_id',
    'related_location_id', 'receipt_url', 'counterparty_text', 'payer_text', 'paid_to_text', 'is_void',
    'voided_at', 'void_reason', 'created_at', 'updated_at', 'created_by'
  ];
  v_missing text[];
  v_purchase_count integer;
  v_cash_count integer;
  v_transaction_count integer;
  v_linked_purchase_count integer;
  v_linked_cash_count integer;
  v_missing_purchase_count integer;
  v_missing_cash_count integer;
begin
  select coalesce(array_agg(expected_column order by expected_column), array[]::text[])
  into v_missing
  from unnest(v_expected) as expected_column
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'financial_transactions'
      and c.column_name = expected_column
  );

  select count(*)::integer into v_purchase_count
  from public.purchase_orders po
  where coalesce(po.status, '') not in ('cancelled', 'voided')
    and abs(coalesce(po.manual_total_lyd, po.total_amount, po.calculated_total_lyd, 0)) > 0;

  select count(*)::integer into v_cash_count
  from public.cash_collections cc
  where cc.actual_cash_collected is not null
    and coalesce(cc.review_status, '') <> 'voided';

  select count(*)::integer into v_transaction_count from public.financial_transactions;

  select count(*)::integer into v_linked_purchase_count
  from public.purchase_orders po
  where coalesce(po.status, '') not in ('cancelled', 'voided')
    and abs(coalesce(po.manual_total_lyd, po.total_amount, po.calculated_total_lyd, 0)) > 0
    and exists (
      select 1 from public.financial_transactions ft
      where (ft.linked_purchase_id = po.id or ft.related_purchase_id = po.id or (ft.source_type = 'purchase' and ft.source_id = po.id))
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  select count(*)::integer into v_linked_cash_count
  from public.cash_collections cc
  where cc.actual_cash_collected is not null
    and coalesce(cc.review_status, '') <> 'voided'
    and exists (
      select 1 from public.financial_transactions ft
      where (ft.linked_cash_collection_id = cc.id or ft.related_cash_collection_id = cc.id or (ft.source_type = 'cash_collection' and ft.source_id = cc.id))
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  v_missing_purchase_count := greatest(v_purchase_count - v_linked_purchase_count, 0);
  v_missing_cash_count := greatest(v_cash_count - v_linked_cash_count, 0);

  return jsonb_build_object(
    'schema_status', case when cardinality(v_missing) = 0 then 'ok' else 'missing_columns' end,
    'missing_columns', to_jsonb(v_missing),
    'transactions_count', v_transaction_count,
    'purchases_count', v_purchase_count,
    'cash_collections_count', v_cash_count,
    'purchases_with_linked_finance_transaction', v_linked_purchase_count,
    'cash_collections_with_linked_finance_transaction', v_linked_cash_count,
    'purchases_missing_finance_transaction', v_missing_purchase_count,
    'cash_collections_missing_finance_transaction', v_missing_cash_count,
    'failed_sync_count', v_missing_purchase_count + v_missing_cash_count,
    'source_types_in_overview', to_jsonb(array['purchase', 'cash_collection', 'manual', 'import']),
    'schema_columns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'column_name', c.column_name,
        'data_type', c.data_type,
        'is_nullable', c.is_nullable,
        'column_default', c.column_default,
        'ordinal_position', c.ordinal_position
      ) order by c.ordinal_position), '[]'::jsonb)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'financial_transactions'
    ),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'constraint_name', tc.constraint_name,
        'constraint_type', tc.constraint_type,
        'definition', coalesce(cc.check_clause, '')
      ) order by tc.constraint_name), '[]'::jsonb)
      from information_schema.table_constraints tc
      left join information_schema.check_constraints cc on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
      where tc.table_schema = 'public' and tc.table_name = 'financial_transactions'
    ),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'indexname', i.indexname,
        'indexdef', i.indexdef
      ) order by i.indexname), '[]'::jsonb)
      from pg_indexes i
      where i.schemaname = 'public' and i.tablename = 'financial_transactions'
    )
  );
end;
$$;

revoke all on function public.ensure_purchase_finance_transaction(uuid) from public;
grant execute on function public.ensure_purchase_finance_transaction(uuid) to authenticated;
revoke all on function public.ensure_cash_collection_finance_transaction(uuid) from public;
grant execute on function public.ensure_cash_collection_finance_transaction(uuid) to authenticated;
revoke all on function public.finance_health_report() from public;
grant execute on function public.finance_health_report() to authenticated;

select pg_notify('pgrst', 'reload schema');
