-- Keep the monthly-profit dashboard aligned with the current UI status rules.
-- Production batches can legitimately live in any of these active/imported states.

create table if not exists public.vms_monthly_product_profit (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.vms_import_batches(id) on delete cascade,
  business_month date not null,
  report_start_date date not null,
  report_end_date date not null,
  merchant_id text,
  merchant_name text,
  machine_code text not null default '',
  machine_name text not null default '',
  product_number text not null default '',
  product_name text not null default '',
  commodity_price numeric(12,2) not null default 0,
  transaction_count integer not null default 0,
  transaction_amount numeric(12,2) not null default 0,
  refund_count integer not null default 0,
  refund_amount numeric(12,2) not null default 0,
  total_transaction_count integer not null default 0,
  total_transaction_amount numeric(12,2) not null default 0,
  cost_price numeric(12,2) not null default 0,
  cost_amount numeric(12,2) not null default 0,
  profit_amount numeric(12,2) not null default 0,
  internal_machine_id uuid references public.machines(id) on delete set null,
  internal_product_id uuid references public.products(id) on delete set null,
  raw_row jsonb not null default '{}'::jsonb,
  normalized_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.vms_monthly_product_profit
  add column if not exists import_batch_id uuid not null references public.vms_import_batches(id) on delete cascade,
  add column if not exists business_month date not null,
  add column if not exists report_start_date date not null,
  add column if not exists report_end_date date not null,
  add column if not exists merchant_id text,
  add column if not exists merchant_name text,
  add column if not exists machine_code text not null default '',
  add column if not exists machine_name text not null default '',
  add column if not exists product_number text not null default '',
  add column if not exists product_name text not null default '',
  add column if not exists commodity_price numeric(12,2) not null default 0,
  add column if not exists transaction_count integer not null default 0,
  add column if not exists transaction_amount numeric(12,2) not null default 0,
  add column if not exists refund_count integer not null default 0,
  add column if not exists refund_amount numeric(12,2) not null default 0,
  add column if not exists total_transaction_count integer not null default 0,
  add column if not exists total_transaction_amount numeric(12,2) not null default 0,
  add column if not exists cost_price numeric(12,2) not null default 0,
  add column if not exists cost_amount numeric(12,2) not null default 0,
  add column if not exists profit_amount numeric(12,2) not null default 0,
  add column if not exists internal_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists internal_product_id uuid references public.products(id) on delete set null,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists normalized_row jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists idx_vms_monthly_product_profit_batch_row_signature
  on public.vms_monthly_product_profit(import_batch_id, business_month, machine_code, product_number, product_name);

create index if not exists idx_vms_monthly_product_profit_batch_month
  on public.vms_monthly_product_profit(import_batch_id, business_month);

create index if not exists idx_vms_monthly_product_profit_month_machine_product
  on public.vms_monthly_product_profit(business_month, machine_code, product_number, product_name);

alter table public.vms_monthly_product_profit enable row level security;
grant select, insert, update, delete on public.vms_monthly_product_profit to authenticated;

drop policy if exists "snacky_vms_monthly_product_profit_select_by_vms_import_permission" on public.vms_monthly_product_profit;
drop policy if exists "snacky_vms_monthly_product_profit_insert_by_vms_import_permission" on public.vms_monthly_product_profit;
drop policy if exists "snacky_vms_monthly_product_profit_update_by_vms_import_permission" on public.vms_monthly_product_profit;
drop policy if exists "snacky_vms_monthly_product_profit_delete_by_vms_import_permission" on public.vms_monthly_product_profit;

create policy "snacky_vms_monthly_product_profit_select_by_vms_import_permission"
on public.vms_monthly_product_profit for select
to authenticated
using (public.snacky_current_profile_can_view_vms_import());

create policy "snacky_vms_monthly_product_profit_insert_by_vms_import_permission"
on public.vms_monthly_product_profit for insert
to authenticated
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_monthly_product_profit_update_by_vms_import_permission"
on public.vms_monthly_product_profit for update
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings())
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_monthly_product_profit_delete_by_vms_import_permission"
on public.vms_monthly_product_profit for delete
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings());

