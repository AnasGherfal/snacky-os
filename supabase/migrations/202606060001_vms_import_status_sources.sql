-- Adds partial-success VMS import statuses and makes active data-source
-- views include imported_with_warnings / partially_imported batches.

alter table public.vms_import_batches
  drop constraint if exists vms_import_batches_status_check;

update public.vms_import_batches
set status = case status
  when 'completed' then 'imported'
  when 'completed_with_warnings' then 'imported_with_warnings'
  when 'processing' then 'draft'
  else status
end
where status in ('completed', 'completed_with_warnings', 'processing');

alter table public.vms_import_batches
  add constraint vms_import_batches_status_check
  check (status in ('draft', 'previewed', 'imported', 'imported_with_warnings', 'partially_imported', 'failed', 'cancelled', 'canceled', 'disabled', 'deleted'));

drop view if exists public.refill_recommendations;

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
    coalesce(tx.payment_time, tx.delivery_time)::date as sale_date,
    date_trunc('month', coalesce(tx.payment_time, tx.delivery_time))::date as sales_month,
    coalesce(vib.report_start_date, coalesce(tx.payment_time, tx.delivery_time)::date) as report_start_date,
    coalesce(vib.report_end_date, coalesce(tx.payment_time, tx.delivery_time)::date) as report_end_date,
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
    jsonb_build_object('source', 'vms_order_details_weekly', 'raw', tx.raw_row, 'normalized', tx.normalized_row, 'transaction_status', tx.transaction_status) as metadata
  from public.vms_transactions_raw tx
  left join public.vms_import_batches vib on vib.id = tx.import_batch_id
  left join public.machines m on m.id = tx.mapped_machine_id
  left join public.locations l on l.id = m.location_id
  left join public.products p on p.id = tx.mapped_product_id
  left join public.product_reporting_costs prc on prc.product_id = tx.mapped_product_id
  where tx.transaction_status = 'successful_sale'
    and tx.mapped_product_id is not null
    and tx.mapped_machine_id is not null
    and coalesce(tx.payment_time, tx.delivery_time) is not null
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.is_active = true
    and vib.deleted_at is null
)
select * from detailed_sales;

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

drop view if exists public.latest_vms_stock_by_slot;

create or replace view public.latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
    vib.uploaded_at as batch_uploaded_at,
    coalesce(vib.original_file_name, vib.file_name) as batch_file_name,
    vss.sync_run_id,
    vss.source_provider,
    vss.machine_id,
    nullif(btrim(vss.slot_code), '') as slot_code,
    vss.product_id,
    nullif(btrim(vss.vms_product_id), '') as vms_product_id,
    nullif(btrim(vss.vms_product_name), '') as vms_product_name,
    vss.current_qty,
    vss.capacity,
    vss.captured_at,
    vss.created_at,
    nullif(btrim(coalesce(vss.aisle_status, vss.tray_status)), '') as tray_status,
    coalesce(
      nullif(btrim(vss.slot_code), ''),
      vss.product_id::text,
      nullif(btrim(vss.vms_product_id), ''),
      nullif(btrim(vss.vms_product_name), ''),
      vss.id::text
    ) as stock_item_key
  from public.vms_stock_snapshots vss
  left join public.vms_import_batches vib on vib.id = vss.import_batch_id
  where vss.machine_id is not null
    and vss.import_row_status = 'imported'
    and (
      vss.import_batch_id is null
      or (
        vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
        and vib.is_active = true
        and vib.deleted_at is null
      )
    )
),
ranked as (
  select
    normalized.*,
    dense_rank() over (
      partition by machine_id, stock_item_key
      order by captured_at desc, batch_imported_at desc nulls last, created_at desc
    ) as recency_rank
  from normalized
),
latest as (
  select *
  from ranked
  where recency_rank = 1
)
select
  (array_agg(id order by created_at desc, id desc))[1] as id,
  machine_id,
  max(slot_code) as slot_code,
  (array_agg(product_id order by (product_id is not null) desc, created_at desc, id desc))[1] as product_id,
  sum(current_qty)::integer as current_qty,
  nullif(sum(coalesce(capacity, 0)), 0)::integer as capacity,
  max(captured_at) as captured_at,
  (array_agg(vms_product_id order by (vms_product_id is not null) desc, created_at desc, id desc))[1] as vms_product_id,
  (array_agg(vms_product_name order by (vms_product_name is not null) desc, created_at desc, id desc))[1] as vms_product_name,
  nullif(string_agg(distinct tray_status, ', '), '') as tray_status,
  stock_item_key,
  (array_agg(import_batch_id order by batch_imported_at desc nulls last, created_at desc, id desc))[1] as import_batch_id,
  max(batch_imported_at) as imported_at,
  max(batch_uploaded_at) as source_uploaded_at,
  (array_agg(batch_file_name order by batch_imported_at desc nulls last, created_at desc, id desc))[1] as source_file_name,
  (array_agg(sync_run_id order by created_at desc, id desc))[1] as sync_run_id,
  (array_agg(source_provider order by created_at desc, id desc))[1] as source_provider
