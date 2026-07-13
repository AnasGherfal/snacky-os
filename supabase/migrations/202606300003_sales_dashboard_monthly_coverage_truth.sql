create or replace function public.sales_dashboard_monthly_coverage_truth(p_report_type text)
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
  select *
  from (
    select *
    from public.sales_dashboard_monthly_coverage()
    where coalesce(p_report_type, '') <> 'monthly_product_profit'

    union all

    select *
    from public.sales_dashboard_monthly_profit_coverage()
    where p_report_type = 'monthly_product_profit'
  ) coverage
  order by coverage.business_month asc nulls last;
$$;

grant execute on function public.sales_dashboard_monthly_coverage_truth(text) to authenticated;

select pg_notify('pgrst', 'reload schema');
