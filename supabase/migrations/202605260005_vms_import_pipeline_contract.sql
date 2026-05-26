-- Hardens the VMS import pipeline schema expected by the import wizard.
-- This migration is additive where possible and preserves compatibility with
-- older Snacky OS column names used by existing import code.

create table if not exists public.vms_import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  file_name text,
  report_type text,
  report_start_date date,
  report_end_date date,
  import_mode text not null default 'append',
  status text not null default 'draft',
  rows_found integer not null default 0,
  rows_imported integer not null default 0,
  rows_skipped_duplicate integer not null default 0,
  rows_needing_review integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_import_batches
  add column if not exists uploaded_by uuid,
  add column if not exists uploaded_at timestamptz not null default now(),
  add column if not exists file_name text,
  add column if not exists report_type text,
  add column if not exists report_start_date date,
  add column if not exists report_end_date date,
  add column if not exists import_mode text not null default 'append',
  add column if not exists status text not null default 'draft',
  add column if not exists rows_found integer not null default 0,
  add column if not exists rows_imported integer not null default 0,
  add column if not exists rows_skipped_duplicate integer not null default 0,
  add column if not exists rows_needing_review integer not null default 0,
  add column if not exists notes text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.vms_import_batches alter column import_mode set default 'append';
alter table public.vms_import_batches alter column status set default 'draft';

update public.vms_import_batches
set import_mode = case import_mode
  when 'append_new' then 'append'
  when 'replace_range' then 'replace_date_range'
  else coalesce(import_mode, 'append')
end;

update public.vms_import_batches
set status = case status
  when 'processing' then 'draft'
  when 'completed' then 'imported'
  when 'completed_with_warnings' then 'imported'
  when 'canceled' then 'cancelled'
  else coalesce(status, 'draft')
end;

alter table public.vms_import_batches
  drop constraint if exists vms_import_batches_import_mode_check,
  drop constraint if exists vms_import_batches_status_check;

alter table public.vms_import_batches
  add constraint vms_import_batches_import_mode_check
  check (import_mode in ('append', 'replace_date_range', 'preview_only')),
  add constraint vms_import_batches_status_check
  check (status in ('draft', 'previewed', 'imported', 'failed', 'cancelled'));

create table if not exists public.vms_import_preview_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  row_number integer,
  raw_row jsonb not null default '{}'::jsonb,
  normalized_row jsonb,
  mapped_product_id uuid references public.products(id) on delete set null,
  mapped_machine_id uuid references public.machines(id) on delete set null,
  status text not null default 'pending',
  review_reason text,
  suggested_mapping jsonb,
  duplicate_hash text,
  created_at timestamptz not null default now()
);

alter table public.vms_import_preview_rows
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  add column if not exists row_number integer,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists normalized_row jsonb,
  add column if not exists mapped_product_id uuid references public.products(id) on delete set null,
  add column if not exists mapped_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists status text not null default 'pending',
  add column if not exists review_reason text,
  add column if not exists suggested_mapping jsonb,
  add column if not exists duplicate_hash text,
  add column if not exists created_at timestamptz not null default now();

alter table public.vms_import_preview_rows
  drop constraint if exists vms_import_preview_rows_status_check;

update public.vms_import_preview_rows
set status = 'needs_review'
where status = 'invalid_row';

alter table public.vms_import_preview_rows
  add constraint vms_import_preview_rows_status_check
  check (status in ('pending', 'ready', 'needs_review', 'duplicate', 'imported', 'skipped'));

create index if not exists idx_vms_import_preview_rows_batch_row
  on public.vms_import_preview_rows(import_batch_id, row_number);

create index if not exists idx_vms_import_preview_rows_duplicate_hash
  on public.vms_import_preview_rows(duplicate_hash);

create table if not exists public.vms_product_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_product_code text,
  vms_product_name text not null,
  snacky_product_id uuid references public.products(id) on delete set null,
  confidence_score numeric,
  status text not null default 'confirmed',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_product_mappings
  add column if not exists vms_product_code text,
  add column if not exists snacky_product_id uuid references public.products(id) on delete set null,
  add column if not exists confidence_score numeric,
  add column if not exists status text not null default 'confirmed',
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.vms_product_mappings
set
  vms_product_code = coalesce(vms_product_code, vms_product_id),
  snacky_product_id = coalesce(snacky_product_id, product_id),
  status = coalesce(nullif(status, ''), match_status, 'confirmed');