from latest
group by machine_id, stock_item_key;


create or replace view public.refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    latest_vms_stock_by_slot.*,
    lower(coalesce(tray_status, '')) as normalized_tray_status
  from latest_vms_stock_by_slot
  where product_id is not null
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code,
    ms.min_qty,
    ms.par_qty
  from vms_stock v
  left join machine_slots ms
    on ms.machine_id = v.machine_id
   and ms.product_id = v.product_id
   and ms.active = true
   and (
     (v.slot_code is not null and ms.slot_code = v.slot_code)
     or v.slot_code is null
   )
  order by
    v.id,
    case when v.slot_code is not null and ms.slot_code = v.slot_code then 0 else 1 end,
    ms.created_at desc nulls last
)
select
  m.id as machine_id,
  m.name as machine_name,
  m.machine_code,
  ms.machine_slot_id,
  coalesce(v.slot_code, ms.slot_code, 'VMS') as slot_code,
  p.id as product_id,
  p.name as product_name,
  v.current_qty,
  coalesce(ms.min_qty, 0)::integer as min_qty,
  coalesce(ms.par_qty, v.capacity, v.current_qty)::integer as par_qty,
  greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0)::integer as suggested_qty,
  coalesce(ss.available_storage_qty, 0) as available_storage_qty,
  least(
    greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0),
    coalesce(ss.available_storage_qty, 0)
  )::integer as final_qty_to_take,
  case
    when v.current_qty <= 0
      or v.normalized_tray_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
      or v.normalized_tray_status like '%out of stock%'
      or v.normalized_tray_status like '%sold out%'
    then 'critical'
    when ms.min_qty is not null and v.current_qty <= ms.min_qty then 'high'
    when v.current_qty < coalesce(ms.par_qty, v.capacity, v.current_qty) then 'medium'
    else 'none'
  end as priority,
  v.captured_at as latest_vms_at,
  v.imported_at,
  v.import_batch_id,
  v.source_file_name,
  v.source_uploaded_at,
  md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
  v.id as vms_stock_snapshot_id,
  'vms_stock'::text as recommendation_source,
  v.capacity::integer as capacity,
  v.tray_status
from vms_stock v
join machines m on m.id = v.machine_id
join products p on p.id = v.product_id
left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
left join storage_stock ss on ss.product_id = p.id
where m.status = 'active'
  and coalesce(ms.par_qty, v.capacity) is not null
  and greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0) > 0;


grant select on public.vms_sales_clean to authenticated;
grant select on public.vms_transaction_status_daily to authenticated;
grant select on public.vms_transaction_status_monthly to authenticated;
grant select on public.latest_vms_stock_by_slot to authenticated;
grant select on public.refill_recommendations to authenticated;

select pg_notify('pgrst', 'reload schema');
