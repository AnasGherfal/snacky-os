-- Finance source sync must never skip real money rows.
-- Fixes:
--   1. Purchase sync treats zero manual/calculated totals as missing and falls back to non-zero totals/lines.
--   2. Cash sync creates a finance row from actual cash when counted, otherwise from expected VMS cash.
--   3. Backfill reruns after the repaired sync functions so missing purchase/cash links are closed.

create or replace function public.finance_purchase_should_sync(p_purchase public.purchase_orders)
returns boolean
language sql
stable
as $$
  select coalesce(p_purchase.status, '') not in ('cancelled', 'voided')
     and coalesce(p_purchase.payment_status, '') <> 'voided'
     and abs(coalesce(
       nullif(p_purchase.manual_total_lyd, 0),
       nullif(p_purchase.total_amount, 0),
       nullif(p_purchase.calculated_total_lyd, 0),
       nullif((
         select sum(coalesce(pol.line_total_lyd, pol.line_total, pol.total_units * pol.unit_cost, pol.received_qty * pol.unit_cost, pol.ordered_qty * pol.unit_cost, 0))
         from public.purchase_order_lines pol
         where pol.purchase_order_id = p_purchase.id
       ), 0),
       0
     )) > 0
$$;

create or replace function public.finance_cash_collection_should_sync(p_cash public.cash_collections)
returns boolean
language sql
stable
as $$
  select coalesce(p_cash.review_status, '') <> 'voided'
     and coalesce(p_cash.actual_cash_collected, p_cash.vms_expected_cash) is not null
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

  v_amount := abs(coalesce(nullif(v_purchase.manual_total_lyd, 0), nullif(v_purchase.total_amount, 0), nullif(v_purchase.calculated_total_lyd, 0), nullif(v_lines_total, 0), 0))::numeric(12,2);
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

  v_amount := abs(coalesce(v_cash.actual_cash_collected, v_cash.vms_expected_cash, 0))::numeric(12,2);
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(v_location_name, v_machine_name, v_machine_code);
  v_notes := concat_ws(
    ' - ',
    'Cash collection',
    coalesce(v_machine_name, v_machine_code, p_cash_collection_id::text),
    v_location_name,
    case when v_cash.actual_cash_collected is null and v_cash.vms_expected_cash is not null then 'Expected cash pending count' end,
    case when nullif(trim(v_cash.cash_bag_id), '') is not null then 'Bag ' || v_cash.cash_bag_id end
  );

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
      counterparty_text, payer_text, paid_to_text, payee_text,
      linked_cash_collection_id, related_cash_collection_id, related_route_id, related_machine_id, source_type, source_id,
      created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_location, v_notes, v_notes, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'cash', 'active', 'confirmed', false, false,
      'Cash customers', 'Cash customers', null, null,
      p_cash_collection_id, p_cash_collection_id, v_cash.route_id, v_cash.machine_id, 'cash_collection', p_cash_collection_id,
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
        related_cash_collection_id = p_cash_collection_id,
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

-- Make existing imported money rows visible even when a category was omitted upstream.
update public.financial_transactions
set category = coalesce(nullif(trim(category), ''), 'Uncategorized'),
    transaction_type = coalesce(nullif(trim(transaction_type), ''), 'Uncategorized'),
    final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Uncategorized'),
    updated_at = now()
where coalesce(is_void, false) = false
  and coalesce(nullif(trim(category), ''), nullif(trim(final_bucket), ''), nullif(trim(transaction_type), ''), nullif(trim(bucket), '')) is null;

-- Real backfill after the repaired contract. The function already deduplicates existing source links.
select * from public.backfill_missing_finance_transactions();
select pg_notify('pgrst', 'reload schema');
