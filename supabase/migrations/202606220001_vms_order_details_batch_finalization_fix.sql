with order_details_batch_coverage as (
  select
    tx.import_batch_id as batch_id,
    min(coalesce(tx.business_date, public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time))) as min_business_date,
    max(coalesce(tx.business_date, public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time))) as max_business_date,
    min(coalesce(tx.payment_time, tx.delivery_time)) as min_transaction_at,
    max(coalesce(tx.payment_time, tx.delivery_time)) as max_transaction_at,
    count(*)::integer as raw_row_count,
    count(*) filter (where tx.transaction_status = 'successful_sale')::integer as successful_rows_count,
    count(*) filter (where tx.transaction_status in ('failed_vend', 'failed_payment', 'needs_review'))::integer as failed_rows_count,
    count(*) filter (where tx.transaction_status = 'refunded')::integer as refunded_rows_count,
    coalesce(sum(greatest(coalesce(tx.payment_amount, 0), 0)) filter (where tx.transaction_status = 'successful_sale'), 0)::numeric(12,2) as total_successful_sales
  from public.vms_transactions_raw tx
  where tx.import_batch_id is not null
  group by tx.import_batch_id
)
update public.vms_import_batches vib
set
  status = 'imported',
  is_active = true,
  imported_at = coalesce(vib.imported_at, now()),
  updated_at = now(),
  report_start_date = coalesce(coverage.min_business_date, vib.report_start_date),
  report_end_date = coalesce(coverage.max_business_date, vib.report_end_date),
  detected_min_datetime = coalesce(coverage.min_transaction_at, vib.detected_min_datetime),
  detected_max_datetime = coalesce(coverage.max_transaction_at, vib.detected_max_datetime),
  rows_found = greatest(coalesce(vib.rows_found, 0), coverage.raw_row_count),
  row_count = greatest(coalesce(vib.row_count, 0), coverage.raw_row_count),
  rows_imported = coverage.raw_row_count,
  successful_rows_count = coverage.successful_rows_count,
  failed_rows_count = coverage.failed_rows_count,
  refunded_rows_count = coverage.refunded_rows_count,
  total_successful_sales = coverage.total_successful_sales,
  latest_error = null,
  last_error = null
from order_details_batch_coverage coverage
where vib.id = coverage.batch_id
  and vib.report_type = 'vms_order_details_weekly'
  and vib.deleted_at is null
  and coverage.raw_row_count > 0
  and (
    vib.status in ('previewed', 'draft', 'failed')
    or (vib.status = 'imported' and coalesce(vib.is_active, false) = false)
  );

create or replace view public.vms_sales_dashboard_clean as
select *
from public.vms_sales_clean;

