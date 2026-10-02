-- Repairs VMS import end-to-end behavior without adding new VMS features.
-- 1. Keep a last_error compatibility column alongside latest_error.
-- 2. Stop the sales-summary import RPC from resetting a batch to failed after
--    the app has already imported usable rows; the app now records the exact
--    failed step and classifies partial imports as imported_with_warnings or
--    partially_imported.

alter table public.vms_import_batches
  add column if not exists last_error text;

update public.vms_import_batches
set last_error = coalesce(last_error, latest_error)
where last_error is null
  and latest_error is not null;

create or replace function public.apply_vms_sales_snapshot_import(
  p_batch_id uuid,
  p_import_mode text,
  p_report_start_date date,
  p_report_end_date date,
  p_sales_rows jsonb
)
returns table(rows_inserted integer, rows_skipped_duplicate integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_count integer := coalesce(jsonb_array_length(coalesce(p_sales_rows, '[]'::jsonb)), 0);
begin
  if p_import_mode = 'replace_range' then
    if p_report_start_date is null or p_report_end_date is null then
      raise exception 'replace_range requires report_start_date and report_end_date'
        using errcode = '22023';
    end if;

    update public.vms_sales_snapshots
    set import_row_status = 'reprocessed_stale'
    where import_row_status = 'imported'
      and coalesce(sales_period_end, period_end::date) between p_report_start_date and p_report_end_date;
  end if;

  insert into public.vms_sales_snapshots (
    import_batch_id,
    import_row_number,
    import_row_status,
    source_row_key,
    vms_transaction_id,
    machine_id,
    product_id,
    sold_qty,
    sales_amount,
    cash_sales_amount,
    card_sales_amount,
    cost_amount,
    profit_amount,
    period_start,
    period_end,
    machine_code,
    machine_name,
    product_number,
    product_name,
    commodity_price,
    transaction_count,
    transaction_amount,
    refund_count,
    refund_amount,
    total_transaction,
    sales_period_start,
    sales_period_end,
    sales_month,
    gross_sales_amount,
    net_sales_amount,
    cost_method,
    unit_cost_amount,
    gross_profit_amount,
    metadata
  )
  select
    p_batch_id,
    r.import_row_number,
    'imported',
    r.source_row_key,
    r.vms_transaction_id,
    r.machine_id,
    r.product_id,
    greatest(coalesce(r.sold_qty, 0), 0),
    greatest(coalesce(r.sales_amount, 0), 0),
    greatest(coalesce(r.cash_sales_amount, 0), 0),
    greatest(coalesce(r.card_sales_amount, 0), 0),
    r.cost_amount,
    r.profit_amount,
    r.period_start,
    r.period_end,
    r.machine_code,
    r.machine_name,
    r.product_number,
    r.product_name,
    r.commodity_price,
    r.transaction_count,
    r.transaction_amount,
    r.refund_count,
    r.refund_amount,
    r.total_transaction,
    r.sales_period_start,
    r.sales_period_end,
    r.sales_month,
    r.gross_sales_amount,
    r.net_sales_amount,
    r.cost_method,
    r.unit_cost_amount,
    r.gross_profit_amount,
    coalesce(r.metadata, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_sales_rows, '[]'::jsonb)) as r(
    import_row_number integer,
    source_row_key text,
    vms_transaction_id text,
    machine_id uuid,
    product_id uuid,
    sold_qty integer,
    sales_amount numeric,
    cash_sales_amount numeric,
    card_sales_amount numeric,
    cost_amount numeric,
    profit_amount numeric,
    period_start timestamptz,
    period_end timestamptz,
    machine_code text,
    machine_name text,
    product_number text,
    product_name text,
    commodity_price numeric,
    transaction_count integer,
    transaction_amount numeric,
    refund_count integer,
    refund_amount numeric,
    total_transaction numeric,
    sales_period_start date,
    sales_period_end date,
    sales_month date,
    gross_sales_amount numeric,
    net_sales_amount numeric,
    cost_method text,
    unit_cost_amount numeric,
    gross_profit_amount numeric,
    metadata jsonb
  )
  on conflict do nothing;

  get diagnostics rows_inserted = row_count;
  rows_skipped_duplicate := greatest(requested_count - rows_inserted, 0);
  return next;
end;
$$;
