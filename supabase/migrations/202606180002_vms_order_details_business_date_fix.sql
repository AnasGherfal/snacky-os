alter table public.vms_transactions_raw
  add column if not exists business_date date;

create or replace function public.snacky_vms_parse_business_date_text(value text)
returns date
language plpgsql
immutable
as $$
declare
  trimmed text := nullif(btrim(value), '');
  iso_match text[];
  serial_value numeric;
begin
  if trimmed is null then
    return null;
  end if;

  iso_match := regexp_match(trimmed, '^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b');
  if iso_match is not null then
    begin
      return make_date(iso_match[1]::integer, iso_match[2]::integer, iso_match[3]::integer);
    exception
      when others then
        return null;
    end;
  end if;

  iso_match := regexp_match(trimmed, '^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b');
  if iso_match is not null then
    begin
      return make_date(iso_match[3]::integer, iso_match[2]::integer, iso_match[1]::integer);
    exception
      when others then
        return null;
    end;
  end if;

  begin
    serial_value := trimmed::numeric;
  exception
    when others then
      serial_value := null;
  end;

  if serial_value is not null and serial_value > 25000 and serial_value < 80000 then
    return ((timestamp with time zone '1899-12-30 00:00:00+00' + (serial_value * interval '1 day')) at time zone 'UTC')::date;
  end if;

  begin
    return (trimmed::timestamp)::date;
  exception
    when others then
      return null;
  end;
end;
$$;

create or replace function public.snacky_vms_order_details_business_date(
  raw_row jsonb,
  normalized_row jsonb,
  payment_time timestamptz,
  delivery_time timestamptz
)
returns date
language sql
immutable
as $$
  select coalesce(
    public.snacky_vms_parse_business_date_text(
      coalesce(
        nullif(btrim(normalized_row ->> 'business_date'), ''),
        nullif(btrim(normalized_row ->> 'sale_date'), ''),
        nullif(btrim(normalized_row ->> 'sales_date'), ''),
        nullif(btrim(normalized_row ->> 'report_date'), ''),
        nullif(btrim(normalized_row ->> 'transaction_date'), ''),
        nullif(btrim(normalized_row ->> 'settlement_date'), ''),
        nullif(btrim(normalized_row ->> 'date'), ''),
        nullif(btrim(raw_row ->> 'business_date'), ''),
        nullif(btrim(raw_row ->> 'sale_date'), ''),
        nullif(btrim(raw_row ->> 'sales_date'), ''),
        nullif(btrim(raw_row ->> 'report_date'), ''),
        nullif(btrim(raw_row ->> 'transaction_date'), ''),
        nullif(btrim(raw_row ->> 'settlement_date'), ''),
        nullif(btrim(raw_row ->> 'date'), ''),
        nullif(btrim(raw_row ->> 'Date'), ''),
        nullif(btrim(raw_row ->> 'Sale date'), ''),
        nullif(btrim(raw_row ->> 'Sale Date'), ''),
        nullif(btrim(raw_row ->> 'Transaction Date'), '')
      )
    ),
    public.snacky_vms_parse_business_date_text(
      coalesce(
        nullif(btrim(normalized_row ->> 'payment_time'), ''),
        nullif(btrim(normalized_row ->> 'time_of_payment'), ''),
        nullif(btrim(normalized_row ->> 'delivery_time'), ''),
        nullif(btrim(raw_row ->> 'payment_time'), ''),
        nullif(btrim(raw_row ->> 'time_of_payment'), ''),
        nullif(btrim(raw_row ->> 'Time of payment'), ''),
        nullif(btrim(raw_row ->> 'Payment time'), ''),
        nullif(btrim(raw_row ->> 'Payment Time'), ''),
        nullif(btrim(raw_row ->> 'delivery_time'), ''),
        nullif(btrim(raw_row ->> 'Delivery time'), ''),
        nullif(btrim(raw_row ->> 'Delivery Time'), '')
      )
    ),
    ((coalesce(payment_time, delivery_time) at time zone 'UTC'))::date
  );
