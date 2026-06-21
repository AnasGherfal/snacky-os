update public.vms_transactions_raw tx
set business_date = public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
from public.vms_import_batches vib
where vib.id = tx.import_batch_id
  and vib.report_type = 'vms_order_details_weekly'
  and tx.business_date is null
  and public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time) is not null;

with detailed_batch_coverage as (
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
  join public.vms_import_batches vib on vib.id = tx.import_batch_id
  where vib.report_type = 'vms_order_details_weekly'
  group by tx.import_batch_id
)
update public.vms_import_batches vib
set
  report_start_date = coalesce(coverage.min_business_date, vib.report_start_date),
  report_end_date = coalesce(coverage.max_business_date, vib.report_end_date),
  detected_min_datetime = coalesce(coverage.min_transaction_at, vib.detected_min_datetime),
  detected_max_datetime = coalesce(coverage.max_transaction_at, vib.detected_max_datetime),
  rows_imported = case
    when coalesce(vib.rows_imported, 0) <= 0 then coverage.raw_row_count
    else vib.rows_imported
  end,
  successful_rows_count = case
    when coalesce(vib.successful_rows_count, 0) <= 0 then coverage.successful_rows_count
    else vib.successful_rows_count
  end,
  failed_rows_count = case
    when coalesce(vib.failed_rows_count, 0) <= 0 then coverage.failed_rows_count
    else vib.failed_rows_count
  end,
  refunded_rows_count = case
    when coalesce(vib.refunded_rows_count, 0) <= 0 then coverage.refunded_rows_count
    else vib.refunded_rows_count
  end,
  total_successful_sales = case
    when coalesce(vib.total_successful_sales, 0) <= 0 then coverage.total_successful_sales
    else vib.total_successful_sales
  end,
  updated_at = now()
from detailed_batch_coverage coverage
where vib.id = coverage.batch_id
  and vib.report_type = 'vms_order_details_weekly'
  and vib.deleted_at is null;

update public.vms_import_batches vib
set
  is_active = true,
  updated_at = now()
where vib.report_type = 'vms_order_details_weekly'
  and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
  and vib.deleted_at is null
  and coalesce(vib.is_active, false) = false
  and exists (
    select 1
    from public.vms_transactions_raw tx
    where tx.import_batch_id = vib.id
  );

