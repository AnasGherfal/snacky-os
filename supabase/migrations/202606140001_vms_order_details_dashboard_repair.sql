-- Repairs detailed VMS order-detail imports so dashboards can use active
-- transaction batches even when mappings are missing or revenue needs a
-- fallback beyond payment_amount.

alter table public.vms_transactions_raw
  add column if not exists amount_paid numeric,
  add column if not exists gross_sales_lyd numeric;

with resolved_amounts as (
  select
    tx.id,
    nullif(tx.payment_amount, 0) as normalized_payment_amount,
    case
      when coalesce(tx.discounted_price, tx.commodity_price_1, tx.commodity_price_2) is null then null
      else greatest(
        coalesce(tx.discounted_price, tx.commodity_price_1, tx.commodity_price_2, 0)
          * greatest(coalesce(tx.quantity, 1), 0),
        0
      )
    end as derived_gross_sales_amount
  from public.vms_transactions_raw tx
)
update public.vms_transactions_raw tx
set amount_paid = coalesce(tx.amount_paid, resolved.normalized_payment_amount),
    gross_sales_lyd = coalesce(
      tx.gross_sales_lyd,
      resolved.normalized_payment_amount,
      resolved.derived_gross_sales_amount,
      0
    )
from resolved_amounts resolved
where resolved.id = tx.id
  and (tx.amount_paid is null or tx.gross_sales_lyd is null);

drop view if exists public.vms_transaction_status_monthly cascade;
drop view if exists public.vms_transaction_status_daily cascade;
drop view if exists public.kpi_location_monthly cascade;
drop view if exists public.kpi_product_monthly cascade;
drop view if exists public.kpi_product_daily cascade;
drop view if exists public.kpi_machine_monthly cascade;
drop view if exists public.kpi_machine_daily cascade;
drop view if exists public.vms_sales_clean cascade;

