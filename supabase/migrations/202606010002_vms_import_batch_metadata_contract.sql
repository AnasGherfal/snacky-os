-- Reasserts the complete vms_import_batches metadata contract expected by
-- the import wizard. Keep this table limited to import metadata; raw VMS file
-- headers belong in row payload tables, not here.

create table if not exists public.vms_import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  file_name text,
  report_type text,
  report_start_date date,
  report_end_date date,
  import_mode text not null default 'append',
  status text not null default 'draft',
  rows_found integer not null default 0,
  rows_imported integer not null default 0,
  rows_skipped_duplicate integer not null default 0,
  rows_needing_review integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if to_regclass('public.vms_import_batches') is not null then
    execute 'alter table public.vms_import_batches enable row level security';
  end if;
end $$;

alter table public.vms_import_batches
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists uploaded_by uuid,
  add column if not exists uploaded_at timestamptz default now(),
  add column if not exists file_name text,
  add column if not exists report_type text,
  add column if not exists report_start_date date,
  add column if not exists report_end_date date,
  add column if not exists import_mode text default 'append',
  add column if not exists status text default 'draft',
  add column if not exists rows_found integer default 0,
  add column if not exists rows_imported integer default 0,
  add column if not exists rows_skipped_duplicate integer default 0,
  add column if not exists rows_needing_review integer default 0,
  add column if not exists notes text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.vms_import_batches
  add column if not exists file_hash text,
  add column if not exists storage_path text,
  add column if not exists detected_min_datetime timestamptz,
  add column if not exists detected_max_datetime timestamptz,
  add column if not exists total_successful_sales numeric default 0,
  add column if not exists successful_rows_count integer default 0,
  add column if not exists failed_rows_count integer default 0,
  add column if not exists refunded_rows_count integer default 0,
  add column if not exists is_active boolean default false,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid,
  add column if not exists disable_reason text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text,
  add column if not exists source_usage jsonb,
  add column if not exists dashboard_usage jsonb,
  add column if not exists latest_error text,
  add column if not exists parse_diagnostics jsonb;

alter table public.vms_import_batches
  add column if not exists source_type text default 'csv',
  add column if not exists file_type text,
  add column if not exists sheet_name text,
  add column if not exists imported_by uuid,
  add column if not exists imported_at timestamptz,
  add column if not exists row_count integer default 0,
  add column if not exists rows_skipped integer default 0,
  add column if not exists error_count integer default 0,
  add column if not exists errors jsonb default '[]'::jsonb,
  add column if not exists unknown_machines jsonb default '[]'::jsonb,
  add column if not exists unmapped_products jsonb default '[]'::jsonb,
  add column if not exists column_mapping jsonb default '{}'::jsonb,
  add column if not exists preview_summary jsonb default '{}'::jsonb,
  add column if not exists review_summary jsonb default '[]'::jsonb,
  add column if not exists failed_at timestamptz,
  add column if not exists last_reprocessed_at timestamptz,
  add column if not exists reprocess_count integer default 0,
  add column if not exists storage_bucket text,
  add column if not exists original_file_name text;

alter table public.vms_import_batches
  alter column uploaded_at set default now(),
  alter column import_mode set default 'append',
  alter column status set default 'draft',
  alter column rows_found set default 0,
  alter column rows_imported set default 0,
  alter column rows_skipped_duplicate set default 0,
  alter column rows_needing_review set default 0,
  alter column created_at set default now(),
  alter column updated_at set default now(),
  alter column source_type set default 'csv',
  alter column row_count set default 0,
  alter column rows_skipped set default 0,
  alter column error_count set default 0,
  alter column errors set default '[]'::jsonb,
  alter column unknown_machines set default '[]'::jsonb,
  alter column unmapped_products set default '[]'::jsonb,
  alter column column_mapping set default '{}'::jsonb,
  alter column preview_summary set default '{}'::jsonb,
  alter column review_summary set default '[]'::jsonb,
  alter column reprocess_count set default 0,
  alter column total_successful_sales set default 0,
  alter column successful_rows_count set default 0,
  alter column failed_rows_count set default 0,
  alter column refunded_rows_count set default 0,
  alter column is_active set default false;