create or replace function public.sales_dashboard_monthly_summary(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  revenue_amount numeric,
  successful_sales_count integer,
  units_sold integer,
  average_transaction numeric,
  failed_vend_count integer,
  failed_vend_amount numeric,
  refund_count integer,
  refund_amount numeric,
  total_attempt_count integer,
  failed_vend_rate numeric,
  cash_sales_amount numeric,
  card_sales_amount numeric,
  unknown_payment_sales_amount numeric,
  payment_method_available boolean,
  rows_used integer,
  failed_payment_count integer,
  needs_review_count integer,
  cash_payment_count integer,
  card_payment_count integer,
  unknown_payment_count integer,
  cogs_amount numeric,
  gross_profit_amount numeric,
  gross_margin_percent numeric,
  missing_cost_sales_count integer,
  missing_cost_revenue_amount numeric,
  estimated_cost_sales_count integer,
  estimated_cost_revenue_amount numeric,
  payment_type_breakdown jsonb,
  status_breakdown jsonb
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select
      public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted,
      public.snacky_current_profile_has_any_role(array['owner', 'admin']) as can_view_profit
  ),
  filtered_rows as (
    select
      mpp.*,
      vib.status as batch_status,
      vib.is_active,
      vib.deleted_at,
      coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) as business_date
    from public.vms_monthly_product_profit mpp
    join public.vms_import_batches vib on vib.id = mpp.import_batch_id
    where vib.report_type = 'monthly_product_profit'
      and vib.status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
      and vib.is_active = true
      and vib.deleted_at is null
  ),
  ranged_rows as (
    select *
    from filtered_rows
    where business_date is not null
      and (p_date_from is null or business_date >= p_date_from)
      and (p_date_to is null or business_date <= p_date_to)
  ),
  transaction_aggregates as (
    select
      count(*)::integer as rows_used,
      coalesce(sum(greatest(coalesce(transaction_amount, 0), 0)), 0)::numeric(12,2) as revenue_amount,
      coalesce(sum(greatest(coalesce(transaction_count, 0), 0)), 0)::integer as successful_sales_count,
      coalesce(sum(greatest(coalesce(transaction_count, 0), 0)), 0)::integer as units_sold,
      coalesce(sum(greatest(coalesce(total_transaction_count, transaction_count, 0), 0)), 0)::integer as total_attempt_count,
      coalesce(sum(greatest(coalesce(refund_count, 0), 0)), 0)::integer as refund_count,
      coalesce(sum(greatest(coalesce(refund_amount, 0), 0)), 0)::numeric(12,2) as refund_amount
    from ranged_rows
  ),
  profit_aggregates as (
    select
      count(*)::integer as rows_used,
      coalesce(sum(greatest(coalesce(cost_amount, 0), 0)), 0)::numeric(12,2) as cogs_amount,
      count(*) filter (where cost_amount is null or cost_amount <= 0)::integer as missing_cost_sales_count,
      coalesce(sum(greatest(coalesce(transaction_amount, 0), 0)) filter (where cost_amount is null or cost_amount <= 0), 0)::numeric(12,2) as missing_cost_revenue_amount,
      0::integer as estimated_cost_sales_count,
      0::numeric(12,2) as estimated_cost_revenue_amount
    from ranged_rows
  )
  select
    transactions.revenue_amount,
    transactions.successful_sales_count,
    transactions.units_sold,
    case
      when transactions.successful_sales_count > 0 then (transactions.revenue_amount / transactions.successful_sales_count)::numeric(12,2)
      else null
    end as average_transaction,
    0::integer as failed_vend_count,
    0::numeric(12,2) as failed_vend_amount,
    transactions.refund_count,
    transactions.refund_amount,
    transactions.total_attempt_count,
    case when transactions.total_attempt_count > 0 then 0::numeric(12,4) else 0::numeric(12,4) end as failed_vend_rate,
    0::numeric(12,2) as cash_sales_amount,
    0::numeric(12,2) as card_sales_amount,
    0::numeric(12,2) as unknown_payment_sales_amount,
    false as payment_method_available,
    coalesce(profit.rows_used, transactions.rows_used) as rows_used,
    0::integer as failed_payment_count,
    0::integer as needs_review_count,
    0::integer as cash_payment_count,
    0::integer as card_payment_count,
    0::integer as unknown_payment_count,
    case when allowed.can_view_profit then profit.cogs_amount else null end as cogs_amount,
    case
      when allowed.can_view_profit then (transactions.revenue_amount - coalesce(profit.cogs_amount, 0))::numeric(12,2)
      else null
    end as gross_profit_amount,
    case
      when allowed.can_view_profit and transactions.revenue_amount > 0 then ((transactions.revenue_amount - coalesce(profit.cogs_amount, 0)) / transactions.revenue_amount)::numeric(12,4)
      when allowed.can_view_profit then 0::numeric(12,4)
      else null
    end as gross_margin_percent,
    case when allowed.can_view_profit then profit.missing_cost_sales_count else null end as missing_cost_sales_count,
    case when allowed.can_view_profit then profit.missing_cost_revenue_amount else null end as missing_cost_revenue_amount,
    case when allowed.can_view_profit then profit.estimated_cost_sales_count else null end as estimated_cost_sales_count,
    case when allowed.can_view_profit then profit.estimated_cost_revenue_amount else null end as estimated_cost_revenue_amount,
    jsonb_build_object(
      'cash', jsonb_build_object('count', 0, 'amount', 0),
      'card', jsonb_build_object('count', 0, 'amount', 0),
      'unknown', jsonb_build_object('count', 0, 'amount', 0)
    ) as payment_type_breakdown,
    jsonb_build_object(
      'successful_sale', jsonb_build_object('count', transactions.successful_sales_count, 'amount', transactions.revenue_amount),
      'failed_vend', jsonb_build_object('count', 0, 'amount', 0),
      'refunded', jsonb_build_object('count', transactions.refund_count, 'amount', transactions.refund_amount),
      'failed_payment', jsonb_build_object('count', 0, 'amount', 0),
      'needs_review', jsonb_build_object('count', 0, 'amount', 0)
    ) as status_breakdown
  from transaction_aggregates transactions
  cross join profit_aggregates profit
  join allowed on allowed.permitted;
