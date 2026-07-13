create table if not exists public.product_cost_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  unit_cost_lyd numeric(12,4) not null,
  effective_from date not null,
  effective_to date,
  source_type text,
  source_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_cost_history_unit_cost_chk check (unit_cost_lyd >= 0),
  constraint product_cost_history_effective_range_chk check (effective_to is null or effective_to >= effective_from)
);

create index if not exists idx_product_cost_history_product_dates
  on public.product_cost_history(product_id, effective_from desc, effective_to desc);

create unique index if not exists idx_product_cost_history_product_source
  on public.product_cost_history(
    product_id,
    effective_from,
    coalesce(source_type, ''),
    coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

with purchase_cost_rows as (
  select distinct on (
    pol.product_id,
    coalesce(po.received_date, po.order_date, pol.created_at::date)
  )
    pol.product_id,
    pol.id as source_id,
    round(coalesce(pol.unit_cost_lyd, pol.unit_cost, 0)::numeric, 4) as unit_cost_lyd,
    coalesce(po.received_date, po.order_date, pol.created_at::date) as effective_from
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where pol.product_id is not null
    and coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) > 0
    and coalesce(po.status, 'received') = 'received'
  order by
    pol.product_id,
    coalesce(po.received_date, po.order_date, pol.created_at::date),
    coalesce(po.received_at, po.received_date::timestamptz, po.order_date::timestamptz, pol.created_at) desc,
    coalesce(pol.line_position, 0) desc,
    pol.id desc
)
insert into public.product_cost_history (
  product_id,
  unit_cost_lyd,
  effective_from,
  source_type,
  source_id,
  notes
)
select
  row.product_id,
  row.unit_cost_lyd,
  row.effective_from,
  'purchase_line',
  row.source_id,
  'Backfilled from received purchase order lines'
from purchase_cost_rows row
where not exists (
  select 1
  from public.product_cost_history existing
  where existing.product_id = row.product_id
    and existing.effective_from = row.effective_from
    and coalesce(existing.source_type, '') = 'purchase_line'
    and existing.source_id = row.source_id
);

with ordered_rows as (
  select
    history.id,
    lead(history.effective_from) over (
      partition by history.product_id
      order by history.effective_from asc, history.created_at asc, history.id asc
    ) as next_effective_from
  from public.product_cost_history history
  where coalesce(history.source_type, '') = 'purchase_line'
)
update public.product_cost_history history
set
  effective_to = case
    when ordered_rows.next_effective_from is null then null
    else ordered_rows.next_effective_from - 1
  end,
  updated_at = now()
from ordered_rows
where history.id = ordered_rows.id
  and history.effective_to is distinct from case
    when ordered_rows.next_effective_from is null then null
    else ordered_rows.next_effective_from - 1
  end;

create or replace view public.vms_sales_clean as
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
    vib.report_type,
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
    and vib.report_type in ('vms_order_details_weekly', 'monthly_transaction_details')
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.is_active = true
    and vib.deleted_at is null
),
costed_sales as (
  select
    rt.*,
    history.id as historical_cost_id,
    history.unit_cost_lyd as historical_unit_cost_lyd,
    fallback.reporting_unit_cost_lyd as fallback_unit_cost_lyd,
    fallback.cost_method as fallback_cost_method
  from resolved_transactions rt
  left join lateral (
    select
      cost.id,
      cost.unit_cost_lyd,
      cost.effective_from,
      cost.effective_to
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
    'source', coalesce(sales.report_type, 'vms_order_details_weekly'),
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

drop function if exists public.sales_dashboard_summary(date, date);

create function public.sales_dashboard_summary(
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
    where vib.report_type in ('vms_order_details_weekly', 'monthly_transaction_details')
      and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
      and vib.is_active = true
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
    from public.vms_sales_clean v
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

drop function if exists public.sales_dashboard_profit_breakdown(text, date, date);

create function public.sales_dashboard_profit_breakdown(
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
    from public.vms_sales_clean v
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

grant select on public.vms_sales_clean to authenticated;
grant execute on function public.sales_dashboard_summary(date, date) to authenticated;
grant execute on function public.sales_dashboard_profit_breakdown(text, date, date) to authenticated;

select pg_notify('pgrst', 'reload schema');