update public.vms_import_batches
set
  uploaded_at = coalesce(uploaded_at, imported_at, created_at, now()),
  import_mode = coalesce(import_mode, 'append'),
  status = coalesce(status, 'draft'),
  rows_found = coalesce(rows_found, row_count, 0),
  rows_imported = coalesce(rows_imported, 0),
  rows_skipped_duplicate = coalesce(rows_skipped_duplicate, 0),
  rows_needing_review = coalesce(rows_needing_review, error_count, 0),
  created_at = coalesce(created_at, uploaded_at, imported_at, now()),
  updated_at = coalesce(updated_at, now()),
  source_type = coalesce(source_type, 'csv'),
  row_count = coalesce(row_count, rows_found, 0),
  rows_skipped = coalesce(rows_skipped, 0),
  error_count = coalesce(error_count, 0),
  errors = coalesce(errors, '[]'::jsonb),
  unknown_machines = coalesce(unknown_machines, '[]'::jsonb),
  unmapped_products = coalesce(unmapped_products, '[]'::jsonb),
  column_mapping = coalesce(column_mapping, '{}'::jsonb),
  preview_summary = coalesce(preview_summary, '{}'::jsonb),
  review_summary = coalesce(review_summary, '[]'::jsonb),
  reprocess_count = coalesce(reprocess_count, 0),
  total_successful_sales = coalesce(total_successful_sales, 0),
  successful_rows_count = coalesce(successful_rows_count, 0),
  failed_rows_count = coalesce(failed_rows_count, 0),
  refunded_rows_count = coalesce(refunded_rows_count, 0),
  is_active = coalesce(is_active, false)
where uploaded_at is null
   or import_mode is null
   or status is null
   or rows_found is null
   or rows_imported is null
   or rows_skipped_duplicate is null
   or rows_needing_review is null
   or created_at is null
   or updated_at is null
   or source_type is null
   or row_count is null
   or rows_skipped is null
   or error_count is null
   or errors is null
   or unknown_machines is null
   or unmapped_products is null
   or column_mapping is null
   or preview_summary is null
   or review_summary is null
   or reprocess_count is null
   or total_successful_sales is null
   or successful_rows_count is null
   or failed_rows_count is null
   or refunded_rows_count is null
   or is_active is null;

create or replace function public.snacky_current_profile_can_view_vms_import()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

create or replace function public.snacky_current_profile_can_manage_vms_mappings()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

grant execute on function public.snacky_current_profile_can_view_vms_import() to authenticated;
grant execute on function public.snacky_current_profile_can_manage_vms_mappings() to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_preview_rows',
    'vms_product_mappings',
    'vms_machine_mappings',
    'vms_header_mappings',
    'vms_machine_stock_snapshots'
  ] loop
    if to_regclass('public.' || table_name) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);

    execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_delete_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_select_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_insert_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_update_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_delete_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_vms_select" on public.%I', table_name);
    execute format('drop policy if exists "snacky_vms_insert" on public.%I', table_name);
    execute format('drop policy if exists "snacky_vms_update" on public.%I', table_name);
    execute format('drop policy if exists "snacky_vms_delete" on public.%I', table_name);

    execute format($policy$
      create policy "snacky_vms_select"
      on public.%I for select
      to authenticated
      using (public.snacky_current_profile_can_view_vms_import())
    $policy$, table_name);

    execute format($policy$
      create policy "snacky_vms_insert"
      on public.%I for insert
      to authenticated
      with check (public.snacky_current_profile_can_manage_vms_mappings())
    $policy$, table_name);

    execute format($policy$
      create policy "snacky_vms_update"
      on public.%I for update
      to authenticated
      using (public.snacky_current_profile_can_manage_vms_mappings())
      with check (public.snacky_current_profile_can_manage_vms_mappings())
    $policy$, table_name);

    execute format($policy$
      create policy "snacky_vms_delete"
      on public.%I for delete
      to authenticated
      using (public.snacky_current_profile_can_manage_vms_mappings())
    $policy$, table_name);
  end loop;
end $$;

select pg_notify('pgrst', 'reload schema');
