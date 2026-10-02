alter table vms_import_batches
  add column if not exists uploaded_by uuid references team_members(id) on delete set null,
  add column if not exists uploaded_at timestamptz,
  add column if not exists report_start_date date,
  add column if not exists report_end_date date,
  add column if not exists import_mode text not null default 'append_new',
  add column if not exists rows_found integer not null default 0,
  add column if not exists rows_skipped_duplicate integer not null default 0,
  add column if not exists rows_needing_review integer not null default 0,
  add column if not exists preview_summary jsonb not null default '{}'::jsonb,
  add column if not exists review_summary jsonb not null default '[]'::jsonb,
  add column if not exists failed_at timestamptz;

update vms_import_batches
set
  uploaded_by = coalesce(uploaded_by, imported_by),
  uploaded_at = coalesce(uploaded_at, imported_at),
  rows_found = greatest(coalesce(rows_found, 0), coalesce(row_count, 0)),
  rows_needing_review = greatest(coalesce(rows_needing_review, 0), coalesce(error_count, 0))
where uploaded_by is null
   or uploaded_at is null
   or rows_found = 0;

do $$ begin
  alter table vms_import_batches
    add constraint vms_import_batches_import_mode_check
    check (import_mode in ('append_new', 'replace_range', 'preview_only'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table vms_import_batches
    add constraint vms_import_batches_status_check
    check (status in ('previewed', 'processing', 'imported', 'failed', 'cancelled', 'canceled', 'completed', 'completed_with_warnings'));
exception when duplicate_object then null; end $$;

alter table vms_sales_snapshots
  add column if not exists source_row_key text,
  add column if not exists vms_transaction_id text,
  add column if not exists gross_sales_amount numeric(12,2),
  add column if not exists net_sales_amount numeric(12,2),
  add column if not exists cost_method text,
  add column if not exists unit_cost_amount numeric(12,4),
  add column if not exists gross_profit_amount numeric(12,2),
  add column if not exists duplicate_of uuid references vms_sales_snapshots(id) on delete set null,
  add column if not exists duplicate_checked_at timestamptz;

create unique index if not exists idx_vms_sales_snapshots_source_row_key_imported
  on vms_sales_snapshots(source_row_key)
  where source_row_key is not null and import_row_status = 'imported';

create index if not exists idx_vms_sales_snapshots_report_range
  on vms_sales_snapshots(sales_period_start, sales_period_end)
  where import_row_status = 'imported';

create table if not exists vms_header_mappings (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,
  source_signature text not null,
  header_names jsonb not null default '[]'::jsonb,
  required_field_mapping jsonb not null default '{}'::jsonb,
  optional_field_mapping jsonb not null default '{}'::jsonb,
  last_used_mapping jsonb not null default '{}'::jsonb,
  use_count integer not null default 1,
  created_by uuid references team_members(id) on delete set null,
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(report_type, source_signature)
);

create index if not exists idx_vms_header_mappings_report_type_updated
  on vms_header_mappings(report_type, updated_at desc);

create table if not exists vms_machine_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_machine_key text not null unique,
  vms_machine_name text,
  machine_id uuid references machines(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  confidence_score numeric(5,4) not null default 1,
  status text not null default 'needs_review',
  aliases text[] not null default '{}'::text[],
  created_by uuid references team_members(id) on delete set null,
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vms_machine_mappings_confidence_check check (confidence_score >= 0 and confidence_score <= 1),
  constraint vms_machine_mappings_status_check check (status in ('confirmed', 'suggested', 'needs_review', 'ignored'))
);

create index if not exists idx_vms_machine_mappings_machine
  on vms_machine_mappings(machine_id);

create table if not exists vms_machine_aliases (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid not null references vms_machine_mappings(id) on delete cascade,
  alias text not null,
  alias_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_machine_aliases_mapping
  on vms_machine_aliases(mapping_id);

alter table vms_product_mappings
  add column if not exists confidence_score numeric(5,4) not null default 1,
  add column if not exists snacky_product_name text;

update vms_product_mappings vpm
set snacky_product_name = p.name
from products p
where vpm.product_id = p.id
  and vpm.snacky_product_name is null;

do $$ begin
  alter table vms_product_mappings
    add constraint vms_product_mappings_confidence_check
    check (confidence_score >= 0 and confidence_score <= 1);
exception when duplicate_object then null; end $$;

create or replace view product_reporting_costs as
with purchase_costs as (
  select
    pol.product_id,
    sum(
      greatest(coalesce(nullif(pol.received_qty, 0), nullif(pol.total_units, 0), nullif(pol.ordered_qty, 0), 0), 0)
      * greatest(coalesce(nullif(pol.unit_cost_lyd, 0), nullif(pol.unit_cost, 0), 0), 0)
    )
    / nullif(sum(greatest(coalesce(nullif(pol.received_qty, 0), nullif(pol.total_units, 0), nullif(pol.ordered_qty, 0), 0), 0)), 0)
      as weighted_average_cost_lyd,
    (array_agg(
      greatest(coalesce(nullif(pol.unit_cost_lyd, 0), nullif(pol.unit_cost, 0), 0), 0)
      order by coalesce(po.received_at, po.order_date::timestamptz, pol.created_at) desc nulls last, pol.created_at desc
    ))[1] as latest_purchase_cost_lyd
  from purchase_order_lines pol
  left join purchase_orders po on po.id = pol.purchase_order_id
  where pol.product_id is not null
    and greatest(coalesce(nullif(pol.unit_cost_lyd, 0), nullif(pol.unit_cost, 0), 0), 0) > 0
    and greatest(coalesce(nullif(pol.received_qty, 0), nullif(pol.total_units, 0), nullif(pol.ordered_qty, 0), 0), 0) > 0
    and coalesce(po.status, 'received') not in ('cancelled', 'voided')
  group by pol.product_id
)
select
  p.id as product_id,
  coalesce(
    nullif(pc.weighted_average_cost_lyd, 0),
    nullif(p.average_cost_lyd, 0),
    nullif(pc.latest_purchase_cost_lyd, 0),
    nullif(p.last_purchase_cost_lyd, 0),
    nullif(p.current_cost_price_lyd, 0),
    nullif(p.cost_price, 0)
  ) as reporting_unit_cost_lyd,
  case
    when nullif(pc.weighted_average_cost_lyd, 0) is not null then 'weighted_average_purchase'
    when nullif(p.average_cost_lyd, 0) is not null then 'product_average_cost'
    when nullif(pc.latest_purchase_cost_lyd, 0) is not null then 'latest_purchase'
    when nullif(p.last_purchase_cost_lyd, 0) is not null then 'product_last_purchase'
    when nullif(p.current_cost_price_lyd, 0) is not null then 'current_product_cost'
    when nullif(p.cost_price, 0) is not null then 'legacy_product_cost'
    else 'missing'
  end as cost_method,
  pc.weighted_average_cost_lyd,
  pc.latest_purchase_cost_lyd,
  p.average_cost_lyd,
  p.last_purchase_cost_lyd,
  p.current_cost_price_lyd,
  p.cost_price
from products p
left join purchase_costs pc on pc.product_id = p.id;

create or replace view vms_sales_raw as
select
  vss.*,
  vib.file_name,
  vib.report_type,
  vib.import_mode,
  vib.uploaded_by,
  vib.uploaded_at,
  vib.imported_at
from vms_sales_snapshots vss
left join vms_import_batches vib on vib.id = vss.import_batch_id
where vss.import_row_status = 'imported';

create or replace view vms_sales_clean as
select
  raw.id,
  raw.import_batch_id,
  raw.source_row_key,
  raw.vms_transaction_id,
  raw.file_name,
  raw.machine_id,
  coalesce(m.name, raw.machine_name, raw.machine_code, 'Unmapped machine') as machine_name,
  coalesce(m.machine_code, raw.machine_code) as machine_code,
  m.location_id,
  coalesce(l.name, 'No location') as location_name,
  raw.product_id,
  coalesce(p.name, raw.product_name, raw.product_number, 'Unmapped product') as product_name,
  coalesce(p.sku, raw.product_number) as product_sku,
  coalesce(raw.sales_period_end, raw.period_end::date) as sale_date,
  coalesce(raw.sales_month, date_trunc('month', raw.period_end)::date) as sales_month,
  coalesce(raw.sales_period_start, raw.period_start::date) as report_start_date,
  coalesce(raw.sales_period_end, raw.period_end::date) as report_end_date,
  greatest(coalesce(raw.sold_qty, raw.transaction_count, 0), 0)::integer as units_sold,
  greatest(coalesce(raw.transaction_count, raw.sold_qty, 0), 0)::integer as transaction_count,
  greatest(coalesce(raw.gross_sales_amount, raw.sales_amount, raw.transaction_amount, 0), 0)::numeric(12,2) as gross_sales_amount,
  greatest(coalesce(raw.net_sales_amount, raw.sales_amount - coalesce(raw.refund_amount, 0), raw.sales_amount, raw.transaction_amount, 0), 0)::numeric(12,2) as net_sales_amount,
  coalesce(raw.cash_sales_amount, 0)::numeric(12,2) as cash_sales_amount,
  coalesce(raw.card_sales_amount, 0)::numeric(12,2) as card_sales_amount,
  coalesce(raw.unit_cost_amount, prc.reporting_unit_cost_lyd) as unit_cost_amount,
  coalesce(raw.cost_method, prc.cost_method, 'missing') as cost_method,
  (coalesce(raw.unit_cost_amount, prc.reporting_unit_cost_lyd) * greatest(coalesce(raw.sold_qty, raw.transaction_count, 0), 0))::numeric(12,2) as product_cost_amount,
  coalesce(
    raw.gross_profit_amount,
    raw.profit_amount,
    greatest(coalesce(raw.net_sales_amount, raw.sales_amount - coalesce(raw.refund_amount, 0), raw.sales_amount, raw.transaction_amount, 0), 0)
      - (coalesce(raw.unit_cost_amount, prc.reporting_unit_cost_lyd) * greatest(coalesce(raw.sold_qty, raw.transaction_count, 0), 0))
  )::numeric(12,2) as gross_profit_amount,
  (coalesce(raw.unit_cost_amount, prc.reporting_unit_cost_lyd) is null or coalesce(raw.unit_cost_amount, prc.reporting_unit_cost_lyd) <= 0) as cost_missing,
  raw.period_start,
  raw.period_end,
  raw.created_at,
  raw.metadata
from vms_sales_raw raw
left join machines m on m.id = raw.machine_id
left join locations l on l.id = m.location_id
left join products p on p.id = raw.product_id
left join product_reporting_costs prc on prc.product_id = raw.product_id;

create or replace view kpi_machine_daily as
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
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from vms_sales_clean
group by machine_id, machine_name, machine_code, location_id, location_name, sale_date;

create or replace view kpi_machine_monthly as
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
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  (sum(net_sales_amount) / nullif(count(distinct sale_date), 0))::numeric(12,2) as average_sales_per_day,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from vms_sales_clean
group by machine_id, machine_name, machine_code, location_id, location_name, sales_month;

create or replace view kpi_product_daily as
select
  product_id,
  product_name,
  product_sku,
  sale_date,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from vms_sales_clean
group by product_id, product_name, product_sku, sale_date;

create or replace view kpi_product_monthly as
select
  product_id,
  product_name,
  product_sku,
  sales_month,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  (sum(units_sold) / nullif(count(distinct sale_date), 0))::numeric(12,4) as stock_velocity_units_per_day,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from vms_sales_clean
group by product_id, product_name, product_sku, sales_month;

create or replace view kpi_location_monthly as
select
  location_id,
  location_name,
  sales_month,
  sum(gross_sales_amount)::numeric(12,2) as gross_sales_amount,
  sum(net_sales_amount)::numeric(12,2) as net_sales_amount,
  sum(units_sold)::integer as units_sold,
  sum(transaction_count)::integer as transaction_count,
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(distinct machine_id) as machine_count,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from vms_sales_clean
group by location_id, location_name, sales_month;

create or replace function apply_vms_sales_snapshot_import(
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

    update vms_sales_snapshots
    set import_row_status = 'reprocessed_stale'
    where import_row_status = 'imported'
      and coalesce(sales_period_end, period_end::date) between p_report_start_date and p_report_end_date;
  end if;

  insert into vms_sales_snapshots (
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
exception when others then
  update vms_import_batches
  set
    status = 'failed',
    failed_at = now(),
    error_count = 1,
    errors = jsonb_build_array(jsonb_build_object('code', sqlstate, 'message', sqlerrm)),
    notes = jsonb_build_object('error_code', sqlstate, 'error_message', sqlerrm, 'failed_at', now())::text
  where id = p_batch_id;
  raise;
end;
$$;
