-- Safety migration for detailed VMS Order Details raw inserts.
-- Some production environments are missing business_date on vms_transactions_raw,
-- which causes the detailed import payload to fail even when the file parsed cleanly.

alter table public.vms_transactions_raw
  add column if not exists business_date date;

create index if not exists idx_vms_transactions_raw_batch_business_date
  on public.vms_transactions_raw(import_batch_id, business_date);

create index if not exists idx_vms_transactions_raw_business_status
  on public.vms_transactions_raw(business_date, transaction_status);
