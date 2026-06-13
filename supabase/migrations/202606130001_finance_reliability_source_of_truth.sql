-- Finance reliability contract:
-- 1. Every non-voided purchase with value must be represented in financial_transactions.
-- 2. Every counted cash collection must be represented in financial_transactions.
-- 3. Source-generated finance rows must never be hidden by ignored/skipped import states.
-- 4. Missing categories fall back to Uncategorized.

update public.financial_transactions
set category = 'Uncategorized',
    updated_at = now()
where category is null
   or btrim(category) = '';

update public.financial_transactions
set final_bucket = coalesce(nullif(btrim(final_bucket), ''), nullif(btrim(category), ''), 'Uncategorized'),
    updated_at = now()
where final_bucket is null
   or btrim(final_bucket) = '';

update public.financial_transactions
set transaction_type = coalesce(nullif(btrim(transaction_type), ''), nullif(btrim(category), ''), nullif(btrim(final_bucket), ''), 'Uncategorized'),
    updated_at = now()
where transaction_type is null
   or btrim(transaction_type) = '';

update public.financial_transactions
set direction = 'money_out',
    amount = abs(coalesce(amount, signed_amount, 0)),
    signed_amount = -abs(coalesce(amount, signed_amount, 0)),
    transaction_kind = 'product_purchase',
    transaction_type = 'Products Restocking',
    category = 'Products Restocking',
    bucket = coalesce(nullif(btrim(bucket), ''), 'Inventory'),
    final_bucket = 'Products Restocking',
    transaction_effect = 'expense',
    import_status = 'confirmed',
    review_status = coalesce(nullif(btrim(review_status), ''), 'confirmed'),
    needs_review = false,
    transaction_status = case
      when coalesce(is_void, false) or voided_at is not null then 'voided'
      else 'active'
    end,
    updated_at = now()
where linked_purchase_id is not null
   or (source_type = 'purchase' and source_id is not null)
   or related_purchase_id is not null;

update public.financial_transactions
set direction = 'money_in',
    amount = abs(coalesce(amount, signed_amount, 0)),
    signed_amount = abs(coalesce(amount, signed_amount, 0)),
    transaction_kind = 'cash_collection',
    transaction_type = 'Revenue',
    category = 'Revenue',
    bucket = coalesce(nullif(btrim(bucket), ''), 'Revenue'),
    final_bucket = 'Revenue',
    transaction_effect = 'income',
    import_status = 'confirmed',
    review_status = coalesce(nullif(btrim(review_status), ''), 'confirmed'),
    needs_review = false,
    transaction_status = case
      when coalesce(is_void, false) or voided_at is not null then 'voided'
      else 'active'
    end,
    updated_at = now()
where linked_cash_collection_id is not null
   or (source_type = 'cash_collection' and source_id is not null)
   or related_cash_collection_id is not null;

