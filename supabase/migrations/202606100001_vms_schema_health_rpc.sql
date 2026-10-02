create or replace function public.get_vms_schema_health()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  expected_tables text[] := array[
    'vms_import_batches',
    'vms_import_preview_rows',
    'vms_product_mappings',
    'vms_machine_mappings',
    'vms_header_mappings',
    'vms_sales_raw',
    'vms_transactions_raw',
    'vms_machine_stock_snapshots'
  ];
  expected_batch_columns text[] := array[
    'file_hash',
    'detected_min_datetime',
    'detected_max_datetime',
    'is_active',
    'status',
    'report_type',
    'rows_found',
    'rows_imported',
    'parse_diagnostics'
  ];
  missing_tables text[];
  missing_columns text[];
begin
  select coalesce(array_agg(t.table_name order by t.table_name), array[]::text[])
  into missing_tables
  from unnest(expected_tables) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;

  select coalesce(array_agg('vms_import_batches.' || c.column_name order by c.column_name), array[]::text[])
  into missing_columns
  from unnest(expected_batch_columns) as c(column_name)
  where to_regclass('public.vms_import_batches') is not null
    and not exists (
      select 1
      from pg_attribute a
      join pg_class pc on pc.oid = a.attrelid
      join pg_namespace n on n.oid = pc.relnamespace
      where n.nspname = 'public'
        and pc.relname = 'vms_import_batches'
        and a.attname = c.column_name
        and a.attnum > 0
        and not a.attisdropped
    );

  return jsonb_build_object(
    'checked', true,
    'missing_tables', missing_tables,
    'missing_columns', missing_columns,
    'migration_status', jsonb_build_object(
      'core_tables_ready', cardinality(missing_tables) = 0,
      'import_batch_metadata_ready', to_regclass('public.vms_import_batches') is not null and cardinality(missing_columns) = 0
    )
  );
end;
$$;

revoke all on function public.get_vms_schema_health() from public;
grant execute on function public.get_vms_schema_health() to authenticated;