create or replace view public.vms_sales_clean as
with detailed_sales as (
  select
    tx.id,
    tx.import_batch_id,
    tx.duplicate_hash as source_row_key,
    coalesce(tx.order_number, tx.third_party_transaction_number, tx.third_party_order_no) as vms_transaction_id,
    vib.file_name,
    tx.mapped_machine_id as machine_id,
    coalesce(m.name, nullif(btrim(tx.machine_name), ''), nullif(btrim(tx.machine_code), ''), 'Unmapped machine') as machine_name,
    coalesce(m.machine_code, nullif(btrim(tx.machine_code), '')) as machine_code,
    m.location_id,
    coalesce(l.name, 'No location') as location_name,
    tx.mapped_product_id as product_id,
    coalesce(p.name, nullif(btrim(tx.vms_product_name), ''), nullif(btrim(tx.product_number), ''), 'Unmapped product') as product_name,
    coalesce(p.sku, nullif(btrim(tx.product_number), '')) as product_sku,
    coalesce(tx.payment_time, tx.delivery_time)::date as sale_date,
    date_trunc('month', coalesce(tx.payment_time, tx.delivery_time))::date as sales_month,
    coalesce(vib.report_start_date, coalesce(tx.payment_time, tx.delivery_time)::date) as report_start_date,
    coalesce(vib.report_end_date, coalesce(tx.payment_time, tx.delivery_time)::date) as report_end_date,
    greatest(coalesce(tx.quantity, 1), 0)::integer as units_sold,
    1::integer as transaction_count,
    amounts.resolved_sales_amount as gross_sales_amount,
    amounts.resolved_sales_amount as net_sales_amount,
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
      else (amounts.resolved_sales_amount - prc.reporting_unit_cost_lyd * greatest(coalesce(tx.quantity, 1), 0))::numeric(12,2)
    end as gross_profit_amount,
    (prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0) as cost_missing,
    coalesce(tx.payment_time, tx.delivery_time) as period_start,
    coalesce(tx.payment_time, tx.delivery_time) as period_end,
    tx.created_at,
    jsonb_build_object(
      'source', 'vms_order_details_weekly',
      'raw', tx.raw_row,
      'normalized', tx.normalized_row,
      'transaction_status', tx.transaction_status
    ) as metadata
  from public.vms_transactions_raw tx
  left join public.vms_import_batches vib on vib.id = tx.import_batch_id
  left join public.machines m on m.id = tx.mapped_machine_id
  left join public.locations l on l.id = m.location_id
  left join public.products p on p.id = tx.mapped_product_id
  left join public.product_reporting_costs prc on prc.product_id = tx.mapped_product_id
  cross join lateral (
    select coalesce(
      nullif(tx.payment_amount, 0),
      nullif(tx.amount_paid, 0),
      nullif(tx.gross_sales_lyd, 0),
      case
        when coalesce(tx.discounted_price, tx.commodity_price_1, tx.commodity_price_2) is null then null
        else greatest(
          coalesce(tx.discounted_price, tx.commodity_price_1, tx.commodity_price_2, 0)
            * greatest(coalesce(tx.quantity, 1), 0),
          0
        )
      end,
      0
    )::numeric(12,2) as resolved_sales_amount
  ) amounts
  where lower(coalesce(tx.transaction_status, '')) in ('successful_sale', 'success', 'goods_shipped', 'completed')
    and coalesce(tx.payment_time, tx.delivery_time) is not null
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.is_active = true
    and vib.deleted_at is null
),
summary_sales as (
  select
    raw.id,
    raw.import_batch_id,
    raw.duplicate_hash as source_row_key,
    raw.normalized_row ->> 'vms_transaction_id' as vms_transaction_id,
    vib.file_name,
    raw.machine_id,
    coalesce(m.name, nullif(btrim(raw.normalized_row ->> 'machine_name'), ''), nullif(btrim(raw.normalized_row ->> 'machine_code'), ''), 'Unmapped machine') as machine_name,
    coalesce(m.machine_code, nullif(btrim(raw.normalized_row ->> 'machine_code'), '')) as machine_code,
    m.location_id,
    coalesce(l.name, 'No location') as location_name,
    raw.product_id,
    coalesce(p.name, nullif(btrim(raw.normalized_row ->> 'product_name'), ''), nullif(btrim(raw.normalized_row ->> 'product_number'), ''), 'Unmapped product') as product_name,
    coalesce(p.sku, nullif(btrim(raw.normalized_row ->> 'product_number'), '')) as product_sku,
    raw.sale_date,
    date_trunc('month', raw.sale_date)::date as sales_month,
    raw.sale_date as report_start_date,
    raw.sale_date as report_end_date,
    greatest(coalesce(raw.quantity, 0), 0)::integer as units_sold,
    greatest(coalesce(raw.quantity, 0), 0)::integer as transaction_count,
    greatest(coalesce(raw.gross_sales_lyd, 0), 0)::numeric(12,2) as gross_sales_amount,
    greatest(coalesce(raw.net_sales_lyd, raw.gross_sales_lyd, 0), 0)::numeric(12,2) as net_sales_amount,
    0::numeric(12,2) as cash_sales_amount,
    0::numeric(12,2) as card_sales_amount,
    prc.reporting_unit_cost_lyd as unit_cost_amount,
    coalesce(prc.cost_method, 'missing') as cost_method,
    case
      when prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0 then null
      else (prc.reporting_unit_cost_lyd * greatest(coalesce(raw.quantity, 0), 0))::numeric(12,2)
    end as product_cost_amount,
    case
      when prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0 then null
      else (greatest(coalesce(raw.net_sales_lyd, raw.gross_sales_lyd, 0), 0) - prc.reporting_unit_cost_lyd * greatest(coalesce(raw.quantity, 0), 0))::numeric(12,2)
    end as gross_profit_amount,
    (prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0) as cost_missing,
    raw.sale_datetime as period_start,
    raw.sale_datetime as period_end,
    raw.created_at,
    jsonb_build_object('source', 'vms_summary_sales', 'raw', raw.raw_row, 'normalized', raw.normalized_row) as metadata
  from public.vms_sales_raw raw
  left join public.vms_import_batches vib on vib.id = raw.import_batch_id
  left join public.machines m on m.id = raw.machine_id
  left join public.locations l on l.id = m.location_id
  left join public.products p on p.id = raw.product_id
  left join public.product_reporting_costs prc on prc.product_id = raw.product_id
  where raw.sale_date is not null
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.is_active = true
    and vib.deleted_at is null
    and not exists (
      select 1
      from public.vms_transactions_raw tx
      join public.vms_import_batches active_tx_batch on active_tx_batch.id = tx.import_batch_id
      where lower(coalesce(tx.transaction_status, '')) in ('successful_sale', 'success', 'goods_shipped', 'completed')
        and coalesce(tx.payment_time, tx.delivery_time)::date = raw.sale_date
        and active_tx_batch.status in ('imported', 'imported_with_warnings', 'partially_imported')
        and active_tx_batch.is_active = true
        and active_tx_batch.deleted_at is null
    )
)
select * from detailed_sales
union all
select * from summary_sales;

create or replace view public.kpi_machine_daily as
select
  machine_id,
  machine_name,
  machine_code,
  location_id,
  location_name,
  sale_date,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  (sum(net_sales_amount) / nullif(sum(transaction_count), 0))::numeric(12,2) as average_transaction_value,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from public.vms_sales_clean
group by machine_id, machine_name, machine_code, location_id, location_name, sale_date;

create or replace view public.kpi_machine_monthly as
select
  machine_id,
  machine_name,
  machine_code,
  location_id,
  location_name,
  sales_month,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  (sum(net_sales_amount) / nullif(sum(transaction_count), 0))::numeric(12,2) as average_transaction_value,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  (sum(net_sales_amount) / nullif(count(distinct sale_date), 0))::numeric(12,2) as average_sales_per_day,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from public.vms_sales_clean
