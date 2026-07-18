begin;

create table if not exists public.stock_reconciliation_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  period_start date not null,
  period_end date not null,
  baseline_at timestamptz not null default now(),
  cutoff_at timestamptz,
  status text not null default 'open',
  created_by uuid references public.team_members(id) on delete set null,
  closed_by uuid references public.team_members(id) on delete set null,
  closed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_reconciliation_period_valid check (period_end >= period_start),
  constraint stock_reconciliation_status_valid check (status in ('open', 'counting', 'review', 'closed', 'cancelled'))
);

create table if not exists public.stock_reconciliation_counts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.stock_reconciliation_sessions(id) on delete cascade,
  count_phase text not null,
  entity_type text not null,
  entity_id uuid,
  entity_key text not null,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity_counted integer not null default 0,
  count_source text not null default 'manual',
  source_at timestamptz,
  is_confirmed boolean not null default false,
  counted_by uuid references public.team_members(id) on delete set null,
  counted_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_reconciliation_count_phase_valid check (count_phase in ('opening', 'closing')),
  constraint stock_reconciliation_entity_type_valid check (entity_type in ('storage', 'machine', 'operator_bag')),
  constraint stock_reconciliation_count_source_valid check (count_source in ('manual', 'ledger', 'vms')),
  constraint stock_reconciliation_quantity_nonnegative check (quantity_counted >= 0),
  unique (session_id, count_phase, entity_type, entity_key, product_id)
);