create or replace view public.vms_sales_dashboard_clean as
with resolved_transactions as (
  select
    tx.id,
    tx.import_batch_id,
    tx.duplicate_hash as source_row_key,
    coalesce(tx.order_number, tx.third_party_transaction_number, tx.third_party_order_no) as vms_transaction_id,
    coalesce(vib.original_file_name, vib.file_name, 'unknown file') as file_name,
    tx.mapped_machine_id as machine_id,
    coalesce(m.name, tx.machine_name, tx.machine_code, 'Unknown machine') as machine_name,
    coalesce(m.machine_code, tx.machine_code) as machine_code,
    m.location_id,
    coalesce(l.name, 'Unknown location') as location_name,
    tx.mapped_product_id as product_id,
    coalesce(p.name, tx.vms_product_name, tx.product_number, 'Unmapped product') as product_name,
    coalesce(p.sku, tx.product_number) as product_sku,
    coalesce(
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ) as sale_date,
    date_trunc('month', coalesce(
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ))::date as sales_month,
    greatest(coalesce(tx.quantity, 1), 0)::integer as units_sold,
    greatest(coalesce(tx.payment_amount, 0), 0)::numeric(12,2) as sales_amount,
    public.snacky_vms_normalize_payment_method(tx.raw_row, tx.normalized_row) as payment_method,
    coalesce(tx.payment_time, tx.delivery_time) as period_start,
    coalesce(tx.payment_time, tx.delivery_time) as period_end,
    tx.created_at,
    tx.raw_row,
    tx.normalized_row,
    tx.transaction_status,
    vib.report_start_date,
    vib.report_end_date
  from public.vms_transactions_raw tx
  join public.vms_import_batches vib on vib.id = tx.import_batch_id
  left join public.machines m on m.id = tx.mapped_machine_id
  left join public.locations l on l.id = m.location_id
  left join public.products p on p.id = tx.mapped_product_id
  where tx.transaction_status = 'successful_sale'
    and coalesce(
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ) is not null
    and vib.report_type = 'vms_order_details_weekly'
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.deleted_at is null
),
costed_sales as (
  select
    rt.*,
    history.unit_cost_lyd as historical_unit_cost_lyd,
    fallback.reporting_unit_cost_lyd as fallback_unit_cost_lyd,
    fallback.cost_method as fallback_cost_method
  from resolved_transactions rt
  left join lateral (
    select
      cost.unit_cost_lyd
    from public.product_cost_history cost
    where cost.product_id = rt.product_id
      and cost.unit_cost_lyd > 0
      and cost.effective_from <= rt.sale_date
      and (cost.effective_to is null or cost.effective_to >= rt.sale_date)
    order by cost.effective_from desc, cost.updated_at desc, cost.created_at desc, cost.id desc
    limit 1
  ) history on true
  left join public.product_reporting_costs fallback on fallback.product_id = rt.product_id
)
select
  sales.id,
  sales.import_batch_id,
  sales.source_row_key,
  sales.vms_transaction_id,
  sales.file_name,
  sales.machine_id,
  sales.machine_name,
  sales.machine_code,
  sales.location_id,
  sales.location_name,
  sales.product_id,
  sales.product_name,
  sales.product_sku,
  sales.sale_date,
  sales.sales_month,
  coalesce(sales.report_start_date, sales.sale_date) as report_start_date,
  coalesce(sales.report_end_date, sales.sale_date) as report_end_date,
  sales.units_sold,
  1::integer as transaction_count,
  sales.sales_amount as gross_sales_amount,
  sales.sales_amount as net_sales_amount,
  case when sales.payment_method = 'cash' then sales.sales_amount else 0::numeric(12,2) end as cash_sales_amount,
  case when sales.payment_method = 'card' then sales.sales_amount else 0::numeric(12,2) end as card_sales_amount,
  coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) as unit_cost_amount,
  case
    when sales.product_id is null then 'unmapped_product'
    when sales.historical_unit_cost_lyd is not null and sales.historical_unit_cost_lyd > 0 then 'historical_cost'
    when sales.fallback_unit_cost_lyd is not null and sales.fallback_unit_cost_lyd > 0 then coalesce(sales.fallback_cost_method, 'current_cost_fallback')
    else 'missing'
  end as cost_method,
  case
    when coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) is null
      or coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) <= 0 then null
    else (coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) * sales.units_sold)::numeric(12,2)
  end as product_cost_amount,
  case
    when coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) is null
      or coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) <= 0 then null
    else (sales.sales_amount - coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) * sales.units_sold)::numeric(12,2)
  end as gross_profit_amount,
  (
    coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) is null
    or coalesce(sales.historical_unit_cost_lyd, sales.fallback_unit_cost_lyd) <= 0
  ) as cost_missing,
  sales.period_start,
  sales.period_end,
  sales.created_at,
  jsonb_build_object(
    'source', 'vms_order_details_weekly',
    'raw', sales.raw_row,
    'normalized', sales.normalized_row,
    'transaction_status', sales.transaction_status,
    'business_date', sales.sale_date,
    'payment_method', sales.payment_method,
    'cost_status', case
      when sales.product_id is null then 'unmapped_product'
      when sales.historical_unit_cost_lyd is not null and sales.historical_unit_cost_lyd > 0 then 'historical_cost'
      when sales.fallback_unit_cost_lyd is not null and sales.fallback_unit_cost_lyd > 0 then 'current_cost_fallback'
      else 'missing_cost'
    end
  ) as metadata,
  sales.payment_method,
  case
    when sales.product_id is null then 'unmapped_product'
    when sales.historical_unit_cost_lyd is not null and sales.historical_unit_cost_lyd > 0 then 'historical_cost'
    when sales.fallback_unit_cost_lyd is not null and sales.fallback_unit_cost_lyd > 0 then 'current_cost_fallback'
    else 'missing_cost'
  end as cost_status,
  (
    sales.product_id is not null
    and sales.historical_unit_cost_lyd is null
    and sales.fallback_unit_cost_lyd is not null
    and sales.fallback_unit_cost_lyd > 0
  ) as cost_estimated
