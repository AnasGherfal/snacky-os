create or replace function public.snacky_vms_normalize_payment_method(
  raw_row jsonb,
  normalized_row jsonb
)
returns text
language plpgsql
immutable
as $$
declare
  candidate text := lower(
    regexp_replace(
      coalesce(
        nullif(btrim(normalized_row ->> 'payment_method'), ''),
        nullif(btrim(normalized_row ->> 'payment_type'), ''),
        nullif(btrim(normalized_row ->> 'paymentMethod'), ''),
        nullif(btrim(normalized_row ->> 'Payment Method'), ''),
        nullif(btrim(normalized_row ->> 'Payment method'), ''),
        nullif(btrim(normalized_row ->> 'Payment Type'), ''),
        nullif(btrim(normalized_row ->> 'payment'), ''),
        nullif(btrim(normalized_row ->> 'Payment'), ''),
        nullif(btrim(normalized_row ->> 'tender'), ''),
        nullif(btrim(normalized_row ->> 'Tender'), ''),
        nullif(btrim(normalized_row ->> 'method'), ''),
        nullif(btrim(normalized_row ->> 'Method'), ''),
        nullif(btrim(raw_row ->> 'payment_method'), ''),
        nullif(btrim(raw_row ->> 'payment_type'), ''),
        nullif(btrim(raw_row ->> 'Payment Method'), ''),
        nullif(btrim(raw_row ->> 'Payment method'), ''),
        nullif(btrim(raw_row ->> 'Payment Type'), ''),
        nullif(btrim(raw_row ->> 'payment'), ''),
        nullif(btrim(raw_row ->> 'Payment'), ''),
        nullif(btrim(raw_row ->> 'tender'), ''),
        nullif(btrim(raw_row ->> 'Tender'), ''),
        nullif(btrim(raw_row ->> 'method'), ''),
        nullif(btrim(raw_row ->> 'Method'), ''),
        ''
      ),
      '\s+',
      ' ',
      'g'
    )
  );
begin
  if candidate = '' then
    return 'unknown';
  end if;

  if candidate ~ '(cash|coin|coins|banknote|bank note|notes)' then
    return 'cash';
  end if;

  if candidate ~ '(card|credit|debit|visa|master|mastercard|pos|electronic|online|wallet|alipay|wechat|apple ?pay|google ?pay|qr|scan)' then
    return 'card';
  end if;

  return 'unknown';
end;
$$;

