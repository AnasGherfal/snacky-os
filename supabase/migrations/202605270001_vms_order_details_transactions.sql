-- Adds weekly VMS Order Details transaction imports as the primary sales/KPI
-- source while keeping the summary sales import available for reconciliation.

create table if not exists public.vms_transactions_raw (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  row_number integer,
  merchant_id text,
  merchant_name text,
  machine_code text,
  machine_name text,
  order_number text,
  cargo_lane_number text,
  product_number text,
  vms_product_name text,
  commodity_price_1 numeric,
  commodity_price_2 numeric,
  discounted_price numeric,
  delivery_time timestamptz,
  shipping_status text,
  purchaser text,
  refund_time timestamptz,
  remarks text,
  refund_status text,
  third_party_transaction_number text,
  third_party_order_no text,
  payment_amount numeric,
  payment_time timestamptz,
  quantity numeric,
  raw_row jsonb not null default '{}'::jsonb,
  normalized_row jsonb not null default '{}'::jsonb,
  mapped_machine_id uuid references public.machines(id) on delete set null,
  mapped_product_id uuid references public.products(id) on delete set null,
  transaction_status text not null default 'needs_review',
  duplicate_hash text,
  created_at timestamptz not null default now()
);

alter table public.vms_transactions_raw
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  add column if not exists row_number integer,
  add column if not exists merchant_id text,
  add column if not exists merchant_name text,
  add column if not exists machine_code text,
  add column if not exists machine_name text,
  add column if not exists order_number text,
  add column if not exists cargo_lane_number text,
  add column if not exists product_number text,
  add column if not exists vms_product_name text,
  add column if not exists commodity_price_1 numeric,
  add column if not exists commodity_price_2 numeric,
  add column if not exists discounted_price numeric,
  add column if not exists delivery_time timestamptz,
  add column if not exists shipping_status text,
  add column if not exists purchaser text,
  add column if not exists refund_time timestamptz,
  add column if not exists remarks text,
  add column if not exists refund_status text,
  add column if not exists third_party_transaction_number text,
  add column if not exists third_party_order_no text,
  add column if not exists payment_amount numeric,
  add column if not exists payment_time timestamptz,
  add column if not exists quantity numeric,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists normalized_row jsonb not null default '{}'::jsonb,
  add column if not exists mapped_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists mapped_product_id uuid references public.products(id) on delete set null,
  add column if not exists transaction_status text not null default 'needs_review',
  add column if not exists duplicate_hash text,
  add column if not exists created_at timestamptz not null default now();

update public.vms_transactions_raw
set duplicate_hash = coalesce(duplicate_hash, id::text)
where duplicate_hash is null;

alter table public.vms_transactions_raw
  alter column duplicate_hash set not null,
  alter column transaction_status set default 'needs_review',
  alter column transaction_status set not null,
  alter column raw_row set default '{}'::jsonb,
  alter column raw_row set not null,
  alter column normalized_row set default '{}'::jsonb,
  alter column normalized_row set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

alter table public.vms_transactions_raw
  drop constraint if exists vms_transactions_raw_status_check;

alter table public.vms_transactions_raw
  add constraint vms_transactions_raw_status_check
  check (transaction_status in ('successful_sale', 'failed_vend', 'refunded', 'failed_payment', 'needs_review'));

create unique index if not exists idx_vms_transactions_raw_duplicate_hash
  on public.vms_transactions_raw(duplicate_hash);

create index if not exists idx_vms_transactions_raw_batch
  on public.vms_transactions_raw(import_batch_id, row_number);

create index if not exists idx_vms_transactions_raw_status_time
  on public.vms_transactions_raw(transaction_status, (coalesce(payment_time, delivery_time)));

create index if not exists idx_vms_transactions_raw_machine_time
  on public.vms_transactions_raw(mapped_machine_id, (coalesce(payment_time, delivery_time)));

create index if not exists idx_vms_transactions_raw_product_time
  on public.vms_transactions_raw(mapped_product_id, (coalesce(payment_time, delivery_time)));

alter table public.vms_transactions_raw enable row level security;
grant select, insert, update, delete on public.vms_transactions_raw to authenticated;

drop policy if exists "snacky_vms_transactions_raw_select_by_vms_import_permission" on public.vms_transactions_raw;
drop policy if exists "snacky_vms_transactions_raw_insert_by_vms_import_permission" on public.vms_transactions_raw;
drop policy if exists "snacky_vms_transactions_raw_update_by_vms_import_permission" on public.vms_transactions_raw;
drop policy if exists "snacky_vms_transactions_raw_delete_by_vms_import_permission" on public.vms_transactions_raw;

create policy "snacky_vms_transactions_raw_select_by_vms_import_permission"
on public.vms_transactions_raw for select
to authenticated
using (public.snacky_current_profile_can_view_vms_import());

create policy "snacky_vms_transactions_raw_insert_by_vms_import_permission"
on public.vms_transactions_raw for insert
to authenticated
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_transactions_raw_update_by_vms_import_permission"
on public.vms_transactions_raw for update
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings())
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_transactions_raw_delete_by_vms_import_permission"
on public.vms_transactions_raw for delete
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings());

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
),
summary_sales as (
  select
    raw.id,
    raw.import_batch_id,
    raw.duplicate_hash as source_row_key,
    raw.normalized_row ->> 'vms_transaction_id' as vms_transaction_id,
    vib.file_name,
    raw.machine_id,
    coalesce(m.name, raw.normalized_row ->> 'machine_name', raw.normalized_row ->> 'machine_code', 'Unmapped machine') as machine_name,
    coalesce(m.machine_code, raw.normalized_row ->> 'machine_code') as machine_code,
    m.location_id,
    coalesce(l.name, 'No location') as location_name,
    raw.product_id,
    coalesce(p.name, raw.normalized_row ->> 'product_name', raw.normalized_row ->> 'product_number', 'Unmapped product') as product_name,
    coalesce(p.sku, raw.normalized_row ->> 'product_number') as product_sku,
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
  where raw.product_id is not null
    and raw.machine_id is not null
    and raw.sale_date is not null
    and not exists (
      select 1
      from public.vms_transactions_raw tx
      where tx.transaction_status = 'successful_sale'
        and tx.mapped_product_id is not null
        and tx.mapped_machine_id is not null
        and coalesce(tx.payment_time, tx.delivery_time)::date = raw.sale_date
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
left join public.machines m on m.id = tx.mapped_machine_id
left join public.products p on p.id = tx.mapped_product_id
where coalesce(tx.payment_time, tx.delivery_time) is not null
group by sale_date, machine_id, machine_name, product_id, product_name;

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
