-- Ensures VMS import batches can store file/import metadata and adds the
-- machine-goods inventory snapshot table used by Inventory of machine goods XLS files.

alter table public.vms_import_batches
  add column if not exists file_hash text,
  add column if not exists storage_path text,
  add column if not exists detected_min_datetime timestamptz,
  add column if not exists detected_max_datetime timestamptz,
  add column if not exists total_successful_sales numeric not null default 0,
  add column if not exists successful_rows_count integer not null default 0,
  add column if not exists failed_rows_count integer not null default 0,
  add column if not exists refunded_rows_count integer not null default 0,
  add column if not exists is_active boolean not null default false,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid,
  add column if not exists disable_reason text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text;

alter table public.vms_import_batches
  alter column is_active set default false,
  alter column total_successful_sales set default 0,
  alter column successful_rows_count set default 0,
  alter column failed_rows_count set default 0,
  alter column refunded_rows_count set default 0;

update public.vms_import_batches
set is_active = false
where status is distinct from 'imported'
   or deleted_at is not null;

create table if not exists public.vms_machine_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  row_number integer,
  machine_id uuid references public.machines(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  machine_code text,
  machine_name text,
  point_name text,
  vms_product_code text,
  vms_product_name text,
  product_specification text,
  product_barcode text,
  third_party_commodity_number text,
  product_unit text,
  production_date date,
  warranty_date date,
  inventory_quantity numeric not null default 0,
  out_of_stock_quantity numeric not null default 0,
  inventory_capacity numeric,
  raw_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.vms_machine_stock_snapshots
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  add column if not exists row_number integer,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists machine_code text,
  add column if not exists machine_name text,
  add column if not exists point_name text,
  add column if not exists vms_product_code text,
  add column if not exists vms_product_name text,
  add column if not exists product_specification text,
  add column if not exists product_barcode text,
  add column if not exists third_party_commodity_number text,
  add column if not exists product_unit text,
  add column if not exists production_date date,
  add column if not exists warranty_date date,
  add column if not exists inventory_quantity numeric not null default 0,
  add column if not exists out_of_stock_quantity numeric not null default 0,
  add column if not exists inventory_capacity numeric,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists idx_vms_machine_stock_snapshots_batch_row
  on public.vms_machine_stock_snapshots(import_batch_id, row_number)
  where import_batch_id is not null and row_number is not null;

create index if not exists idx_vms_machine_stock_snapshots_machine_product
  on public.vms_machine_stock_snapshots(machine_id, product_id, created_at desc);

alter table public.vms_machine_stock_snapshots enable row level security;
grant select, insert, update, delete on public.vms_machine_stock_snapshots to authenticated;

drop policy if exists "snacky_vms_machine_stock_snapshots_select_by_vms_import_permission" on public.vms_machine_stock_snapshots;
drop policy if exists "snacky_vms_machine_stock_snapshots_insert_by_vms_import_permission" on public.vms_machine_stock_snapshots;
drop policy if exists "snacky_vms_machine_stock_snapshots_update_by_vms_import_permission" on public.vms_machine_stock_snapshots;
drop policy if exists "snacky_vms_machine_stock_snapshots_delete_by_vms_import_permission" on public.vms_machine_stock_snapshots;

create policy "snacky_vms_machine_stock_snapshots_select_by_vms_import_permission"
on public.vms_machine_stock_snapshots for select
to authenticated
using (public.snacky_current_profile_can_view_vms_import());

create policy "snacky_vms_machine_stock_snapshots_insert_by_vms_import_permission"
on public.vms_machine_stock_snapshots for insert
to authenticated
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_machine_stock_snapshots_update_by_vms_import_permission"
on public.vms_machine_stock_snapshots for update
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings())
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_machine_stock_snapshots_delete_by_vms_import_permission"
on public.vms_machine_stock_snapshots for delete
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings());

update public.vms_import_batches
set
  source_usage = '{"source_type":"machine_stock_snapshot","main_sales_source":false,"reconciliation_only":false,"dashboards":["inventory","refills","products","machines"],"excluded_dashboards":["sales","finance"]}'::jsonb,
  dashboard_usage = '{"source_type":"machine_stock_snapshot","main_sales_source":false,"reconciliation_only":false,"dashboards":["inventory","refills","products","machines"],"excluded_dashboards":["sales","finance"]}'::jsonb,
  total_successful_sales = 0,
  successful_rows_count = 0,
  failed_rows_count = 0,
  refunded_rows_count = 0
where report_type = 'machine_stock_snapshot';

select pg_notify('pgrst', 'reload schema');