create unique index if not exists idx_vms_product_mappings_name_code_unique
  on public.vms_product_mappings (lower(vms_product_name), coalesce(vms_product_code, ''));

create table if not exists public.vms_machine_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_machine_code text,
  vms_machine_name text not null,
  snacky_machine_id uuid references public.machines(id) on delete set null,
  snacky_machine_name text,
  status text not null default 'confirmed',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_machine_mappings
  add column if not exists vms_machine_code text,
  add column if not exists snacky_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists snacky_machine_name text,
  add column if not exists status text not null default 'confirmed',
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.vms_machine_mappings vmm
set
  vms_machine_code = coalesce(vms_machine_code, vms_machine_key),
  snacky_machine_id = coalesce(snacky_machine_id, machine_id),
  snacky_machine_name = coalesce(snacky_machine_name, m.name)
from public.machines m
where m.id = vmm.machine_id
   or m.id = vmm.snacky_machine_id;

create table if not exists public.vms_header_mappings (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,
  source_header text,
  target_field text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_header_mappings
  add column if not exists source_header text,
  add column if not exists target_field text,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists idx_vms_header_mappings_report_source_header
  on public.vms_header_mappings(report_type, source_header)
  where source_header is not null;

drop view if exists public.kpi_location_monthly cascade;
drop view if exists public.kpi_product_monthly cascade;
drop view if exists public.kpi_product_daily cascade;
drop view if exists public.kpi_machine_monthly cascade;
drop view if exists public.kpi_machine_daily cascade;
drop view if exists public.vms_sales_clean cascade;

do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'vms_sales_raw'
      and c.relkind in ('v', 'm')
  ) then
    execute 'drop view if exists public.vms_sales_raw cascade';
    execute 'drop materialized view if exists public.vms_sales_raw cascade';
  end if;
end $$;