create or replace function public.sales_dashboard_summary(
  p_date_from date default null,
  p_date_to date default null,
  p_machine_id uuid default null,
  p_product_id uuid default null,
  p_batch_id uuid default null
)
returns table (
  successful_sales_amount numeric,
  successful_sales_count integer,
  successful_units_sold integer,
  failed_vend_count integer,
  failed_vend_amount numeric,
  refund_count integer,
  refund_amount numeric,
  failed_payment_count integer,
  needs_review_count integer,
  total_attempt_count integer,
  average_transaction numeric,
  cash_payment_count integer,
  cash_payment_amount numeric,
  card_payment_count integer,
  card_payment_amount numeric,
  unknown_payment_count integer,
  unknown_payment_amount numeric,
  payment_method_available boolean,
  payment_type_breakdown jsonb,
  status_breakdown jsonb,
  rows_used integer
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  filtered_transactions as (
    select
      tx.transaction_status,
      greatest(coalesce(tx.payment_amount, 0), 0)::numeric(12,2) as payment_amount,
      greatest(coalesce(tx.quantity, 1), 0)::integer as units_sold,
      coalesce(
        tx.business_date,
        public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
      ) as sale_business_date,
      public.snacky_vms_normalize_payment_method(tx.raw_row, tx.normalized_row) as payment_method
    from public.vms_transactions_raw tx
    join public.vms_import_batches vib on vib.id = tx.import_batch_id
    where vib.report_type = 'vms_order_details_weekly'
      and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
      and vib.is_active = true
      and vib.deleted_at is null
      and (p_machine_id is null or tx.mapped_machine_id = p_machine_id)
      and (p_product_id is null or tx.mapped_product_id = p_product_id)
      and (p_batch_id is null or tx.import_batch_id = p_batch_id)
  ),
  ranged_transactions as (
    select *
    from filtered_transactions
    where sale_business_date is not null
      and (p_date_from is null or sale_business_date >= p_date_from)
      and (p_date_to is null or sale_business_date <= p_date_to)
  ),
  aggregated as (
    select
      count(*)::integer as rows_used,
      count(*)::integer as total_attempt_count,
      count(*) filter (where transaction_status = 'successful_sale')::integer as successful_sales_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale'), 0)::numeric(12,2) as successful_sales_amount,
      coalesce(sum(units_sold) filter (where transaction_status = 'successful_sale'), 0)::integer as successful_units_sold,
      count(*) filter (where transaction_status = 'failed_vend')::integer as failed_vend_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'failed_vend'), 0)::numeric(12,2) as failed_vend_amount,
      count(*) filter (where transaction_status = 'refunded')::integer as refund_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'refunded'), 0)::numeric(12,2) as refund_amount,
      count(*) filter (where transaction_status = 'failed_payment')::integer as failed_payment_count,
      count(*) filter (where transaction_status = 'needs_review')::integer as needs_review_count,
      count(*) filter (where transaction_status = 'successful_sale' and payment_method = 'cash')::integer as cash_payment_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale' and payment_method = 'cash'), 0)::numeric(12,2) as cash_payment_amount,
      count(*) filter (where transaction_status = 'successful_sale' and payment_method = 'card')::integer as card_payment_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale' and payment_method = 'card'), 0)::numeric(12,2) as card_payment_amount,
      count(*) filter (where transaction_status = 'successful_sale' and payment_method not in ('cash', 'card'))::integer as unknown_payment_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale' and payment_method not in ('cash', 'card')), 0)::numeric(12,2) as unknown_payment_amount,
      bool_or(transaction_status = 'successful_sale' and payment_method in ('cash', 'card')) as payment_method_available
    from ranged_transactions
  )
  select
    aggregated.successful_sales_amount,
    aggregated.successful_sales_count,
    aggregated.successful_units_sold,
    aggregated.failed_vend_count,
    aggregated.failed_vend_amount,
    aggregated.refund_count,
    aggregated.refund_amount,
    aggregated.failed_payment_count,
    aggregated.needs_review_count,
    aggregated.total_attempt_count,
    case
      when aggregated.successful_sales_count > 0
        then (aggregated.successful_sales_amount / aggregated.successful_sales_count)::numeric(12,2)
      else null
    end as average_transaction,
    aggregated.cash_payment_count,
    aggregated.cash_payment_amount,
    aggregated.card_payment_count,
    aggregated.card_payment_amount,
    aggregated.unknown_payment_count,
    aggregated.unknown_payment_amount,
    coalesce(aggregated.payment_method_available, false) as payment_method_available,
    jsonb_build_object(
      'cash', jsonb_build_object('count', aggregated.cash_payment_count, 'amount', aggregated.cash_payment_amount),
      'card', jsonb_build_object('count', aggregated.card_payment_count, 'amount', aggregated.card_payment_amount),
      'unknown', jsonb_build_object('count', aggregated.unknown_payment_count, 'amount', aggregated.unknown_payment_amount)
    ) as payment_type_breakdown,
    jsonb_build_object(
      'successful_sale', jsonb_build_object('count', aggregated.successful_sales_count, 'amount', aggregated.successful_sales_amount),
      'failed_vend', jsonb_build_object('count', aggregated.failed_vend_count, 'amount', aggregated.failed_vend_amount),
      'refunded', jsonb_build_object('count', aggregated.refund_count, 'amount', aggregated.refund_amount),
      'failed_payment', jsonb_build_object('count', aggregated.failed_payment_count, 'amount', 0),
      'needs_review', jsonb_build_object('count', aggregated.needs_review_count, 'amount', 0)
    ) as status_breakdown,
    aggregated.rows_used
  from aggregated
  join allowed on allowed.permitted;
$$;

grant execute on function public.snacky_vms_normalize_payment_method(jsonb, jsonb) to authenticated;
grant execute on function public.sales_dashboard_summary(date, date, uuid, uuid, uuid) to authenticated;