group by machine_id, machine_name, machine_code, location_id, location_name, sales_month;

create or replace view public.kpi_product_daily as
select
  product_id,
  product_name,
  product_sku,
  sale_date,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  (sum(net_sales_amount) / nullif(sum(transaction_count), 0))::numeric(12,2) as average_transaction_value,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from public.vms_sales_clean
group by product_id, product_name, product_sku, sale_date;

create or replace view public.kpi_product_monthly as
select
  product_id,
  product_name,
  product_sku,
  sales_month,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  (sum(net_sales_amount) / nullif(sum(transaction_count), 0))::numeric(12,2) as average_transaction_value,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  (sum(units_sold) / nullif(count(distinct sale_date), 0))::numeric(12,4) as stock_velocity_units_per_day,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from public.vms_sales_clean
group by product_id, product_name, product_sku, sales_month;

create or replace view public.kpi_location_monthly as
select
  location_id,
  location_name,
  sales_month,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  (sum(net_sales_amount) / nullif(sum(transaction_count), 0))::numeric(12,2) as average_transaction_value,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(distinct machine_id) as machine_count,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from public.vms_sales_clean
group by location_id, location_name, sales_month;

create or replace view public.vms_transaction_status_daily as
select
  coalesce(tx.payment_time, tx.delivery_time)::date as sale_date,
  tx.mapped_machine_id as machine_id,
  coalesce(m.name, nullif(btrim(tx.machine_name), ''), nullif(btrim(tx.machine_code), ''), 'Unmapped machine') as machine_name,
  tx.mapped_product_id as product_id,
  coalesce(p.name, nullif(btrim(tx.vms_product_name), ''), nullif(btrim(tx.product_number), ''), 'Unmapped product') as product_name,
  count(*) filter (where tx.transaction_status = 'failed_vend') as failed_vend_count,
  (
    sum(
      case
        when tx.transaction_status = 'failed_vend' then amounts.resolved_sales_amount
        else 0
      end
    )
  )::numeric(12,2) as failed_vend_amount,
  count(*) filter (where tx.transaction_status = 'refunded') as refund_count,
  (
    sum(
      case
        when tx.transaction_status = 'refunded' then amounts.resolved_sales_amount
        else 0
      end
    )
  )::numeric(12,2) as refund_amount,
  count(*) filter (where tx.transaction_status = 'failed_payment') as failed_payment_count,
  count(*) filter (where tx.transaction_status = 'needs_review') as needs_review_count,
  count(*) as transaction_rows
from public.vms_transactions_raw tx
join public.vms_import_batches vib on vib.id = tx.import_batch_id
left join public.machines m on m.id = tx.mapped_machine_id
left join public.products p on p.id = tx.mapped_product_id
cross join lateral (
  select coalesce(
    nullif(tx.payment_amount, 0),
    nullif(tx.amount_paid, 0),
    nullif(tx.gross_sales_lyd, 0),
    case
      when coalesce(tx.discounted_price, tx.commodity_price_1, tx.commodity_price_2) is null then null
      else greatest(
        coalesce(tx.discounted_price, tx.commodity_price_1, tx.commodity_price_2, 0)
          * greatest(coalesce(tx.quantity, 1), 0),
        0
      )
    end,
    0
  )::numeric(12,2) as resolved_sales_amount
) amounts
where coalesce(tx.payment_time, tx.delivery_time) is not null
  and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
  and vib.is_active = true
  and vib.deleted_at is null
group by 1, 2, 3, 4, 5;

create or replace view public.vms_transaction_status_monthly as
select
  date_trunc('month', sale_date)::date as sales_month,
  sum(failed_vend_count)::integer as failed_vend_count,
  sum(coalesce(failed_vend_amount, 0))::numeric(12,2) as failed_vend_amount,
  sum(refund_count)::integer as refund_count,
  sum(coalesce(refund_amount, 0))::numeric(12,2) as refund_amount,
  sum(failed_payment_count)::integer as failed_payment_count,
  sum(needs_review_count)::integer as needs_review_count,
  sum(transaction_rows)::integer as transaction_rows
from public.vms_transaction_status_daily
group by date_trunc('month', sale_date)::date;

grant select on public.vms_sales_clean to authenticated;
grant select on public.kpi_machine_daily to authenticated;
grant select on public.kpi_machine_monthly to authenticated;
grant select on public.kpi_product_daily to authenticated;
grant select on public.kpi_product_monthly to authenticated;
grant select on public.kpi_location_monthly to authenticated;
grant select on public.vms_transaction_status_daily to authenticated;
grant select on public.vms_transaction_status_monthly to authenticated;

select pg_notify('pgrst', 'reload schema');