create table if not exists public.stock_reconciliation_variance_cases (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.stock_reconciliation_sessions(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  case_status text not null default 'open',
  resolution_reason text,
  notes text,
  reviewed_by uuid references public.team_members(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_reconciliation_case_status_valid check (case_status in ('open', 'investigating', 'resolved', 'adjusted', 'accepted_loss')),
  unique (session_id, product_id)
);

create index if not exists idx_stock_reconciliation_counts_session_phase
  on public.stock_reconciliation_counts(session_id, count_phase, product_id);
create index if not exists idx_stock_reconciliation_counts_entity
  on public.stock_reconciliation_counts(session_id, entity_type, entity_key);
create index if not exists idx_stock_reconciliation_cases_session_status
  on public.stock_reconciliation_variance_cases(session_id, case_status);

create or replace function public.snacky_create_stock_reconciliation_session(
  p_name text,
  p_period_start date,
  p_period_end date,
  p_created_by uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_now timestamptz := now();
begin
  if nullif(btrim(p_name), '') is null then
    raise exception using errcode = '22023', message = 'Reconciliation name is required.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception using errcode = '22023', message = 'A valid reconciliation date range is required.';
  end if;

  insert into public.stock_reconciliation_sessions (
    name, period_start, period_end, baseline_at, status, created_by, notes
  ) values (
    btrim(p_name), p_period_start, p_period_end, v_now, 'open', p_created_by, nullif(btrim(p_notes), '')
  ) returning id into v_session_id;

  insert into public.stock_reconciliation_counts (
    session_id, count_phase, entity_type, entity_id, entity_key, product_id,
    quantity_counted, count_source, source_at, is_confirmed, counted_by, counted_at
  )
  select
    v_session_id,
    'opening',
    inventory.location_type,
    inventory.location_id,
    coalesce(inventory.location_id::text, inventory.location_type || ':unassigned'),
    inventory.product_id,
    greatest(sum(inventory.quantity_on_hand), 0)::integer,
    'ledger',
    v_now,
    false,
    p_created_by,
    v_now
  from public.current_inventory_by_location inventory
  where inventory.location_type in ('storage', 'operator_bag')
    and inventory.product_id is not null
  group by inventory.location_type, inventory.location_id, inventory.product_id
  on conflict (session_id, count_phase, entity_type, entity_key, product_id)
  do update set
    quantity_counted = excluded.quantity_counted,
    source_at = excluded.source_at,
    counted_by = excluded.counted_by,
    counted_at = excluded.counted_at,
    updated_at = v_now;

  insert into public.stock_reconciliation_counts (
    session_id, count_phase, entity_type, entity_id, entity_key, product_id,
    quantity_counted, count_source, source_at, is_confirmed, counted_by, counted_at
  )
  select
    v_session_id,
    'opening',
    'machine',
    stock.machine_id,
    stock.machine_id::text,
    stock.product_id,
    greatest(sum(stock.current_qty), 0)::integer,
    'vms',
    max(stock.captured_at),
    true,
    p_created_by,
    v_now
  from public.latest_vms_stock_by_slot stock
  where stock.machine_id is not null
    and stock.product_id is not null
  group by stock.machine_id, stock.product_id
  on conflict (session_id, count_phase, entity_type, entity_key, product_id)
  do update set
    quantity_counted = excluded.quantity_counted,
    source_at = excluded.source_at,
    counted_by = excluded.counted_by,
    counted_at = excluded.counted_at,
    updated_at = v_now;

  return v_session_id;
end;
$$;

create or replace function public.snacky_capture_stock_reconciliation_closing(
  p_session_id uuid,
  p_counted_by uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_rows integer := 0;
  v_added integer := 0;
begin
  if not exists (
    select 1 from public.stock_reconciliation_sessions where id = p_session_id and status <> 'cancelled'
  ) then
    raise exception using errcode = 'P0002', message = 'Stock reconciliation session was not found.';
  end if;

  update public.stock_reconciliation_counts
  set quantity_counted = 0,
      source_at = v_now,
      counted_at = v_now,
      counted_by = p_counted_by,
      updated_at = v_now
  where session_id = p_session_id
    and count_phase = 'closing'
    and count_source <> 'manual';

  insert into public.stock_reconciliation_counts (
    session_id, count_phase, entity_type, entity_id, entity_key, product_id,
    quantity_counted, count_source, source_at, is_confirmed, counted_by, counted_at
  )
  select
    p_session_id,
    'closing',
    inventory.location_type,
    inventory.location_id,
    coalesce(inventory.location_id::text, inventory.location_type || ':unassigned'),
    inventory.product_id,
    greatest(sum(inventory.quantity_on_hand), 0)::integer,
    'ledger',
    v_now,
    false,
    p_counted_by,
    v_now
  from public.current_inventory_by_location inventory
  where inventory.location_type in ('storage', 'operator_bag')
    and inventory.product_id is not null
  group by inventory.location_type, inventory.location_id, inventory.product_id
  on conflict (session_id, count_phase, entity_type, entity_key, product_id)
  do update set
    quantity_counted = excluded.quantity_counted,
    count_source = excluded.count_source,
    source_at = excluded.source_at,
    is_confirmed = excluded.is_confirmed,
    counted_by = excluded.counted_by,
    counted_at = excluded.counted_at,
    updated_at = v_now;
  get diagnostics v_added = row_count;
  v_rows := v_rows + v_added;

  insert into public.stock_reconciliation_counts (
    session_id, count_phase, entity_type, entity_id, entity_key, product_id,
    quantity_counted, count_source, source_at, is_confirmed, counted_by, counted_at
  )
  select
    p_session_id,
    'closing',
    'machine',
    stock.machine_id,
    stock.machine_id::text,
    stock.product_id,
    greatest(sum(stock.current_qty), 0)::integer,
    'vms',
    max(stock.captured_at),
    true,
    p_counted_by,
    v_now
  from public.latest_vms_stock_by_slot stock
  where stock.machine_id is not null
    and stock.product_id is not null
  group by stock.machine_id, stock.product_id
  on conflict (session_id, count_phase, entity_type, entity_key, product_id)
  do update set
    quantity_counted = excluded.quantity_counted,
    count_source = excluded.count_source,
    source_at = excluded.source_at,
    is_confirmed = excluded.is_confirmed,
    counted_by = excluded.counted_by,
    counted_at = excluded.counted_at,
    updated_at = v_now;
  get diagnostics v_added = row_count;
  v_rows := v_rows + v_added;

  update public.stock_reconciliation_sessions
  set cutoff_at = v_now,
      status = case when status = 'closed' then status else 'counting' end,
      updated_at = v_now
  where id = p_session_id;

  return v_rows;
end;
$$;

create or replace function public.snacky_stock_reconciliation_variance(
  p_session_id uuid
)
returns table (
  product_id uuid,
  product_name text,
  sku text,
  category text,
  case_quantity integer,
  opening_units integer,
  purchased_units integer,
  other_inflow_units integer,
  sold_units integer,
  recorded_loss_units integer,
  expected_closing_units integer,
  storage_units integer,
  machine_units integer,
  operator_units integer,
  actual_closing_units integer,
  variance_units integer,
  missing_units integer,
  extra_units integer,
  unit_cost numeric,
  missing_cost numeric,
  confidence text,
  variance_status text,
  sales_source text,
  latest_count_at timestamptz,
  case_status text,
  resolution_reason text,
  case_notes text
)
language sql
stable
security definer
set search_path = public
as $$
with session_row as (
  select *
  from public.stock_reconciliation_sessions
  where id = p_session_id
),
opening_by_type as (
  select
    counts.product_id,
    counts.entity_type,
    coalesce(
      sum(counts.quantity_counted) filter (where counts.count_source = 'manual' and counts.is_confirmed),
      sum(counts.quantity_counted) filter (where counts.count_source <> 'manual'),
      0
    )::integer as quantity,
    bool_or(counts.count_source = 'manual' and counts.is_confirmed) as has_manual,
    count(*)::integer as row_count
  from public.stock_reconciliation_counts counts
  where counts.session_id = p_session_id
    and counts.count_phase = 'opening'
  group by counts.product_id, counts.entity_type
),
opening as (
  select
    product_id,
    sum(quantity)::integer as opening_units,
    coalesce(sum(quantity) filter (where entity_type = 'machine'), 0)::integer as opening_machine_units,
    coalesce(bool_or(has_manual) filter (where entity_type = 'storage'), false) as storage_manual,
    coalesce(bool_or(has_manual) filter (where entity_type = 'operator_bag'), false) as operator_manual,
    sum(row_count)::integer as opening_rows
  from opening_by_type
  group by product_id
),
closing_by_type as (
  select
    counts.product_id,
    counts.entity_type,
    coalesce(
      sum(counts.quantity_counted) filter (where counts.count_source = 'manual' and counts.is_confirmed),
      sum(counts.quantity_counted) filter (where counts.count_source <> 'manual'),
      0
    )::integer as quantity,
    bool_or(counts.count_source = 'manual' and counts.is_confirmed) as has_manual,
    max(counts.source_at) filter (where counts.count_source = 'manual' and counts.is_confirmed) as manual_source_at,
    max(counts.source_at) filter (where counts.count_source <> 'manual') as auto_source_at,
    count(*)::integer as row_count
  from public.stock_reconciliation_counts counts
  where counts.session_id = p_session_id
    and counts.count_phase = 'closing'
  group by counts.product_id, counts.entity_type
),
closing as (
  select
    product_id,
    coalesce(sum(quantity) filter (where entity_type = 'storage'), 0)::integer as storage_units,
    coalesce(sum(quantity) filter (where entity_type = 'machine'), 0)::integer as machine_units,
    coalesce(sum(quantity) filter (where entity_type = 'operator_bag'), 0)::integer as operator_units,
    coalesce(sum(quantity), 0)::integer as actual_closing_units,
    bool_or(has_manual) filter (where entity_type = 'storage') as storage_manual,
    bool_or(has_manual) filter (where entity_type = 'operator_bag') as operator_manual,
    coalesce(sum(row_count), 0)::integer as closing_rows,
    max(coalesce(manual_source_at, auto_source_at)) as latest_count_at,
    max(coalesce(manual_source_at, auto_source_at)) filter (where entity_type = 'machine') as machine_count_at
  from closing_by_type
  group by product_id
),
movement_rollup as (
  select
    movements.product_id,
    coalesce(sum(movements.quantity) filter (
      where movements.from_entity_type::text = 'supplier'
        and movements.to_entity_type::text in ('storage', 'operator_bag', 'machine')
    ), 0)::integer as purchased_units,
    coalesce(sum(movements.quantity) filter (
      where movements.from_entity_type::text not in ('storage', 'operator_bag', 'machine')
        and movements.from_entity_type::text <> 'supplier'
        and movements.to_entity_type::text in ('storage', 'operator_bag', 'machine')
    ), 0)::integer as other_inflow_units,
    coalesce(sum(movements.quantity) filter (
      where movements.from_entity_type::text in ('storage', 'operator_bag', 'machine')
        and movements.to_entity_type::text not in ('storage', 'operator_bag', 'machine')
    ), 0)::integer as recorded_loss_units
  from public.inventory_movements movements
  cross join session_row session
  where movements.created_at >= session.period_start::timestamptz
    and movements.created_at < (session.period_end + 1)::timestamptz
  group by movements.product_id
),
monthly_batches as (
  select distinct on (date_trunc('month', profit.business_month)::date)
    batches.id,
    date_trunc('month', profit.business_month)::date as business_month,
    batches.report_end_date,
    batches.imported_at
  from public.vms_import_batches batches
  join public.vms_monthly_product_profit profit on profit.import_batch_id = batches.id
  cross join session_row session
  where batches.report_type = 'monthly_product_profit'
    and batches.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and batches.is_active = true
    and batches.deleted_at is null
    and date_trunc('month', profit.business_month)::date between date_trunc('month', session.period_start)::date and date_trunc('month', session.period_end)::date
  order by date_trunc('month', profit.business_month)::date, batches.report_end_date desc nulls last, batches.imported_at desc nulls last
),
monthly_sales as (
  select
    profit.internal_product_id as product_id,
    sum(greatest(coalesce(profit.transaction_count, 0), 0))::integer as sold_units
  from public.vms_monthly_product_profit profit
  join monthly_batches batches on batches.id = profit.import_batch_id
  where profit.internal_product_id is not null
  group by profit.internal_product_id
),
detailed_sales as (
  select
    transactions.mapped_product_id as product_id,
    sum(greatest(coalesce(transactions.quantity, 1), 0))::integer as sold_units
  from public.vms_transactions_raw transactions
  join public.vms_import_batches batches on batches.id = transactions.import_batch_id
  cross join session_row session
  where transactions.transaction_status = 'successful_sale'
    and transactions.mapped_product_id is not null
    and batches.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and batches.is_active = true
    and batches.deleted_at is null
    and coalesce(transactions.payment_time, transactions.delivery_time) >= session.period_start::timestamptz
    and coalesce(transactions.payment_time, transactions.delivery_time) < (session.period_end + 1)::timestamptz
  group by transactions.mapped_product_id
),
sales_mode as (
  select
    case
      when session.period_start = date_trunc('month', session.period_start)::date
        and exists (select 1 from monthly_batches)
      then 'monthly_product_profit'
      when exists (select 1 from detailed_sales)
      then 'detailed_transactions'
      else 'none'
    end as sales_source,
    case
      when session.period_start = date_trunc('month', session.period_start)::date
        and exists (select 1 from monthly_batches)
      then (select max(report_end_date) from monthly_batches)
      when exists (select 1 from detailed_sales)
      then session.period_end
      else null
    end as sales_coverage_end
  from session_row session
),
selected_sales as (
  select monthly.product_id, monthly.sold_units
  from monthly_sales monthly, sales_mode mode
  where mode.sales_source = 'monthly_product_profit'
  union all
  select detailed.product_id, detailed.sold_units
  from detailed_sales detailed, sales_mode mode
  where mode.sales_source = 'detailed_transactions'
),
product_scope as (
  select product_id from opening
  union select product_id from closing
  union select product_id from movement_rollup
  union select product_id from selected_sales
),
calculated as (
  select
    products.id as product_id,
    products.name as product_name,
    products.sku,
    products.category,
    greatest(coalesce(products.case_quantity, 1), 1)::integer as case_quantity,
    coalesce(opening.opening_units, 0)::integer as opening_units,
    coalesce(opening.opening_machine_units, 0)::integer as opening_machine_units,
    coalesce(opening.storage_manual, false) as opening_storage_manual,
    coalesce(opening.operator_manual, false) as opening_operator_manual,
    coalesce(opening.opening_rows, 0)::integer as opening_rows,
    coalesce(movements.purchased_units, 0)::integer as purchased_units,
    coalesce(movements.other_inflow_units, 0)::integer as other_inflow_units,
    coalesce(sales.sold_units, 0)::integer as sold_units,
    coalesce(movements.recorded_loss_units, 0)::integer as recorded_loss_units,
    greatest(
      coalesce(opening.opening_units, 0)
      + coalesce(movements.purchased_units, 0)
      + coalesce(movements.other_inflow_units, 0)
      - coalesce(sales.sold_units, 0)
      - coalesce(movements.recorded_loss_units, 0),
      0
    )::integer as expected_closing_units,
    coalesce(closing.storage_units, 0)::integer as storage_units,
    coalesce(closing.machine_units, 0)::integer as machine_units,
    coalesce(closing.operator_units, 0)::integer as operator_units,
    coalesce(closing.actual_closing_units, 0)::integer as actual_closing_units,
    coalesce(closing.storage_manual, false) as storage_manual,
    coalesce(closing.operator_manual, false) as operator_manual,
    coalesce(closing.closing_rows, 0)::integer as closing_rows,
    closing.latest_count_at,
    closing.machine_count_at,
    greatest(coalesce(products.cost_price, 0), 0)::numeric as unit_cost,
    mode.sales_source,
    mode.sales_coverage_end,
    (session.baseline_at::date > session.period_start) as baseline_misaligned,
    (session.cutoff_at is null or session.cutoff_at::date < session.period_end) as closing_misaligned,
    session.period_end
  from product_scope scope
  join public.products products on products.id = scope.product_id
  left join opening on opening.product_id = products.id
  left join closing on closing.product_id = products.id
  left join movement_rollup movements on movements.product_id = products.id
  left join selected_sales sales on sales.product_id = products.id
  cross join sales_mode mode
  cross join session_row session
),
final_rows as (
  select
    calculated.*,
    (calculated.actual_closing_units - calculated.expected_closing_units)::integer as variance_units,
    greatest(calculated.expected_closing_units - calculated.actual_closing_units, 0)::integer as missing_units,
    greatest(calculated.actual_closing_units - calculated.expected_closing_units, 0)::integer as extra_units,
    case
      when calculated.opening_rows <= 0 or calculated.closing_rows <= 0 or calculated.sales_source = 'none' then 'data_gap'
      when calculated.baseline_misaligned or calculated.closing_misaligned then 'data_gap'
      when calculated.sales_coverage_end is null then 'data_gap'
      when calculated.sales_coverage_end < calculated.period_end then 'suspected'
      when not calculated.opening_storage_manual or not calculated.opening_operator_manual
        or not calculated.storage_manual or not calculated.operator_manual then 'suspected'
      when calculated.opening_machine_units > 0 and calculated.machine_count_at is null then 'data_gap'
      when calculated.machine_count_at is not null and calculated.machine_count_at < (select period_end::timestamptz - interval '1 day' from session_row) then 'suspected'
      else 'confirmed'
    end as confidence
  from calculated
)
select
  rows.product_id,
  rows.product_name,
  rows.sku,
  rows.category,
  rows.case_quantity,
  rows.opening_units,
  rows.purchased_units,
  rows.other_inflow_units,
  rows.sold_units,
  rows.recorded_loss_units,
  rows.expected_closing_units,
  rows.storage_units,
  rows.machine_units,
  rows.operator_units,
  rows.actual_closing_units,
  rows.variance_units,
  case when rows.confidence = 'data_gap' then 0 else rows.missing_units end as missing_units,
  rows.extra_units,
  rows.unit_cost,
  case when rows.confidence = 'data_gap' then 0 else (rows.missing_units * rows.unit_cost)::numeric end as missing_cost,
  rows.confidence,
  case
    when rows.confidence = 'data_gap' then 'data_gap'
    when rows.missing_units > 0 and rows.confidence = 'confirmed' then 'confirmed_missing'
    when rows.missing_units > 0 then 'suspected_missing'
    when rows.extra_units > 0 then 'extra_found'
    else 'balanced'
  end as variance_status,
  rows.sales_source,
  rows.latest_count_at,
  coalesce(cases.case_status, case when rows.missing_units > 0 then 'open' else 'resolved' end) as case_status,
  cases.resolution_reason,
  cases.notes as case_notes
from final_rows rows
left join public.stock_reconciliation_variance_cases cases
  on cases.session_id = p_session_id and cases.product_id = rows.product_id
order by missing_cost desc, missing_units desc, rows.product_name;
$$;

alter table public.stock_reconciliation_sessions enable row level security;
alter table public.stock_reconciliation_counts enable row level security;
alter table public.stock_reconciliation_variance_cases enable row level security;

drop policy if exists stock_reconciliation_sessions_authenticated on public.stock_reconciliation_sessions;
create policy stock_reconciliation_sessions_authenticated
  on public.stock_reconciliation_sessions for all to authenticated
  using (true) with check (true);

drop policy if exists stock_reconciliation_counts_authenticated on public.stock_reconciliation_counts;
create policy stock_reconciliation_counts_authenticated
  on public.stock_reconciliation_counts for all to authenticated
  using (true) with check (true);

drop policy if exists stock_reconciliation_cases_authenticated on public.stock_reconciliation_variance_cases;
create policy stock_reconciliation_cases_authenticated
  on public.stock_reconciliation_variance_cases for all to authenticated
  using (true) with check (true);

grant select, insert, update on public.stock_reconciliation_sessions to authenticated;
grant select, insert, update on public.stock_reconciliation_counts to authenticated;
grant select, insert, update on public.stock_reconciliation_variance_cases to authenticated;
grant execute on function public.snacky_create_stock_reconciliation_session(text, date, date, uuid, text) to authenticated;
grant execute on function public.snacky_capture_stock_reconciliation_closing(uuid, uuid) to authenticated;
grant execute on function public.snacky_stock_reconciliation_variance(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