$$;

update public.vms_transactions_raw
set business_date = public.snacky_vms_order_details_business_date(raw_row, normalized_row, payment_time, delivery_time)
where business_date is null;

create index if not exists idx_vms_transactions_raw_batch_business_date
  on public.vms_transactions_raw(import_batch_id, business_date);

create index if not exists idx_vms_transactions_raw_business_status
  on public.vms_transactions_raw(business_date, transaction_status);

create or replace view public.vms_sales_clean as
with detailed_sales as (
  select
    tx.id,
    tx.import_batch_id,
    tx.duplicate_hash as source_row_key,
    coalesce(tx.order_number, tx.third_party_transaction_number, tx.third_party_order_no) as vms_transaction_id,
    vib.file_name,
    tx.mapped_machine_id as machine_id,
    coalesce(m.name, tx.machine_name, tx.machine_code, 'Unmapped machine') as machine_name,
    coalesce(m.machine_code, tx.machine_code) as machine_code,
    m.location_id,
    coalesce(l.name, 'No location') as location_name,
    tx.mapped_product_id as product_id,
    coalesce(p.name, tx.vms_product_name, tx.product_number, 'Unmapped product') as product_name,
    coalesce(p.sku, tx.product_number) as product_sku,
    coalesce(
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ) as sale_date,
    date_trunc('month', coalesce(
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ))::date as sales_month,
    coalesce(
      vib.report_start_date,
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ) as report_start_date,
    coalesce(
      vib.report_end_date,
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ) as report_end_date,
    greatest(coalesce(tx.quantity, 1), 0)::integer as units_sold,
    1::integer as transaction_count,
    greatest(coalesce(tx.payment_amount, 0), 0)::numeric(12,2) as gross_sales_amount,
    greatest(coalesce(tx.payment_amount, 0), 0)::numeric(12,2) as net_sales_amount,
    0::numeric(12,2) as cash_sales_amount,
    0::numeric(12,2) as card_sales_amount,
    prc.reporting_unit_cost_lyd as unit_cost_amount,
    coalesce(prc.cost_method, 'missing') as cost_method,
    case
      when prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0 then null
      else (prc.reporting_unit_cost_lyd * greatest(coalesce(tx.quantity, 1), 0))::numeric(12,2)
    end as product_cost_amount,
    case
      when prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0 then null
      else (greatest(coalesce(tx.payment_amount, 0), 0) - prc.reporting_unit_cost_lyd * greatest(coalesce(tx.quantity, 1), 0))::numeric(12,2)
    end as gross_profit_amount,
    (prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0) as cost_missing,
    coalesce(tx.payment_time, tx.delivery_time) as period_start,
    coalesce(tx.payment_time, tx.delivery_time) as period_end,
    tx.created_at,
    jsonb_build_object('source', coalesce(vib.report_type, 'vms_order_details_weekly'), 'raw', tx.raw_row, 'normalized', tx.normalized_row, 'transaction_status', tx.transaction_status, 'business_date', tx.business_date) as metadata
  from public.vms_transactions_raw tx
  left join public.vms_import_batches vib on vib.id = tx.import_batch_id
  left join public.machines m on m.id = tx.mapped_machine_id
  left join public.locations l on l.id = m.location_id
  left join public.products p on p.id = tx.mapped_product_id
  left join public.product_reporting_costs prc on prc.product_id = tx.mapped_product_id
  where tx.transaction_status = 'successful_sale'
    and coalesce(
      tx.business_date,
      public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
    ) is not null
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.is_active = true
    and vib.deleted_at is null
)
select * from detailed_sales;

