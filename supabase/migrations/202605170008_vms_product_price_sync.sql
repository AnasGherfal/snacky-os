alter table vms_product_mappings
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists vms_cost_price_lyd numeric(12,4),
  add column if not exists latest_machine_id uuid references machines(id) on delete set null,
  add column if not exists latest_vms_machine_id text,
  add column if not exists latest_machine_name text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_import_batch_id uuid references vms_import_batches(id) on delete set null;

create index if not exists vms_product_mappings_last_seen_at_idx on vms_product_mappings(last_seen_at desc);
create index if not exists vms_product_mappings_latest_machine_id_idx on vms_product_mappings(latest_machine_id);
