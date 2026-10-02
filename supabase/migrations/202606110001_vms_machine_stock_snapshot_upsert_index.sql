create unique index if not exists idx_vms_machine_stock_snapshots_batch_row_upsert
  on public.vms_machine_stock_snapshots(import_batch_id, row_number);
