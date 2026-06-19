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
    from public.vms_sales_clean v
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

create or replace function public.cash_reconciliation_summary(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  collection_count integer,
  counted_collection_count integer,
  pending_collection_count integer,
  variance_review_count integer,
  expected_cash_amount numeric,
  actual_cash_collected_amount numeric,
  variance_amount numeric,
  variance_rate numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  filtered_collections as (
    select
      cc.review_status,
      cc.actual_cash_collected,
      greatest(coalesce(cc.vms_expected_cash, 0), 0)::numeric(12, 2) as expected_cash_amount,
      greatest(coalesce(cc.actual_cash_collected, 0), 0)::numeric(12, 2) as actual_cash_amount
    from public.cash_collections cc
    where coalesce(cc.review_status, '') <> 'voided'
      and (p_date_from is null or cc.collected_at::date >= p_date_from)
      and (p_date_to is null or cc.collected_at::date <= p_date_to)
  ),
  aggregated as (
    select
      count(*)::integer as collection_count,
      count(*) filter (where actual_cash_collected is not null)::integer as counted_collection_count,
      count(*) filter (where actual_cash_collected is null)::integer as pending_collection_count,
      count(*) filter (where review_status = 'variance_review')::integer as variance_review_count,
      coalesce(sum(expected_cash_amount), 0)::numeric(12, 2) as expected_cash_amount,
      coalesce(sum(actual_cash_amount), 0)::numeric(12, 2) as actual_cash_collected_amount,
      coalesce(sum(actual_cash_amount - expected_cash_amount), 0)::numeric(12, 2) as variance_amount
    from filtered_collections
  )
  select
    aggregated.collection_count,
    aggregated.counted_collection_count,
    aggregated.pending_collection_count,
    aggregated.variance_review_count,
    aggregated.expected_cash_amount,
    aggregated.actual_cash_collected_amount,
    aggregated.variance_amount,
    case
      when aggregated.expected_cash_amount <> 0
        then (aggregated.variance_amount / aggregated.expected_cash_amount)::numeric(12, 4)
      else 0::numeric(12, 4)
    end as variance_rate
  from aggregated
  join allowed on allowed.permitted;
$$;

create or replace function public.cash_reconciliation_breakdown(
  p_dimension text,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_key text,
  bucket_label text,
  sort_key text,
  expected_cash_amount numeric,
  actual_cash_collected_amount numeric,
  variance_amount numeric,
  collection_count integer,
  counted_collection_count integer,
  pending_collection_count integer,
  variance_review_count integer
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  filtered_collections as (
    select
      cc.collected_at,
      cc.review_status,
      cc.actual_cash_collected,
      greatest(coalesce(cc.vms_expected_cash, 0), 0)::numeric(12, 2) as expected_cash_amount,
      greatest(coalesce(cc.actual_cash_collected, 0), 0)::numeric(12, 2) as actual_cash_amount,
      coalesce(nullif(btrim(m.name), ''), nullif(btrim(m.machine_code), ''), 'Unknown machine') as machine_label
    from public.cash_collections cc
    left join public.machines m on m.id = cc.machine_id
    where coalesce(cc.review_status, '') <> 'voided'
      and (p_date_from is null or cc.collected_at::date >= p_date_from)
      and (p_date_to is null or cc.collected_at::date <= p_date_to)
  ),
  grouped_collections as (
    select
      case p_dimension
        when 'day' then to_char(collected_at::date, 'YYYY-MM-DD')
        when 'month' then to_char(date_trunc('month', collected_at), 'YYYY-MM')
        when 'machine' then machine_label
        else to_char(collected_at::date, 'YYYY-MM-DD')
      end as bucket_key,
      case p_dimension
        when 'day' then to_char(collected_at::date, 'YYYY-MM-DD')
        when 'month' then to_char(date_trunc('month', collected_at), 'YYYY-MM')
        when 'machine' then machine_label
        else to_char(collected_at::date, 'YYYY-MM-DD')
      end as bucket_label,
      case p_dimension
        when 'day' then to_char(collected_at::date, 'YYYY-MM-DD')
        when 'month' then to_char(date_trunc('month', collected_at), 'YYYY-MM-DD')
        when 'machine' then lower(machine_label)
        else to_char(collected_at::date, 'YYYY-MM-DD')
      end as sort_key,
      count(*)::integer as collection_count,
      count(*) filter (where actual_cash_collected is not null)::integer as counted_collection_count,
      count(*) filter (where actual_cash_collected is null)::integer as pending_collection_count,
      count(*) filter (where review_status = 'variance_review')::integer as variance_review_count,
      coalesce(sum(expected_cash_amount), 0)::numeric(12, 2) as expected_cash_amount,
      coalesce(sum(actual_cash_amount), 0)::numeric(12, 2) as actual_cash_collected_amount,
      coalesce(sum(actual_cash_amount - expected_cash_amount), 0)::numeric(12, 2) as variance_amount
    from filtered_collections
    group by 1, 2, 3
  )
  select
    grouped_collections.bucket_key,
    grouped_collections.bucket_label,
    grouped_collections.sort_key,
    grouped_collections.expected_cash_amount,
    grouped_collections.actual_cash_collected_amount,
    grouped_collections.variance_amount,
    grouped_collections.collection_count,
    grouped_collections.counted_collection_count,
    grouped_collections.pending_collection_count,
    grouped_collections.variance_review_count
  from grouped_collections
  join allowed on allowed.permitted
  order by grouped_collections.sort_key asc, grouped_collections.bucket_label asc;
$$;

grant execute on function public.sales_dashboard_breakdown(text, date, date) to authenticated;
grant execute on function public.cash_reconciliation_summary(date, date) to authenticated;
grant execute on function public.cash_reconciliation_breakdown(text, date, date) to authenticated;
