-- Snacky OS is an internal application. Preserve the existing signed-in API
-- behavior while removing anonymous access to every remaining legacy table
-- that was created with Supabase's old broad default grants.

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'cash_collections',
    'finance_categories',
    'finance_import_batches',
    'finance_import_rows',
    'finance_opening_balances',
    'finance_settings',
    'historical_route_deduction_batches',
    'historical_route_deduction_lines',
    'issues',
    'locations',
    'machine_aliases',
    'machine_refill_history',
    'machine_slots',
    'machines',
    'product_aliases',
    'receipt_scan_results',
    'route_pick_adjustments',
    'route_stop_fill_lines',
    'system_activity_logs',
    'team_members',
    'vms_machine_aliases',
    'vms_machine_status_snapshots',
    'vms_product_catalog_snapshots',
    'vms_sales_snapshots',
    'vms_stock_snapshots',
    'vms_sync_runs'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is not null then
      execute format(
        'revoke all on table public.%I from public, anon',
        target_table
      );
      execute format(
        'grant select, insert, update, delete on table public.%I to authenticated',
        target_table
      );
    end if;
  end loop;
end $$;

-- New internal tables must not inherit anonymous Data API access.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon;

select pg_notify('pgrst', 'reload schema');