create table if not exists public.vms_sales_raw (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  row_number integer,
  raw_row jsonb not null,
  normalized_row jsonb,
  machine_id uuid references public.machines(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  sale_date date,
  sale_datetime timestamptz,
  quantity numeric not null default 0,
  gross_sales_lyd numeric not null default 0,
  net_sales_lyd numeric,
  duplicate_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.vms_sales_raw
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  add column if not exists row_number integer,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists normalized_row jsonb,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists sale_date date,
  add column if not exists sale_datetime timestamptz,
  add column if not exists quantity numeric not null default 0,
  add column if not exists gross_sales_lyd numeric not null default 0,
  add column if not exists net_sales_lyd numeric,
  add column if not exists duplicate_hash text,
  add column if not exists created_at timestamptz not null default now();

update public.vms_sales_raw
set duplicate_hash = coalesce(duplicate_hash, id::text)
where duplicate_hash is null;

alter table public.vms_sales_raw
  alter column duplicate_hash set not null;

create unique index if not exists idx_vms_sales_raw_duplicate_hash
  on public.vms_sales_raw(duplicate_hash);

insert into public.vms_sales_raw (
  import_batch_id,
  row_number,
  raw_row,
  normalized_row,
  machine_id,
  product_id,
  sale_date,
  sale_datetime,
  quantity,
  gross_sales_lyd,
  net_sales_lyd,
  duplicate_hash,
  created_at
)
select
  vss.import_batch_id,
  vss.import_row_number,
  coalesce(vss.metadata -> 'raw', '{}'::jsonb),
  jsonb_strip_nulls(jsonb_build_object(
    'machine_code', vss.machine_code,
    'machine_name', vss.machine_name,
    'product_number', vss.product_number,
    'product_name', vss.product_name,
    'quantity', vss.sold_qty,
    'gross_sales_lyd', coalesce(vss.gross_sales_amount, vss.sales_amount),
    'net_sales_lyd', coalesce(vss.net_sales_amount, vss.sales_amount)
  )),
  vss.machine_id,
  vss.product_id,
  coalesce(vss.sales_period_end, vss.period_end::date),
  vss.period_end,
  greatest(coalesce(vss.sold_qty, vss.transaction_count, 0), 0),
  greatest(coalesce(vss.gross_sales_amount, vss.sales_amount, vss.transaction_amount, 0), 0),
  greatest(coalesce(vss.net_sales_amount, vss.sales_amount - coalesce(vss.refund_amount, 0), vss.sales_amount, vss.transaction_amount, 0), 0),
  coalesce(vss.source_row_key, md5(concat_ws('|', vss.import_batch_id, vss.import_row_number, vss.machine_id, vss.product_id, vss.period_end, vss.sales_amount))),
  vss.created_at
from public.vms_sales_snapshots vss
where vss.import_row_status = 'imported'
on conflict (duplicate_hash) do nothing;

create or replace view public.vms_sales_clean as
select
  raw.id,
  raw.import_batch_id,
  raw.duplicate_hash as source_row_key,
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
  (prc.reporting_unit_cost_lyd * greatest(coalesce(raw.quantity, 0), 0))::numeric(12,2) as product_cost_amount,
  (greatest(coalesce(raw.net_sales_lyd, raw.gross_sales_lyd, 0), 0) - coalesce(prc.reporting_unit_cost_lyd, 0) * greatest(coalesce(raw.quantity, 0), 0))::numeric(12,2) as gross_profit_amount,
  (prc.reporting_unit_cost_lyd is null or prc.reporting_unit_cost_lyd <= 0) as cost_missing,
  raw.sale_datetime as period_start,
  raw.sale_datetime as period_end,
  raw.created_at,
  jsonb_build_object('raw', raw.raw_row, 'normalized', raw.normalized_row) as metadata
from public.vms_sales_raw raw
left join public.vms_import_batches vib on vib.id = raw.import_batch_id
left join public.machines m on m.id = raw.machine_id
left join public.locations l on l.id = m.location_id
left join public.products p on p.id = raw.product_id
left join public.product_reporting_costs prc on prc.product_id = raw.product_id
where raw.product_id is not null
  and raw.machine_id is not null;

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
  sum(coalesce(gross_profit_amount, 0))::numeric(12,2) as gross_profit_amount,
  count(distinct machine_id) as machine_count,
  count(*) filter (where cost_missing) as cost_missing_rows,
  count(*) as sales_rows
from public.vms_sales_clean
group by location_id, location_name, sales_month;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_preview_rows',
    'vms_product_mappings',
    'vms_machine_mappings',
    'vms_header_mappings',
    'vms_sales_raw'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('grant select, insert, update on public.%I to authenticated', table_name);
    execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);

    execute format($policy$
      create policy "snacky_%s_select_by_vms_import_role"
      on public.%I for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$, table_name, table_name);

    execute format($policy$
      create policy "snacky_%s_insert_by_vms_import_role"
      on public.%I for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$, table_name, table_name);

    execute format($policy$
      create policy "snacky_%s_update_by_vms_import_role"
      on public.%I for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$, table_name, table_name);
  end loop;
end $$;

grant select on public.vms_sales_clean to authenticated;
grant select on public.kpi_machine_daily to authenticated;
grant select on public.kpi_machine_monthly to authenticated;
grant select on public.kpi_product_daily to authenticated;
grant select on public.kpi_product_monthly to authenticated;
grant select on public.kpi_location_monthly to authenticated;

insert into public.vms_machine_mappings (
  vms_machine_code,
  vms_machine_name,
  snacky_machine_id,
  snacky_machine_name,
  status
)
select alias_name, alias_name, m.id, m.name, 'confirmed'
from public.machines m
cross join unnest(array['KhalijUniversity', 'Khalij University', '@الخليج', '@خليج']::text[]) as alias_name
where trim(m.name) = 'جامعة طرابلس الاهلية'
on conflict do nothing;

insert into public.vms_machine_mappings (
  vms_machine_key,
  vms_machine_code,
  vms_machine_name,
  machine_id,
  snacky_machine_id,
  snacky_machine_name,
  location_id,
  confidence_score,
  status,
  aliases
)
select
  'khalijuniversity',
  'KhalijUniversity',
  'Khalij University',
  m.id,
  m.id,
  m.name,
  m.location_id,
  1,
  'confirmed',
  array['KhalijUniversity', 'Khalij University', '@الخليج', '@خليج']::text[]
from public.machines m
where trim(m.name) = 'جامعة طرابلس الاهلية'
on conflict (vms_machine_key) do update
set
  vms_machine_code = excluded.vms_machine_code,
  vms_machine_name = excluded.vms_machine_name,
  machine_id = excluded.machine_id,
  snacky_machine_id = excluded.snacky_machine_id,
  snacky_machine_name = excluded.snacky_machine_name,
  location_id = excluded.location_id,
  confidence_score = excluded.confidence_score,
  status = excluded.status,
  aliases = excluded.aliases,
  updated_at = now();

select pg_notify('pgrst', 'reload schema');
