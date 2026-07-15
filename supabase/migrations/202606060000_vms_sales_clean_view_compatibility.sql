-- Production compatibility bridge for the next migration.
--
-- Some production databases already have public.vms_sales_clean with an older
-- column contract. PostgreSQL does not allow CREATE OR REPLACE VIEW to remove,
-- rename, or reorder existing columns, so 202606060001 previously stopped with
-- SQLSTATE 42P16 before later VMS dashboard migrations could run.
--
-- Rename the old view instead of dropping it. This preserves its data contract
-- and any unknown dependent views while freeing the canonical name for the new
-- definition created by 202606060001_vms_import_status_sources.sql.
-- No tables, rows, or columns are deleted by this migration.

do $$
begin
  if to_regclass('public.vms_sales_clean') is not null
     and to_regclass('public.vms_sales_clean_legacy_202606060001') is null then
    alter view public.vms_sales_clean
      rename to vms_sales_clean_legacy_202606060001;
  end if;
end
$$;

select pg_notify('pgrst', 'reload schema');
