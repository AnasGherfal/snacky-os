-- Stop reporting views from running with their creator's privileges and remove
-- the anonymous read surface. Application users keep explicit authenticated
-- access, while underlying table RLS decides which rows each caller may read.

do $$
declare
  target_view text;
begin
  foreach target_view in array array[
    'machine_refill_history_metrics',
    'machine_refill_history_monthly',
    'finance_import_clarification_groups',
    'finance_account_balance_impacts',
    'finance_account_balances',
    'product_reporting_costs',
    'operator_money_balances',
    'current_inventory_by_location',
    'kpi_machine_daily',
    'kpi_machine_monthly',
    'kpi_product_daily',
    'kpi_product_monthly',
    'kpi_location_monthly',
    'location_leads',
    'location_payroll_distances',
    'vms_sales_dashboard_clean',
    'vms_transaction_status_daily',
    'vms_transaction_status_monthly',
    'latest_vms_stock_by_slot',
    'refill_recommendations',
    'vms_sales_clean_legacy_202606060001'
  ]
  loop
    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = target_view
        and c.relkind in ('v', 'm')
    ) then
      if exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = target_view
          and c.relkind = 'v'
      ) then
        execute format(
          'alter view public.%I set (security_invoker = true)',
          target_view
        );
      end if;

      execute format(
        'revoke all on table public.%I from public, anon',
        target_view
      );
      execute format(
        'grant select on table public.%I to authenticated, service_role',
        target_view
      );
    end if;
  end loop;
end $$;

select pg_notify('pgrst', 'reload schema');