create or replace function public.sales_dashboard_summary(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  revenue_amount numeric,
  successful_sales_count integer,
  units_sold integer,
  average_transaction numeric,
  failed_vend_count integer,
  failed_vend_amount numeric,
  refund_count integer,
  refund_amount numeric,
  total_attempt_count integer,
  failed_vend_rate numeric,
  cash_sales_amount numeric,
  card_sales_amount numeric,
  unknown_payment_sales_amount numeric,
  payment_method_available boolean,
  rows_used integer,
  failed_payment_count integer,
  needs_review_count integer,
  cash_payment_count integer,
  card_payment_count integer,
  unknown_payment_count integer,
  cogs_amount numeric,
  gross_profit_amount numeric,
  gross_margin_percent numeric,
  missing_cost_sales_count integer,
  missing_cost_revenue_amount numeric,
  estimated_cost_sales_count integer,
  estimated_cost_revenue_amount numeric,
  payment_type_breakdown jsonb,
  status_breakdown jsonb
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select
      public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted,
      public.snacky_current_profile_has_any_role(array['owner', 'admin']) as can_view_profit
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
      and coalesce(vib.is_active, false) = true
      and vib.deleted_at is null
  ),
  ranged_transactions as (
    select *
    from filtered_transactions
    where sale_business_date is not null
      and (p_date_from is null or sale_business_date >= p_date_from)
      and (p_date_to is null or sale_business_date <= p_date_to)
  ),
  transaction_aggregates as (
    select
      count(*) filter (where transaction_status = 'successful_sale')::integer as successful_sales_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale'), 0)::numeric(12,2) as revenue_amount,
      coalesce(sum(units_sold) filter (where transaction_status = 'successful_sale'), 0)::integer as units_sold,
      count(*)::integer as total_attempt_count,
      count(*) filter (where transaction_status = 'failed_vend')::integer as failed_vend_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'failed_vend'), 0)::numeric(12,2) as failed_vend_amount,
      count(*) filter (where transaction_status = 'refunded')::integer as refund_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'refunded'), 0)::numeric(12,2) as refund_amount,
      count(*) filter (where transaction_status = 'failed_payment')::integer as failed_payment_count,
      count(*) filter (where transaction_status = 'needs_review')::integer as needs_review_count,
      count(*) filter (where transaction_status = 'successful_sale' and payment_method = 'cash')::integer as cash_payment_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale' and payment_method = 'cash'), 0)::numeric(12,2) as cash_sales_amount,
      count(*) filter (where transaction_status = 'successful_sale' and payment_method = 'card')::integer as card_payment_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale' and payment_method = 'card'), 0)::numeric(12,2) as card_sales_amount,
      count(*) filter (where transaction_status = 'successful_sale' and payment_method not in ('cash', 'card'))::integer as unknown_payment_count,
      coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale' and payment_method not in ('cash', 'card')), 0)::numeric(12,2) as unknown_payment_sales_amount,
      bool_or(transaction_status = 'successful_sale' and payment_method in ('cash', 'card')) as payment_method_available
    from ranged_transactions
  ),
  profit_aggregates as (
    select
      count(*)::integer as rows_used,
      coalesce(sum(coalesce(v.product_cost_amount, 0)), 0)::numeric(12,2) as cogs_amount,
      count(*) filter (where v.cost_status in ('missing_cost', 'unmapped_product'))::integer as missing_cost_sales_count,
      coalesce(sum(v.net_sales_amount) filter (where v.cost_status in ('missing_cost', 'unmapped_product')), 0)::numeric(12,2) as missing_cost_revenue_amount,
      count(*) filter (where v.cost_estimated)::integer as estimated_cost_sales_count,
      coalesce(sum(v.net_sales_amount) filter (where v.cost_estimated), 0)::numeric(12,2) as estimated_cost_revenue_amount
    from public.vms_sales_dashboard_clean v
    where (p_date_from is null or v.sale_date >= p_date_from)
      and (p_date_to is null or v.sale_date <= p_date_to)
  )
  select
    transactions.revenue_amount,
    transactions.successful_sales_count,
    transactions.units_sold,
    case
      when transactions.successful_sales_count > 0
        then (transactions.revenue_amount / transactions.successful_sales_count)::numeric(12,2)
      else null
    end as average_transaction,
    transactions.failed_vend_count,
    transactions.failed_vend_amount,
    transactions.refund_count,
    transactions.refund_amount,
    transactions.total_attempt_count,
    case
      when transactions.total_attempt_count > 0
        then (transactions.failed_vend_count::numeric / transactions.total_attempt_count::numeric)::numeric(12,4)
      else 0::numeric(12,4)
    end as failed_vend_rate,
    transactions.cash_sales_amount,
    transactions.card_sales_amount,
    transactions.unknown_payment_sales_amount,
    coalesce(transactions.payment_method_available, false) as payment_method_available,
    coalesce(profit.rows_used, transactions.successful_sales_count)::integer as rows_used,
    transactions.failed_payment_count,
    transactions.needs_review_count,
    transactions.cash_payment_count,
    transactions.card_payment_count,
    transactions.unknown_payment_count,
    case when allowed.can_view_profit then profit.cogs_amount else null end as cogs_amount,
    case
      when allowed.can_view_profit
        then (transactions.revenue_amount - coalesce(profit.cogs_amount, 0))::numeric(12,2)
      else null
    end as gross_profit_amount,
    case
      when allowed.can_view_profit and transactions.revenue_amount > 0
        then ((transactions.revenue_amount - coalesce(profit.cogs_amount, 0)) / transactions.revenue_amount)::numeric(12,4)
      when allowed.can_view_profit
        then 0::numeric(12,4)
      else null
    end as gross_margin_percent,
    case when allowed.can_view_profit then profit.missing_cost_sales_count else null end as missing_cost_sales_count,
    case when allowed.can_view_profit then profit.missing_cost_revenue_amount else null end as missing_cost_revenue_amount,
    case when allowed.can_view_profit then profit.estimated_cost_sales_count else null end as estimated_cost_sales_count,
    case when allowed.can_view_profit then profit.estimated_cost_revenue_amount else null end as estimated_cost_revenue_amount,
    jsonb_build_object(
      'cash', jsonb_build_object('count', transactions.cash_payment_count, 'amount', transactions.cash_sales_amount),
      'card', jsonb_build_object('count', transactions.card_payment_count, 'amount', transactions.card_sales_amount),
      'unknown', jsonb_build_object('count', transactions.unknown_payment_count, 'amount', transactions.unknown_payment_sales_amount)
    ) as payment_type_breakdown,
    jsonb_build_object(
      'successful_sale', jsonb_build_object('count', transactions.successful_sales_count, 'amount', transactions.revenue_amount),
      'failed_vend', jsonb_build_object('count', transactions.failed_vend_count, 'amount', transactions.failed_vend_amount),
      'refunded', jsonb_build_object('count', transactions.refund_count, 'amount', transactions.refund_amount),
      'failed_payment', jsonb_build_object('count', transactions.failed_payment_count, 'amount', 0),
      'needs_review', jsonb_build_object('count', transactions.needs_review_count, 'amount', 0)
    ) as status_breakdown
  from transaction_aggregates transactions
  cross join profit_aggregates profit
  join allowed on allowed.permitted;
$$;

grant select on public.vms_sales_dashboard_clean to authenticated;
grant execute on function public.sales_dashboard_summary(date, date) to authenticated;

select pg_notify('pgrst', 'reload schema');