create or replace view public.vms_transaction_status_daily as
select
  coalesce(
    tx.business_date,
    public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
  ) as sale_date,
  tx.mapped_machine_id as machine_id,
  coalesce(m.name, tx.machine_name, tx.machine_code, 'Unmapped machine') as machine_name,
  tx.mapped_product_id as product_id,
  coalesce(p.name, tx.vms_product_name, tx.product_number, 'Unmapped product') as product_name,
  count(*) filter (where tx.transaction_status = 'failed_vend') as failed_vend_count,
  (sum(coalesce(tx.payment_amount, 0)) filter (where tx.transaction_status = 'failed_vend'))::numeric(12,2) as failed_vend_amount,
  count(*) filter (where tx.transaction_status = 'refunded') as refund_count,
  (sum(coalesce(tx.payment_amount, 0)) filter (where tx.transaction_status = 'refunded'))::numeric(12,2) as refund_amount,
  count(*) filter (where tx.transaction_status = 'failed_payment') as failed_payment_count,
  count(*) filter (where tx.transaction_status = 'needs_review') as needs_review_count,
  count(*) as transaction_rows
from public.vms_transactions_raw tx
join public.vms_import_batches vib on vib.id = tx.import_batch_id
left join public.machines m on m.id = tx.mapped_machine_id
left join public.products p on p.id = tx.mapped_product_id
where coalesce(
    tx.business_date,
    public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
  ) is not null
  and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
  and vib.is_active = true
  and vib.deleted_at is null
group by 1, 2, 3, 4, 5;