from costed_sales sales;

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

create or replace function public.sales_dashboard_profit_breakdown(
  p_dimension text,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_key text,
  bucket_label text,
  sort_key text,
  revenue_amount numeric,
  successful_sales_count integer,
  units_sold integer,
  rows_used integer,
  cogs_amount numeric,
  gross_profit_amount numeric,
  gross_margin_percent numeric,
  missing_cost_sales_count integer,
  missing_cost_revenue_amount numeric,
  estimated_cost_sales_count integer,
  estimated_cost_revenue_amount numeric,
  cost_status text
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin']) as permitted
  ),
  filtered_sales as (
    select
      case p_dimension
        when 'machine' then coalesce(nullif(btrim(v.machine_name), ''), 'Unknown machine')
        when 'location' then coalesce(nullif(btrim(v.location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(v.product_name), ''), 'Unmapped product')
        else coalesce(nullif(btrim(v.product_name), ''), 'Unmapped product')
      end as bucket_label,
      case p_dimension
        when 'machine' then coalesce(nullif(btrim(v.machine_name), ''), 'Unknown machine')
        when 'location' then coalesce(nullif(btrim(v.location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(v.product_name), ''), 'Unmapped product')
        else coalesce(nullif(btrim(v.product_name), ''), 'Unmapped product')
      end as bucket_key,
      case p_dimension
        when 'machine' then lower(coalesce(nullif(btrim(v.machine_name), ''), 'Unknown machine'))
        when 'location' then lower(coalesce(nullif(btrim(v.location_name), ''), 'Unknown location'))
        when 'product' then lower(coalesce(nullif(btrim(v.product_name), ''), 'Unmapped product'))
        else lower(coalesce(nullif(btrim(v.product_name), ''), 'Unmapped product'))
      end as sort_key,
      v.net_sales_amount,
      v.product_cost_amount,
      v.units_sold,
      v.cost_estimated,
      v.cost_status
    from public.vms_sales_dashboard_clean v
    where (p_date_from is null or v.sale_date >= p_date_from)
      and (p_date_to is null or v.sale_date <= p_date_to)
  ),
  grouped_sales as (
    select
      sales.bucket_key,
      sales.bucket_label,
      sales.sort_key,
      count(*)::integer as successful_sales_count,
      coalesce(sum(sales.net_sales_amount), 0)::numeric(12,2) as revenue_amount,
      coalesce(sum(sales.units_sold), 0)::integer as units_sold,
      count(*)::integer as rows_used,
      coalesce(sum(coalesce(sales.product_cost_amount, 0)), 0)::numeric(12,2) as cogs_amount,
      count(*) filter (where sales.cost_status in ('missing_cost', 'unmapped_product'))::integer as missing_cost_sales_count,
      coalesce(sum(sales.net_sales_amount) filter (where sales.cost_status in ('missing_cost', 'unmapped_product')), 0)::numeric(12,2) as missing_cost_revenue_amount,
      count(*) filter (where sales.cost_estimated)::integer as estimated_cost_sales_count,
      coalesce(sum(sales.net_sales_amount) filter (where sales.cost_estimated), 0)::numeric(12,2) as estimated_cost_revenue_amount,
      count(*) filter (where sales.cost_status = 'unmapped_product')::integer as unmapped_sales_count,
      count(*) filter (where sales.cost_status = 'missing_cost')::integer as missing_status_count,
      count(*) filter (where sales.cost_estimated)::integer as estimated_status_count,
      count(*) filter (where sales.cost_status = 'historical_cost')::integer as historical_status_count
    from filtered_sales sales
    group by 1, 2, 3
  )
  select
    grouped.bucket_key,
    grouped.bucket_label,
    grouped.sort_key,
    grouped.revenue_amount,
    grouped.successful_sales_count,
    grouped.units_sold,
    grouped.rows_used,
    grouped.cogs_amount,
    (grouped.revenue_amount - grouped.cogs_amount)::numeric(12,2) as gross_profit_amount,
    case
      when grouped.revenue_amount > 0
        then ((grouped.revenue_amount - grouped.cogs_amount) / grouped.revenue_amount)::numeric(12,4)
      else 0::numeric(12,4)
    end as gross_margin_percent,
    grouped.missing_cost_sales_count,
    grouped.missing_cost_revenue_amount,
    grouped.estimated_cost_sales_count,
    grouped.estimated_cost_revenue_amount,
    case
      when grouped.unmapped_sales_count > 0 then 'unmapped_product'
      when grouped.missing_status_count > 0 then 'missing_cost'
      when grouped.estimated_status_count > 0 and grouped.historical_status_count > 0 then 'historical_and_fallback'
      when grouped.estimated_status_count > 0 then 'current_cost_fallback'
      else 'historical_cost'
    end as cost_status
  from grouped_sales grouped
  join allowed on allowed.permitted
  order by
    case when p_dimension in ('machine', 'location', 'product') then (grouped.revenue_amount - grouped.cogs_amount) end desc nulls last,
    grouped.sort_key asc,
    grouped.bucket_label asc;
$$;

create or replace function public.sales_dashboard_breakdown(
  p_dimension text,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_key text,
  bucket_label text,
  sort_key text,
  successful_sales_amount numeric,
  successful_sales_count integer,
  units_sold integer,
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
  filtered_sales as (
    select
      coalesce(v.sale_date, v.sales_month::date) as sale_date,
      v.period_start,
      v.period_end,
      v.machine_name,
      v.location_name,
      v.product_name,
      greatest(coalesce(v.units_sold, 0), 0)::integer as units_sold,
      greatest(coalesce(v.net_sales_amount, v.gross_sales_amount, 0), 0)::numeric(12, 2) as sales_amount
    from public.vms_sales_dashboard_clean v
    where coalesce(v.sale_date, v.sales_month::date) is not null
      and (p_date_from is null or coalesce(v.sale_date, v.sales_month::date) >= p_date_from)
      and (p_date_to is null or coalesce(v.sale_date, v.sales_month::date) <= p_date_to)
  ),
  grouped_sales as (
    select
      case p_dimension
        when 'day' then to_char(sale_date, 'YYYY-MM-DD')
        when 'month' then to_char(date_trunc('month', sale_date::timestamp), 'YYYY-MM')
        when 'hour' then to_char(date_trunc('hour', coalesce(period_start, period_end, sale_date::timestamp)), 'HH24:00')
        when 'machine' then coalesce(nullif(btrim(machine_name), ''), 'Unknown / not mapped')
        when 'location' then coalesce(nullif(btrim(location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(product_name), ''), 'Unknown / not mapped')
        else to_char(sale_date, 'YYYY-MM-DD')
      end as bucket_key,
      case p_dimension
        when 'day' then to_char(sale_date, 'YYYY-MM-DD')
        when 'month' then to_char(date_trunc('month', sale_date::timestamp), 'YYYY-MM')
        when 'hour' then to_char(date_trunc('hour', coalesce(period_start, period_end, sale_date::timestamp)), 'HH24:00')
        when 'machine' then coalesce(nullif(btrim(machine_name), ''), 'Unknown / not mapped')
        when 'location' then coalesce(nullif(btrim(location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(product_name), ''), 'Unknown / not mapped')
        else to_char(sale_date, 'YYYY-MM-DD')
      end as bucket_label,
      case p_dimension
        when 'day' then to_char(sale_date, 'YYYY-MM-DD')
        when 'month' then to_char(date_trunc('month', sale_date::timestamp), 'YYYY-MM-DD')
        when 'hour' then to_char(date_trunc('hour', coalesce(period_start, period_end, sale_date::timestamp)), 'HH24:00')
        when 'machine' then lower(coalesce(nullif(btrim(machine_name), ''), 'Unknown / not mapped'))
        when 'location' then lower(coalesce(nullif(btrim(location_name), ''), 'Unknown location'))
        when 'product' then lower(coalesce(nullif(btrim(product_name), ''), 'Unknown / not mapped'))
        else to_char(sale_date, 'YYYY-MM-DD')
      end as sort_key,
      count(*)::integer as successful_sales_count,
      coalesce(sum(sales_amount), 0)::numeric(12, 2) as successful_sales_amount,
      coalesce(sum(units_sold), 0)::integer as units_sold,
      count(*)::integer as rows_used
    from filtered_sales
    group by 1, 2, 3
  )
  select
    grouped_sales.bucket_key,
    grouped_sales.bucket_label,
    grouped_sales.sort_key,
    grouped_sales.successful_sales_amount,
    grouped_sales.successful_sales_count,
    grouped_sales.units_sold,
    grouped_sales.rows_used
  from grouped_sales
  join allowed on allowed.permitted
  order by grouped_sales.sort_key asc, grouped_sales.bucket_label asc;
$$;

create or replace function public.sales_dashboard_monthly_coverage()
returns table (
  business_month date,
  total_rows integer,
  finalized_rows integer,
  successful_sale_rows integer,
  finalized_successful_sale_rows integer,
  successful_sale_amount numeric,
  finalized_successful_sale_amount numeric,
  min_business_date date,
  max_business_date date,
  batch_count integer,
  finalized_batch_count integer,
  active_finalized_batch_count integer,
  null_business_date_rows integer
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  detailed_rows as (
    select
      tx.import_batch_id as batch_id,
      vib.status as batch_status,
      vib.is_active,
      vib.deleted_at,
      coalesce(
        tx.business_date,
        public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
      ) as business_date,
      tx.transaction_status,
      greatest(coalesce(tx.payment_amount, 0), 0)::numeric(12,2) as payment_amount
    from public.vms_transactions_raw tx
    join public.vms_import_batches vib on vib.id = tx.import_batch_id
    where vib.report_type = 'vms_order_details_weekly'
  )
  select
    date_trunc('month', detailed.business_date::timestamp)::date as business_month,
    count(*)::integer as total_rows,
    count(*) filter (
      where detailed.batch_status in ('imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    )::integer as finalized_rows,
    count(*) filter (where detailed.transaction_status = 'successful_sale')::integer as successful_sale_rows,
    count(*) filter (
      where detailed.transaction_status = 'successful_sale'
        and detailed.batch_status in ('imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    )::integer as finalized_successful_sale_rows,
    coalesce(sum(detailed.payment_amount) filter (where detailed.transaction_status = 'successful_sale'), 0)::numeric(12,2) as successful_sale_amount,
    coalesce(sum(detailed.payment_amount) filter (
      where detailed.transaction_status = 'successful_sale'
        and detailed.batch_status in ('imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    ), 0)::numeric(12,2) as finalized_successful_sale_amount,
    min(detailed.business_date) as min_business_date,
    max(detailed.business_date) as max_business_date,
    count(distinct detailed.batch_id)::integer as batch_count,
    count(distinct detailed.batch_id) filter (
      where detailed.batch_status in ('imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    )::integer as finalized_batch_count,
    count(distinct detailed.batch_id) filter (
      where detailed.batch_status in ('imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
        and coalesce(detailed.is_active, true)
    )::integer as active_finalized_batch_count,
    count(*) filter (where detailed.business_date is null)::integer as null_business_date_rows
  from detailed_rows detailed
  join allowed on allowed.permitted
  group by 1
  order by 1 nulls last;
$$;

grant select on public.vms_sales_dashboard_clean to authenticated;
grant execute on function public.sales_dashboard_summary(date, date) to authenticated;
grant execute on function public.sales_dashboard_profit_breakdown(text, date, date) to authenticated;
grant execute on function public.sales_dashboard_breakdown(text, date, date) to authenticated;
grant execute on function public.sales_dashboard_monthly_coverage() to authenticated;

select pg_notify('pgrst', 'reload schema');
