alter table products
  add column if not exists import_source text not null default 'initial_import',
  add column if not exists last_vms_import_batch_id uuid references vms_import_batches(id) on delete set null,
  add column if not exists last_vms_seen_at timestamptz;

create index if not exists products_import_source_idx on products(import_source);
create index if not exists products_last_vms_seen_at_idx on products(last_vms_seen_at desc);
