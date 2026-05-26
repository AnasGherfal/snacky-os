create table if not exists public.vms_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_type text not null default 'csv',
  file_name text,
  file_type text,
  sheet_name text,
  uploaded_by uuid references public.team_members(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  imported_by uuid references public.team_members(id) on delete set null,
  imported_at timestamptz not null default now(),
  report_type text,
  report_start_date date,
  report_end_date date,
  import_mode text not null default 'append_new',
  status text not null default 'previewed',
  row_count integer default 0,
  rows_found integer not null default 0,
  rows_imported integer not null default 0,
  rows_skipped integer default 0,
  rows_skipped_duplicate integer not null default 0,
  rows_needing_review integer not null default 0,
  error_count integer default 0,
  errors jsonb not null default '[]'::jsonb,
  unknown_machines jsonb not null default '[]'::jsonb,
  unmapped_products jsonb not null default '[]'::jsonb,
  column_mapping jsonb not null default '{}'::jsonb,
  notes text
);

alter table public.vms_import_batches
  add column if not exists file_type text,
  add column if not exists sheet_name text,
  add column if not exists report_type text,
  add column if not exists row_count integer default 0,
  add column if not exists rows_skipped integer default 0,
  add column if not exists error_count integer default 0,
  add column if not exists errors jsonb not null default '[]'::jsonb,
  add column if not exists unknown_machines jsonb not null default '[]'::jsonb,
  add column if not exists unmapped_products jsonb not null default '[]'::jsonb,
  add column if not exists column_mapping jsonb not null default '{}'::jsonb,
  add column if not exists uploaded_by uuid references public.team_members(id) on delete set null,
  add column if not exists uploaded_at timestamptz,
  add column if not exists report_start_date date,
  add column if not exists report_end_date date,
  add column if not exists import_mode text not null default 'append_new',
  add column if not exists rows_found integer not null default 0,
  add column if not exists rows_imported integer not null default 0,
  add column if not exists rows_skipped_duplicate integer not null default 0,
  add column if not exists rows_needing_review integer not null default 0,
  add column if not exists preview_summary jsonb not null default '{}'::jsonb,
  add column if not exists review_summary jsonb not null default '[]'::jsonb,
  add column if not exists failed_at timestamptz,
  add column if not exists last_reprocessed_at timestamptz,
  add column if not exists reprocess_count integer not null default 0;

update public.vms_import_batches
set
  uploaded_by = coalesce(uploaded_by, imported_by),
  uploaded_at = coalesce(uploaded_at, imported_at, now()),
  rows_found = greatest(coalesce(rows_found, 0), coalesce(row_count, 0)),
  rows_needing_review = greatest(coalesce(rows_needing_review, 0), coalesce(error_count, 0))
where uploaded_by is null
   or uploaded_at is null
   or rows_found = 0;

create table if not exists public.vms_import_previews (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_type text not null default 'csv',
  report_type text not null default 'custom',
  sheets jsonb not null default '[]'::jsonb,
  uploaded_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  file_size_bytes bigint
);

alter table public.vms_import_previews
  add column if not exists file_size_bytes bigint;

create table if not exists public.vms_import_preview_rows (
  id uuid primary key default gen_random_uuid(),
  preview_id uuid not null references public.vms_import_previews(id) on delete cascade,
  sheet_name text,
  row_number integer not null,
  raw_row jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(preview_id, sheet_name, row_number)
);

create table if not exists public.vms_header_mappings (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,
  source_signature text not null,
  header_names jsonb not null default '[]'::jsonb,
  required_field_mapping jsonb not null default '{}'::jsonb,
  optional_field_mapping jsonb not null default '{}'::jsonb,
  last_used_mapping jsonb not null default '{}'::jsonb,
  use_count integer not null default 1,
  created_by uuid references public.team_members(id) on delete set null,
  updated_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(report_type, source_signature)
);

create table if not exists public.vms_machine_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_machine_key text not null unique,
  vms_machine_name text,
  machine_id uuid references public.machines(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  confidence_score numeric(5,4) not null default 1,
  status text not null default 'needs_review',
  aliases text[] not null default '{}'::text[],
  created_by uuid references public.team_members(id) on delete set null,
  updated_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_product_mappings
  add column if not exists confidence_score numeric(5,4) not null default 1,
  add column if not exists snacky_product_name text;

create index if not exists idx_vms_import_batches_uploaded_at
  on public.vms_import_batches(uploaded_at desc);
create index if not exists idx_vms_import_batches_status
  on public.vms_import_batches(status);
create index if not exists idx_vms_import_preview_rows_preview
  on public.vms_import_preview_rows(preview_id, row_number);
create index if not exists idx_vms_header_mappings_report_type_updated
  on public.vms_header_mappings(report_type, updated_at desc);
create index if not exists idx_vms_machine_mappings_status
  on public.vms_machine_mappings(status);

do $$ begin
  alter table public.vms_import_batches
    add constraint vms_import_batches_import_mode_check
    check (import_mode in ('append_new', 'replace_range', 'preview_only'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_import_batches
    add constraint vms_import_batches_status_check
    check (status in ('previewed', 'processing', 'imported', 'failed', 'cancelled', 'canceled', 'completed', 'completed_with_warnings'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_machine_mappings
    add constraint vms_machine_mappings_confidence_check
    check (confidence_score >= 0 and confidence_score <= 1);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_machine_mappings
    add constraint vms_machine_mappings_status_check
    check (status in ('confirmed', 'suggested', 'needs_review', 'ignored'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_product_mappings
    add constraint vms_product_mappings_confidence_check
    check (confidence_score >= 0 and confidence_score <= 1);
exception when duplicate_object then null; end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_previews',
    'vms_import_preview_rows',
    'vms_import_rows',
    'vms_import_raw_rows',
    'vms_header_mappings',
    'vms_product_mappings',
    'vms_machine_mappings'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
      execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_delete_by_vms_import_role" on public.%I', table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_select_by_vms_import_role"
        on public.%I for select
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_insert_by_vms_import_role"
        on public.%I for insert
        to authenticated
        with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_update_by_vms_import_role"
        on public.%I for update
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
        with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_delete_by_vms_import_role"
        on public.%I for delete
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.vms_sales_raw') is not null then
    grant select on public.vms_sales_raw to authenticated;
  end if;
  if to_regclass('public.vms_sales_clean') is not null then
    grant select on public.vms_sales_clean to authenticated;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