create or replace function public.finance_purchase_should_sync(p_purchase public.purchase_orders)
returns boolean
language sql
stable
as $$
  select coalesce(p_purchase.status, '') not in ('cancelled', 'voided')
     and greatest(
       abs(coalesce(p_purchase.manual_total_lyd, 0)),
       abs(coalesce(p_purchase.total_amount, 0)),
       abs(coalesce(p_purchase.calculated_total_lyd, 0)),
       0
     ) > 0
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

  v_amount := abs(coalesce(v_purchase.manual_total_lyd, nullif(v_purchase.total_amount, 0), nullif(v_purchase.calculated_total_lyd, 0), nullif(v_lines_total, 0), 0))::numeric(12,2);
  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := coalesce(nullif(trim(v_purchase.currency), ''), case when lower(v_account_key) like '%usd%' then 'USD' else 'LYD' end, 'LYD');
  v_notes := concat_ws(' / ', nullif(trim(v_purchase.notes), ''), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end, 'Payment status ' || coalesce(nullif(trim(v_purchase.payment_status), ''), 'unknown'));
  v_description := concat_ws(' - ', 'Purchase from ' || coalesce(v_supplier_name, 'supplier'), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
     or ft.related_purchase_id = p_purchase_id
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_purchase_should_sync(v_purchase) or v_amount <= 0 then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source purchase no longer qualifies for finance sync'),
          source_type = 'purchase',
          source_id = p_purchase_id,
          linked_purchase_id = p_purchase_id,
          import_status = 'confirmed',
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
      payment_method, receipt_url, import_status, transaction_status, review_status, needs_review, is_void,
      counterparty_text, paid_to_text, payee_text, payer_text, linked_purchase_id,
      source_type, source_id, created_by, updated_at
    ) values (
      coalesce(v_purchase.order_date, current_date), coalesce(v_purchase.order_date, current_date)::timestamptz,
      'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', null,
      coalesce(nullif(v_description, ''), 'Purchase'), coalesce(nullif(v_notes, ''), coalesce(nullif(v_description, ''), 'Purchase')), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      v_purchase.payment_method, v_purchase.receipt_url, 'confirmed', 'active', 'confirmed', false, false,
      v_supplier_name, v_supplier_name, v_supplier_name, null, p_purchase_id,
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
        notes = coalesce(nullif(v_notes, ''), coalesce(nullif(v_description, ''), 'Purchase')),
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
        import_status = 'confirmed',
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
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_purchase_id = p_purchase_id
      or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
      or ft.related_purchase_id = p_purchase_id);

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
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
     or ft.related_cash_collection_id = p_cash_collection_id
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
          import_status = 'confirmed',
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
      payment_method, import_status, transaction_status, review_status, needs_review, is_void,
      counterparty_text, payer_text, paid_to_text, payee_text,
      linked_cash_collection_id, related_route_id, related_machine_id, source_type, source_id,
      created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_location, v_notes, v_notes, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'cash', 'confirmed', 'active', 'confirmed', false, false,
      'Cash customers', 'Cash customers', null, null,
      p_cash_collection_id, v_cash.route_id, v_cash.machine_id, 'cash_collection', p_cash_collection_id,
      v_cash.operator_id, now()
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
        import_status = 'confirmed',
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
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_cash_collection_id = p_cash_collection_id
      or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
      or ft.related_cash_collection_id = p_cash_collection_id);

  return v_transaction_id;
end;
$$;

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
    'transaction_effect', 'source_account_id', 'destination_account_id', 'category', 'bucket', 'final_bucket',
    'payment_method', 'transaction_status', 'review_status', 'needs_review', 'source_type', 'source_id',
    'linked_purchase_id', 'linked_cash_collection_id', 'related_cash_collection_id', 'related_purchase_id',
    'related_route_id', 'related_machine_id', 'receipt_url', 'counterparty_text', 'payer_text', 'paid_to_text',
    'payee_text', 'is_void', 'voided_at', 'void_reason', 'created_at', 'updated_at', 'created_by'
  ];
  v_missing text[];
  v_purchase_count integer;
  v_cash_count integer;
  v_transaction_count integer;
  v_linked_purchase_count integer;
  v_linked_cash_count integer;
  v_missing_purchase_count integer;
  v_missing_cash_count integer;
  v_broken_link_count integer;
  v_balance_inconsistency_count integer;
  v_missing_category_count integer;
  v_ignored_source_count integer;
