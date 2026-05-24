alter table vms_sales_snapshots
  add column if not exists machine_code text,
  add column if not exists machine_name text,
  add column if not exists product_number text,
  add column if not exists product_name text,
  add column if not exists commodity_price numeric(12,2),
  add column if not exists transaction_count integer,
  add column if not exists transaction_amount numeric(12,2),
  add column if not exists refund_count integer,
  add column if not exists refund_amount numeric(12,2),
  add column if not exists total_transaction numeric(12,2),
  add column if not exists sales_period_start date,
  add column if not exists sales_period_end date,
  add column if not exists sales_month date;

update vms_sales_snapshots
set
  transaction_count = coalesce(transaction_count, sold_qty),
  transaction_amount = coalesce(transaction_amount, sales_amount),
  sales_period_start = coalesce(sales_period_start, period_start::date),
  sales_period_end = coalesce(sales_period_end, period_end::date),
  sales_month = coalesce(sales_month, date_trunc('month', period_start)::date)
where transaction_count is null
   or transaction_amount is null
   or sales_period_start is null
   or sales_period_end is null
   or sales_month is null;

create index if not exists idx_vms_sales_snapshots_sales_month
  on vms_sales_snapshots(sales_month);

create index if not exists idx_vms_sales_snapshots_machine_product_month
  on vms_sales_snapshots(machine_code, product_number, sales_month);
