-- Adds weekly VMS Order Details transaction imports as the primary sales/KPI
-- source while keeping the summary sales import available for reconciliation.
-- Also makes VMS import batches manageable data sources that can be disabled,
-- soft-deleted, restored, and excluded from dashboards without losing audit data.

alter table public.vms_import_batches
  add column if not exists is_active boolean not null default true,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid,
  add column if not exists disable_reason text,
  add column if not exists source_usage jsonb not null default '{}'::jsonb,
  add column if not exists dashboard_usage jsonb,
  add column if not exists file_hash text,
  add column if not exists storage_bucket text,
  add column if not exists storage_path text,
  add column if not exists original_file_name text,
  add column if not exists detected_min_datetime timestamptz,
  add column if not exists detected_max_datetime timestamptz,
  add column if not exists total_successful_sales numeric not null default 0,
  add column if not exists successful_rows_count integer not null default 0,
  add column if not exists failed_rows_count integer not null default 0,
  add column if not exists refunded_rows_count integer not null default 0;

update public.vms_import_batches
set is_active = false
where status in ('failed', 'deleted', 'disabled', 'draft', 'previewed')
   or deleted_at is not null;

alter table public.vms_import_batches
  drop constraint if exists vms_import_batches_status_check;

alter table public.vms_import_batches
  add constraint vms_import_batches_status_check
  check (status in ('draft', 'previewed', 'imported', 'failed', 'cancelled', 'disabled', 'deleted'));

create index if not exists idx_vms_import_batches_active_usage
  on public.vms_import_batches(status, is_active, report_type, report_start_date, report_end_date)
  where deleted_at is null;

alter table public.vms_import_previews
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  add column if not exists file_hash text,
  add column if not exists storage_bucket text,
  add column if not exists storage_path text,
  add column if not exists original_file_name text;

create index if not exists idx_vms_import_previews_batch
  on public.vms_import_previews(import_batch_id);

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('vms-imports', 'vms-imports', false, 52428800)
    on conflict (id) do nothing;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "snacky_vms_import_files_select" on storage.objects';
    execute 'drop policy if exists "snacky_vms_import_files_insert" on storage.objects';
    execute 'drop policy if exists "snacky_vms_import_files_update" on storage.objects';
    execute $policy$
      create policy "snacky_vms_import_files_select"
      on storage.objects for select
      to authenticated
      using (bucket_id = 'vms-imports' and public.snacky_current_profile_can_view_vms_import())
    $policy$;
    execute $policy$
      create policy "snacky_vms_import_files_insert"
      on storage.objects for insert
      to authenticated
      with check (bucket_id = 'vms-imports' and public.snacky_current_profile_can_manage_vms_mappings())
    $policy$;
    execute $policy$
      create policy "snacky_vms_import_files_update"
      on storage.objects for update
      to authenticated
      using (bucket_id = 'vms-imports' and public.snacky_current_profile_can_manage_vms_mappings())
      with check (bucket_id = 'vms-imports' and public.snacky_current_profile_can_manage_vms_mappings())
    $policy$;
  end if;
end $$;

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
    and vib.status = 'imported'
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
    and vib.status = 'imported'
    and vib.is_active = true
    and vib.deleted_at is null
    and not exists (
      select 1
      from public.vms_transactions_raw tx
      join public.vms_import_batches active_tx_batch on active_tx_batch.id = tx.import_batch_id
      where tx.transaction_status = 'successful_sale'
        and tx.mapped_product_id is not null
        and tx.mapped_machine_id is not null
        and coalesce(tx.payment_time, tx.delivery_time)::date = raw.sale_date
        and active_tx_batch.status = 'imported'
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
  and vib.status = 'imported'
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

drop view if exists public.refill_recommendations;
drop view if exists public.latest_vms_stock_by_slot;

create view public.latest_vms_stock_by_slot as
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

grant select on public.vms_sales_clean to authenticated;
grant select on public.kpi_machine_daily to authenticated;
grant select on public.kpi_machine_monthly to authenticated;
grant select on public.kpi_product_daily to authenticated;
grant select on public.kpi_product_monthly to authenticated;
grant select on public.kpi_location_monthly to authenticated;
grant select on public.vms_transaction_status_daily to authenticated;
grant select on public.vms_transaction_status_monthly to authenticated;
grant select on public.latest_vms_stock_by_slot to authenticated;

update public.vms_import_batches vib
set
  detected_min_datetime = coalesce(stats.min_time, vib.detected_min_datetime),
  detected_max_datetime = coalesce(stats.max_time, vib.detected_max_datetime),
  total_successful_sales = coalesce(stats.total_successful_sales, vib.total_successful_sales, 0),
  successful_rows_count = coalesce(stats.successful_rows_count, vib.successful_rows_count, 0),
  failed_rows_count = coalesce(stats.failed_rows_count, vib.failed_rows_count, 0),
  refunded_rows_count = coalesce(stats.refunded_rows_count, vib.refunded_rows_count, 0),
  source_usage = case
    when vib.report_type = 'vms_order_details_weekly' then '{"source_type":"detailed_order_transactions","main_sales_source":true,"reconciliation_only":false,"dashboards":["sales","products","machines","failed_vends","refills"],"excluded_dashboards":["finance"]}'::jsonb
    when vib.report_type = 'sales' then '{"source_type":"general_summary_sales","main_sales_source":false,"reconciliation_only":true,"dashboards":["reconciliation"],"excluded_dashboards":["sales","products","machines","failed_vends","finance"]}'::jsonb
    when vib.report_type in ('stock','planogram') then '{"source_type":"machine_stock","main_sales_source":false,"reconciliation_only":false,"dashboards":["refills","inventory","machines"],"excluded_dashboards":["sales","products","finance"]}'::jsonb
    else coalesce(vib.source_usage, '{}'::jsonb)
  end,
  dashboard_usage = case
    when vib.report_type = 'vms_order_details_weekly' then '{"source_type":"detailed_order_transactions","main_sales_source":true,"reconciliation_only":false,"dashboards":["sales","products","machines","failed_vends","refills"],"excluded_dashboards":["finance"]}'::jsonb
    when vib.report_type = 'sales' then '{"source_type":"general_summary_sales","main_sales_source":false,"reconciliation_only":true,"dashboards":["reconciliation"],"excluded_dashboards":["sales","products","machines","failed_vends","finance"]}'::jsonb
    when vib.report_type in ('stock','planogram') then '{"source_type":"machine_stock","main_sales_source":false,"reconciliation_only":false,"dashboards":["refills","inventory","machines"],"excluded_dashboards":["sales","products","finance"]}'::jsonb
    else coalesce(vib.dashboard_usage, '{}'::jsonb)
  end
from (
  select
    import_batch_id,
    min(coalesce(payment_time, delivery_time)) as min_time,
    max(coalesce(payment_time, delivery_time)) as max_time,
    coalesce(sum(payment_amount) filter (where transaction_status = 'successful_sale'), 0) as total_successful_sales,
    count(*) filter (where transaction_status = 'successful_sale')::integer as successful_rows_count,
    count(*) filter (where transaction_status in ('failed_vend', 'failed_payment', 'needs_review'))::integer as failed_rows_count,
    count(*) filter (where transaction_status = 'refunded')::integer as refunded_rows_count
  from public.vms_transactions_raw
  group by import_batch_id
) stats
where stats.import_batch_id = vib.id;

select pg_notify('pgrst', 'reload schema');