begin
  select coalesce(array_agg(expected_column order by expected_column), array[]::text[])
  into v_missing
  from unnest(v_expected) as expected_column
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'financial_transactions'
      and c.column_name = expected_column
  );

  select count(*)::integer into v_purchase_count
  from public.purchase_orders po
  where public.finance_purchase_should_sync(po);

  select count(*)::integer into v_cash_count
  from public.cash_collections cc
  where public.finance_cash_collection_should_sync(cc);

  select count(*)::integer into v_transaction_count from public.financial_transactions;

  select count(*)::integer
  into v_linked_purchase_count
  from public.purchase_orders po
  where public.finance_purchase_should_sync(po)
    and exists (
      select 1
      from public.financial_transactions ft
      where ft.source_type = 'purchase'
        and ft.source_id = po.id
        and ft.linked_purchase_id = po.id
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  select count(*)::integer
  into v_linked_cash_count
  from public.cash_collections cc
  where public.finance_cash_collection_should_sync(cc)
    and exists (
      select 1
      from public.financial_transactions ft
      where ft.source_type = 'cash_collection'
        and ft.source_id = cc.id
        and ft.linked_cash_collection_id = cc.id
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  v_missing_purchase_count := greatest(v_purchase_count - v_linked_purchase_count, 0);
  v_missing_cash_count := greatest(v_cash_count - v_linked_cash_count, 0);

  select count(*)::integer
  into v_broken_link_count
  from public.financial_transactions ft
  where coalesce(ft.transaction_status, 'active') = 'active'
    and coalesce(ft.is_void, false) = false
    and (
      (
        ft.source_type = 'purchase'
        and (
          ft.source_id is null
          or ft.linked_purchase_id is null
          or ft.source_id <> ft.linked_purchase_id
          or not exists (select 1 from public.purchase_orders po where po.id = coalesce(ft.linked_purchase_id, ft.source_id))
        )
      )
      or (
        ft.source_type = 'cash_collection'
        and (
          ft.source_id is null
          or ft.linked_cash_collection_id is null
          or ft.source_id <> ft.linked_cash_collection_id
          or not exists (select 1 from public.cash_collections cc where cc.id = coalesce(ft.linked_cash_collection_id, ft.source_id))
        )
      )
    );

  select count(*)::integer
  into v_balance_inconsistency_count
  from public.financial_transactions ft
  where coalesce(ft.transaction_status, 'active') = 'active'
    and coalesce(ft.is_void, false) = false
    and (
      (
        ft.source_type = 'purchase'
        and (
          ft.direction <> 'money_out'
          or coalesce(ft.transaction_effect, '') <> 'expense'
          or coalesce(ft.signed_amount, 0) > 0
          or abs(coalesce(ft.amount, 0)) <> abs(coalesce(ft.signed_amount, 0))
        )
      )
      or (
        ft.source_type = 'cash_collection'
        and (
          ft.direction <> 'money_in'
          or coalesce(ft.transaction_effect, '') <> 'income'
          or coalesce(ft.signed_amount, 0) < 0
          or abs(coalesce(ft.amount, 0)) <> abs(coalesce(ft.signed_amount, 0))
        )
      )
    );

  select count(*)::integer
  into v_missing_category_count
  from public.financial_transactions ft
  where coalesce(ft.transaction_status, 'active') = 'active'
    and coalesce(ft.is_void, false) = false
    and (
      ft.category is null or btrim(ft.category) = ''
      or ft.final_bucket is null or btrim(ft.final_bucket) = ''
      or ft.transaction_type is null or btrim(ft.transaction_type) = ''
    );

  select count(*)::integer
  into v_ignored_source_count
  from public.financial_transactions ft
  where ft.source_type in ('purchase', 'cash_collection')
    and coalesce(ft.transaction_status, 'active') = 'active'
    and coalesce(ft.is_void, false) = false
    and coalesce(ft.import_status, '') in ('ignored', 'skipped');

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
    'broken_link_count', v_broken_link_count,
    'balance_inconsistency_count', v_balance_inconsistency_count,
    'missing_category_count', v_missing_category_count,
    'ignored_source_count', v_ignored_source_count,
    'failed_sync_count', v_missing_purchase_count + v_missing_cash_count,
    'source_types_in_overview', (
      select coalesce(jsonb_agg(distinct ft.source_type), '[]'::jsonb)
      from public.financial_transactions ft
      where ft.source_type in ('purchase', 'cash_collection')
    ),
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

select * from public.backfill_missing_finance_transactions();

select pg_notify('pgrst', 'reload schema');