$$;

create or replace function public.sales_dashboard_monthly_breakdown(
  p_dimension text,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_key text,
  bucket_label text,
  sort_key text,
  successful_sales_amount numeric,
  successful_sales_count integer,
  units_sold integer,
  rows_used integer
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  filtered_rows as (
    select
      coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) as business_month,
      mpp.transaction_amount,
      mpp.transaction_count,
      coalesce(nullif(btrim(m.name), ''), nullif(btrim(mpp.machine_name), ''), nullif(btrim(mpp.machine_code), ''), 'Unknown machine') as machine_name,
      coalesce(nullif(btrim(l.name), ''), 'Unknown location') as location_name,
      coalesce(nullif(btrim(p.name), ''), nullif(btrim(mpp.product_name), ''), nullif(btrim(mpp.product_number), ''), 'Unmapped product') as product_name
    from public.vms_monthly_product_profit mpp
    join public.vms_import_batches vib on vib.id = mpp.import_batch_id
    left join public.machines m on m.id = mpp.internal_machine_id
    left join public.locations l on l.id = m.location_id
    left join public.products p on p.id = mpp.internal_product_id
    where vib.report_type = 'monthly_product_profit'
      and vib.status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
      and vib.is_active = true
      and vib.deleted_at is null
      and coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) is not null
      and (p_date_from is null or coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) >= p_date_from)
      and (p_date_to is null or coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) <= p_date_to)
  ),
  grouped_rows as (
    select
      case p_dimension
        when 'machine' then coalesce(nullif(btrim(machine_name), ''), 'Unknown machine')
        when 'location' then coalesce(nullif(btrim(location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(product_name), ''), 'Unmapped product')
        else to_char(business_month, 'YYYY-MM')
      end as bucket_key,
      case p_dimension
        when 'machine' then coalesce(nullif(btrim(machine_name), ''), 'Unknown machine')
        when 'location' then coalesce(nullif(btrim(location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(product_name), ''), 'Unmapped product')
        else to_char(business_month, 'YYYY-MM')
      end as bucket_label,
      case p_dimension
        when 'machine' then lower(coalesce(nullif(btrim(machine_name), ''), 'Unknown machine'))
        when 'location' then lower(coalesce(nullif(btrim(location_name), ''), 'Unknown location'))
        when 'product' then lower(coalesce(nullif(btrim(product_name), ''), 'Unmapped product'))
        else to_char(business_month, 'YYYY-MM')
      end as sort_key,
      coalesce(sum(greatest(coalesce(transaction_amount, 0), 0)), 0)::numeric(12,2) as successful_sales_amount,
      coalesce(sum(greatest(coalesce(transaction_count, 0), 0)), 0)::integer as successful_sales_count,
      coalesce(sum(greatest(coalesce(transaction_count, 0), 0)), 0)::integer as units_sold,
      count(*)::integer as rows_used
    from filtered_rows
    group by 1, 2, 3
  )
  select
    grouped_rows.bucket_key,
    grouped_rows.bucket_label,
    grouped_rows.sort_key,
    grouped_rows.successful_sales_amount,
    grouped_rows.successful_sales_count,
    grouped_rows.units_sold,
    grouped_rows.rows_used
  from grouped_rows
  join allowed on allowed.permitted
  order by grouped_rows.sort_key asc, grouped_rows.bucket_label asc;
$$;

create or replace function public.sales_dashboard_monthly_profit_breakdown(
  p_dimension text,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_key text,
  bucket_label text,
  sort_key text,
  revenue_amount numeric,
  successful_sales_count integer,
  units_sold integer,
  rows_used integer,
  cogs_amount numeric,
  gross_profit_amount numeric,
  gross_margin_percent numeric,
  missing_cost_sales_count integer,
  missing_cost_revenue_amount numeric,
  estimated_cost_sales_count integer,
  estimated_cost_revenue_amount numeric,
  cost_status text
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin']) as permitted
  ),
  filtered_rows as (
    select
      coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) as business_month,
      mpp.transaction_amount,
      mpp.transaction_count,
      mpp.cost_amount,
      coalesce(nullif(btrim(m.name), ''), nullif(btrim(mpp.machine_name), ''), nullif(btrim(mpp.machine_code), ''), 'Unknown machine') as machine_name,
      coalesce(nullif(btrim(l.name), ''), 'Unknown location') as location_name,
      coalesce(nullif(btrim(p.name), ''), nullif(btrim(mpp.product_name), ''), nullif(btrim(mpp.product_number), ''), 'Unmapped product') as product_name
    from public.vms_monthly_product_profit mpp
    join public.vms_import_batches vib on vib.id = mpp.import_batch_id
    left join public.machines m on m.id = mpp.internal_machine_id
    left join public.locations l on l.id = m.location_id
    left join public.products p on p.id = mpp.internal_product_id
    where vib.report_type = 'monthly_product_profit'
      and vib.status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
      and vib.is_active = true
      and vib.deleted_at is null
      and coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) is not null
      and (p_date_from is null or coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) >= p_date_from)
      and (p_date_to is null or coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) <= p_date_to)
  ),
  grouped_rows as (
    select
      case p_dimension
        when 'machine' then coalesce(nullif(btrim(machine_name), ''), 'Unknown machine')
        when 'location' then coalesce(nullif(btrim(location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(product_name), ''), 'Unmapped product')
        else to_char(business_month, 'YYYY-MM')
      end as bucket_key,
      case p_dimension
        when 'machine' then coalesce(nullif(btrim(machine_name), ''), 'Unknown machine')
        when 'location' then coalesce(nullif(btrim(location_name), ''), 'Unknown location')
        when 'product' then coalesce(nullif(btrim(product_name), ''), 'Unmapped product')
        else to_char(business_month, 'YYYY-MM')
      end as bucket_label,
      case p_dimension
        when 'machine' then lower(coalesce(nullif(btrim(machine_name), ''), 'Unknown machine'))
        when 'location' then lower(coalesce(nullif(btrim(location_name), ''), 'Unknown location'))
        when 'product' then lower(coalesce(nullif(btrim(product_name), ''), 'Unmapped product'))
        else to_char(business_month, 'YYYY-MM')
      end as sort_key,
      coalesce(sum(greatest(coalesce(transaction_amount, 0), 0)), 0)::numeric(12,2) as revenue_amount,
      coalesce(sum(greatest(coalesce(transaction_count, 0), 0)), 0)::integer as successful_sales_count,
      coalesce(sum(greatest(coalesce(transaction_count, 0), 0)), 0)::integer as units_sold,
      count(*)::integer as rows_used,
      coalesce(sum(greatest(coalesce(cost_amount, 0), 0)), 0)::numeric(12,2) as cogs_amount,
      count(*) filter (where cost_amount is null or cost_amount <= 0)::integer as missing_cost_sales_count,
      coalesce(sum(greatest(coalesce(transaction_amount, 0), 0)) filter (where cost_amount is null or cost_amount <= 0), 0)::numeric(12,2) as missing_cost_revenue_amount,
      0::integer as estimated_cost_sales_count,
      0::numeric(12,2) as estimated_cost_revenue_amount,
      count(*) filter (where cost_amount is null or cost_amount <= 0)::integer as missing_status_count
    from filtered_rows
    group by 1, 2, 3
  )
  select
    grouped_rows.bucket_key,
    grouped_rows.bucket_label,
    grouped_rows.sort_key,
    grouped_rows.revenue_amount,
    grouped_rows.successful_sales_count,
    grouped_rows.units_sold,
    grouped_rows.rows_used,
    grouped_rows.cogs_amount,
    (grouped_rows.revenue_amount - grouped_rows.cogs_amount)::numeric(12,2) as gross_profit_amount,
    case
      when grouped_rows.revenue_amount > 0 then ((grouped_rows.revenue_amount - grouped_rows.cogs_amount) / grouped_rows.revenue_amount)::numeric(12,4)
      else 0::numeric(12,4)
    end as gross_margin_percent,
    grouped_rows.missing_cost_sales_count,
    grouped_rows.missing_cost_revenue_amount,
    grouped_rows.estimated_cost_sales_count,
    grouped_rows.estimated_cost_revenue_amount,
    case
      when grouped_rows.missing_status_count > 0 then 'missing_cost'
      else 'monthly_report_cost'
    end as cost_status
  from grouped_rows
  join allowed on allowed.permitted
  order by
    case when p_dimension in ('machine', 'location', 'product') then (grouped_rows.revenue_amount - grouped_rows.cogs_amount) end desc nulls last,
    grouped_rows.sort_key asc,
    grouped_rows.bucket_label asc;
$$;

create or replace function public.sales_dashboard_monthly_batch_reconciliation(
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
    where vib.report_type = 'monthly_product_profit'
  ),
  normalized_rows as (
    select
      mpp.import_batch_id as batch_id,
      mpp.transaction_count,
      mpp.transaction_amount,
      mpp.refund_count,
      mpp.refund_amount,
      mpp.total_transaction_count,
      coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) as business_date
    from public.vms_monthly_product_profit mpp
    join public.vms_import_batches vib on vib.id = mpp.import_batch_id
    where vib.report_type = 'monthly_product_profit'
      and vib.status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
      and vib.is_active = true
      and vib.deleted_at is null
  ),
  aggregated as (
    select
      db.batch_id,
      count(nr.batch_id)::integer as raw_row_count_total,
      count(*) filter (where coalesce(nr.transaction_count, 0) > 0)::integer as raw_successful_rows_total,
      0::integer as raw_failed_vend_rows_total,
      count(*) filter (where coalesce(nr.refund_count, 0) > 0 or coalesce(nr.refund_amount, 0) > 0)::integer as raw_refunded_rows_total,
      0::integer as raw_failed_payment_rows_total,
      0::integer as raw_needs_review_rows_total,
      count(*) filter (where nr.business_date is null)::integer as raw_missing_datetime_rows_total,
      count(*) filter (where nr.transaction_amount is null)::integer as raw_missing_amount_rows_total,
      coalesce(sum(greatest(coalesce(nr.transaction_amount, 0), 0)), 0)::numeric(12,2) as raw_successful_sales_amount_total,
      0::numeric(12,2) as raw_failed_vend_amount_total,
      coalesce(sum(greatest(coalesce(nr.refund_amount, 0), 0)), 0)::numeric(12,2) as raw_refunded_amount_total,
      coalesce(sum(greatest(coalesce(nr.transaction_count, 0), 0)), 0)::integer as raw_units_sold_total,
      min(nr.business_date::timestamp) as raw_min_transaction_at,
      max(nr.business_date::timestamp) as raw_max_transaction_at,
      min(nr.business_date) as raw_min_sale_date,
      max(nr.business_date) as raw_max_sale_date,
      count(*) filter (
        where nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      )::integer as range_row_count,
      count(*) filter (
        where coalesce(nr.transaction_count, 0) > 0
          and nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      )::integer as range_successful_rows,
      0::integer as range_failed_vend_rows,
      count(*) filter (
        where (coalesce(nr.refund_count, 0) > 0 or coalesce(nr.refund_amount, 0) > 0)
          and nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      )::integer as range_refunded_rows,
      0::integer as range_failed_payment_rows,
      0::integer as range_needs_review_rows,
      coalesce(sum(greatest(coalesce(nr.transaction_amount, 0), 0)) filter (
        where coalesce(nr.transaction_count, 0) > 0
          and nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      ), 0)::numeric(12,2) as range_successful_sales_amount,
      0::numeric(12,2) as range_failed_vend_amount,
      coalesce(sum(greatest(coalesce(nr.refund_amount, 0), 0)) filter (
        where (coalesce(nr.refund_count, 0) > 0 or coalesce(nr.refund_amount, 0) > 0)
          and nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      ), 0)::numeric(12,2) as range_refunded_amount,
      coalesce(sum(greatest(coalesce(nr.transaction_count, 0), 0)) filter (
        where nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      ), 0)::integer as range_units_sold,
      count(*) filter (
        where coalesce(nr.transaction_count, 0) > 0
          and nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      )::integer as range_transaction_count,
      min(nr.business_date::timestamp) filter (
        where nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
      ) as range_min_transaction_at,
      max(nr.business_date::timestamp) filter (
        where nr.business_date is not null
          and (p_date_from is null or nr.business_date >= p_date_from)
          and (p_date_to is null or nr.business_date <= p_date_to)
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

create or replace function public.sales_dashboard_monthly_profit_coverage()
returns table (
  business_month date,
  total_rows integer,
  finalized_rows integer,
  successful_sale_rows integer,
  finalized_successful_sale_rows integer,
  successful_sale_amount numeric,
  finalized_successful_sale_amount numeric,
  min_business_date date,
  max_business_date date,
  batch_count integer,
  finalized_batch_count integer,
  active_finalized_batch_count integer,
  null_business_date_rows integer
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) as permitted
  ),
  detailed_rows as (
    select
      mpp.import_batch_id as batch_id,
      vib.status as batch_status,
      vib.is_active,
      vib.deleted_at,
      coalesce(mpp.business_month, vib.report_start_date, vib.report_end_date) as business_date,
      mpp.transaction_count,
      mpp.transaction_amount
    from public.vms_monthly_product_profit mpp
    join public.vms_import_batches vib on vib.id = mpp.import_batch_id
    where vib.report_type = 'monthly_product_profit'
      and vib.status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
  )
  select
    date_trunc('month', detailed.business_date::timestamp)::date as business_month,
    count(*)::integer as total_rows,
    count(*) filter (
      where detailed.batch_status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    )::integer as finalized_rows,
    count(*) filter (where coalesce(detailed.transaction_count, 0) > 0)::integer as successful_sale_rows,
    count(*) filter (
      where coalesce(detailed.transaction_count, 0) > 0
        and detailed.batch_status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    )::integer as finalized_successful_sale_rows,
    coalesce(sum(greatest(coalesce(detailed.transaction_amount, 0), 0)) filter (where coalesce(detailed.transaction_count, 0) > 0), 0)::numeric as successful_sale_amount,
    coalesce(sum(greatest(coalesce(detailed.transaction_amount, 0), 0)) filter (
      where coalesce(detailed.transaction_count, 0) > 0
        and detailed.batch_status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    ), 0)::numeric as finalized_successful_sale_amount,
    min(detailed.business_date) as min_business_date,
    max(detailed.business_date) as max_business_date,
    count(distinct detailed.batch_id)::integer as batch_count,
    count(distinct detailed.batch_id) filter (
      where detailed.batch_status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
    )::integer as finalized_batch_count,
    count(distinct detailed.batch_id) filter (
      where detailed.batch_status in ('imported', 'imported_active', 'needs_mapping_but_imported', 'imported_with_warnings', 'partially_imported')
        and detailed.deleted_at is null
        and coalesce(detailed.is_active, true)
    )::integer as active_finalized_batch_count,
    count(*) filter (where detailed.business_date is null)::integer as null_business_date_rows
  from detailed_rows detailed
  join allowed on allowed.permitted
  group by 1
  order by 1 nulls last;
$$;

grant execute on function public.sales_dashboard_monthly_summary(date, date) to authenticated;
grant execute on function public.sales_dashboard_monthly_breakdown(text, date, date) to authenticated;
grant execute on function public.sales_dashboard_monthly_profit_breakdown(text, date, date) to authenticated;
grant execute on function public.sales_dashboard_monthly_batch_reconciliation(date, date) to authenticated;
grant execute on function public.sales_dashboard_monthly_profit_coverage() to authenticated;

select pg_notify('pgrst', 'reload schema');
