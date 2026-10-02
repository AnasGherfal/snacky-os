create table if not exists vms_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references vms_import_batches(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  validation_status text not null default 'pending',
  validation_errors jsonb not null default '[]'::jsonb,
  machine_match_status text,
  product_match_status text,
  matched_machine_id uuid references machines(id) on delete set null,
  matched_product_id uuid references products(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(import_batch_id, row_number),
  constraint vms_import_rows_validation_status_check check (
    validation_status in ('pending', 'imported', 'needs_mapping', 'unknown_machine', 'invalid_row', 'skipped')
  )
);

create index if not exists idx_vms_import_rows_batch
  on vms_import_rows(import_batch_id, row_number);

create index if not exists idx_vms_import_rows_validation_status
  on vms_import_rows(validation_status);

create index if not exists idx_vms_import_rows_product_match_status
  on vms_import_rows(product_match_status);

insert into vms_import_rows (
  import_batch_id,
  row_number,
  raw_data,
  normalized_data,
  validation_status,
  validation_errors,
  machine_match_status,
  product_match_status,
  created_at
)
select
  import_batch_id,
  source_row_number,
  original_row,
  mapped_row,
  row_status,
  row_reasons,
  case
    when row_status = 'unknown_machine' then 'unknown'
    when vms_machine_identifier is null then null
    else 'matched'
  end,
  case
    when row_status = 'needs_mapping' then 'needs_mapping'
    when vms_product_id is null and vms_product_name is null then null
    else 'matched'
  end,
  created_at
from vms_import_raw_rows
on conflict (import_batch_id, row_number) do nothing;