create or replace function public.sales_dashboard_batch_reconciliation(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  batch_id uuid,
  source_file_name text,
  batch_status text,
  is_active boolean,
  deleted_at timestamptz,
  uploaded_at timestamptz,
  imported_at timestamptz,
  metadata_report_start_date date,
  metadata_report_end_date date,
  metadata_detected_min_datetime timestamptz,
  metadata_detected_max_datetime timestamptz,
  metadata_imported_rows_total integer,
  metadata_rows_found_total integer,
  metadata_duplicate_rows_total integer,
  raw_row_count_total integer,
  raw_successful_rows_total integer,
  raw_failed_vend_rows_total integer,
  raw_refunded_rows_total integer,
  raw_failed_payment_rows_total integer,
  raw_needs_review_rows_total integer,
  raw_missing_datetime_rows_total integer,
  raw_missing_amount_rows_total integer,
  raw_successful_sales_amount_total numeric,
  raw_failed_vend_amount_total numeric,
  raw_refunded_amount_total numeric,
  raw_units_sold_total integer,
  raw_min_transaction_at timestamptz,
  raw_max_transaction_at timestamptz,
  raw_min_sale_date date,
  raw_max_sale_date date,
  range_row_count integer,
  range_successful_rows integer,
  range_failed_vend_rows integer,
  range_refunded_rows integer,
  range_failed_payment_rows integer,
  range_needs_review_rows integer,
  range_successful_sales_amount numeric,
  range_failed_vend_amount numeric,
  range_refunded_amount numeric,
  range_units_sold integer,
  range_transaction_count integer,
  range_min_transaction_at timestamptz,
  range_max_transaction_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  detailed_batches as (
    select
      vib.id as batch_id,
      coalesce(vib.original_file_name, vib.file_name, 'unknown file') as source_file_name,
      vib.status as batch_status,
      vib.is_active,
      vib.deleted_at,
      vib.uploaded_at,
      vib.imported_at,
      vib.report_start_date as metadata_report_start_date,
      vib.report_end_date as metadata_report_end_date,
      vib.detected_min_datetime as metadata_detected_min_datetime,
      vib.detected_max_datetime as metadata_detected_max_datetime,
      greatest(coalesce(vib.rows_imported, vib.rows_found, vib.row_count, 0), 0)::integer as metadata_imported_rows_total,
      greatest(coalesce(vib.rows_found, vib.row_count, 0), 0)::integer as metadata_rows_found_total,
      greatest(coalesce(vib.rows_skipped_duplicate, 0), 0)::integer as metadata_duplicate_rows_total
    from public.vms_import_batches vib
    where vib.report_type in ('vms_order_details_weekly', 'monthly_transaction_details')
  ),
  normalized_rows as (
    select
      tx.import_batch_id as batch_id,
      tx.transaction_status,
      tx.payment_amount,
      greatest(coalesce(tx.quantity, 1), 0)::integer as units_sold,
      coalesce(tx.payment_time, tx.delivery_time) as transaction_at,
      coalesce(
        tx.business_date,
        public.snacky_vms_order_details_business_date(tx.raw_row, tx.normalized_row, tx.payment_time, tx.delivery_time)
      ) as sale_business_date,
      tx.payment_amount is null as missing_amount
    from public.vms_transactions_raw tx
    where tx.import_batch_id is not null
  ),
  aggregated as (
    select
      db.batch_id,
      count(nr.batch_id)::integer as raw_row_count_total,
      count(*) filter (where nr.transaction_status = 'successful_sale')::integer as raw_successful_rows_total,
      count(*) filter (where nr.transaction_status = 'failed_vend')::integer as raw_failed_vend_rows_total,
      count(*) filter (where nr.transaction_status = 'refunded')::integer as raw_refunded_rows_total,
      count(*) filter (where nr.transaction_status = 'failed_payment')::integer as raw_failed_payment_rows_total,
      count(*) filter (where nr.transaction_status = 'needs_review')::integer as raw_needs_review_rows_total,
      count(*) filter (where nr.batch_id is not null and nr.transaction_at is null)::integer as raw_missing_datetime_rows_total,
      count(*) filter (where nr.transaction_status = 'successful_sale' and nr.missing_amount)::integer as raw_missing_amount_rows_total,
      coalesce(sum(greatest(coalesce(nr.payment_amount, 0), 0)) filter (where nr.transaction_status = 'successful_sale'), 0)::numeric(12,2) as raw_successful_sales_amount_total,
      coalesce(sum(greatest(coalesce(nr.payment_amount, 0), 0)) filter (where nr.transaction_status = 'failed_vend'), 0)::numeric(12,2) as raw_failed_vend_amount_total,
      coalesce(sum(greatest(coalesce(nr.payment_amount, 0), 0)) filter (where nr.transaction_status = 'refunded'), 0)::numeric(12,2) as raw_refunded_amount_total,
      coalesce(sum(nr.units_sold) filter (where nr.transaction_status = 'successful_sale'), 0)::integer as raw_units_sold_total,
      min(nr.transaction_at) as raw_min_transaction_at,
      max(nr.transaction_at) as raw_max_transaction_at,
      min(nr.sale_business_date) as raw_min_sale_date,
      max(nr.sale_business_date) as raw_max_sale_date,
      count(*) filter (
        where nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_row_count,
      count(*) filter (
        where nr.transaction_status = 'successful_sale'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_successful_rows,
      count(*) filter (
        where nr.transaction_status = 'failed_vend'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_failed_vend_rows,
      count(*) filter (
        where nr.transaction_status = 'refunded'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_refunded_rows,
      count(*) filter (
        where nr.transaction_status = 'failed_payment'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_failed_payment_rows,
      count(*) filter (
        where nr.transaction_status = 'needs_review'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_needs_review_rows,
      coalesce(sum(greatest(coalesce(nr.payment_amount, 0), 0)) filter (
        where nr.transaction_status = 'successful_sale'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      ), 0)::numeric(12,2) as range_successful_sales_amount,
      coalesce(sum(greatest(coalesce(nr.payment_amount, 0), 0)) filter (
        where nr.transaction_status = 'failed_vend'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      ), 0)::numeric(12,2) as range_failed_vend_amount,
      coalesce(sum(greatest(coalesce(nr.payment_amount, 0), 0)) filter (
        where nr.transaction_status = 'refunded'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      ), 0)::numeric(12,2) as range_refunded_amount,
      coalesce(sum(nr.units_sold) filter (
        where nr.transaction_status = 'successful_sale'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      ), 0)::integer as range_units_sold,
      count(*) filter (
        where nr.transaction_status = 'successful_sale'
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      )::integer as range_transaction_count,
      min(nr.transaction_at) filter (
        where nr.transaction_at is not null
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      ) as range_min_transaction_at,
      max(nr.transaction_at) filter (
        where nr.transaction_at is not null
          and nr.sale_business_date is not null
          and (p_date_from is null or nr.sale_business_date >= p_date_from)
          and (p_date_to is null or nr.sale_business_date <= p_date_to)
      ) as range_max_transaction_at
    from detailed_batches db
    left join normalized_rows nr on nr.batch_id = db.batch_id
    group by db.batch_id
  )
  select
    db.batch_id,
    db.source_file_name,
    db.batch_status,
    db.is_active,
    db.deleted_at,
    db.uploaded_at,
    db.imported_at,
    db.metadata_report_start_date,
    db.metadata_report_end_date,
    db.metadata_detected_min_datetime,
    db.metadata_detected_max_datetime,
    db.metadata_imported_rows_total,
    db.metadata_rows_found_total,
    db.metadata_duplicate_rows_total,
    coalesce(ag.raw_row_count_total, 0) as raw_row_count_total,
    coalesce(ag.raw_successful_rows_total, 0) as raw_successful_rows_total,
    coalesce(ag.raw_failed_vend_rows_total, 0) as raw_failed_vend_rows_total,
    coalesce(ag.raw_refunded_rows_total, 0) as raw_refunded_rows_total,
    coalesce(ag.raw_failed_payment_rows_total, 0) as raw_failed_payment_rows_total,
    coalesce(ag.raw_needs_review_rows_total, 0) as raw_needs_review_rows_total,
    coalesce(ag.raw_missing_datetime_rows_total, 0) as raw_missing_datetime_rows_total,
    coalesce(ag.raw_missing_amount_rows_total, 0) as raw_missing_amount_rows_total,
    coalesce(ag.raw_successful_sales_amount_total, 0)::numeric(12,2) as raw_successful_sales_amount_total,
    coalesce(ag.raw_failed_vend_amount_total, 0)::numeric(12,2) as raw_failed_vend_amount_total,
    coalesce(ag.raw_refunded_amount_total, 0)::numeric(12,2) as raw_refunded_amount_total,
    coalesce(ag.raw_units_sold_total, 0) as raw_units_sold_total,
    ag.raw_min_transaction_at,
    ag.raw_max_transaction_at,
    ag.raw_min_sale_date,
    ag.raw_max_sale_date,
    coalesce(ag.range_row_count, 0) as range_row_count,
    coalesce(ag.range_successful_rows, 0) as range_successful_rows,
    coalesce(ag.range_failed_vend_rows, 0) as range_failed_vend_rows,
    coalesce(ag.range_refunded_rows, 0) as range_refunded_rows,
    coalesce(ag.range_failed_payment_rows, 0) as range_failed_payment_rows,
    coalesce(ag.range_needs_review_rows, 0) as range_needs_review_rows,
    coalesce(ag.range_successful_sales_amount, 0)::numeric(12,2) as range_successful_sales_amount,
    coalesce(ag.range_failed_vend_amount, 0)::numeric(12,2) as range_failed_vend_amount,
    coalesce(ag.range_refunded_amount, 0)::numeric(12,2) as range_refunded_amount,
    coalesce(ag.range_units_sold, 0) as range_units_sold,
    coalesce(ag.range_transaction_count, 0) as range_transaction_count,
    ag.range_min_transaction_at,
    ag.range_max_transaction_at
  from detailed_batches db
  join allowed on allowed.permitted
  left join aggregated ag on ag.batch_id = db.batch_id
  order by coalesce(db.uploaded_at, db.imported_at) desc nulls last, db.batch_id desc;
$$;

grant select on public.vms_sales_clean to authenticated;
grant select on public.vms_transaction_status_daily to authenticated;
grant execute on function public.snacky_vms_parse_business_date_text(text) to authenticated;
grant execute on function public.snacky_vms_order_details_business_date(jsonb, jsonb, timestamptz, timestamptz) to authenticated;
grant execute on function public.sales_dashboard_batch_reconciliation(date, date) to authenticated;
