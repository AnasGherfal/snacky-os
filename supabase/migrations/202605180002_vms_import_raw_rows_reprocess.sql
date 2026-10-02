alter table vms_import_batches
  add column if not exists last_reprocessed_at timestamptz,
  add column if not exists reprocess_count integer not null default 0;

create table if not exists vms_import_raw_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references vms_import_batches(id) on delete cascade,
  source_row_number integer not null,
  original_row jsonb not null default '{}'::jsonb,
  mapped_row jsonb not null default '{}'::jsonb,
  row_status text not null default 'pending',
  row_reasons jsonb not null default '[]'::jsonb,
  vms_machine_identifier text,
  vms_product_id text,
  vms_product_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(import_batch_id, source_row_number),
  constraint vms_import_raw_rows_status_check check (
    row_status in ('pending', 'imported', 'needs_mapping', 'unknown_machine', 'invalid_row', 'skipped')
  )
);

create index if not exists idx_vms_import_raw_rows_batch
  on vms_import_raw_rows(import_batch_id, source_row_number);

create index if not exists idx_vms_import_raw_rows_status
  on vms_import_raw_rows(row_status);
