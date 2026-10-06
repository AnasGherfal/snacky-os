-- SNACKY_OS_SCHEMA_REPAIR.sql
-- Master repair script for Snacky OS deployed Supabase PostgreSQL schemas.
-- Generated from the current codebase migration set on 2026-06-09.
--
-- Purpose:
-- - create missing tables, views, functions/RPCs, triggers, indexes, storage buckets, and RLS policies
-- - add missing columns and constraints introduced by current application code
-- - backfill metadata required by route, VMS import, purchase, inventory, and finance workflows
--
-- Run this as ONE SQL file in Supabase SQL editor or with:
--   npx supabase db query --linked --file SNACKY_OS_SCHEMA_REPAIR.sql
--
-- Notes:
-- - This file intentionally consolidates the current schema contract into one deployable repair script.
-- - It does not contain secrets.
-- - It preserves existing data unless a repair block from the underlying migration explicitly backfills metadata.

-- Intentionally not wrapped in one explicit transaction because PostgreSQL enum repairs
-- may need to commit before later statements can safely use newly added enum values.


-- ============================================================================
-- Source migration: supabase/migrations/202605060001_initial_snacky_schema.sql
-- ============================================================================

-- Snacky OS initial database schema
-- This is the core operating database: machines, products, inventory, VMS snapshots, refills, cash, and issues.

create extension if not exists pgcrypto;

-- ---------- ENUMS ----------
do $$ begin
  create type machine_status as enum ('planned', 'incoming', 'standby', 'active', 'inactive', 'maintenance', 'relocated', 'retired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type location_type as enum ('school', 'hospital', 'mall', 'university', 'office', 'gym', 'warehouse', 'mixed', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type team_role as enum ('owner', 'admin', 'supervisor', 'operator', 'warehouse', 'procurement', 'finance', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type route_status as enum ('draft', 'assigned', 'in_progress', 'completed', 'reviewed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type route_stop_status as enum ('pending', 'arrived', 'refilling', 'cash_collected', 'completed', 'skipped', 'issue_reported');
exception when duplicate_object then null; end $$;

do $$ begin
  create type refill_status as enum ('draft', 'assigned', 'picked', 'in_progress', 'completed', 'review_required', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type issue_priority as enum ('critical', 'high', 'normal', 'low');
exception when duplicate_object then null; end $$;

do $$ begin
  create type issue_status as enum ('open', 'assigned', 'in_progress', 'resolved', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type inventory_entity_type as enum ('supplier', 'storage', 'operator_bag', 'machine', 'waste', 'adjustment');
exception when duplicate_object then null; end $$;

do $$ begin
  create type movement_reason as enum (
    'purchase_received',
    'storage_to_operator_bag',
    'operator_bag_to_machine',
    'operator_bag_to_storage',
    'machine_to_storage',
    'damaged',
    'expired',
    'stock_count_adjustment',
    'theft_or_missing'
  );
exception when duplicate_object then null; end $$;

-- ---------- MASTER DATA ----------
create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_type location_type not null default 'other',
  address text,
  contact_name text,
  contact_phone text,
  rent_amount numeric(12,2) default 0,
  rent_type text default 'monthly_fixed',
  contract_start date,
  contract_end date,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists machines (
  id uuid primary key default gen_random_uuid(),
  machine_code text unique not null,
  vms_machine_id text unique,
  name text not null,
  machine_type text not null default 'lift',
  location_id uuid references locations(id) on delete set null,
  status machine_status not null default 'planned',
  serial_number text,
  installed_date date,
  rent_amount numeric(12,2) default 0,
  target_nsm numeric(12,2) default 2800,
  target_uptime_percent numeric(5,2) default 98,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  phone text,
  payment_terms text,
  usual_delivery_days integer default 1,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  barcode text,
  name text not null,
  category text not null default 'snack',
  brand text,
  supplier_id uuid references suppliers(id) on delete set null,
  cost_price numeric(12,2) not null default 0,
  selling_price numeric(12,2) not null default 0,
  case_quantity integer default 1,
  image_url text,
  expiry_sensitive boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selling_price_nonnegative check (selling_price >= 0),
  constraint cost_price_nonnegative check (cost_price >= 0)
);

create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,
  email text,
  role team_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists storage_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists machine_slots (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id) on delete cascade,
  slot_code text not null,
  product_id uuid not null references products(id) on delete restrict,
  capacity integer not null,
  min_qty integer not null default 2,
  par_qty integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(machine_id, slot_code),
  constraint slot_capacity_positive check (capacity > 0),
  constraint par_qty_positive check (par_qty > 0),
  constraint par_qty_lte_capacity check (par_qty <= capacity),
  constraint min_qty_nonnegative check (min_qty >= 0)
);

-- ---------- VMS IMPORT + MAPPING ----------
create table if not exists vms_product_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_product_id text,
  vms_product_name text not null,
  product_id uuid references products(id) on delete set null,
  match_status text not null default 'needs_review', -- confirmed, needs_review, ignored
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vms_product_id, vms_product_name)
);

create table if not exists vms_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_type text not null default 'csv', -- csv, api, email_report
  file_name text,
  imported_by uuid references team_members(id) on delete set null,
  imported_at timestamptz not null default now(),
  status text not null default 'completed',
  row_count integer default 0,
  error_count integer default 0,
  notes text
);

create table if not exists vms_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references vms_import_batches(id) on delete set null,
  machine_id uuid references machines(id) on delete cascade,
  vms_machine_id text,
  slot_code text,
  vms_product_id text,
  vms_product_name text,
  product_id uuid references products(id) on delete set null,
  current_qty integer not null default 0,
  capacity integer,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint vms_current_qty_nonnegative check (current_qty >= 0)
);

create table if not exists vms_sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references vms_import_batches(id) on delete set null,
  machine_id uuid references machines(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  sold_qty integer not null default 0,
  sales_amount numeric(12,2) not null default 0,
  cash_sales_amount numeric(12,2) not null default 0,
  card_sales_amount numeric(12,2) not null default 0,
  period_start timestamptz not null,
  period_end timestamptz not null,
  created_at timestamptz not null default now(),
  constraint sold_qty_nonnegative check (sold_qty >= 0),
  constraint sales_amount_nonnegative check (sales_amount >= 0)
);

-- ---------- INVENTORY ----------
create table if not exists inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete restrict,
  quantity integer not null,
  from_entity_type inventory_entity_type not null,
  from_entity_id uuid,
  to_entity_type inventory_entity_type not null,
  to_entity_id uuid,
  reason movement_reason not null,
  related_route_id uuid,
  related_refill_order_id uuid,
  created_by uuid references team_members(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  constraint movement_quantity_positive check (quantity > 0)
);

-- ---------- ROUTES + REFILLS ----------
create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  route_date date not null,
  operator_id uuid references team_members(id) on delete set null,
  status route_status not null default 'draft',
  created_by uuid references team_members(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  machine_id uuid not null references machines(id) on delete cascade,
  stop_order integer not null default 1,
  status route_stop_status not null default 'pending',
  arrived_at timestamptz,
  completed_at timestamptz,
  notes text,
  unique(route_id, machine_id)
);

create table if not exists refill_orders (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id) on delete set null,
  machine_id uuid not null references machines(id) on delete cascade,
  status refill_status not null default 'draft',
  generated_at timestamptz not null default now(),
  completed_at timestamptz,
  notes text
);

create table if not exists refill_order_lines (
  id uuid primary key default gen_random_uuid(),
  refill_order_id uuid not null references refill_orders(id) on delete cascade,
  machine_slot_id uuid references machine_slots(id) on delete set null,
  product_id uuid not null references products(id) on delete restrict,
  current_qty_vms integer default 0,
  par_qty integer not null,
  suggested_qty integer not null,
  available_storage_qty integer not null default 0,
  final_qty_to_take integer not null default 0,
  picked_qty integer default 0,
  filled_qty integer default 0,
  returned_qty integer default 0,
  shortage_qty integer default 0,
  created_at timestamptz not null default now(),
  constraint suggested_qty_nonnegative check (suggested_qty >= 0),
  constraint picked_qty_nonnegative check (picked_qty >= 0),
  constraint filled_qty_nonnegative check (filled_qty >= 0),
  constraint returned_qty_nonnegative check (returned_qty >= 0),
  constraint shortage_qty_nonnegative check (shortage_qty >= 0)
);

-- ---------- CASH ----------
create table if not exists cash_collections (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id) on delete set null,
  machine_id uuid not null references machines(id) on delete cascade,
  operator_id uuid references team_members(id) on delete set null,
  vms_expected_cash numeric(12,2) not null default 0,
  actual_cash_collected numeric(12,2) not null default 0,
  variance numeric(12,2) generated always as (actual_cash_collected - vms_expected_cash) stored,
  review_status text not null default 'pending', -- ok, pending, review_required, resolved
  collected_at timestamptz not null default now(),
  notes text
);

-- ---------- ISSUES / MAINTENANCE ----------
create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid references machines(id) on delete cascade,
  reported_by uuid references team_members(id) on delete set null,
  assigned_to uuid references team_members(id) on delete set null,
  issue_type text not null,
  priority issue_priority not null default 'normal',
  status issue_status not null default 'open',
  description text,
  photo_url text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  sla_due_at timestamptz
);

create or replace function set_issue_sla_due_at()
returns trigger as $$
begin
  if new.created_at is null then
    new.created_at := now();
  end if;

  new.sla_due_at :=
    case
      when new.priority = 'critical' then new.created_at + interval '24 hours'
      when new.priority = 'high' then new.created_at + interval '24 hours'
      else new.created_at + interval '72 hours'
    end;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_issue_sla_due_at on issues;

create trigger trg_set_issue_sla_due_at
before insert or update of priority, created_at
on issues
for each row
execute function set_issue_sla_due_at();

-- ---------- PURCHASES ----------
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id) on delete set null,
  status text not null default 'draft', -- draft, ordered, received, cancelled
  order_date date not null default current_date,
  expected_delivery_date date,
  received_date date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  ordered_qty integer not null,
  received_qty integer not null default 0,
  unit_cost numeric(12,2) not null default 0,
  constraint po_ordered_qty_positive check (ordered_qty > 0),
  constraint po_received_qty_nonnegative check (received_qty >= 0)
);

-- ---------- VIEWS ----------
create or replace view current_inventory_by_location as
with movement_locations as (
  select
    product_id,
    from_entity_type as location_type,
    from_entity_id as location_id,
    -quantity as quantity_delta
  from inventory_movements
  where from_entity_type in ('storage', 'operator_bag', 'machine')

  union all

  select
    product_id,
    to_entity_type as location_type,
    to_entity_id as location_id,
    quantity as quantity_delta
  from inventory_movements
  where to_entity_type in ('storage', 'operator_bag', 'machine')
)
select
  p.id as product_id,
  p.name as product_name,
  ml.location_type::text as location_type,
  ml.location_id,
  coalesce(sl.name, tm.full_name, m.name, 'Unknown') as location_name,
  sum(ml.quantity_delta)::integer as quantity_on_hand
from movement_locations ml
join products p on p.id = ml.product_id
left join storage_locations sl on ml.location_type = 'storage' and sl.id = ml.location_id
left join team_members tm on ml.location_type = 'operator_bag' and tm.id = ml.location_id
left join machines m on ml.location_type = 'machine' and m.id = ml.location_id
group by p.id, p.name, ml.location_type, ml.location_id, sl.name, tm.full_name, m.name
having sum(ml.quantity_delta) <> 0;

create or replace view latest_vms_stock_by_slot as
select distinct on (machine_id, slot_code)
  id,
  machine_id,
  slot_code,
  product_id,
  current_qty,
  capacity,
  captured_at
from vms_stock_snapshots
where machine_id is not null and slot_code is not null
order by machine_id, slot_code, captured_at desc;

create or replace view refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
)
select
  m.id as machine_id,
  m.name as machine_name,
  m.machine_code,
  ms.id as machine_slot_id,
  ms.slot_code,
  p.id as product_id,
  p.name as product_name,
  coalesce(lvs.current_qty, 0) as current_qty,
  ms.min_qty,
  ms.par_qty,
  greatest(ms.par_qty - coalesce(lvs.current_qty, 0), 0)::integer as suggested_qty,
  coalesce(ss.available_storage_qty, 0) as available_storage_qty,
  least(greatest(ms.par_qty - coalesce(lvs.current_qty, 0), 0), coalesce(ss.available_storage_qty, 0))::integer as final_qty_to_take,
  case
    when coalesce(lvs.current_qty, 0) = 0 then 'critical'
    when coalesce(lvs.current_qty, 0) <= ms.min_qty then 'high'
    when coalesce(lvs.current_qty, 0) < ms.par_qty then 'medium'
    else 'none'
  end as priority,
  lvs.captured_at as latest_vms_at
from machine_slots ms
join machines m on m.id = ms.machine_id
join products p on p.id = ms.product_id
left join latest_vms_stock_by_slot lvs on lvs.machine_id = ms.machine_id and lvs.slot_code = ms.slot_code
left join storage_stock ss on ss.product_id = p.id
where ms.active = true
  and m.status = 'active'
  and greatest(ms.par_qty - coalesce(lvs.current_qty, 0), 0) > 0;

-- Helpful indexes for scale
create index if not exists idx_machines_location_id on machines(location_id);
create index if not exists idx_machine_slots_machine_id on machine_slots(machine_id);
create index if not exists idx_vms_stock_machine_slot_captured on vms_stock_snapshots(machine_id, slot_code, captured_at desc);
create index if not exists idx_inventory_movements_product on inventory_movements(product_id);
create index if not exists idx_inventory_movements_from on inventory_movements(from_entity_type, from_entity_id);
create index if not exists idx_inventory_movements_to on inventory_movements(to_entity_type, to_entity_id);
create index if not exists idx_routes_operator_date on routes(operator_id, route_date);
create index if not exists idx_issues_machine_status on issues(machine_id, status);


-- ============================================================================
-- Source migration: supabase/migrations/202605130001_cash_collection_status.sql
-- ============================================================================

alter table cash_collections
  alter column review_status set default 'ok';

update cash_collections
set review_status = case
  when review_status = 'resolved' then 'resolved'
  when abs(variance) >= 10 then 'needs_review'
  else 'ok'
end
where review_status is null
  or review_status not in ('ok', 'needs_review', 'resolved');

alter table cash_collections
  drop constraint if exists cash_collections_review_status_check;

alter table cash_collections
  add constraint cash_collections_review_status_check
  check (review_status in ('ok', 'needs_review', 'resolved'));


-- ============================================================================
-- Source migration: supabase/migrations/202605130002_auth_profiles.sql
-- ============================================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text unique,
  phone text,
  role team_role not null default 'viewer',
  active_status text not null default 'active',
  team_member_id uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_active_status_check check (active_status in ('active', 'inactive'))
);

create index if not exists idx_profiles_role on profiles(role);
create index if not exists idx_profiles_active_status on profiles(active_status);
create index if not exists idx_profiles_team_member_id on profiles(team_member_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605140001_route_stock_lines.sql
-- ============================================================================

create table if not exists route_stock_lines (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  planned_qty integer not null default 0,
  picked_qty integer not null default 0,
  returned_qty integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(route_id, product_id),
  constraint route_stock_planned_qty_nonnegative check (planned_qty >= 0),
  constraint route_stock_picked_qty_nonnegative check (picked_qty >= 0),
  constraint route_stock_returned_qty_nonnegative check (returned_qty >= 0)
);

create index if not exists idx_route_stock_lines_route_id on route_stock_lines(route_id);
create index if not exists idx_route_stock_lines_product_id on route_stock_lines(product_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605140002_profiles_last_login.sql
-- ============================================================================

alter table profiles
add column if not exists last_login_at timestamptz;


-- ============================================================================
-- Source migration: supabase/migrations/202605140003_team_auth_password_flags.sql
-- ============================================================================

alter table team_members
add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
add column if not exists active_status text not null default 'active',
add column if not exists must_change_password boolean not null default false;

alter table profiles
add column if not exists must_change_password boolean not null default false;

create index if not exists idx_team_members_auth_user_id on team_members(auth_user_id);
create index if not exists idx_team_members_active_status on team_members(active_status);

update team_members
set active_status = case when active then 'active' else 'inactive' end
where active_status is null or active_status not in ('active', 'inactive');


-- ============================================================================
-- Source migration: supabase/migrations/202605140004_route_stop_fill_lines.sql
-- ============================================================================

create table if not exists route_stop_fill_lines (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  route_stop_id uuid not null references route_stops(id) on delete cascade,
  machine_id uuid not null references machines(id) on delete cascade,
  refill_order_line_id uuid references refill_order_lines(id) on delete set null,
  assigned_product_id uuid references products(id) on delete set null,
  product_id uuid references products(id) on delete set null,
  substitute_product_id uuid references products(id) on delete set null,
  action_type text not null default 'assigned_fill',
  assigned_qty integer not null default 0,
  actual_qty integer not null default 0,
  difference_qty integer not null default 0,
  reason text,
  notes text,
  missing_product_name text,
  needs_review boolean not null default false,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint route_stop_fill_lines_action_check check (action_type in ('assigned_fill', 'extra_product', 'substitution', 'missing_product_report')),
  constraint route_stop_fill_lines_assigned_qty_nonnegative check (assigned_qty >= 0),
  constraint route_stop_fill_lines_actual_qty_nonnegative check (actual_qty >= 0)
);

create index if not exists idx_route_stop_fill_lines_route_id on route_stop_fill_lines(route_id);
create index if not exists idx_route_stop_fill_lines_route_stop_id on route_stop_fill_lines(route_stop_id);
create index if not exists idx_route_stop_fill_lines_needs_review on route_stop_fill_lines(needs_review);


-- ============================================================================
-- Source migration: supabase/migrations/202605140005_refill_line_source.sql
-- ============================================================================

alter table refill_order_lines
add column if not exists source text not null default 'refill_recommendation';

do $$ begin
  alter table refill_order_lines
    add constraint refill_order_lines_source_check
    check (source in ('refill_recommendation', 'manual_admin_assignment'));
exception when duplicate_object then null; end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605140006_route_pick_adjustments.sql
-- ============================================================================

create table if not exists route_pick_adjustments (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  planned_qty integer not null default 0,
  picked_qty integer not null default 0,
  difference_qty integer not null default 0,
  reason text,
  notes text,
  needs_review boolean not null default true,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint route_pick_adjustments_planned_qty_nonnegative check (planned_qty >= 0),
  constraint route_pick_adjustments_picked_qty_nonnegative check (picked_qty >= 0)
);

create index if not exists idx_route_pick_adjustments_route_id on route_pick_adjustments(route_id);
create index if not exists idx_route_pick_adjustments_needs_review on route_pick_adjustments(needs_review);


-- ============================================================================
-- Source migration: supabase/migrations/202605140007_route_stop_items_pick_list_items.sql
-- ============================================================================

create table if not exists route_stop_items (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  route_stop_id uuid not null references route_stops(id) on delete cascade,
  machine_id uuid not null references machines(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  machine_slot_id uuid references machine_slots(id) on delete set null,
  planned_quantity integer not null default 0,
  picked_quantity integer,
  filled_quantity integer,
  returned_quantity integer,
  source text not null default 'manual_admin_assignment',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_stop_items_planned_quantity_nonnegative check (planned_quantity >= 0),
  constraint route_stop_items_picked_quantity_nonnegative check (picked_quantity is null or picked_quantity >= 0),
  constraint route_stop_items_filled_quantity_nonnegative check (filled_quantity is null or filled_quantity >= 0),
  constraint route_stop_items_returned_quantity_nonnegative check (returned_quantity is null or returned_quantity >= 0),
  constraint route_stop_items_source_check check (source in ('refill_recommendation', 'manual_admin_assignment'))
);

create index if not exists idx_route_stop_items_route_id on route_stop_items(route_id);
create index if not exists idx_route_stop_items_route_stop_id on route_stop_items(route_stop_id);
create index if not exists idx_route_stop_items_product_id on route_stop_items(product_id);

create table if not exists route_pick_list_items (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  planned_qty integer not null default 0,
  picked_qty integer not null default 0,
  action_type text not null default 'planned_pick',
  substituted_for_product_id uuid references products(id) on delete set null,
  reason text,
  notes text,
  needs_review boolean not null default false,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pick_list_items_action_check check (action_type in ('planned_pick', 'extra_product', 'substitution')),
  constraint route_pick_list_items_planned_qty_nonnegative check (planned_qty >= 0),
  constraint route_pick_list_items_picked_qty_nonnegative check (picked_qty >= 0)
);

create index if not exists idx_route_pick_list_items_route_id on route_pick_list_items(route_id);
create index if not exists idx_route_pick_list_items_product_id on route_pick_list_items(product_id);
create index if not exists idx_route_pick_list_items_needs_review on route_pick_list_items(needs_review);

alter table inventory_movements
add column if not exists related_route_stop_id uuid references route_stops(id) on delete set null;


-- ============================================================================
-- Source migration: supabase/migrations/202605160001_product_images.sql
-- ============================================================================

alter table products
  add column if not exists image_url text;


-- ============================================================================
-- Source migration: supabase/migrations/202605170001_product_image_candidates.sql
-- ============================================================================

-- Online product image candidates were generated into
-- docs/current-data/product_image_candidates.csv for manual review only.
-- The app should prefer local CSV images imported into Supabase Storage for speed.
select 1;


-- ============================================================================
-- Source migration: supabase/migrations/202605170002_clear_remote_candidate_product_images.sql
-- ============================================================================

update products
set image_url = null
where image_url like 'https://images.openfoodfacts.org/%';


-- ============================================================================
-- Source migration: supabase/migrations/202605170003_purchases_module.sql
-- ============================================================================

alter table purchase_orders
  add column if not exists receipt_number text,
  add column if not exists payment_method text not null default 'cash',
  add column if not exists receipt_url text,
  add column if not exists total_amount numeric(12,2) not null default 0,
  add column if not exists created_by uuid references team_members(id) on delete set null,
  add column if not exists received_by uuid references team_members(id) on delete set null,
  add column if not exists received_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table purchase_order_lines
  add column if not exists boxes_qty integer not null default 0,
  add column if not exists units_per_box integer not null default 1,
  add column if not exists loose_units_qty integer not null default 0,
  add column if not exists total_units integer not null default 0,
  add column if not exists line_total numeric(12,2) not null default 0,
  add column if not exists created_at timestamptz not null default now();

update purchase_order_lines
set
  total_units = greatest(total_units, ordered_qty, received_qty, 0),
  line_total = greatest(line_total, coalesce(nullif(total_units, 0), ordered_qty, received_qty, 0) * unit_cost, 0)
where total_units = 0 or line_total = 0;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_boxes_nonnegative check (boxes_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_units_per_box_positive check (units_per_box > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_loose_units_nonnegative check (loose_units_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_total_units_nonnegative check (total_units >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_line_total_nonnegative check (line_total >= 0);
exception when duplicate_object then null; end $$;

alter table inventory_movements
  add column if not exists related_purchase_id uuid references purchase_orders(id) on delete set null;

create unique index if not exists idx_inventory_movements_purchase_product_received
  on inventory_movements(related_purchase_id, product_id)
  where reason = 'purchase_received' and related_purchase_id is not null;

create index if not exists idx_purchase_orders_status_date on purchase_orders(status, order_date desc);
create index if not exists idx_purchase_order_lines_purchase on purchase_order_lines(purchase_order_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605170004_purchase_status_constraints.sql
-- ============================================================================

update purchase_orders
set status = 'draft'
where status not in ('draft', 'received', 'cancelled');

do $$ begin
  alter table purchase_orders add constraint purchase_orders_status_check check (status in ('draft', 'received', 'cancelled'));
exception when duplicate_object then null; end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605170005_purchase_line_costs.sql
-- ============================================================================

alter table purchase_order_lines
  add column if not exists unit_cost_lyd numeric(12,4) not null default 0,
  add column if not exists line_total_lyd numeric(12,2) not null default 0;

update purchase_order_lines
set
  unit_cost_lyd = coalesce(nullif(unit_cost_lyd, 0), unit_cost, 0),
  line_total_lyd = coalesce(nullif(line_total_lyd, 0), line_total, 0)
where unit_cost_lyd = 0 or line_total_lyd = 0;

alter table inventory_movements
  add column if not exists related_purchase_line_id uuid references purchase_order_lines(id) on delete set null,
  add column if not exists unit_cost_lyd numeric(12,4),
  add column if not exists line_total_lyd numeric(12,2);

drop index if exists idx_inventory_movements_purchase_product_received;

create unique index if not exists idx_inventory_movements_purchase_line_received
  on inventory_movements(related_purchase_line_id)
  where reason = 'purchase_received' and related_purchase_line_id is not null;

create index if not exists idx_inventory_movements_related_purchase on inventory_movements(related_purchase_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605170006_purchase_line_position.sql
-- ============================================================================

alter table purchase_order_lines
  add column if not exists line_position integer not null default 0;

with ranked as (
  select
    id,
    row_number() over (partition by purchase_order_id order by created_at, id) - 1 as position
  from purchase_order_lines
)
update purchase_order_lines pol
set line_position = ranked.position
from ranked
where pol.id = ranked.id
  and pol.line_position = 0;

create index if not exists idx_purchase_order_lines_position on purchase_order_lines(purchase_order_id, line_position);


-- ============================================================================
-- Source migration: supabase/migrations/202605170007_product_pricing_sources.sql
-- ============================================================================

alter table products
  add column if not exists current_cost_price_lyd numeric(12,4) not null default 0,
  add column if not exists current_selling_price_lyd numeric(12,2) not null default 0,
  add column if not exists last_purchase_cost_lyd numeric(12,4),
  add column if not exists average_cost_lyd numeric(12,4),
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists cost_price_source text not null default 'initial_import',
  add column if not exists selling_price_source text not null default 'initial_import',
  add column if not exists price_updated_at timestamptz;

update products
set
  current_cost_price_lyd = case when current_cost_price_lyd = 0 then cost_price else current_cost_price_lyd end,
  current_selling_price_lyd = case when current_selling_price_lyd = 0 then selling_price else current_selling_price_lyd end,
  cost_price_source = coalesce(nullif(cost_price_source, ''), 'initial_import'),
  selling_price_source = coalesce(nullif(selling_price_source, ''), 'initial_import');

do $$ begin
  alter table products add constraint products_cost_price_source_check check (cost_price_source in ('initial_import', 'latest_purchase', 'manual', 'vms', 'average_cost'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table products add constraint products_selling_price_source_check check (selling_price_source in ('initial_import', 'latest_purchase', 'manual', 'vms', 'average_cost'));
exception when duplicate_object then null; end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605170008_vms_product_price_sync.sql
-- ============================================================================

alter table vms_product_mappings
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists vms_cost_price_lyd numeric(12,4),
  add column if not exists latest_machine_id uuid references machines(id) on delete set null,
  add column if not exists latest_vms_machine_id text,
  add column if not exists latest_machine_name text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_import_batch_id uuid references vms_import_batches(id) on delete set null;

create index if not exists vms_product_mappings_last_seen_at_idx on vms_product_mappings(last_seen_at desc);
create index if not exists vms_product_mappings_latest_machine_id_idx on vms_product_mappings(latest_machine_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605170009_purchase_manual_totals.sql
-- ============================================================================

alter table purchase_orders
  add column if not exists manual_total_lyd numeric(12,2),
  add column if not exists calculated_total_lyd numeric(12,2) not null default 0,
  add column if not exists total_adjustment_lyd numeric(12,2),
  add column if not exists total_source text not null default 'calculated';

update purchase_orders
set
  calculated_total_lyd = case when calculated_total_lyd = 0 then coalesce(total_amount, 0) else calculated_total_lyd end,
  total_source = case when manual_total_lyd is null then 'calculated' else 'manual' end,
  total_adjustment_lyd = case when manual_total_lyd is null then null else manual_total_lyd - calculated_total_lyd end;

do $$
begin
  alter table purchase_orders add constraint purchase_orders_total_source_check check (total_source in ('calculated', 'manual'));
exception
  when duplicate_object then null;
end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605170010_inventory_movement_audit.sql
-- ============================================================================

alter type movement_reason add value if not exists 'manual_correction';
alter type movement_reason add value if not exists 'product_substitution';

alter table inventory_movements
  add column if not exists related_machine_id uuid references machines(id) on delete set null;

alter table inventory_movements
  add column if not exists movement_reason movement_reason generated always as (reason) stored;

create index if not exists idx_inventory_movements_reason_created on inventory_movements(reason, created_at desc);
create index if not exists idx_inventory_movements_created_by on inventory_movements(created_by);
create index if not exists idx_inventory_movements_related_route on inventory_movements(related_route_id);
create index if not exists idx_inventory_movements_related_route_stop on inventory_movements(related_route_stop_id);
create index if not exists idx_inventory_movements_related_machine on inventory_movements(related_machine_id);

create table if not exists system_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles(id) on delete set null,
  actor_team_member_id uuid references team_members(id) on delete set null,
  actor_name text,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb,
  ip_address text,
  user_agent text,
  summary text,
  created_at timestamptz not null default now()
);

alter table system_activity_logs
  add column if not exists actor_user_id uuid references profiles(id) on delete set null,
  add column if not exists actor_team_member_id uuid references team_members(id) on delete set null,
  add column if not exists actor_name text,
  add column if not exists actor_role text,
  add column if not exists entity_label text,
  add column if not exists before_data jsonb,
  add column if not exists after_data jsonb,
  add column if not exists metadata jsonb,
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists summary text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'system_activity_logs' and column_name = 'actor_id'
  ) then
    execute 'update system_activity_logs set actor_team_member_id = coalesce(actor_team_member_id, actor_id) where actor_team_member_id is null';
  end if;
end $$;

alter table system_activity_logs
  alter column metadata set default '{}'::jsonb;

update system_activity_logs set metadata = '{}'::jsonb where metadata is null;

create index if not exists idx_system_activity_logs_actor on system_activity_logs(actor_team_member_id, created_at desc);
create index if not exists idx_system_activity_logs_actor_user on system_activity_logs(actor_user_id, created_at desc);
create index if not exists idx_system_activity_logs_action on system_activity_logs(action, created_at desc);
create index if not exists idx_system_activity_logs_entity on system_activity_logs(entity_type, entity_id);
create index if not exists idx_system_activity_logs_created on system_activity_logs(created_at desc);

create or replace function log_inventory_movement_activity()
returns trigger as $$
begin
  insert into system_activity_logs (actor_team_member_id, action, entity_type, entity_id, entity_label, summary, after_data, metadata)
  values (
    new.created_by,
    'create',
    'inventory_movement',
    new.id,
    concat(new.reason::text, ' ', new.quantity::text),
    concat('Created ', new.reason::text, ' movement for ', new.quantity::text, ' units'),
    to_jsonb(new),
    jsonb_build_object(
      'product_id', new.product_id,
      'quantity', new.quantity,
      'from_entity_type', new.from_entity_type,
      'from_entity_id', new.from_entity_id,
      'to_entity_type', new.to_entity_type,
      'to_entity_id', new.to_entity_id,
      'movement_reason', new.reason,
      'related_route_id', new.related_route_id,
      'related_route_stop_id', new.related_route_stop_id,
      'related_purchase_id', new.related_purchase_id,
      'related_purchase_line_id', new.related_purchase_line_id,
      'related_machine_id', new.related_machine_id
    )
  );

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_log_inventory_movement_activity on inventory_movements;
create trigger trg_log_inventory_movement_activity
after insert on inventory_movements
for each row execute function log_inventory_movement_activity();


-- ============================================================================
-- Source migration: supabase/migrations/202605170011_system_activity_logs_actor_columns.sql
-- ============================================================================

create table if not exists system_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles(id) on delete set null,
  actor_team_member_id uuid references team_members(id) on delete set null,
  actor_name text,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb default '{}'::jsonb,
  ip_address text,
  user_agent text,
  summary text,
  created_at timestamptz not null default now()
);

alter table system_activity_logs
  add column if not exists actor_user_id uuid references profiles(id) on delete set null,
  add column if not exists actor_team_member_id uuid references team_members(id) on delete set null,
  add column if not exists actor_name text,
  add column if not exists actor_role text,
  add column if not exists entity_label text,
  add column if not exists before_data jsonb,
  add column if not exists after_data jsonb,
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists summary text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'system_activity_logs'
      and column_name = 'actor_id'
  ) then
    execute 'update system_activity_logs set actor_team_member_id = coalesce(actor_team_member_id, actor_id) where actor_team_member_id is null';
  end if;
end $$;

update system_activity_logs
set metadata = '{}'::jsonb
where metadata is null;

create index if not exists idx_system_activity_logs_actor_team_member
  on system_activity_logs(actor_team_member_id, created_at desc);

create index if not exists idx_system_activity_logs_actor_user
  on system_activity_logs(actor_user_id, created_at desc);

create index if not exists idx_system_activity_logs_actor_role
  on system_activity_logs(actor_role, created_at desc);

create index if not exists idx_system_activity_logs_action
  on system_activity_logs(action, created_at desc);

create index if not exists idx_system_activity_logs_entity
  on system_activity_logs(entity_type, entity_id);

create index if not exists idx_system_activity_logs_created
  on system_activity_logs(created_at desc);


-- ============================================================================
-- Source migration: supabase/migrations/202605170012_financial_transactions.sql
-- ============================================================================

create table if not exists financial_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_date date not null,
  direction text not null check (direction in ('money_in', 'money_out')),
  transaction_kind text not null default 'manual' check (transaction_kind in ('spreadsheet_import', 'manual_money_in', 'manual_money_out', 'product_purchase', 'cash_collection')),
  transaction_type text,
  location text,
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  signed_amount numeric(12,2) not null,
  bucket text,
  bucket_override text,
  final_bucket text,
  review_status text not null default 'confirmed' check (review_status in ('confirmed', 'needs_review', 'reviewed')),
  needs_review boolean not null default false,
  source_sheet text,
  source_row integer,
  related_purchase_id uuid references purchase_orders(id) on delete set null,
  related_cash_collection_id uuid references cash_collections(id) on delete set null,
  created_by uuid references team_members(id) on delete set null,
  reviewed_by uuid references team_members(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_signed_direction check (
    (direction = 'money_in' and signed_amount >= 0)
    or (direction = 'money_out' and signed_amount <= 0)
  )
);

create unique index if not exists idx_financial_transactions_source
  on financial_transactions(source_sheet, source_row)
  where source_sheet is not null and source_row is not null;

create unique index if not exists idx_financial_transactions_purchase
  on financial_transactions(related_purchase_id)
  where related_purchase_id is not null and transaction_kind = 'product_purchase';

create unique index if not exists idx_financial_transactions_cash_collection
  on financial_transactions(related_cash_collection_id)
  where related_cash_collection_id is not null and transaction_kind = 'cash_collection';

create index if not exists idx_financial_transactions_date
  on financial_transactions(transaction_date desc);

create index if not exists idx_financial_transactions_review
  on financial_transactions(needs_review, review_status, transaction_date desc);

create index if not exists idx_financial_transactions_kind
  on financial_transactions(transaction_kind, transaction_date desc);


-- ============================================================================
-- Source migration: supabase/migrations/202605170013_finance_settings.sql
-- ============================================================================

create table if not exists finance_settings (
  id text primary key default 'default',
  opening_balance numeric(12,2),
  opening_balance_date date,
  default_currency text not null default 'LYD',
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_settings_singleton check (id = 'default'),
  constraint finance_settings_currency_not_blank check (length(trim(default_currency)) between 2 and 8)
);

create index if not exists idx_finance_settings_updated_at
  on finance_settings(updated_at desc);


-- ============================================================================
-- Source migration: supabase/migrations/202605170014_finance_import_flow.sql
-- ============================================================================

alter table financial_transactions
  add column if not exists import_status text check (import_status in ('imported', 'needs_review', 'skipped')),
  add column if not exists source_file text,
  add column if not exists original_description text,
  add column if not exists import_notes text;

update financial_transactions
set
  import_status = coalesce(import_status, case when needs_review then 'needs_review' else 'imported' end),
  source_file = coalesce(source_file, 'docs/current-data/financial_transactions.csv'),
  original_description = coalesce(original_description, description)
where transaction_kind = 'spreadsheet_import';

create index if not exists idx_financial_transactions_import_status
  on financial_transactions(import_status, source_file, source_sheet, source_row);

create table if not exists finance_import_rows (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  source_sheet text not null,
  source_row integer not null,
  import_status text not null check (import_status in ('imported', 'needs_review', 'skipped')),
  transaction_date date,
  raw_date text,
  amount numeric(12,2),
  signed_amount numeric(12,2),
  raw_amount text,
  direction text check (direction in ('money_in', 'money_out')),
  raw_direction text,
  category text,
  raw_category text,
  original_description text,
  review_reason text,
  financial_transaction_id uuid references financial_transactions(id) on delete set null,
  raw_record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_file, source_sheet, source_row)
);

create index if not exists idx_finance_import_rows_status
  on finance_import_rows(import_status, source_file, source_sheet, source_row);


-- ============================================================================
-- Source migration: supabase/migrations/202605170015_finance_transaction_status_relations.sql
-- ============================================================================

alter table financial_transactions
  add column if not exists transaction_status text not null default 'active' check (transaction_status in ('active', 'voided', 'archived')),
  add column if not exists payment_method text,
  add column if not exists notes text,
  add column if not exists related_route_id uuid references routes(id) on delete set null,
  add column if not exists related_machine_id uuid references machines(id) on delete set null,
  add column if not exists related_location_id uuid references locations(id) on delete set null,
  add column if not exists receipt_url text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references team_members(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references team_members(id) on delete set null,
  add column if not exists status_reason text;

update financial_transactions
set transaction_status = 'active'
where transaction_status is null;

create index if not exists idx_financial_transactions_status_date
  on financial_transactions(transaction_status, transaction_date desc);

create index if not exists idx_financial_transactions_related_refs
  on financial_transactions(related_purchase_id, related_route_id, related_machine_id, related_location_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605170016_vms_excel_import_flow.sql
-- ============================================================================

alter table vms_import_batches
  add column if not exists file_type text,
  add column if not exists sheet_name text,
  add column if not exists report_type text,
  add column if not exists rows_imported integer default 0,
  add column if not exists rows_skipped integer default 0,
  add column if not exists errors jsonb not null default '[]'::jsonb,
  add column if not exists unknown_machines jsonb not null default '[]'::jsonb,
  add column if not exists unmapped_products jsonb not null default '[]'::jsonb,
  add column if not exists column_mapping jsonb not null default '{}'::jsonb;

create table if not exists vms_import_previews (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_type text not null,
  report_type text not null,
  sheets jsonb not null default '[]'::jsonb,
  uploaded_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_import_previews_created_at
  on vms_import_previews(created_at desc);

alter table machines
  add column if not exists vms_online_status text,
  add column if not exists vms_temperature_c numeric(8,2),
  add column if not exists vms_cash_balance_lyd numeric(12,2),
  add column if not exists vms_empty_trays integer,
  add column if not exists last_vms_status_at timestamptz;

alter table vms_stock_snapshots
  add column if not exists temperature_c numeric(8,2),
  add column if not exists cash_balance_lyd numeric(12,2),
  add column if not exists tray_status text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table vms_sales_snapshots
  add column if not exists cost_amount numeric(12,2),
  add column if not exists profit_amount numeric(12,2),
  add column if not exists metadata jsonb not null default '{}'::jsonb;


-- ============================================================================
-- Source migration: supabase/migrations/202605180001_vms_import_wizard.sql
-- ============================================================================

alter table vms_import_previews
  add column if not exists file_size_bytes bigint;


-- ============================================================================
-- Source migration: supabase/migrations/202605180002_vms_import_raw_rows_reprocess.sql
-- ============================================================================

alter table vms_import_batches
  add column if not exists last_reprocessed_at timestamptz,
  add column if not exists reprocess_count integer not null default 0;

create table if not exists vms_import_raw_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references vms_import_batches(id) on delete cascade,
  source_row_number integer not null,
  original_row jsonb not null default '{}'::jsonb,
  mapped_row jsonb not null default '{}'::jsonb,
  row_status text not null default 'pending',
  row_reasons jsonb not null default '[]'::jsonb,
  vms_machine_identifier text,
  vms_product_id text,
  vms_product_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(import_batch_id, source_row_number),
  constraint vms_import_raw_rows_status_check check (
    row_status in ('pending', 'imported', 'needs_mapping', 'unknown_machine', 'invalid_row', 'skipped')
  )
);

create index if not exists idx_vms_import_raw_rows_batch
  on vms_import_raw_rows(import_batch_id, source_row_number);

create index if not exists idx_vms_import_raw_rows_status
  on vms_import_raw_rows(row_status);


-- ============================================================================
-- Source migration: supabase/migrations/202605180003_vms_import_rows_canonical.sql
-- ============================================================================

create table if not exists vms_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references vms_import_batches(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  validation_status text not null default 'pending',
  validation_errors jsonb not null default '[]'::jsonb,
  machine_match_status text,
  product_match_status text,
  matched_machine_id uuid references machines(id) on delete set null,
  matched_product_id uuid references products(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(import_batch_id, row_number),
  constraint vms_import_rows_validation_status_check check (
    validation_status in ('pending', 'imported', 'needs_mapping', 'unknown_machine', 'invalid_row', 'skipped')
  )
);

create index if not exists idx_vms_import_rows_batch
  on vms_import_rows(import_batch_id, row_number);

create index if not exists idx_vms_import_rows_validation_status
  on vms_import_rows(validation_status);

create index if not exists idx_vms_import_rows_product_match_status
  on vms_import_rows(product_match_status);

insert into vms_import_rows (
  import_batch_id,
  row_number,
  raw_data,
  normalized_data,
  validation_status,
  validation_errors,
  machine_match_status,
  product_match_status,
  created_at
)
select
  import_batch_id,
  source_row_number,
  original_row,
  mapped_row,
  row_status,
  row_reasons,
  case
    when row_status = 'unknown_machine' then 'unknown'
    when vms_machine_identifier is null then null
    else 'matched'
  end,
  case
    when row_status = 'needs_mapping' then 'needs_mapping'
    when vms_product_id is null and vms_product_name is null then null
    else 'matched'
  end,
  created_at
from vms_import_raw_rows
on conflict (import_batch_id, row_number) do nothing;


-- ============================================================================
-- Source migration: supabase/migrations/202605180004_vms_product_catalog_source.sql
-- ============================================================================

alter table products
  add column if not exists import_source text not null default 'initial_import',
  add column if not exists last_vms_import_batch_id uuid references vms_import_batches(id) on delete set null,
  add column if not exists last_vms_seen_at timestamptz;

create index if not exists products_import_source_idx on products(import_source);
create index if not exists products_last_vms_seen_at_idx on products(last_vms_seen_at desc);


-- ============================================================================
-- Source migration: supabase/migrations/202605180005_product_source_badges_defaults.sql
-- ============================================================================

alter table products
  alter column import_source set default 'initial_import';

update products
set import_source = 'initial_import'
where import_source = 'manual'
  and last_vms_import_batch_id is null
  and last_vms_seen_at is null;


-- ============================================================================
-- Source migration: supabase/migrations/202605180006_purchase_payment_status.sql
-- ============================================================================

alter table purchase_orders
  add column if not exists payment_status text not null default 'paid';

update purchase_orders
set payment_status = 'paid'
where payment_status is null
  or payment_status not in ('paid', 'unpaid', 'partial');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_orders_payment_status_check'
  ) then
    alter table purchase_orders
      add constraint purchase_orders_payment_status_check
      check (payment_status in ('paid', 'unpaid', 'partial'));
  end if;
end $$;

create index if not exists idx_purchase_orders_payment_status
  on purchase_orders(payment_status, order_date desc);


-- ============================================================================
-- Source migration: supabase/migrations/202605190001_storage_buckets_policies.sql
-- ============================================================================

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage schema is not available; skipping Snacky OS storage bucket setup.';
    return;
  end if;

  execute $sql$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values
      ('product-images', 'product-images', true, 5242880, array['image/png', 'image/jpeg', 'image/webp']),
      ('receipt-images', 'receipt-images', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
      ('machine-photos', 'machine-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp']),
      ('refill-photos', 'refill-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp']),
      ('issue-photos', 'issue-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      updated_at = now()
  $sql$;

  -- Supabase owns storage.objects and manages its RLS setting.
  -- Keep this migration to bucket upserts and policy definitions so it can run in hosted projects.
end $$;

create or replace function public.snacky_storage_has_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and p.role::text = any(allowed_roles)
  );
$$;

create or replace function public.snacky_storage_route_id(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
    else null
  end;
$$;

create or replace function public.snacky_storage_can_access_route(route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.routes r on r.id = route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.role::text in ('owner', 'admin', 'supervisor')
        or (p.role::text = 'operator' and p.team_member_id is not null and r.operator_id = p.team_member_id)
      )
  );
$$;

grant execute on function public.snacky_storage_has_role(text[]) to authenticated;
grant execute on function public.snacky_storage_route_id(text) to authenticated;
grant execute on function public.snacky_storage_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage objects table is not available; skipping Snacky OS storage policies.';
    return;
  end if;

  execute 'drop policy if exists "snacky_product_images_public_read" on storage.objects';
  execute 'drop policy if exists "snacky_product_images_owner_admin_upload" on storage.objects';
  execute 'drop policy if exists "snacky_product_images_owner_admin_update" on storage.objects';
  execute 'drop policy if exists "snacky_product_images_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_receipt_images_role_read" on storage.objects';
  execute 'drop policy if exists "snacky_receipt_images_owner_admin_upload" on storage.objects';
  execute 'drop policy if exists "snacky_receipt_images_owner_admin_update" on storage.objects';
  execute 'drop policy if exists "snacky_receipt_images_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_machine_photos_authenticated_read" on storage.objects';
  execute 'drop policy if exists "snacky_machine_photos_owner_admin_upload" on storage.objects';
  execute 'drop policy if exists "snacky_machine_photos_owner_admin_update" on storage.objects';
  execute 'drop policy if exists "snacky_machine_photos_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_refill_photos_route_read" on storage.objects';
  execute 'drop policy if exists "snacky_refill_photos_assigned_route_upload" on storage.objects';
  execute 'drop policy if exists "snacky_refill_photos_assigned_route_update" on storage.objects';
  execute 'drop policy if exists "snacky_refill_photos_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_issue_photos_route_read" on storage.objects';
  execute 'drop policy if exists "snacky_issue_photos_assigned_route_upload" on storage.objects';
  execute 'drop policy if exists "snacky_issue_photos_assigned_route_update" on storage.objects';
  execute 'drop policy if exists "snacky_issue_photos_owner_admin_delete" on storage.objects';

  execute $sql$
    create policy "snacky_product_images_public_read"
    on storage.objects for select
    to public
    using (bucket_id = 'product-images')
  $sql$;

  execute $sql$
    create policy "snacky_product_images_owner_admin_upload"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_product_images_owner_admin_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
    with check (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_product_images_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_role_read"
    on storage.objects for select
    to authenticated
    using (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin', 'supervisor', 'warehouse', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_owner_admin_upload"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_owner_admin_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
    with check (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_authenticated_read"
    on storage.objects for select
    to authenticated
    using (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin', 'supervisor', 'operator', 'warehouse', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_owner_admin_upload"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_owner_admin_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
    with check (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_route_read"
    on storage.objects for select
    to authenticated
    using (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_assigned_route_upload"
    on storage.objects for insert
    to authenticated
    with check (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_assigned_route_update"
    on storage.objects for update
    to authenticated
    using (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
    with check (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'refill-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_route_read"
    on storage.objects for select
    to authenticated
    using (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_assigned_route_upload"
    on storage.objects for insert
    to authenticated
    with check (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_assigned_route_update"
    on storage.objects for update
    to authenticated
    using (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
    with check (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'issue-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;
end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605190002_auth_profile_self_read_policies.sql
-- ============================================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise notice 'profiles table is not available; skipping self-read policy setup.';
    return;
  end if;

  execute 'drop policy if exists "snacky_profiles_self_read" on public.profiles';

  execute $sql$
    create policy "snacky_profiles_self_read"
    on public.profiles for select
    to authenticated
    using (id = auth.uid())
  $sql$;
end $$;

do $$
begin
  if to_regclass('public.team_members') is null then
    raise notice 'team_members table is not available; skipping self-read policy setup.';
    return;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'team_members'
      and column_name = 'auth_user_id'
  ) then
    raise notice 'team_members.auth_user_id is not available; skipping team member self-read policy setup.';
    return;
  end if;

  execute 'drop policy if exists "snacky_team_members_self_read" on public.team_members';

  execute $sql$
    create policy "snacky_team_members_self_read"
    on public.team_members for select
    to authenticated
    using (auth_user_id = auth.uid())
  $sql$;
end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605190003_vms_stock_refill_recommendations.sql
-- ============================================================================

alter table refill_order_lines
  add column if not exists slot_code text;

alter table route_stop_items
  add column if not exists slot_code text;

create index if not exists idx_vms_stock_machine_product_captured
  on vms_stock_snapshots(machine_id, product_id, captured_at desc);

create or replace view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vss.machine_id,
    nullif(btrim(vss.slot_code), '') as slot_code,
    vss.product_id,
    nullif(btrim(vss.vms_product_id), '') as vms_product_id,
    nullif(btrim(vss.vms_product_name), '') as vms_product_name,
    vss.current_qty,
    vss.capacity,
    vss.captured_at,
    vss.created_at,
    nullif(btrim(vss.tray_status), '') as tray_status,
    coalesce(
      nullif(btrim(vss.slot_code), ''),
      vss.product_id::text,
      nullif(btrim(vss.vms_product_id), ''),
      nullif(btrim(vss.vms_product_name), ''),
      vss.id::text
    ) as stock_item_key
  from vms_stock_snapshots vss
  where vss.machine_id is not null
),
ranked as (
  select
    normalized.*,
    dense_rank() over (
      partition by machine_id, stock_item_key
      order by captured_at desc, import_batch_id desc nulls last
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
  stock_item_key
from latest
group by machine_id, stock_item_key;

create or replace view refill_recommendations as
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


-- ============================================================================
-- Source migration: supabase/migrations/202605190004_refill_recommendation_source_priority.sql
-- ============================================================================

create or replace view refill_recommendations as
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
    ms.slot_code
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
),
vms_recommendations as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.machine_slot_id,
    coalesce(v.slot_code, ms.slot_code, 'VMS') as slot_code,
    p.id as product_id,
    p.name as product_name,
    v.current_qty,
    null::integer as min_qty,
    v.capacity::integer as par_qty,
    case
      when v.capacity is not null then greatest(v.capacity - v.current_qty, 0)::integer
      else null::integer
    end as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    case
      when v.capacity is not null then least(greatest(v.capacity - v.current_qty, 0), coalesce(ss.available_storage_qty, 0))::integer
      else null::integer
    end as final_qty_to_take,
    case
      when v.current_qty <= 0
        or (
          v.normalized_tray_status not like '%not empty%'
          and v.normalized_tray_status not like '%not out%'
          and (
            v.normalized_tray_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
            or v.normalized_tray_status like '%out of stock%'
            or v.normalized_tray_status like '%sold out%'
            or v.normalized_tray_status like '%empty%'
          )
        )
      then 'critical'
      when v.capacity is not null and v.current_qty < v.capacity then 'medium'
      else 'none'
    end as priority,
    v.captured_at as latest_vms_at,
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
    and (
      (v.capacity is not null and greatest(v.capacity - v.current_qty, 0) > 0)
      or (
        v.capacity is null
        and (
          v.current_qty <= 0
          or (
            v.normalized_tray_status not like '%not empty%'
            and v.normalized_tray_status not like '%not out%'
            and (
              v.normalized_tray_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
              or v.normalized_tray_status like '%out of stock%'
              or v.normalized_tray_status like '%sold out%'
              or v.normalized_tray_status like '%empty%'
            )
          )
        )
      )
    )
),
planogram_fallback as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.id as machine_slot_id,
    ms.slot_code,
    p.id as product_id,
    p.name as product_name,
    0::integer as current_qty,
    ms.min_qty,
    ms.par_qty,
    ms.par_qty::integer as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    least(ms.par_qty, coalesce(ss.available_storage_qty, 0))::integer as final_qty_to_take,
    'critical'::text as priority,
    null::timestamptz as latest_vms_at,
    md5(concat_ws('|', 'manual_planogram', ms.id::text)) as recommendation_key,
    null::uuid as vms_stock_snapshot_id,
    'manual_planogram_fallback'::text as recommendation_source,
    ms.capacity::integer as capacity,
    null::text as tray_status
  from machine_slots ms
  join machines m on m.id = ms.machine_id
  join products p on p.id = ms.product_id
  left join storage_stock ss on ss.product_id = p.id
  where ms.active = true
    and m.status = 'active'
    and not exists (
      select 1
      from latest_vms_stock_by_slot v
      where v.machine_id = ms.machine_id
    )
    and ms.par_qty > 0
)
select * from vms_recommendations
union all
select * from planogram_fallback;


-- ============================================================================
-- Source migration: supabase/migrations/202605190005_refill_capacity_thresholds.sql
-- ============================================================================

create or replace view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
    vss.machine_id,
    nullif(btrim(vss.slot_code), '') as slot_code,
    vss.product_id,
    nullif(btrim(vss.vms_product_id), '') as vms_product_id,
    nullif(btrim(vss.vms_product_name), '') as vms_product_name,
    vss.current_qty,
    vss.capacity,
    vss.captured_at,
    vss.created_at,
    nullif(btrim(vss.tray_status), '') as tray_status,
    coalesce(
      nullif(btrim(vss.slot_code), ''),
      vss.product_id::text,
      nullif(btrim(vss.vms_product_id), ''),
      nullif(btrim(vss.vms_product_name), ''),
      vss.id::text
    ) as stock_item_key
  from vms_stock_snapshots vss
  left join vms_import_batches vib on vib.id = vss.import_batch_id
  where vss.machine_id is not null
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
  max(batch_imported_at) as imported_at
from latest
group by machine_id, stock_item_key;

create or replace view refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    lvs.id,
    lvs.machine_id,
    lvs.slot_code,
    coalesce(lvs.product_id, mapped.product_id) as product_id,
    lvs.vms_product_id,
    lvs.vms_product_name,
    lvs.current_qty,
    lvs.capacity,
    lvs.captured_at,
    lvs.tray_status,
    lvs.stock_item_key,
    lvs.import_batch_id,
    lvs.imported_at,
    lower(coalesce(lvs.tray_status, '')) as normalized_status
  from latest_vms_stock_by_slot lvs
  left join lateral (
    select vpm.product_id
    from vms_product_mappings vpm
    where vpm.product_id is not null
      and vpm.match_status = 'confirmed'
      and (
        (
          lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
        or (
          lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        )
        or (
          lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
      )
    order by
      case
        when lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        then 0
        when lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        then 1
        else 2
      end,
      vpm.updated_at desc
    limit 1
  ) mapped on true
  where coalesce(lvs.product_id, mapped.product_id) is not null
),
vms_scored as (
  select
    vms_stock.*,
    (
      current_qty <= 0
      or (
        normalized_status not like '%not empty%'
        and normalized_status not like '%not out%'
        and (
          normalized_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
          or normalized_status like '%out of stock%'
          or normalized_status like '%sold out%'
          or normalized_status like '%empty%'
        )
      )
    ) as out_of_stock
  from vms_stock
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code
  from vms_scored v
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
),
vms_recommendations as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.machine_slot_id,
    coalesce(v.slot_code, ms.slot_code, 'VMS') as slot_code,
    p.id as product_id,
    p.name as product_name,
    v.current_qty,
    null::integer as min_qty,
    v.capacity::integer as par_qty,
    case
      when v.capacity is not null then greatest(v.capacity - v.current_qty, 0)::integer
      else null::integer
    end as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    case
      when v.capacity is not null then least(greatest(v.capacity - v.current_qty, 0), coalesce(ss.available_storage_qty, 0))::integer
      else null::integer
    end as final_qty_to_take,
    case
      when v.out_of_stock then 'critical'
      when v.capacity is not null and v.current_qty <= v.capacity * 0.25 then 'high'
      when v.capacity is not null and v.current_qty <= v.capacity * 0.50 then 'medium'
      else 'low'
    end as priority,
    v.captured_at as latest_vms_at,
    md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
    v.id as vms_stock_snapshot_id,
    'vms_stock'::text as recommendation_source,
    v.capacity::integer as capacity,
    v.tray_status,
    v.import_batch_id,
    v.imported_at
  from vms_scored v
  join machines m on m.id = v.machine_id
  join products p on p.id = v.product_id
  left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
  left join storage_stock ss on ss.product_id = p.id
  where m.status = 'active'
    and (
      (v.capacity is not null and greatest(v.capacity - v.current_qty, 0) > 0)
      or v.out_of_stock
    )
),
planogram_fallback as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.id as machine_slot_id,
    ms.slot_code,
    p.id as product_id,
    p.name as product_name,
    0::integer as current_qty,
    ms.min_qty,
    ms.par_qty,
    ms.par_qty::integer as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    least(ms.par_qty, coalesce(ss.available_storage_qty, 0))::integer as final_qty_to_take,
    'critical'::text as priority,
    null::timestamptz as latest_vms_at,
    md5(concat_ws('|', 'manual_planogram', ms.id::text)) as recommendation_key,
    null::uuid as vms_stock_snapshot_id,
    'manual_planogram_fallback'::text as recommendation_source,
    ms.capacity::integer as capacity,
    null::text as tray_status,
    null::uuid as import_batch_id,
    null::timestamptz as imported_at
  from machine_slots ms
  join machines m on m.id = ms.machine_id
  join products p on p.id = ms.product_id
  left join storage_stock ss on ss.product_id = p.id
  where ms.active = true
    and m.status = 'active'
    and not exists (
      select 1
      from latest_vms_stock_by_slot v
      where v.machine_id = ms.machine_id
    )
    and ms.par_qty > 0
)
select * from vms_recommendations
union all
select * from planogram_fallback;


-- ============================================================================
-- Source migration: supabase/migrations/202605200001_storage_locations_metadata.sql
-- ============================================================================

alter table storage_locations
  add column if not exists location_type text not null default 'main_storage',
  add column if not exists related_operator_id uuid references team_members(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

update storage_locations
set location_type = 'main_storage'
where location_type is null
  or location_type = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'storage_locations_location_type_check'
  ) then
    alter table storage_locations
      add constraint storage_locations_location_type_check
      check (location_type in ('main_storage', 'operator_bag', 'vehicle', 'damaged', 'expired', 'temporary', 'other'));
  end if;
end $$;

create index if not exists idx_storage_locations_location_type on storage_locations(location_type);
create index if not exists idx_storage_locations_related_operator on storage_locations(related_operator_id);
create index if not exists idx_storage_locations_active_type on storage_locations(active, location_type);



-- ============================================================================
-- Source migration: supabase/migrations/202605200002_safe_action_metadata.sql
-- ============================================================================

alter table purchase_orders
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references team_members(id) on delete set null,
  add column if not exists void_reason text;

alter table purchase_orders
  drop constraint if exists purchase_orders_status_check;

alter table purchase_orders
  add constraint purchase_orders_status_check check (status in ('draft', 'received', 'cancelled', 'voided'));

alter table inventory_movements
  add column if not exists reversed_movement_id uuid references inventory_movements(id) on delete set null,
  add column if not exists correction_reason text;

create index if not exists idx_inventory_movements_reversed_movement
  on inventory_movements(reversed_movement_id);

alter table routes
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references team_members(id) on delete set null,
  add column if not exists cancellation_reason text;

create index if not exists idx_routes_cancelled_at
  on routes(cancelled_at desc)
  where cancelled_at is not null;


-- ============================================================================
-- Source migration: supabase/migrations/202605200003_cash_operations_milestone.sql
-- ============================================================================

alter type movement_reason add value if not exists 'opening_balance';

alter table cash_collections
  add column if not exists cash_bag_id text,
  add column if not exists counted_at timestamptz,
  add column if not exists counted_by uuid references team_members(id) on delete set null,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references team_members(id) on delete set null,
  add column if not exists void_reason text,
  alter column vms_expected_cash drop not null,
  alter column vms_expected_cash drop default,
  alter column actual_cash_collected drop not null,
  alter column actual_cash_collected drop default;

update cash_collections
set review_status = case
  when review_status in ('resolved', 'ok') then 'counted_confirmed'
  when review_status in ('needs_review', 'review_required') then 'variance_review'
  when review_status in ('pending', 'pending_collection') then 'pending_collection'
  else 'pending_collection'
end
where review_status is null
   or review_status not in ('pending_collection', 'collected_pending_count', 'counted_confirmed', 'variance_review', 'voided');

alter table cash_collections
  drop constraint if exists cash_collections_review_status_check;

alter table cash_collections
  add constraint cash_collections_review_status_check
  check (review_status in ('pending_collection', 'collected_pending_count', 'counted_confirmed', 'variance_review', 'voided'));

update purchase_orders
set payment_status = 'partially_paid'
where payment_status = 'partial';

alter table purchase_orders
  drop constraint if exists purchase_orders_payment_status_check;

alter table purchase_orders
  add constraint purchase_orders_payment_status_check
  check (payment_status in ('unpaid', 'paid', 'partially_paid', 'voided'));

create index if not exists idx_cash_collections_status_date
  on cash_collections(review_status, collected_at desc);

create index if not exists idx_cash_collections_machine_date
  on cash_collections(machine_id, collected_at desc);

create index if not exists idx_cash_collections_operator_date
  on cash_collections(operator_id, collected_at desc);


-- ============================================================================
-- Source migration: supabase/migrations/202605200004_vms_reprocess_snapshot_keys.sql
-- ============================================================================

alter table vms_stock_snapshots
  add column if not exists import_row_number integer,
  add column if not exists import_row_status text not null default 'imported';

alter table vms_stock_snapshots
  drop constraint if exists vms_stock_snapshots_import_row_status_check;

alter table vms_stock_snapshots
  add constraint vms_stock_snapshots_import_row_status_check
  check (import_row_status in ('imported', 'reprocessed_stale'));

alter table vms_sales_snapshots
  add column if not exists import_row_number integer,
  add column if not exists import_row_status text not null default 'imported';

alter table vms_sales_snapshots
  drop constraint if exists vms_sales_snapshots_import_row_status_check;

alter table vms_sales_snapshots
  add constraint vms_sales_snapshots_import_row_status_check
  check (import_row_status in ('imported', 'reprocessed_stale'));

create unique index if not exists idx_vms_stock_snapshots_batch_row
  on vms_stock_snapshots(import_batch_id, import_row_number);

create unique index if not exists idx_vms_sales_snapshots_batch_row
  on vms_sales_snapshots(import_batch_id, import_row_number);

create index if not exists idx_vms_stock_snapshots_import_row_status
  on vms_stock_snapshots(import_row_status);

create index if not exists idx_vms_sales_snapshots_import_row_status
  on vms_sales_snapshots(import_row_status);

create or replace view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
    vss.machine_id,
    nullif(btrim(vss.slot_code), '') as slot_code,
    vss.product_id,
    nullif(btrim(vss.vms_product_id), '') as vms_product_id,
    nullif(btrim(vss.vms_product_name), '') as vms_product_name,
    vss.current_qty,
    vss.capacity,
    vss.captured_at,
    vss.created_at,
    nullif(btrim(vss.tray_status), '') as tray_status,
    coalesce(
      nullif(btrim(vss.slot_code), ''),
      vss.product_id::text,
      nullif(btrim(vss.vms_product_id), ''),
      nullif(btrim(vss.vms_product_name), ''),
      vss.id::text
    ) as stock_item_key
  from vms_stock_snapshots vss
  left join vms_import_batches vib on vib.id = vss.import_batch_id
  where vss.machine_id is not null
    and vss.import_row_status = 'imported'
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
  max(batch_imported_at) as imported_at
from latest
group by machine_id, stock_item_key;

create or replace view refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    lvs.id,
    lvs.machine_id,
    lvs.slot_code,
    coalesce(lvs.product_id, mapped.product_id) as product_id,
    lvs.vms_product_id,
    lvs.vms_product_name,
    lvs.current_qty,
    lvs.capacity,
    lvs.captured_at,
    lvs.tray_status,
    lvs.stock_item_key,
    lvs.import_batch_id,
    lvs.imported_at,
    lower(coalesce(lvs.tray_status, '')) as normalized_status
  from latest_vms_stock_by_slot lvs
  left join lateral (
    select vpm.product_id
    from vms_product_mappings vpm
    where vpm.product_id is not null
      and vpm.match_status = 'confirmed'
      and (
        (
          lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
        or (
          lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        )
        or (
          lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
      )
    order by
      case
        when lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        then 0
        when lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        then 1
        else 2
      end,
      vpm.updated_at desc
    limit 1
  ) mapped on true
  where coalesce(lvs.product_id, mapped.product_id) is not null
),
vms_scored as (
  select
    vms_stock.*,
    (
      current_qty <= 0
      or (
        normalized_status not like '%not empty%'
        and normalized_status not like '%not out%'
        and (
          normalized_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
          or normalized_status like '%out of stock%'
          or normalized_status like '%sold out%'
          or normalized_status like '%empty%'
        )
      )
    ) as out_of_stock
  from vms_stock
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code
  from vms_scored v
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
),
vms_recommendations as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.machine_slot_id,
    coalesce(v.slot_code, ms.slot_code, 'VMS') as slot_code,
    p.id as product_id,
    p.name as product_name,
    v.current_qty,
    null::integer as min_qty,
    v.capacity::integer as par_qty,
    case
      when v.capacity is not null then greatest(v.capacity - v.current_qty, 0)::integer
      else null::integer
    end as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    case
      when v.capacity is not null then least(greatest(v.capacity - v.current_qty, 0), coalesce(ss.available_storage_qty, 0))::integer
      else null::integer
    end as final_qty_to_take,
    case
      when v.out_of_stock then 'critical'
      when v.capacity is not null and v.current_qty <= v.capacity * 0.25 then 'high'
      when v.capacity is not null and v.current_qty <= v.capacity * 0.50 then 'medium'
      else 'low'
    end as priority,
    v.captured_at as latest_vms_at,
    md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
    v.id as vms_stock_snapshot_id,
    'vms_stock'::text as recommendation_source,
    v.capacity::integer as capacity,
    v.tray_status,
    v.import_batch_id,
    v.imported_at
  from vms_scored v
  join machines m on m.id = v.machine_id
  join products p on p.id = v.product_id
  left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
  left join storage_stock ss on ss.product_id = p.id
  where m.status = 'active'
    and (
      (v.capacity is not null and greatest(v.capacity - v.current_qty, 0) > 0)
      or v.out_of_stock
    )
),
planogram_fallback as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.id as machine_slot_id,
    ms.slot_code,
    p.id as product_id,
    p.name as product_name,
    0::integer as current_qty,
    ms.min_qty,
    ms.par_qty,
    ms.par_qty::integer as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    least(ms.par_qty, coalesce(ss.available_storage_qty, 0))::integer as final_qty_to_take,
    'critical'::text as priority,
    null::timestamptz as latest_vms_at,
    md5(concat_ws('|', 'manual_planogram', ms.id::text)) as recommendation_key,
    null::uuid as vms_stock_snapshot_id,
    'manual_planogram_fallback'::text as recommendation_source,
    ms.capacity::integer as capacity,
    null::text as tray_status,
    null::uuid as import_batch_id,
    null::timestamptz as imported_at
  from machine_slots ms
  join machines m on m.id = ms.machine_id
  join products p on p.id = ms.product_id
  left join storage_stock ss on ss.product_id = p.id
  where ms.active = true
    and m.status = 'active'
    and not exists (
      select 1
      from latest_vms_stock_by_slot v
      where v.machine_id = ms.machine_id
    )
    and ms.par_qty > 0
)
select * from vms_recommendations
union all
select * from planogram_fallback;


-- ============================================================================
-- Source migration: supabase/migrations/202605200005_activity_inventory_actor_context.sql
-- ============================================================================

create or replace function public.log_inventory_movement_activity()
returns trigger
language plpgsql
as $$
declare
  activity_actor_user_id uuid;
  activity_actor_name text;
  activity_actor_role text;
begin
  if new.created_by is not null then
    select p.id, coalesce(tm.full_name, p.full_name), coalesce(tm.role::text, p.role::text)
      into activity_actor_user_id, activity_actor_name, activity_actor_role
    from team_members tm
    left join profiles p on p.team_member_id = tm.id
    where tm.id = new.created_by
    order by p.created_at nulls last
    limit 1;
  end if;

  insert into system_activity_logs (
    actor_user_id,
    actor_team_member_id,
    actor_name,
    actor_role,
    action,
    entity_type,
    entity_id,
    entity_label,
    summary,
    after_data,
    metadata
  )
  values (
    activity_actor_user_id,
    new.created_by,
    activity_actor_name,
    activity_actor_role,
    'create_inventory_movement',
    'inventory_movement',
    new.id,
    concat(replace(new.reason::text, '_', ' '), ' ', new.quantity::text),
    concat('Created ', replace(new.reason::text, '_', ' '), ' movement for ', new.quantity::text, ' units'),
    to_jsonb(new),
    jsonb_build_object(
      'product_id', new.product_id,
      'quantity', new.quantity,
      'from_entity_type', new.from_entity_type,
      'from_entity_id', new.from_entity_id,
      'to_entity_type', new.to_entity_type,
      'to_entity_id', new.to_entity_id,
      'movement_reason', new.reason,
      'related_route_id', new.related_route_id,
      'related_route_stop_id', new.related_route_stop_id,
      'related_purchase_id', new.related_purchase_id,
      'related_purchase_line_id', new.related_purchase_line_id,
      'related_machine_id', new.related_machine_id,
      'reversed_movement_id', new.reversed_movement_id
    )
  );

  return new;
end;
$$;


-- ============================================================================
-- Source migration: supabase/migrations/202605200006_xy_vms_api.sql
-- ============================================================================

create table if not exists vms_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'xy',
  sync_type text not null,
  status text not null default 'running',
  endpoint text,
  merchant_id_masked text,
  requested_by uuid references team_members(id) on delete set null,
  row_count integer not null default 0,
  rows_imported integer not null default 0,
  rows_updated integer not null default 0,
  rows_skipped integer not null default 0,
  error_count integer not null default 0,
  message text,
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint vms_sync_runs_status_check check (status in ('running', 'completed', 'completed_with_warnings', 'failed'))
);

create index if not exists idx_vms_sync_runs_provider_type_created
  on vms_sync_runs(provider, sync_type, created_at desc);

create index if not exists idx_vms_sync_runs_status_created
  on vms_sync_runs(status, created_at desc);

create table if not exists vms_product_catalog_snapshots (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references vms_sync_runs(id) on delete set null,
  vms_product_id text,
  third_party_product_id text,
  product_id uuid references products(id) on delete set null,
  product_name text,
  barcode text,
  selling_price_lyd numeric(12,2),
  image_url text,
  detail_images jsonb not null default '[]'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_product_catalog_snapshots_product
  on vms_product_catalog_snapshots(vms_product_id, third_party_product_id, captured_at desc);

create index if not exists idx_vms_product_catalog_snapshots_sync_run
  on vms_product_catalog_snapshots(sync_run_id);

create table if not exists vms_machine_status_snapshots (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references vms_sync_runs(id) on delete set null,
  machine_id uuid references machines(id) on delete cascade,
  vms_machine_id text,
  network_status text,
  temperature_raw text,
  humidity_raw text,
  raw_data jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_machine_status_snapshots_machine
  on vms_machine_status_snapshots(machine_id, captured_at desc);

create index if not exists idx_vms_machine_status_snapshots_sync_run
  on vms_machine_status_snapshots(sync_run_id);

alter table locations
  add column if not exists latitude numeric(12,8),
  add column if not exists longitude numeric(12,8),
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table machines
  add column if not exists vms_provider text,
  add column if not exists vms_category text,
  add column if not exists vms_type text,
  add column if not exists vms_location_name text,
  add column if not exists vms_longitude numeric(12,8),
  add column if not exists vms_latitude numeric(12,8),
  add column if not exists vms_temperature_raw text,
  add column if not exists vms_humidity_raw text,
  add column if not exists vms_raw_metadata jsonb not null default '{}'::jsonb,
  add column if not exists vms_last_synced_at timestamptz;

alter table vms_product_mappings
  add column if not exists vms_third_party_product_id text,
  add column if not exists vms_barcode text,
  add column if not exists vms_image_url text,
  add column if not exists vms_raw_metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_vms_product_mappings_third_party
  on vms_product_mappings(vms_third_party_product_id);

create index if not exists idx_vms_product_mappings_barcode
  on vms_product_mappings(vms_barcode);

alter table vms_stock_snapshots
  add column if not exists sync_run_id uuid references vms_sync_runs(id) on delete set null,
  add column if not exists source_provider text,
  add column if not exists third_party_product_id text,
  add column if not exists locked_inventory_qty integer,
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists product_image_url text,
  add column if not exists production_date date,
  add column if not exists aisle_status text;

create index if not exists idx_vms_stock_snapshots_sync_run
  on vms_stock_snapshots(sync_run_id);

create index if not exists idx_vms_stock_snapshots_provider_captured
  on vms_stock_snapshots(source_provider, captured_at desc);

create or replace view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
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
  from vms_stock_snapshots vss
  left join vms_import_batches vib on vib.id = vss.import_batch_id
  where vss.machine_id is not null
    and vss.import_row_status = 'imported'
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
  (array_agg(sync_run_id order by created_at desc, id desc))[1] as sync_run_id,
  (array_agg(source_provider order by created_at desc, id desc))[1] as source_provider
from latest
group by machine_id, stock_item_key;

create or replace view refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    lvs.id,
    lvs.machine_id,
    lvs.slot_code,
    coalesce(lvs.product_id, mapped.product_id) as product_id,
    lvs.vms_product_id,
    lvs.vms_product_name,
    lvs.current_qty,
    lvs.capacity,
    lvs.captured_at,
    lvs.tray_status,
    lvs.stock_item_key,
    lvs.import_batch_id,
    lvs.imported_at,
    lower(coalesce(lvs.tray_status, '')) as normalized_status
  from latest_vms_stock_by_slot lvs
  left join lateral (
    select vpm.product_id
    from vms_product_mappings vpm
    where vpm.product_id is not null
      and vpm.match_status = 'confirmed'
      and (
        (
          lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
        or (
          lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        )
        or (
          lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
      )
    order by
      case
        when lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        then 0
        when lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        then 1
        else 2
      end,
      vpm.updated_at desc
    limit 1
  ) mapped on true
  where coalesce(lvs.product_id, mapped.product_id) is not null
),
vms_scored as (
  select
    vms_stock.*,
    (
      current_qty <= 0
      or (
        normalized_status not like '%not empty%'
        and normalized_status not like '%not out%'
        and (
          normalized_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
          or normalized_status like '%out of stock%'
          or normalized_status like '%sold out%'
          or normalized_status like '%empty%'
        )
      )
    ) as out_of_stock
  from vms_stock
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code
  from vms_scored v
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
  null::integer as min_qty,
  v.capacity::integer as par_qty,
  case
    when v.capacity is not null then greatest(v.capacity - v.current_qty, 0)::integer
    else null::integer
  end as suggested_qty,
  coalesce(ss.available_storage_qty, 0) as available_storage_qty,
  case
    when v.capacity is not null then least(greatest(v.capacity - v.current_qty, 0), coalesce(ss.available_storage_qty, 0))::integer
    else null::integer
  end as final_qty_to_take,
  case
    when v.out_of_stock then 'critical'
    when v.capacity is not null and v.current_qty <= v.capacity * 0.25 then 'high'
    when v.capacity is not null and v.current_qty <= v.capacity * 0.50 then 'medium'
    else 'low'
  end as priority,
  v.captured_at as latest_vms_at,
  md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
  v.id as vms_stock_snapshot_id,
  'vms_stock'::text as recommendation_source,
  v.capacity::integer as capacity,
  v.tray_status,
  v.import_batch_id,
  v.imported_at
from vms_scored v
join machines m on m.id = v.machine_id
join products p on p.id = v.product_id
left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
left join storage_stock ss on ss.product_id = p.id
where m.status = 'active'
  and (
    (v.capacity is not null and greatest(v.capacity - v.current_qty, 0) > 0)
    or v.out_of_stock
  );


-- ============================================================================
-- Source migration: supabase/migrations/202605200007_machine_refill_history.sql
-- ============================================================================

create table if not exists machine_refill_history (
  id uuid primary key default gen_random_uuid(),
  legacy_refill_id text not null,
  refill_at timestamptz not null,
  machine_id uuid references machines(id) on delete set null,
  machine_name text not null,
  operator_id uuid references team_members(id) on delete set null,
  operator_email text,
  machine_photo_url text,
  machine_photo_path text,
  fill_status text,
  issues_found boolean not null default false,
  issue_notes text,
  linked_issue_id uuid references issues(id) on delete set null,
  source_file text not null default 'Items - MachineRefills.csv',
  source_row integer,
  import_status text not null default 'imported',
  review_reason text,
  raw_record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint machine_refill_history_legacy_refill_id_unique unique (legacy_refill_id),
  constraint machine_refill_history_source_row_unique unique (source_file, source_row),
  constraint machine_refill_history_import_status_check check (import_status in ('imported', 'needs_review', 'skipped'))
);

create index if not exists idx_machine_refill_history_refill_at
  on machine_refill_history(refill_at desc);

create index if not exists idx_machine_refill_history_machine_at
  on machine_refill_history(machine_id, refill_at desc);

create index if not exists idx_machine_refill_history_operator_at
  on machine_refill_history(operator_id, refill_at desc);

create index if not exists idx_machine_refill_history_issues
  on machine_refill_history(issues_found, refill_at desc);

create or replace view machine_refill_history_metrics as
select
  machine_id,
  machine_name,
  count(*)::integer as total_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'full')::integer as full_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'partial')::integer as partial_refills,
  count(*) filter (where issues_found)::integer as issue_refills,
  max(refill_at) as last_refill_at,
  count(distinct operator_id) filter (where operator_id is not null)::integer as operator_count
from machine_refill_history
group by machine_id, machine_name;

create or replace view machine_refill_history_monthly as
select
  date_trunc('month', refill_at)::date as month_start,
  machine_id,
  machine_name,
  count(*)::integer as total_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'full')::integer as full_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'partial')::integer as partial_refills,
  count(*) filter (where issues_found)::integer as issue_refills
from machine_refill_history
group by date_trunc('month', refill_at)::date, machine_id, machine_name;


-- ============================================================================
-- Source migration: supabase/migrations/202605200008_machine_refill_history_live_links.sql
-- ============================================================================

alter table machine_refill_history
  add column if not exists route_id uuid references routes(id) on delete set null,
  add column if not exists route_stop_id uuid references route_stops(id) on delete set null;

create index if not exists idx_machine_refill_history_route_id
  on machine_refill_history(route_id);

create index if not exists idx_machine_refill_history_route_stop_id
  on machine_refill_history(route_stop_id);


-- ============================================================================
-- Source migration: supabase/migrations/202605210001_seed_helper_functions.sql
-- ============================================================================

create or replace function public.snacky_seed_clean_text(value text)
returns text
language sql
immutable
as $$
  select case
    when btrim(coalesce(value, '')) = '' then null
    when upper(btrim(coalesce(value, ''))) = 'TO_CONFIRM' then null
    else btrim(value)
  end
$$;

create or replace function public.snacky_seed_numeric(value text)
returns numeric
language sql
immutable
as $$
  select case
    when public.snacky_seed_clean_text(value) ~ '^-?[0-9]+(\.[0-9]+)?$'
      then public.snacky_seed_clean_text(value)::numeric
    else null
  end
$$;

create or replace function public.snacky_seed_date(value text)
returns date
language plpgsql
immutable
as $$
begin
  if public.snacky_seed_clean_text(value) is null then
    return null;
  end if;

  return public.snacky_seed_clean_text(value)::date;
exception when others then
  return null;
end;
$$;


-- ============================================================================
-- Source migration: supabase/migrations/202605210002_receipt_scanning.sql
-- ============================================================================

create table if not exists product_aliases (
  id uuid primary key default gen_random_uuid(),
  alias_name text not null,
  product_id uuid not null references products(id) on delete cascade,
  source text not null default 'receipt',
  confidence numeric,
  approved_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(alias_name, product_id)
);

create index if not exists idx_product_aliases_alias_name
  on product_aliases(lower(alias_name));

create index if not exists idx_product_aliases_product
  on product_aliases(product_id);

create table if not exists receipt_scan_results (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references purchase_orders(id) on delete set null,
  file_url text,
  raw_text text,
  extracted_data jsonb not null default '{}'::jsonb,
  status text not null default 'completed',
  error_message text,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_receipt_scan_results_purchase
  on receipt_scan_results(purchase_id);

create index if not exists idx_receipt_scan_results_created_by
  on receipt_scan_results(created_by, created_at desc);

create index if not exists idx_receipt_scan_results_status
  on receipt_scan_results(status, created_at desc);

do $$
begin
  alter table receipt_scan_results
    add constraint receipt_scan_results_status_check
    check (status in ('completed', 'not_configured', 'failed'));
exception
  when duplicate_object then null;
end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605220001_fix_purchase_finance_transaction_dates.sql
-- ============================================================================

do $$
declare
  has_payment_date boolean;
  has_paid_at boolean;
  purchase_transaction_date_expr text;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_orders'
      and column_name = 'payment_date'
  )
  into has_payment_date;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_orders'
      and column_name = 'paid_at'
  )
  into has_paid_at;

  purchase_transaction_date_expr := case
    when has_payment_date and has_paid_at then 'coalesce(po.payment_date::date, po.paid_at::date, po.order_date)'
    when has_payment_date then 'coalesce(po.payment_date::date, po.order_date)'
    when has_paid_at then 'coalesce(po.paid_at::date, po.order_date)'
    else 'po.order_date'
  end;

  execute format($sql$
    update financial_transactions ft
    set transaction_date = %1$s,
        updated_at = now()
    from purchase_orders po
    where ft.related_purchase_id = po.id
      and ft.transaction_kind = 'product_purchase'
      and ft.related_purchase_id is not null
      and %1$s is not null
      and ft.transaction_date is distinct from %1$s
  $sql$, purchase_transaction_date_expr);
end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605220002_finance_accounts_import_review.sql
-- ============================================================================

create table if not exists finance_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  source_sheet text not null,
  mode text not null default 'import',
  imported_by uuid references team_members(id) on delete set null,
  status text not null default 'processing',
  row_count integer not null default 0,
  imported_count integer not null default 0,
  auto_classified_count integer not null default 0,
  confirmed_count integer not null default 0,
  needs_review_count integer not null default 0,
  ignored_count integer not null default 0,
  review_group_count integer not null default 0,
  clarification_prompts jsonb not null default '[]'::jsonb,
  error_message text,
  imported_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table finance_settings
  add column if not exists opening_balance_snacky_lyd numeric(12,2) not null default 0,
  add column if not exists opening_balance_snacky_usd numeric(12,2) not null default 0,
  add column if not exists opening_balance_owner_lyd numeric(12,2) not null default 0,
  add column if not exists opening_balance_owner_usd numeric(12,2) not null default 0,
  add column if not exists exchange_rate_usd_to_lyd numeric(12,6);

update finance_settings
set opening_balance_snacky_lyd = coalesce(opening_balance_snacky_lyd, opening_balance, 0)
where id = 'default';

alter table financial_transactions
  add column if not exists currency text not null default 'LYD',
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists exchange_rate_usd_to_lyd numeric(12,6),
  add column if not exists import_batch_id uuid references finance_import_batches(id) on delete set null,
  add column if not exists original_csv_row jsonb not null default '{}'::jsonb,
  add column if not exists review_reason text,
  add column if not exists suggested_category text,
  add column if not exists suggested_account text,
  add column if not exists suggested_machine text,
  add column if not exists confidence_score numeric(5,4);

update financial_transactions
set
  currency = coalesce(nullif(currency, ''), 'LYD'),
  account_id = coalesce(nullif(account_id, ''), 'snacky_lyd'),
  transaction_effect = coalesce(nullif(transaction_effect, ''), case when direction = 'money_in' then 'income' else 'expense' end)
where currency is null
   or account_id is null
   or transaction_effect is null;

alter table financial_transactions
  alter column account_id set default 'snacky_lyd',
  alter column transaction_effect set default 'expense';

update financial_transactions
set
  transaction_effect = 'transfer',
  account_id = 'snacky_lyd',
  source_account_id = 'snacky_lyd',
  destination_account_id = 'owner_lyd',
  final_bucket = coalesce(nullif(final_bucket, 'Owner Draw'), 'Owner Transfer')
where transaction_status = 'active'
  and (
    lower(coalesce(transaction_type, '')) = 'anas'
    or lower(coalesce(final_bucket, '')) = 'owner draw'
  );

update financial_transactions
set
  transaction_effect = 'transfer',
  account_id = 'snacky_lyd',
  source_account_id = 'owner_lyd',
  destination_account_id = 'snacky_lyd',
  final_bucket = 'Owner Funding'
where transaction_status = 'active'
  and lower(coalesce(transaction_type, '')) = 'to snacky';

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'financial_transactions'::regclass
      and pg_get_constraintdef(oid) ilike '%import_status%'
  loop
    execute format('alter table financial_transactions drop constraint %I', constraint_name);
  end loop;
end $$;

alter table financial_transactions
  add constraint financial_transactions_import_status_check
  check (import_status is null or import_status in ('imported', 'auto_classified', 'needs_review', 'confirmed', 'ignored', 'skipped'));

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_currency_check check (currency in ('LYD', 'USD'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_account_id_check check (
      account_id is null or account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_effect_check check (
      transaction_effect in ('income', 'expense', 'transfer', 'opening_balance')
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_transfer_accounts_check check (
      transaction_effect <> 'transfer'
      or (
        source_account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
        and destination_account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
        and source_account_id <> destination_account_id
      )
    );
exception when duplicate_object then null; end $$;

alter table finance_import_rows
  add column if not exists import_batch_id uuid references finance_import_batches(id) on delete set null,
  add column if not exists currency text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists review_group_key text,
  add column if not exists suggested_category text,
  add column if not exists suggested_account text,
  add column if not exists suggested_currency text,
  add column if not exists suggested_machine text,
  add column if not exists suggested_machine_id uuid references machines(id) on delete set null,
  add column if not exists suggested_source_account text,
  add column if not exists suggested_destination_account text,
  add column if not exists confidence_score numeric(5,4),
  add column if not exists clarification_question text;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'finance_import_rows'::regclass
      and pg_get_constraintdef(oid) ilike '%import_status%'
  loop
    execute format('alter table finance_import_rows drop constraint %I', constraint_name);
  end loop;
end $$;

alter table finance_import_rows
  add constraint finance_import_rows_import_status_check
  check (import_status in ('imported', 'auto_classified', 'needs_review', 'confirmed', 'ignored', 'skipped'));

create table if not exists machine_aliases (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id) on delete cascade,
  alias_name text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique(alias_name)
);

update machines
set name = 'جامعة طرابلس الاهليه',
    updated_at = now()
where vms_machine_id = '2510001719'
   or machine_code in ('2510001719', 'SNK-2510001719')
   or name = 'خليج ليبيا';

insert into machine_aliases (machine_id, alias_name, source)
select m.id, alias_name, 'finance_import'
from machines m
cross join (values
  ('KhalijUniversity'),
  ('Khalij University'),
  ('2510001719'),
  ('خليج ليبيا'),
  ('جامعة طرابلس الاهليه')
) as aliases(alias_name)
where m.vms_machine_id = '2510001719'
   or m.machine_code in ('2510001719', 'SNK-2510001719')
   or m.name = 'جامعة طرابلس الاهليه'
on conflict (alias_name) do update
set machine_id = excluded.machine_id,
    source = excluded.source;

create index if not exists idx_machine_aliases_lookup
  on machine_aliases(lower(alias_name));

create index if not exists idx_financial_transactions_account_currency_date
  on financial_transactions(account_id, currency, transaction_date desc);

create index if not exists idx_financial_transactions_import_batch
  on financial_transactions(import_batch_id);

create index if not exists idx_finance_import_rows_review_group
  on finance_import_rows(import_status, review_group_key);

create unique index if not exists idx_financial_transactions_source_file_row
  on financial_transactions(source_file, source_sheet, source_row)
  where source_file is not null and source_sheet is not null and source_row is not null;

create index if not exists idx_financial_transactions_business_dedupe
  on financial_transactions(
    transaction_date,
    amount,
    coalesce(original_description, description, ''),
    currency,
    transaction_effect,
    coalesce(account_id, ''),
    coalesce(source_account_id, ''),
    coalesce(destination_account_id, '')
  )
  where transaction_status = 'active'
    and coalesce(import_status, '') not in ('ignored', 'skipped');

create or replace view finance_account_balance_impacts as
select
  id as financial_transaction_id,
  transaction_date,
  account_id as account_id,
  currency,
  signed_amount as amount_delta,
  transaction_effect,
  final_bucket,
  source_file,
  source_sheet,
  source_row
from financial_transactions
where transaction_status = 'active'
  and coalesce(needs_review, false) = false
  and coalesce(import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and transaction_effect <> 'transfer'
  and account_id is not null

union all

select
  id,
  transaction_date,
  source_account_id,
  case when right(source_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  -abs(amount),
  transaction_effect,
  final_bucket,
  source_file,
  source_sheet,
  source_row
from financial_transactions
where transaction_status = 'active'
  and coalesce(needs_review, false) = false
  and coalesce(import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and transaction_effect = 'transfer'
  and source_account_id is not null

union all

select
  id,
  transaction_date,
  destination_account_id,
  case when right(destination_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  abs(amount),
  transaction_effect,
  final_bucket,
  source_file,
  source_sheet,
  source_row
from financial_transactions
where transaction_status = 'active'
  and coalesce(needs_review, false) = false
  and coalesce(import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and transaction_effect = 'transfer'
  and destination_account_id is not null;

create or replace view finance_account_balances as
select
  account_id,
  currency,
  sum(amount_delta)::numeric(12,2) as balance
from finance_account_balance_impacts
group by account_id, currency;

create or replace view finance_import_clarification_groups as
select
  coalesce(review_group_key, review_reason, 'needs_review') as review_group_key,
  count(*)::integer as affected_rows,
  (array_agg(coalesce(nullif(original_description, ''), raw_category, 'Unclear transaction') order by source_row))[1:3] as example_descriptions,
  sum(abs(coalesce(amount, 0)))::numeric(12,2) as total_amount,
  coalesce(max(suggested_currency), max(currency), 'LYD') as currency,
  max(suggested_category) as suggested_category,
  max(suggested_account) as suggested_account,
  max(suggested_machine) as suggested_machine,
  max(suggested_source_account) as suggested_source_account,
  max(suggested_destination_account) as suggested_destination_account,
  avg(coalesce(confidence_score, 0))::numeric(5,4) as confidence_score,
  max(clarification_question) as clarification_question,
  max(review_reason) as review_reason
from finance_import_rows
where import_status = 'needs_review'
group by coalesce(review_group_key, review_reason, 'needs_review');


-- ============================================================================
-- Source migration: supabase/migrations/202605220003_receipts_sessions_storage_roles.sql
-- ============================================================================

-- Receipts, simple storage adjustments, session-safe role metadata, and multi-role access.

alter type team_role add value if not exists 'purchasing';

alter table team_members
  add column if not exists roles team_role[],
  add column if not exists can_add_products boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table profiles
  add column if not exists roles team_role[],
  add column if not exists can_add_products boolean not null default false;

update team_members
set roles = array[role]::team_role[]
where roles is null or array_length(roles, 1) is null;

update profiles
set roles = array[role]::team_role[]
where roles is null or array_length(roles, 1) is null;

update team_members
set can_add_products = true
where role in ('owner', 'admin');

update profiles
set can_add_products = true
where role in ('owner', 'admin');

create index if not exists idx_team_members_roles on team_members using gin (roles);
create index if not exists idx_profiles_roles on profiles using gin (roles);
create index if not exists idx_team_members_can_add_products on team_members(can_add_products);

alter table purchase_orders
  add column if not exists receipt_file_name text,
  add column if not exists receipt_content_type text,
  add column if not exists receipt_storage_path text;

create index if not exists idx_purchase_orders_receipt_storage_path
  on purchase_orders(receipt_storage_path)
  where receipt_storage_path is not null;

create or replace function public.snacky_profile_has_any_role(profile_roles team_role[], primary_role team_role, allowed_roles text[])
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from unnest(coalesce(profile_roles, array[primary_role]::team_role[])) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$$;

create or replace function public.snacky_storage_has_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
  );
$$;

create or replace function public.snacky_storage_can_access_route(route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.routes r on r.id = route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
          and p.team_member_id is not null
          and r.operator_id = p.team_member_id
        )
      )
  );
$$;

grant execute on function public.snacky_profile_has_any_role(team_role[], team_role, text[]) to authenticated;
grant execute on function public.snacky_storage_has_role(text[]) to authenticated;
grant execute on function public.snacky_storage_can_access_route(uuid) to authenticated;


-- ============================================================================
-- Source migration: supabase/migrations/202605230001_historical_route_deductions.sql
-- ============================================================================

alter type inventory_entity_type add value if not exists 'historical_route';
alter type movement_reason add value if not exists 'historical_route_deduction';

create table if not exists historical_route_deduction_batches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft',
  original_text text not null,
  content_hash text,
  row_count integer not null default 0,
  ready_row_count integer not null default 0,
  needs_review_count integer not null default 0,
  total_quantity integer not null default 0,
  created_by uuid references team_members(id) on delete set null,
  previewed_at timestamptz,
  applied_by uuid references team_members(id) on delete set null,
  applied_at timestamptz,
  cancelled_by uuid references team_members(id) on delete set null,
  cancelled_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint historical_route_deduction_batches_status_check
    check (status in ('draft', 'previewed', 'applied', 'cancelled')),
  constraint historical_route_deduction_batches_counts_nonnegative
    check (row_count >= 0 and ready_row_count >= 0 and needs_review_count >= 0 and total_quantity >= 0)
);

create table if not exists historical_route_deduction_lines (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references historical_route_deduction_batches(id) on delete cascade,
  line_number integer not null,
  section_name text,
  machine_alias text,
  machine_id uuid references machines(id) on delete set null,
  product_alias text,
  product_id uuid references products(id) on delete set null,
  quantity integer,
  original_text text not null,
  status text not null default 'needs_review',
  review_reason text,
  storage_location_id uuid references storage_locations(id) on delete set null,
  storage_qty_before integer,
  storage_qty_after integer,
  storage_negative_warning boolean not null default false,
  movement_id uuid,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  constraint historical_route_deduction_lines_status_check
    check (status in ('ready', 'needs_review', 'applied', 'skipped')),
  constraint historical_route_deduction_lines_quantity_positive
    check (quantity is null or quantity > 0)
);

alter table inventory_movements
  add column if not exists import_batch_id uuid references historical_route_deduction_batches(id) on delete set null,
  add column if not exists original_text text,
  add column if not exists historical_route_deduction_line_id uuid references historical_route_deduction_lines(id) on delete set null;

create index if not exists idx_historical_route_deduction_batches_status
  on historical_route_deduction_batches(status, created_at desc);

create index if not exists idx_historical_route_deduction_batches_hash
  on historical_route_deduction_batches(content_hash)
  where content_hash is not null;

create index if not exists idx_historical_route_deduction_lines_batch
  on historical_route_deduction_lines(import_batch_id, status);

create index if not exists idx_historical_route_deduction_lines_machine_product
  on historical_route_deduction_lines(machine_id, product_id);

create index if not exists idx_inventory_movements_import_batch
  on inventory_movements(import_batch_id);

create unique index if not exists idx_inventory_movements_historical_route_line_once
  on inventory_movements(historical_route_deduction_line_id)
  where historical_route_deduction_line_id is not null;


-- ============================================================================
-- Source migration: supabase/migrations/202605230002_apply_historical_route_deduction.sql
-- ============================================================================

create or replace function public.apply_historical_route_deduction_batch(
  target_batch_id uuid,
  actor_team_member_id uuid
)
returns table(inserted_movements integer, skipped_review_rows integer)
language plpgsql
as $$
declare
  current_status text;
  ready_count integer;
  inserted_count integer := 0;
  review_count integer := 0;
  deduction_line record;
  inserted_movement_id uuid;
begin
  select status
    into current_status
  from historical_route_deduction_batches
  where id = target_batch_id
  for update;

  if not found then
    raise exception 'Historical route deduction batch was not found.';
  end if;

  if current_status = 'applied' then
    raise exception 'This historical route deduction batch has already been applied.';
  end if;

  if current_status <> 'previewed' then
    raise exception 'Only previewed historical route deduction batches can be applied.';
  end if;

  select count(*)::integer
    into ready_count
  from historical_route_deduction_lines
  where import_batch_id = target_batch_id
    and status = 'ready'
    and product_id is not null
    and machine_id is not null
    and quantity is not null
    and quantity > 0
    and storage_location_id is not null;

  if coalesce(ready_count, 0) = 0 then
    raise exception 'This batch has no ready deduction rows to apply.';
  end if;

  for deduction_line in
    select *
    from historical_route_deduction_lines
    where import_batch_id = target_batch_id
      and status = 'ready'
      and product_id is not null
      and machine_id is not null
      and quantity is not null
      and quantity > 0
      and storage_location_id is not null
    order by line_number, id
    for update
  loop
    insert into inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_machine_id,
      created_by,
      notes,
      import_batch_id,
      original_text,
      historical_route_deduction_line_id
    )
    values (
      deduction_line.product_id,
      deduction_line.quantity,
      'storage',
      deduction_line.storage_location_id,
      'historical_route',
      null,
      'historical_route_deduction',
      deduction_line.machine_id,
      actor_team_member_id,
      concat_ws(
        ' - ',
        'Old route data was not previously deducted from storage',
        concat('Machine/location: ', coalesce(deduction_line.section_name, deduction_line.machine_alias, 'Unknown')),
        concat('Original row: ', deduction_line.original_text)
      ),
      target_batch_id,
      deduction_line.original_text,
      deduction_line.id
    )
    returning id into inserted_movement_id;

    update historical_route_deduction_lines
    set
      status = 'applied',
      movement_id = inserted_movement_id,
      applied_at = now()
    where id = deduction_line.id;

    inserted_count := inserted_count + 1;
  end loop;

  select count(*)::integer
    into review_count
  from historical_route_deduction_lines
  where import_batch_id = target_batch_id
    and status = 'needs_review';

  update historical_route_deduction_batches
  set
    status = 'applied',
    applied_by = actor_team_member_id,
    applied_at = now(),
    updated_at = now()
  where id = target_batch_id;

  return query select inserted_count, coalesce(review_count, 0);
end;
$$;


-- ============================================================================
-- Source migration: supabase/migrations/202605230003_historical_route_activity_metadata.sql
-- ============================================================================

create or replace function public.log_inventory_movement_activity()
returns trigger
language plpgsql
as $$
declare
  activity_actor_user_id uuid;
  activity_actor_name text;
  activity_actor_role text;
begin
  if new.created_by is not null then
    select p.id, coalesce(tm.full_name, p.full_name), coalesce(tm.role::text, p.role::text)
      into activity_actor_user_id, activity_actor_name, activity_actor_role
    from team_members tm
    left join profiles p on p.team_member_id = tm.id
    where tm.id = new.created_by
    order by p.created_at nulls last
    limit 1;
  end if;

  insert into system_activity_logs (
    actor_user_id,
    actor_team_member_id,
    actor_name,
    actor_role,
    action,
    entity_type,
    entity_id,
    entity_label,
    summary,
    after_data,
    metadata
  )
  values (
    activity_actor_user_id,
    new.created_by,
    activity_actor_name,
    activity_actor_role,
    'create_inventory_movement',
    'inventory_movement',
    new.id,
    concat(replace(new.reason::text, '_', ' '), ' ', new.quantity::text),
    concat('Created ', replace(new.reason::text, '_', ' '), ' movement for ', new.quantity::text, ' units'),
    to_jsonb(new),
    jsonb_build_object(
      'product_id', new.product_id,
      'quantity', new.quantity,
      'from_entity_type', new.from_entity_type,
      'from_entity_id', new.from_entity_id,
      'to_entity_type', new.to_entity_type,
      'to_entity_id', new.to_entity_id,
      'movement_reason', new.reason,
      'related_route_id', new.related_route_id,
      'related_route_stop_id', new.related_route_stop_id,
      'related_purchase_id', new.related_purchase_id,
      'related_purchase_line_id', new.related_purchase_line_id,
      'related_machine_id', new.related_machine_id,
      'reversed_movement_id', new.reversed_movement_id,
      'import_batch_id', new.import_batch_id,
      'historical_route_deduction_line_id', new.historical_route_deduction_line_id,
      'original_text', new.original_text
    )
  );

  return new;
end;
$$;


-- ============================================================================
-- Source migration: supabase/migrations/202605230004_multi_role_inventory_product_permissions.sql
-- ============================================================================

-- Multi-role helpers and RLS policies for product and warehouse inventory access.
-- These policies are safe to define even before RLS is enabled on the core tables.

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
  );
$$;

create or replace function public.snacky_current_profile_can_add_products()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.can_add_products = true
        or public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'purchasing'])
      )
  );
$$;

create or replace function public.snacky_operator_can_read_product(target_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and p.team_member_id is not null
      and public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
      and (
        exists (
          select 1
          from public.routes r
          join public.route_stock_lines rsl on rsl.route_id = r.id
          where r.operator_id = p.team_member_id
            and rsl.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.route_stop_items rsi on rsi.route_id = r.id
          where r.operator_id = p.team_member_id
            and rsi.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.refill_orders ro on ro.route_id = r.id
          join public.refill_order_lines rol on rol.refill_order_id = ro.id
          where r.operator_id = p.team_member_id
            and rol.product_id = target_product_id
        )
      )
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and p.team_member_id is not null
      and r.operator_id = p.team_member_id
      and public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
  );
$$;

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_current_profile_can_add_products() to authenticated;
grant execute on function public.snacky_operator_can_read_product(uuid) to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'drop policy if exists "snacky_products_select_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_insert_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_update_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_delete_by_effective_role" on public.products';

    execute $sql$
      create policy "snacky_products_select_by_effective_role"
      on public.products for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance'])
        or public.snacky_operator_can_read_product(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_insert_by_effective_role"
      on public.products for insert
      to authenticated
      with check (public.snacky_current_profile_can_add_products())
    $sql$;

    execute $sql$
      create policy "snacky_products_update_by_effective_role"
      on public.products for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_products_delete_by_effective_role"
      on public.products for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.storage_locations') is not null then
    execute 'drop policy if exists "snacky_storage_locations_select_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_insert_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_update_by_effective_role" on public.storage_locations';

    execute $sql$
      create policy "snacky_storage_locations_select_by_effective_role"
      on public.storage_locations for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_insert_by_effective_role"
      on public.storage_locations for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_update_by_effective_role"
      on public.storage_locations for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'drop policy if exists "snacky_inventory_movements_select_by_effective_role" on public.inventory_movements';
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
      create policy "snacky_inventory_movements_select_by_effective_role"
      on public.inventory_movements for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or (related_route_id is not null and public.snacky_operator_can_access_route(related_route_id))
      )
    $sql$;

    execute $sql$
      create policy "snacky_inventory_movements_insert_by_effective_role"
      on public.inventory_movements for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'damaged', 'expired', 'product_substitution'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'damaged', 'expired', 'product_substitution'])
        )
      )
    $sql$;
  end if;

  if to_regclass('public.purchase_orders') is not null then
    execute 'drop policy if exists "snacky_purchase_orders_select_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_insert_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_update_by_effective_role" on public.purchase_orders';

    execute $sql$
      create policy "snacky_purchase_orders_select_by_effective_role"
      on public.purchase_orders for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_insert_by_effective_role"
      on public.purchase_orders for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_update_by_effective_role"
      on public.purchase_orders for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;
  end if;

  if to_regclass('public.purchase_order_lines') is not null then
    execute 'drop policy if exists "snacky_purchase_order_lines_select_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_insert_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_update_by_effective_role" on public.purchase_order_lines';

    execute $sql$
      create policy "snacky_purchase_order_lines_select_by_effective_role"
      on public.purchase_order_lines for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_insert_by_effective_role"
      on public.purchase_order_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_update_by_effective_role"
      on public.purchase_order_lines for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;
  end if;
end $$;


-- ============================================================================
-- Source migration: supabase/migrations/202605230005_grouped_refill_slot_allocations.sql
-- ============================================================================

alter table route_stop_items
  add column if not exists recommended_take_qty integer not null default 0,
  add column if not exists final_take_qty integer not null default 0,
  add column if not exists slot_allocations jsonb not null default '[]'::jsonb;

alter table refill_order_lines
  add column if not exists recommended_take_qty integer not null default 0,
  add column if not exists final_take_qty integer not null default 0,
  add column if not exists slot_allocations jsonb not null default '[]'::jsonb;

update route_stop_items
set
  recommended_take_qty = greatest(coalesce(recommended_take_qty, 0), coalesce(planned_quantity, 0)),
  final_take_qty = greatest(coalesce(final_take_qty, 0), coalesce(planned_quantity, 0))
where recommended_take_qty = 0
   or final_take_qty = 0;

update refill_order_lines
set
  recommended_take_qty = greatest(coalesce(recommended_take_qty, 0), coalesce(suggested_qty, 0)),
  final_take_qty = greatest(coalesce(final_take_qty, 0), coalesce(final_qty_to_take, 0))
where recommended_take_qty = 0
   or final_take_qty = 0;

do $$ begin
  alter table route_stop_items add constraint route_stop_items_recommended_take_qty_nonnegative check (recommended_take_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table route_stop_items add constraint route_stop_items_final_take_qty_nonnegative check (final_take_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table refill_order_lines add constraint refill_order_lines_recommended_take_qty_nonnegative check (recommended_take_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table refill_order_lines add constraint refill_order_lines_final_take_qty_nonnegative check (final_take_qty >= 0);
exception when duplicate_object then null; end $$;

create index if not exists idx_route_stop_items_slot_allocations
  on route_stop_items using gin (slot_allocations);

create index if not exists idx_refill_order_lines_slot_allocations
  on refill_order_lines using gin (slot_allocations);


-- ============================================================================
-- Source migration: supabase/migrations/202605240001_route_stop_items_recommended_take_qty_schema_cache.sql
-- ============================================================================

alter table if exists public.route_stop_items
  add column if not exists recommended_take_qty integer default 0,
  add column if not exists final_take_qty integer default 0,
  add column if not exists slot_allocations jsonb default '[]'::jsonb;

alter table if exists public.route_stop_items
  alter column recommended_take_qty set default 0,
  alter column final_take_qty set default 0,
  alter column slot_allocations set default '[]'::jsonb,
  alter column recommended_take_qty drop not null,
  alter column final_take_qty drop not null,
  alter column slot_allocations drop not null;

update public.route_stop_items
set
  recommended_take_qty = coalesce(recommended_take_qty, planned_quantity, 0),
  final_take_qty = coalesce(final_take_qty, planned_quantity, 0),
  slot_allocations = coalesce(slot_allocations, '[]'::jsonb)
where recommended_take_qty is null
   or final_take_qty is null
   or slot_allocations is null;

do $$ begin
  alter table public.route_stop_items
    add constraint route_stop_items_recommended_take_qty_nonnegative_nullable
    check (recommended_take_qty is null or recommended_take_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.route_stop_items
    add constraint route_stop_items_final_take_qty_nonnegative_nullable
    check (final_take_qty is null or final_take_qty >= 0);
exception when duplicate_object then null; end $$;

create index if not exists idx_route_stop_items_slot_allocations
  on public.route_stop_items using gin (slot_allocations);

alter table if exists public.refill_order_lines
  add column if not exists recommended_take_qty integer default 0,
  add column if not exists final_take_qty integer default 0,
  add column if not exists slot_allocations jsonb default '[]'::jsonb;

alter table if exists public.refill_order_lines
  alter column recommended_take_qty set default 0,
  alter column final_take_qty set default 0,
  alter column slot_allocations set default '[]'::jsonb,
  alter column recommended_take_qty drop not null,
  alter column final_take_qty drop not null,
  alter column slot_allocations drop not null;

update public.refill_order_lines
set
  recommended_take_qty = coalesce(recommended_take_qty, suggested_qty, 0),
  final_take_qty = coalesce(final_take_qty, final_qty_to_take, 0),
  slot_allocations = coalesce(slot_allocations, '[]'::jsonb)
where recommended_take_qty is null
   or final_take_qty is null
   or slot_allocations is null;

do $$ begin
  alter table public.refill_order_lines
    add constraint refill_order_lines_recommended_take_qty_nonnegative_nullable
    check (recommended_take_qty is null or recommended_take_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.refill_order_lines
    add constraint refill_order_lines_final_take_qty_nonnegative_nullable
    check (final_take_qty is null or final_take_qty >= 0);
exception when duplicate_object then null; end $$;

create index if not exists idx_refill_order_lines_slot_allocations
  on public.refill_order_lines using gin (slot_allocations);

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240002_route_lifecycle_statuses_and_multirole_access.sql
-- ============================================================================

alter type route_status add value if not exists 'available';
alter type route_status add value if not exists 'ready';
alter type route_status add value if not exists 'started';
alter type route_status add value if not exists 'pickup_confirmed';
alter type route_status add value if not exists 'machine_filling';
alter type route_status add value if not exists 'canceled';

create or replace function public.snacky_profile_has_any_role(profile_roles team_role[], primary_role team_role, allowed_roles text[])
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from unnest(array_remove(coalesce(profile_roles, array[]::team_role[]) || array[primary_role], null)) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$$;

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and p.team_member_id is not null
      and public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
      and (
        r.operator_id = p.team_member_id
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;

grant execute on function public.snacky_profile_has_any_role(team_role[], team_role, text[]) to authenticated;
grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.routes') is not null then
    execute 'drop policy if exists "snacky_routes_select_by_effective_role" on public.routes';
    execute $sql$
      create policy "snacky_routes_select_by_effective_role"
      on public.routes for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stops') is not null then
    execute 'drop policy if exists "snacky_route_stops_select_by_route_access" on public.route_stops';
    execute $sql$
      create policy "snacky_route_stops_select_by_route_access"
      on public.route_stops for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stock_lines') is not null then
    execute 'drop policy if exists "snacky_route_stock_lines_select_by_route_access" on public.route_stock_lines';
    execute $sql$
      create policy "snacky_route_stock_lines_select_by_route_access"
      on public.route_stock_lines for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stop_items') is not null then
    execute 'drop policy if exists "snacky_route_stop_items_select_by_route_access" on public.route_stop_items';
    execute $sql$
      create policy "snacky_route_stop_items_select_by_route_access"
      on public.route_stop_items for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_pick_list_items') is not null then
    execute 'drop policy if exists "snacky_route_pick_list_items_select_by_route_access" on public.route_pick_list_items';
    execute $sql$
      create policy "snacky_route_pick_list_items_select_by_route_access"
      on public.route_pick_list_items for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
      create policy "snacky_inventory_movements_insert_by_effective_role"
      on public.inventory_movements for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'damaged', 'expired', 'product_substitution', 'manual_correction'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'machine', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'machine', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'damaged', 'expired', 'product_substitution', 'manual_correction'])
        )
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240003_inventory_debug_purchase_atomic_rpc.sql
-- ============================================================================

create or replace function public.snacky_create_purchase_with_lines(
  p_supplier_id uuid,
  p_order_date date,
  p_receipt_number text,
  p_payment_method text,
  p_payment_status text,
  p_receipt_url text,
  p_receipt_file_name text,
  p_receipt_content_type text,
  p_receipt_storage_path text,
  p_notes text,
  p_calculated_total_lyd numeric,
  p_manual_total_lyd numeric,
  p_total_adjustment_lyd numeric,
  p_total_source text,
  p_total_amount numeric,
  p_created_by uuid,
  p_submit_action text,
  p_lines jsonb
)
returns table (
  id uuid,
  receipt_number text,
  status text,
  total_amount numeric,
  payment_status text,
  movement_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase_id uuid;
  v_storage_id uuid;
  v_status text := 'draft';
  v_movement_count integer := 0;
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'Permission denied for purchase save' using errcode = '42501';
  end if;

  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Purchase must include at least one line item' using errcode = '22023';
  end if;

  insert into public.purchase_orders (
    supplier_id,
    status,
    order_date,
    receipt_number,
    payment_method,
    payment_status,
    receipt_url,
    receipt_file_name,
    receipt_content_type,
    receipt_storage_path,
    notes,
    calculated_total_lyd,
    manual_total_lyd,
    total_adjustment_lyd,
    total_source,
    total_amount,
    created_by
  )
  values (
    p_supplier_id,
    'draft',
    coalesce(p_order_date, current_date),
    nullif(trim(coalesce(p_receipt_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_payment_method, '')), ''), 'cash'),
    coalesce(nullif(trim(coalesce(p_payment_status, '')), ''), 'paid'),
    nullif(trim(coalesce(p_receipt_url, '')), ''),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_receipt_content_type, '')), ''),
    nullif(trim(coalesce(p_receipt_storage_path, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    coalesce(p_calculated_total_lyd, 0),
    p_manual_total_lyd,
    p_total_adjustment_lyd,
    coalesce(nullif(trim(coalesce(p_total_source, '')), ''), 'calculated'),
    coalesce(p_total_amount, 0),
    p_created_by
  )
  returning purchase_orders.id into v_purchase_id;

  insert into public.purchase_order_lines (
    purchase_order_id,
    product_id,
    line_position,
    boxes_qty,
    units_per_box,
    loose_units_qty,
    total_units,
    ordered_qty,
    received_qty,
    unit_cost,
    unit_cost_lyd,
    line_total,
    line_total_lyd
  )
  select
    v_purchase_id,
    line.product_id,
    coalesce(line.line_position, 0),
    greatest(coalesce(line.boxes_qty, 0), 0),
    greatest(coalesce(line.units_per_box, 1), 1),
    greatest(coalesce(line.loose_units_qty, 0), 0),
    greatest(coalesce(line.total_units, 0), 0),
    greatest(coalesce(line.total_units, 0), 0),
    case when p_submit_action = 'received' then greatest(coalesce(line.total_units, 0), 0) else 0 end,
    greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0),
    greatest(coalesce(line.unit_cost_lyd, line.unit_cost, 0), 0),
    greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0),
    greatest(coalesce(line.line_total_lyd, line.line_total, 0), 0)
  from jsonb_to_recordset(p_lines) as line(
    product_id uuid,
    line_position integer,
    boxes_qty integer,
    units_per_box integer,
    loose_units_qty integer,
    total_units integer,
    unit_cost numeric,
    unit_cost_lyd numeric,
    line_total numeric,
    line_total_lyd numeric
  )
  where line.product_id is not null
    and greatest(coalesce(line.total_units, 0), 0) > 0;

  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v_purchase_id) then
    raise exception 'Purchase must include at least one valid line item' using errcode = '22023';
  end if;

  if p_submit_action = 'received' then
    select sl.id
    into v_storage_id
    from public.storage_locations sl
    where sl.active = true
      and sl.location_type::text = 'main_storage'
    order by sl.name
    limit 1;

    if v_storage_id is null then
      select sl.id
      into v_storage_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type::text in ('vehicle', 'temporary', 'other')
      order by sl.name
      limit 1;
    end if;

    if v_storage_id is null then
      raise exception 'No active storage location found' using errcode = '23514';
    end if;

    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_purchase_id,
      related_purchase_line_id,
      unit_cost_lyd,
      line_total_lyd,
      created_by,
      notes
    )
    select
      pol.product_id,
      pol.total_units,
      'supplier',
      p_supplier_id,
      'storage',
      v_storage_id,
      'purchase_received',
      v_purchase_id,
      pol.id,
      coalesce(pol.unit_cost_lyd, pol.unit_cost, 0),
      coalesce(pol.line_total_lyd, pol.line_total, 0),
      p_created_by,
      'Purchase received'
    from public.purchase_order_lines pol
    where pol.purchase_order_id = v_purchase_id
      and pol.total_units > 0;

    get diagnostics v_movement_count = row_count;

    with latest_line as (
      select distinct on (pol.product_id)
        pol.product_id,
        coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) as latest_cost
      from public.purchase_order_lines pol
      where pol.purchase_order_id = v_purchase_id
      order by pol.product_id, pol.line_position desc, pol.id desc
    )
    update public.products p
    set
      cost_price = latest_line.latest_cost,
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      cost_price_source = 'latest_purchase',
      price_updated_at = now(),
      updated_at = now()
    from latest_line
    where p.id = latest_line.product_id;

    update public.purchase_orders po
    set
      status = 'received',
      received_at = now(),
      received_date = current_date,
      received_by = p_created_by,
      updated_at = now()
    where po.id = v_purchase_id;

    v_status := 'received';
  end if;

  return query
  select
    po.id,
    po.receipt_number,
    po.status,
    po.total_amount,
    po.payment_status,
    v_movement_count
  from public.purchase_orders po
  where po.id = v_purchase_id;
end;
$$;

grant execute on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) to authenticated;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'drop policy if exists "snacky_products_select_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_insert_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_update_by_effective_role" on public.products';

    execute $sql$
      create policy "snacky_products_select_by_effective_role"
      on public.products for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance'])
        or public.snacky_operator_can_read_product(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_insert_by_effective_role"
      on public.products for insert
      to authenticated
      with check (
        public.snacky_current_profile_can_add_products()
        or public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing'])
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_update_by_effective_role"
      on public.products for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
      create policy "snacky_inventory_movements_insert_by_effective_role"
      on public.inventory_movements for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_current_profile_has_any_role(array['warehouse', 'purchasing'])
          and reason::text = 'purchase_received'
          and from_entity_type::text = 'supplier'
          and to_entity_type::text = 'storage'
        )
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'manual_correction', 'damaged', 'expired', 'theft_or_missing', 'product_substitution'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'manual_correction', 'damaged', 'expired', 'product_substitution'])
        )
      )
    $sql$;
  end if;
end $$;

grant select on table public.products to authenticated;
grant select on table public.inventory_movements to authenticated;
grant select on table public.route_stock_lines to authenticated;
grant select on table public.current_inventory_by_location to authenticated;
grant select on table public.storage_locations to authenticated;
grant select on table public.suppliers to authenticated;
grant select on table public.purchase_orders to authenticated;
grant select on table public.purchase_order_lines to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240004_supplier_purchase_read_policies.sql
-- ============================================================================

do $$
begin
  if to_regclass('public.suppliers') is not null then
    execute 'drop policy if exists "snacky_suppliers_select_by_effective_role" on public.suppliers';

    execute $sql$
      create policy "snacky_suppliers_select_by_effective_role"
      on public.suppliers for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;
  end if;
end $$;

grant select on table public.suppliers to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240005_additive_profile_team_member_rls_helpers.sql
-- ============================================================================

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
        or public.snacky_profile_has_any_role(tm.roles, tm.role, allowed_roles)
      )
  );
$$;

create or replace function public.snacky_current_profile_can_add_products()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.can_add_products = true
        or tm.can_add_products = true
        or public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'warehouse', 'purchasing'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'warehouse', 'purchasing'])
      )
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;

create or replace function public.snacky_operator_can_read_product(target_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator'])
      )
      and (
        exists (
          select 1
          from public.routes r
          join public.route_stock_lines rsl on rsl.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsl.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.route_stop_items rsi on rsi.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsi.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.refill_orders ro on ro.route_id = r.id
          join public.refill_order_lines rol on rol.refill_order_id = ro.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rol.product_id = target_product_id
        )
      )
  );
$$;

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_current_profile_can_add_products() to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;
grant execute on function public.snacky_operator_can_read_product(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240006_enable_core_workflow_rls.sql
-- ============================================================================

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'alter table public.products enable row level security';
  end if;

  if to_regclass('public.storage_locations') is not null then
    execute 'alter table public.storage_locations enable row level security';
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'alter table public.inventory_movements enable row level security';
  end if;

  if to_regclass('public.purchase_orders') is not null then
    execute 'alter table public.purchase_orders enable row level security';
  end if;

  if to_regclass('public.purchase_order_lines') is not null then
    execute 'alter table public.purchase_order_lines enable row level security';
  end if;

  if to_regclass('public.suppliers') is not null then
    execute 'alter table public.suppliers enable row level security';

    execute 'drop policy if exists "snacky_suppliers_insert_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_update_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_delete_by_effective_role" on public.suppliers';

    execute $sql$
      create policy "snacky_suppliers_insert_by_effective_role"
      on public.suppliers for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_update_by_effective_role"
      on public.suppliers for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_delete_by_effective_role"
      on public.suppliers for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240007_route_creation_rls_policies.sql
-- ============================================================================

do $$
begin
  if to_regclass('public.routes') is not null then
    execute 'grant select, insert, update, delete on table public.routes to authenticated';

    execute 'drop policy if exists "snacky_routes_insert_by_effective_role" on public.routes';
    execute 'drop policy if exists "snacky_routes_update_by_effective_role" on public.routes';
    execute 'drop policy if exists "snacky_routes_delete_by_effective_role" on public.routes';

    execute $sql$
      create policy "snacky_routes_insert_by_effective_role"
      on public.routes for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_routes_update_by_effective_role"
      on public.routes for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_routes_delete_by_effective_role"
      on public.routes for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.route_stops') is not null then
    execute 'grant select, insert, update, delete on table public.route_stops to authenticated';

    execute 'drop policy if exists "snacky_route_stops_insert_by_effective_role" on public.route_stops';
    execute 'drop policy if exists "snacky_route_stops_update_by_effective_role" on public.route_stops';
    execute 'drop policy if exists "snacky_route_stops_delete_by_effective_role" on public.route_stops';

    execute $sql$
      create policy "snacky_route_stops_insert_by_effective_role"
      on public.route_stops for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_route_stops_update_by_effective_role"
      on public.route_stops for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stops_delete_by_effective_role"
      on public.route_stops for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.route_stock_lines') is not null then
    execute 'grant select, insert, update, delete on table public.route_stock_lines to authenticated';

    execute 'drop policy if exists "snacky_route_stock_lines_insert_by_effective_role" on public.route_stock_lines';
    execute 'drop policy if exists "snacky_route_stock_lines_update_by_effective_role" on public.route_stock_lines';
    execute 'drop policy if exists "snacky_route_stock_lines_delete_by_effective_role" on public.route_stock_lines';

    execute $sql$
      create policy "snacky_route_stock_lines_insert_by_effective_role"
      on public.route_stock_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_route_stock_lines_update_by_effective_role"
      on public.route_stock_lines for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stock_lines_delete_by_effective_role"
      on public.route_stock_lines for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.route_stop_items') is not null then
    execute 'grant select, insert, update, delete on table public.route_stop_items to authenticated';

    execute 'drop policy if exists "snacky_route_stop_items_insert_by_effective_role" on public.route_stop_items';
    execute 'drop policy if exists "snacky_route_stop_items_update_by_effective_role" on public.route_stop_items';
    execute 'drop policy if exists "snacky_route_stop_items_delete_by_effective_role" on public.route_stop_items';

    execute $sql$
      create policy "snacky_route_stop_items_insert_by_effective_role"
      on public.route_stop_items for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_route_stop_items_update_by_effective_role"
      on public.route_stop_items for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stop_items_delete_by_effective_role"
      on public.route_stop_items for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.route_pick_list_items') is not null then
    execute 'grant select, insert, update, delete on table public.route_pick_list_items to authenticated';

    execute 'drop policy if exists "snacky_route_pick_list_items_insert_by_effective_role" on public.route_pick_list_items';
    execute 'drop policy if exists "snacky_route_pick_list_items_update_by_effective_role" on public.route_pick_list_items';
    execute 'drop policy if exists "snacky_route_pick_list_items_delete_by_effective_role" on public.route_pick_list_items';

    execute $sql$
      create policy "snacky_route_pick_list_items_insert_by_effective_role"
      on public.route_pick_list_items for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pick_list_items_update_by_effective_role"
      on public.route_pick_list_items for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pick_list_items_delete_by_effective_role"
      on public.route_pick_list_items for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.refill_orders') is not null then
    execute 'grant select, insert, update, delete on table public.refill_orders to authenticated';

    execute 'drop policy if exists "snacky_refill_orders_insert_by_effective_role" on public.refill_orders';
    execute 'drop policy if exists "snacky_refill_orders_update_by_effective_role" on public.refill_orders';
    execute 'drop policy if exists "snacky_refill_orders_delete_by_effective_role" on public.refill_orders';

    execute $sql$
      create policy "snacky_refill_orders_insert_by_effective_role"
      on public.refill_orders for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_refill_orders_update_by_effective_role"
      on public.refill_orders for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_refill_orders_delete_by_effective_role"
      on public.refill_orders for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.refill_order_lines') is not null then
    execute 'grant select, insert, update, delete on table public.refill_order_lines to authenticated';

    execute 'drop policy if exists "snacky_refill_order_lines_insert_by_effective_role" on public.refill_order_lines';
    execute 'drop policy if exists "snacky_refill_order_lines_update_by_effective_role" on public.refill_order_lines';
    execute 'drop policy if exists "snacky_refill_order_lines_delete_by_effective_role" on public.refill_order_lines';

    execute $sql$
      create policy "snacky_refill_order_lines_insert_by_effective_role"
      on public.refill_order_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_refill_order_lines_update_by_effective_role"
      on public.refill_order_lines for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_refill_order_lines_delete_by_effective_role"
      on public.refill_order_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        )
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240008_route_status_lifecycle_consistency.sql
-- ============================================================================

alter type route_status add value if not exists 'available';
alter type route_status add value if not exists 'ready';
alter type route_status add value if not exists 'started';
alter type route_status add value if not exists 'pickup_confirmed';
alter type route_status add value if not exists 'filling';
alter type route_status add value if not exists 'machine_filling';
alter type route_status add value if not exists 'canceled';

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'draft')
        )
      )
  );
$$;

grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240009_route_status_write_compatibility.sql
-- ============================================================================

alter type route_status add value if not exists 'available';
alter type route_status add value if not exists 'ready';
alter type route_status add value if not exists 'started';
alter type route_status add value if not exists 'pickup_confirmed';
alter type route_status add value if not exists 'filling';
alter type route_status add value if not exists 'machine_filling';
alter type route_status add value if not exists 'canceled';

comment on type route_status is
  'Snacky OS route lifecycle. App writes stable statuses draft, assigned, in_progress, completed, reviewed, cancelled; extra values are accepted for legacy deployed rows and displayed by route-workflow helpers.';

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('draft', 'available', 'ready')
        )
      )
  );
$$;

grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.route_stock_lines') is not null then
    execute 'grant select, insert, update, delete on table public.route_stock_lines to authenticated';
    execute 'drop policy if exists "snacky_route_stock_lines_insert_by_effective_role" on public.route_stock_lines';

    execute $sql$
      create policy "snacky_route_stock_lines_insert_by_effective_role"
      on public.route_stock_lines for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240010_route_pick_list_stop_assignments.sql
-- ============================================================================

alter table if exists public.route_pick_list_items
  add column if not exists route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists route_stop_item_id uuid references public.route_stop_items(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null;

create index if not exists idx_route_pick_list_items_route_stop_id
  on public.route_pick_list_items(route_stop_id);

create index if not exists idx_route_pick_list_items_route_stop_item_id
  on public.route_pick_list_items(route_stop_item_id);

create index if not exists idx_route_pick_list_items_machine_id
  on public.route_pick_list_items(machine_id);

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605240011_vms_sales_period_fields.sql
-- ============================================================================

alter table vms_sales_snapshots
  add column if not exists machine_code text,
  add column if not exists machine_name text,
  add column if not exists product_number text,
  add column if not exists product_name text,
  add column if not exists commodity_price numeric(12,2),
  add column if not exists transaction_count integer,
  add column if not exists transaction_amount numeric(12,2),
  add column if not exists refund_count integer,
  add column if not exists refund_amount numeric(12,2),
  add column if not exists total_transaction numeric(12,2),
  add column if not exists sales_period_start date,
  add column if not exists sales_period_end date,
  add column if not exists sales_month date;

update vms_sales_snapshots
set
  transaction_count = coalesce(transaction_count, sold_qty),
  transaction_amount = coalesce(transaction_amount, sales_amount),
  sales_period_start = coalesce(sales_period_start, period_start::date),
  sales_period_end = coalesce(sales_period_end, period_end::date),
  sales_month = coalesce(sales_month, date_trunc('month', period_start)::date)
where transaction_count is null
   or transaction_amount is null
   or sales_period_start is null
   or sales_period_end is null
   or sales_month is null;

create index if not exists idx_vms_sales_snapshots_sales_month
  on vms_sales_snapshots(sales_month);

create index if not exists idx_vms_sales_snapshots_machine_product_month
  on vms_sales_snapshots(machine_code, product_number, sales_month);


-- ============================================================================
-- Source migration: supabase/migrations/202605240012_route_pickup_batches_and_partial_stops.sql
-- ============================================================================

alter type route_stop_status add value if not exists 'picked';
alter type route_stop_status add value if not exists 'in_progress';
alter type route_stop_status add value if not exists 'canceled';

create table if not exists public.route_pickup_batches (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  status text not null default 'confirmed',
  selected_stop_ids uuid[] not null default '{}'::uuid[],
  product_summary jsonb not null default '[]'::jsonb,
  storage_deducted boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pickup_batches_status_check check (status in ('draft', 'confirmed', 'cancelled')),
  constraint route_pickup_batches_product_summary_array check (jsonb_typeof(product_summary) = 'array')
);

create table if not exists public.route_pickup_batch_stops (
  pickup_batch_id uuid not null references public.route_pickup_batches(id) on delete cascade,
  route_stop_id uuid not null references public.route_stops(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pickup_batch_id, route_stop_id)
);

alter table if exists public.route_pick_list_items
  add column if not exists pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

alter table if exists public.inventory_movements
  add column if not exists related_pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

create index if not exists idx_route_pickup_batches_route_id
  on public.route_pickup_batches(route_id);

create index if not exists idx_route_pickup_batches_operator_id
  on public.route_pickup_batches(operator_id);

create index if not exists idx_route_pickup_batch_stops_route_stop_id
  on public.route_pickup_batch_stops(route_stop_id);

create index if not exists idx_route_pick_list_items_pickup_batch_id
  on public.route_pick_list_items(pickup_batch_id);

create index if not exists idx_inventory_movements_pickup_batch_id
  on public.inventory_movements(related_pickup_batch_id);

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null then
    execute 'alter table public.route_pickup_batches enable row level security';
    execute 'grant select, insert, update, delete on table public.route_pickup_batches to authenticated';

    execute 'drop policy if exists "snacky_route_pickup_batches_select_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_insert_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_update_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_delete_by_route_access" on public.route_pickup_batches';

    execute $sql$
      create policy "snacky_route_pickup_batches_select_by_route_access"
      on public.route_pickup_batches for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_insert_by_route_access"
      on public.route_pickup_batches for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_update_by_route_access"
      on public.route_pickup_batches for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_delete_by_route_access"
      on public.route_pickup_batches for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_pickup_batch_stops') is not null then
    execute 'alter table public.route_pickup_batch_stops enable row level security';
    execute 'grant select, insert, update, delete on table public.route_pickup_batch_stops to authenticated';

    execute 'drop policy if exists "snacky_route_pickup_batch_stops_select_by_route_access" on public.route_pickup_batch_stops';
    execute 'drop policy if exists "snacky_route_pickup_batch_stops_insert_by_route_access" on public.route_pickup_batch_stops';
    execute 'drop policy if exists "snacky_route_pickup_batch_stops_delete_by_route_access" on public.route_pickup_batch_stops';

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_select_by_route_access"
      on public.route_pickup_batch_stops for select
      to authenticated
      using (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_insert_by_route_access"
      on public.route_pickup_batch_stops for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_delete_by_route_access"
      on public.route_pickup_batch_stops for delete
      to authenticated
      using (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;
  end if;

  if to_regclass('public.route_stop_items') is not null then
    execute 'drop policy if exists "snacky_route_stop_items_insert_by_effective_role" on public.route_stop_items';
    execute 'drop policy if exists "snacky_route_stop_items_delete_by_effective_role" on public.route_stop_items';

    execute $sql$
      create policy "snacky_route_stop_items_insert_by_effective_role"
      on public.route_stop_items for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stop_items_delete_by_effective_role"
      on public.route_stop_items for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stock_lines') is not null then
    execute 'drop policy if exists "snacky_route_stock_lines_insert_by_effective_role" on public.route_stock_lines';
    execute 'drop policy if exists "snacky_route_stock_lines_delete_by_effective_role" on public.route_stock_lines';

    execute $sql$
      create policy "snacky_route_stock_lines_insert_by_effective_role"
      on public.route_stock_lines for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stock_lines_delete_by_effective_role"
      on public.route_stock_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.refill_order_lines') is not null then
    execute 'drop policy if exists "snacky_refill_order_lines_insert_by_effective_role" on public.refill_order_lines';
    execute 'drop policy if exists "snacky_refill_order_lines_delete_by_effective_role" on public.refill_order_lines';

    execute $sql$
      create policy "snacky_refill_order_lines_insert_by_effective_role"
      on public.refill_order_lines for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_refill_order_lines_delete_by_effective_role"
      on public.refill_order_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
    $sql$;
  end if;

  if to_regclass('public.refill_orders') is not null then
    execute 'drop policy if exists "snacky_refill_orders_insert_by_effective_role" on public.refill_orders';

    execute $sql$
      create policy "snacky_refill_orders_insert_by_effective_role"
      on public.refill_orders for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605250001_route_pickup_schema_contract.sql
-- ============================================================================

alter type public.route_stop_status add value if not exists 'picked';
alter type public.route_stop_status add value if not exists 'in_progress';
alter type public.route_stop_status add value if not exists 'canceled';

create table if not exists public.route_pickup_batches (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  status text not null default 'confirmed',
  selected_stop_ids uuid[] not null default '{}'::uuid[],
  product_summary jsonb not null default '[]'::jsonb,
  storage_deducted boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pickup_batches_status_check check (status in ('draft', 'confirmed', 'cancelled')),
  constraint route_pickup_batches_product_summary_array check (jsonb_typeof(product_summary) = 'array')
);

create table if not exists public.route_pickup_batch_stops (
  pickup_batch_id uuid not null references public.route_pickup_batches(id) on delete cascade,
  route_stop_id uuid not null references public.route_stops(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pickup_batch_id, route_stop_id)
);

alter table if exists public.route_pick_list_items
  add column if not exists route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists route_stop_item_id uuid references public.route_stop_items(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

alter table if exists public.inventory_movements
  add column if not exists related_pickup_batch_id uuid;

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null
    and to_regclass('public.inventory_movements') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'inventory_movements_related_pickup_batch_id_fkey'
        and conrelid = 'public.inventory_movements'::regclass
    )
  then
    alter table public.inventory_movements
      add constraint inventory_movements_related_pickup_batch_id_fkey
      foreign key (related_pickup_batch_id)
      references public.route_pickup_batches(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_route_pick_list_items_route_stop_id
  on public.route_pick_list_items(route_stop_id);

create index if not exists idx_route_pick_list_items_route_stop_item_id
  on public.route_pick_list_items(route_stop_item_id);

create index if not exists idx_route_pick_list_items_machine_id
  on public.route_pick_list_items(machine_id);

create index if not exists idx_route_pick_list_items_pickup_batch_id
  on public.route_pick_list_items(pickup_batch_id);

create index if not exists idx_route_pickup_batches_route_id
  on public.route_pickup_batches(route_id);

create index if not exists idx_route_pickup_batches_operator_id
  on public.route_pickup_batches(operator_id);

create index if not exists idx_route_pickup_batch_stops_route_stop_id
  on public.route_pickup_batch_stops(route_stop_id);

create index if not exists idx_inventory_movements_pickup_batch_id
  on public.inventory_movements(related_pickup_batch_id);

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
        or public.snacky_profile_has_any_role(tm.roles, tm.role, allowed_roles)
      )
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null then
    execute 'alter table public.route_pickup_batches enable row level security';
    execute 'grant select, insert, update, delete on table public.route_pickup_batches to authenticated';

    execute 'drop policy if exists "snacky_route_pickup_batches_select_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_insert_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_update_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_delete_by_route_access" on public.route_pickup_batches';

    execute $sql$
      create policy "snacky_route_pickup_batches_select_by_route_access"
      on public.route_pickup_batches for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_insert_by_route_access"
      on public.route_pickup_batches for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_update_by_route_access"
      on public.route_pickup_batches for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_delete_by_route_access"
      on public.route_pickup_batches for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_pickup_batch_stops') is not null then
    execute 'alter table public.route_pickup_batch_stops enable row level security';
    execute 'grant select, insert, update, delete on table public.route_pickup_batch_stops to authenticated';

    execute 'drop policy if exists "snacky_route_pickup_batch_stops_select_by_route_access" on public.route_pickup_batch_stops';
    execute 'drop policy if exists "snacky_route_pickup_batch_stops_insert_by_route_access" on public.route_pickup_batch_stops';
    execute 'drop policy if exists "snacky_route_pickup_batch_stops_delete_by_route_access" on public.route_pickup_batch_stops';

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_select_by_route_access"
      on public.route_pickup_batch_stops for select
      to authenticated
      using (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_insert_by_route_access"
      on public.route_pickup_batch_stops for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_delete_by_route_access"
      on public.route_pickup_batch_stops for delete
      to authenticated
      using (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;
  end if;
end $$;

drop function if exists public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[]
);

create or replace function public.confirm_route_pickup_batch(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean default false,
  p_pickup_batch jsonb default null,
  p_batch_stop_ids uuid[] default '{}'::uuid[],
  p_new_stop_item_rows jsonb default '[]'::jsonb,
  p_inventory_movements jsonb default '[]'::jsonb,
  p_pick_list_rows jsonb default '[]'::jsonb,
  p_stock_line_rows jsonb default '[]'::jsonb,
  p_stop_item_picks jsonb default '[]'::jsonb,
  p_refill_line_picks jsonb default '[]'::jsonb,
  p_selected_stop_ids uuid[] default '{}'::uuid[],
  p_selected_machine_ids uuid[] default '{}'::uuid[]
)
returns table(pickup_batch_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pickup_batch_id uuid;
  v_expected_stop_count integer;
  v_updated_stop_count integer;
begin
  if p_pickup_batch is not null and jsonb_typeof(p_pickup_batch) = 'object' then
    v_pickup_batch_id := coalesce((p_pickup_batch->>'id')::uuid, gen_random_uuid());

    insert into public.route_pickup_batches (
      id,
      route_id,
      operator_id,
      status,
      selected_stop_ids,
      product_summary,
      storage_deducted,
      confirmed_at
    )
    values (
      v_pickup_batch_id,
      p_route_id,
      nullif(p_pickup_batch->>'operator_id', '')::uuid,
      coalesce(nullif(p_pickup_batch->>'status', ''), 'confirmed'),
      coalesce(p_batch_stop_ids, '{}'::uuid[]),
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb),
      coalesce((p_pickup_batch->>'storage_deducted')::boolean, false),
      nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz
    );

    if coalesce(array_length(p_batch_stop_ids, 1), 0) > 0 then
      insert into public.route_pickup_batch_stops (pickup_batch_id, route_stop_id)
      select v_pickup_batch_id, unnest(p_batch_stop_ids)
      on conflict do nothing;
    end if;
  end if;

  if jsonb_array_length(coalesce(p_new_stop_item_rows, '[]'::jsonb)) > 0 then
    insert into public.route_stop_items (
      id,
      route_id,
      route_stop_id,
      machine_id,
      product_id,
      machine_slot_id,
      slot_code,
      planned_quantity,
      picked_quantity,
      source,
      notes
    )
    select
      x.id,
      p_route_id,
      x.route_stop_id,
      x.machine_id,
      x.product_id,
      x.machine_slot_id,
      x.slot_code,
      x.planned_quantity,
      x.picked_quantity,
      x.source,
      x.notes
    from jsonb_to_recordset(p_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    );
  end if;

  if p_replace_pick_list then
    delete from public.route_pick_list_items
    where route_id = p_route_id;
  end if;

  if jsonb_array_length(coalesce(p_inventory_movements, '[]'::jsonb)) > 0 then
    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_route_id,
      related_pickup_batch_id,
      created_by,
      notes
    )
    select
      x.product_id,
      x.quantity,
      x.from_entity_type::public.inventory_entity_type,
      x.from_entity_id,
      x.to_entity_type::public.inventory_entity_type,
      x.to_entity_id,
      x.reason::public.movement_reason,
      p_route_id,
      x.related_pickup_batch_id,
      x.created_by,
      x.notes
    from jsonb_to_recordset(p_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    );
  end if;

  if jsonb_array_length(coalesce(p_pick_list_rows, '[]'::jsonb)) > 0 then
    insert into public.route_pick_list_items (
      route_id,
      route_stop_id,
      route_stop_item_id,
      machine_id,
      product_id,
      planned_qty,
      picked_qty,
      action_type,
      pickup_batch_id,
      reason,
      notes,
      needs_review,
      created_by
    )
    select
      p_route_id,
      x.route_stop_id,
      x.route_stop_item_id,
      x.machine_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      x.action_type,
      x.pickup_batch_id,
      x.reason,
      x.notes,
      x.needs_review,
      x.created_by
    from jsonb_to_recordset(p_pick_list_rows) as x(
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid
    );
  end if;

  if jsonb_array_length(coalesce(p_stock_line_rows, '[]'::jsonb)) > 0 then
    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      updated_at
    )
    select
      p_route_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(p_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    on conflict (route_id, product_id)
    do update set
      planned_qty = excluded.planned_qty,
      picked_qty = excluded.picked_qty,
      updated_at = excluded.updated_at;
  end if;

  if jsonb_array_length(coalesce(p_stop_item_picks, '[]'::jsonb)) > 0 then
    update public.route_stop_items rsi
    set picked_quantity = x.picked_quantity,
        updated_at = now()
    from jsonb_to_recordset(p_stop_item_picks) as x(id uuid, picked_quantity integer)
    where rsi.id = x.id
      and rsi.route_id = p_route_id;
  end if;

  if jsonb_array_length(coalesce(p_refill_line_picks, '[]'::jsonb)) > 0 then
    update public.refill_order_lines rol
    set picked_qty = x.picked_qty
    from jsonb_to_recordset(p_refill_line_picks) as x(id uuid, picked_qty integer)
    where rol.id = x.id;
  end if;

  update public.routes
  set status = p_next_route_status,
      started_at = coalesce(started_at, p_started_at)
  where id = p_route_id
    and status = p_expected_route_status;

  if not found then
    raise exception 'Route % could not be updated because its status changed.', p_route_id
      using errcode = 'P0001';
  end if;

  v_expected_stop_count := coalesce(array_length(p_selected_stop_ids, 1), 0);
  if v_expected_stop_count > 0 then
    update public.route_stops
    set status = 'picked'::public.route_stop_status
    where route_id = p_route_id
      and id = any(p_selected_stop_ids)
      and status = 'pending'::public.route_stop_status;

    get diagnostics v_updated_stop_count = row_count;
    if v_updated_stop_count <> v_expected_stop_count then
      raise exception 'Only pending stops can be picked for route %.', p_route_id
        using errcode = 'P0001';
    end if;
  end if;

  update public.refill_orders
  set status = 'picked'::public.refill_status
  where route_id = p_route_id
    and status in ('assigned'::public.refill_status, 'in_progress'::public.refill_status, 'picked'::public.refill_status)
    and (
      coalesce(array_length(p_selected_machine_ids, 1), 0) = 0
      or machine_id = any(p_selected_machine_ids)
    );

  return query select v_pickup_batch_id;
end;
$$;

grant execute on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[]
) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605250002_fix_purchase_creation_rpc.sql
-- ============================================================================

create or replace function public.snacky_create_purchase_with_lines(
  p_supplier_id uuid,
  p_order_date date,
  p_receipt_number text,
  p_payment_method text,
  p_payment_status text,
  p_receipt_url text,
  p_receipt_file_name text,
  p_receipt_content_type text,
  p_receipt_storage_path text,
  p_notes text,
  p_calculated_total_lyd numeric,
  p_manual_total_lyd numeric,
  p_total_adjustment_lyd numeric,
  p_total_source text,
  p_total_amount numeric,
  p_created_by uuid,
  p_submit_action text,
  p_lines jsonb
)
returns table (
  id uuid,
  receipt_number text,
  status text,
  total_amount numeric,
  payment_status text,
  movement_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase_id uuid;
  v_storage_id uuid;
  v_submit_action text;
  v_payment_status text;
  v_total_source text;
  v_total_amount numeric;
  v_created_by uuid;
  v_actor_team_member_id uuid;
  v_movement_count integer := 0;
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'Permission denied for purchase save' using errcode = '42501';
  end if;

  select coalesce(p.team_member_id, tm.id)
  into v_actor_team_member_id
  from public.profiles p
  left join public.team_members tm
    on tm.id = p.team_member_id
    or tm.auth_user_id = p.id
  where p.id = auth.uid()
    and p.active_status = 'active'
  limit 1;

  if p_created_by is not null
    and v_actor_team_member_id is not null
    and p_created_by <> v_actor_team_member_id
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  then
    raise exception 'Permission denied for purchase actor' using errcode = '42501';
  end if;

  v_created_by := coalesce(v_actor_team_member_id, p_created_by);
  v_submit_action := case
    when lower(trim(coalesce(p_submit_action, ''))) in ('received', 'receive', 'submitted', 'submit') then 'received'
    else 'draft'
  end;
  v_payment_status := lower(trim(coalesce(p_payment_status, 'paid')));
  if v_payment_status = 'partial' then
    v_payment_status := 'partially_paid';
  end if;
  if v_payment_status not in ('paid', 'unpaid', 'partially_paid', 'voided') then
    v_payment_status := 'paid';
  end if;
  v_total_source := case
    when lower(trim(coalesce(p_total_source, ''))) = 'manual' then 'manual'
    else 'calculated'
  end;
  v_total_amount := greatest(coalesce(p_total_amount, p_manual_total_lyd, p_calculated_total_lyd, 0), 0);

  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Purchase must include at least one line item' using errcode = '22023';
  end if;

  insert into public.purchase_orders (
    supplier_id,
    status,
    order_date,
    receipt_number,
    payment_method,
    payment_status,
    receipt_url,
    receipt_file_name,
    receipt_content_type,
    receipt_storage_path,
    notes,
    calculated_total_lyd,
    manual_total_lyd,
    total_adjustment_lyd,
    total_source,
    total_amount,
    created_by
  )
  values (
    p_supplier_id,
    'draft',
    coalesce(p_order_date, current_date),
    nullif(trim(coalesce(p_receipt_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_payment_method, '')), ''), 'cash'),
    v_payment_status,
    nullif(trim(coalesce(p_receipt_url, '')), ''),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_receipt_content_type, '')), ''),
    nullif(trim(coalesce(p_receipt_storage_path, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    greatest(coalesce(p_calculated_total_lyd, 0), 0),
    p_manual_total_lyd,
    p_total_adjustment_lyd,
    v_total_source,
    v_total_amount,
    v_created_by
  )
  returning purchase_orders.id into v_purchase_id;

  with parsed_lines as (
    select
      line.product_id,
      greatest(coalesce(line.line_position, 0), 0) as line_position,
      floor(greatest(coalesce(line.boxes_qty, line.box_qty, line.box_quantity, 0), 0))::integer as boxes_qty,
      floor(greatest(coalesce(line.units_per_box, line.pieces_per_box, 1), 1))::integer as units_per_box,
      floor(greatest(coalesce(line.loose_units_qty, line.loose_units, 0), 0))::integer as loose_units_qty,
      line.total_units as explicit_total_units,
      line.received_units,
      line.quantity,
      line.ordered_qty,
      greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0) as raw_unit_cost,
      greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0) as raw_line_total
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid,
      line_position integer,
      boxes_qty numeric,
      box_qty numeric,
      box_quantity numeric,
      units_per_box numeric,
      pieces_per_box numeric,
      loose_units_qty numeric,
      loose_units numeric,
      total_units numeric,
      received_units numeric,
      quantity numeric,
      ordered_qty numeric,
      unit_cost numeric,
      unit_cost_lyd numeric,
      line_total numeric,
      line_total_lyd numeric,
      notes text
    )
  ),
  normalized_lines as (
    select
      parsed_lines.product_id,
      parsed_lines.line_position,
      parsed_lines.boxes_qty,
      parsed_lines.units_per_box,
      parsed_lines.loose_units_qty,
      floor(
        greatest(
          coalesce(
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as total_units,
      floor(
        greatest(
          coalesce(
            parsed_lines.ordered_qty,
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as ordered_qty,
      parsed_lines.raw_unit_cost,
      parsed_lines.raw_line_total
    from parsed_lines
  ),
  priced_lines as (
    select
      normalized_lines.product_id,
      normalized_lines.line_position,
      normalized_lines.boxes_qty,
      normalized_lines.units_per_box,
      normalized_lines.loose_units_qty,
      normalized_lines.total_units,
      greatest(normalized_lines.ordered_qty, normalized_lines.total_units) as ordered_qty,
      case
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.raw_unit_cost
        when normalized_lines.raw_line_total > 0 and normalized_lines.total_units > 0 then normalized_lines.raw_line_total / normalized_lines.total_units
        else 0
      end as unit_cost,
      case
        when normalized_lines.raw_line_total > 0 then normalized_lines.raw_line_total
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.total_units * normalized_lines.raw_unit_cost
        else 0
      end as line_total
    from normalized_lines
  )
  insert into public.purchase_order_lines (
    purchase_order_id,
    product_id,
    line_position,
    boxes_qty,
    units_per_box,
    loose_units_qty,
    total_units,
    ordered_qty,
    received_qty,
    unit_cost,
    unit_cost_lyd,
    line_total,
    line_total_lyd
  )
  select
    v_purchase_id,
    priced_lines.product_id,
    priced_lines.line_position,
    priced_lines.boxes_qty,
    priced_lines.units_per_box,
    priced_lines.loose_units_qty,
    priced_lines.total_units,
    priced_lines.ordered_qty,
    case when v_submit_action = 'received' then priced_lines.total_units else 0 end,
    priced_lines.unit_cost,
    priced_lines.unit_cost,
    priced_lines.line_total,
    priced_lines.line_total
  from priced_lines
  where priced_lines.product_id is not null
    and priced_lines.total_units > 0;

  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v_purchase_id) then
    raise exception 'Purchase must include at least one valid line item' using errcode = '22023';
  end if;

  if v_submit_action = 'received' then
    select sl.id
    into v_storage_id
    from public.storage_locations sl
    where sl.active = true
      and sl.location_type = 'main_storage'
    order by sl.name
    limit 1;

    if v_storage_id is null then
      select sl.id
      into v_storage_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type in ('vehicle', 'temporary', 'other')
      order by sl.name
      limit 1;
    end if;

    if v_storage_id is null then
      raise exception 'No active storage location found' using errcode = '23514';
    end if;

    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_purchase_id,
      related_purchase_line_id,
      unit_cost_lyd,
      line_total_lyd,
      created_by,
      notes
    )
    select
      pol.product_id,
      pol.total_units,
      'supplier',
      p_supplier_id,
      'storage',
      v_storage_id,
      'purchase_received',
      v_purchase_id,
      pol.id,
      coalesce(pol.unit_cost_lyd, pol.unit_cost, 0),
      coalesce(pol.line_total_lyd, pol.line_total, 0),
      v_created_by,
      'Purchase received'
    from public.purchase_order_lines pol
    where pol.purchase_order_id = v_purchase_id
      and pol.total_units > 0;

    get diagnostics v_movement_count = row_count;

    if v_movement_count = 0 then
      raise exception 'Purchase receipt created no inventory movements' using errcode = '23514';
    end if;

    with latest_line as (
      select distinct on (pol.product_id)
        pol.product_id,
        coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) as latest_cost
      from public.purchase_order_lines pol
      where pol.purchase_order_id = v_purchase_id
      order by pol.product_id, pol.line_position desc, pol.id desc
    )
    update public.products p
    set
      cost_price = latest_line.latest_cost,
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      cost_price_source = 'latest_purchase',
      price_updated_at = now(),
      updated_at = now()
    from latest_line
    where p.id = latest_line.product_id;

    update public.purchase_orders po
    set
      status = 'received',
      received_at = now(),
      received_date = current_date,
      received_by = v_created_by,
      updated_at = now()
    where po.id = v_purchase_id;
  end if;

  return query
  select
    po.id,
    po.receipt_number,
    po.status,
    po.total_amount,
    po.payment_status,
    v_movement_count
  from public.purchase_orders po
  where po.id = v_purchase_id;
end;
$$;

revoke all on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) from public;

revoke execute on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) from anon;

grant execute on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605250003_confirm_pickup_transaction_guards.sql
-- ============================================================================

alter type public.route_status add value if not exists 'pickup_confirmed';

alter type public.route_stop_status add value if not exists 'picked';
alter type public.route_stop_status add value if not exists 'in_progress';
alter type public.route_stop_status add value if not exists 'canceled';

alter table if exists public.route_pick_list_items
  add column if not exists route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists route_stop_item_id uuid references public.route_stop_items(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

alter table if exists public.inventory_movements
  add column if not exists related_pickup_batch_id uuid;

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null
    and to_regclass('public.inventory_movements') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'inventory_movements_related_pickup_batch_id_fkey'
        and conrelid = 'public.inventory_movements'::regclass
    )
  then
    alter table public.inventory_movements
      add constraint inventory_movements_related_pickup_batch_id_fkey
      foreign key (related_pickup_batch_id)
      references public.route_pickup_batches(id)
      on delete set null;
  end if;
end $$;

drop function if exists public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[]
);

create or replace function public.confirm_route_pickup_batch(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean default false,
  p_pickup_batch jsonb default null,
  p_batch_stop_ids uuid[] default '{}'::uuid[],
  p_new_stop_item_rows jsonb default '[]'::jsonb,
  p_inventory_movements jsonb default '[]'::jsonb,
  p_pick_list_rows jsonb default '[]'::jsonb,
  p_stock_line_rows jsonb default '[]'::jsonb,
  p_stop_item_picks jsonb default '[]'::jsonb,
  p_refill_line_picks jsonb default '[]'::jsonb,
  p_selected_stop_ids uuid[] default '{}'::uuid[],
  p_selected_machine_ids uuid[] default '{}'::uuid[]
)
returns table(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_stop_ids uuid[],
  pending_stop_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_route record;
  v_pickup_batch_id uuid;
  v_batch_stop_ids uuid[] := case
    when coalesce(array_length(p_batch_stop_ids, 1), 0) > 0 then p_batch_stop_ids
    else coalesce(p_selected_stop_ids, '{}'::uuid[])
  end;
  v_new_stop_item_rows jsonb := coalesce(p_new_stop_item_rows, '[]'::jsonb);
  v_inventory_movements jsonb := coalesce(p_inventory_movements, '[]'::jsonb);
  v_pick_list_rows jsonb := coalesce(p_pick_list_rows, '[]'::jsonb);
  v_stock_line_rows jsonb := coalesce(p_stock_line_rows, '[]'::jsonb);
  v_stop_item_picks jsonb := coalesce(p_stop_item_picks, '[]'::jsonb);
  v_refill_line_picks jsonb := coalesce(p_refill_line_picks, '[]'::jsonb);
  v_expected_stop_count integer := coalesce(array_length(p_selected_stop_ids, 1), 0);
  v_updated_stop_count integer := 0;
  v_pending_after_count integer := 0;
  v_invalid_count integer := 0;
  v_invalid_stops text;
  v_missing_products text;
  v_product_name text;
  v_available integer;
  v_needed integer;
  v_stock record;
  v_next_route_status public.route_status;
  v_has_storage_deductions boolean := false;
begin
  if p_route_id is null then
    raise exception 'Route id is required for pickup confirmation.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_new_stop_item_rows) <> 'array'
    or jsonb_typeof(v_inventory_movements) <> 'array'
    or jsonb_typeof(v_pick_list_rows) <> 'array'
    or jsonb_typeof(v_stock_line_rows) <> 'array'
    or jsonb_typeof(v_stop_item_picks) <> 'array'
    or jsonb_typeof(v_refill_line_picks) <> 'array'
  then
    raise exception 'Pickup confirmation payload is invalid.' using errcode = 'P0001';
  end if;

  if p_pickup_batch is not null and jsonb_typeof(p_pickup_batch) <> 'object' then
    raise exception 'Pickup batch payload is invalid.' using errcode = 'P0001';
  end if;

  select r.id, r.operator_id, r.status, r.started_at
  into v_route
  from public.routes r
  where r.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0001';
  end if;

  if v_route.operator_id is null then
    raise exception 'Route must be assigned to an operator before pickup can be confirmed.' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Route status does not allow pickup confirmation: %.', v_route.status::text using errcode = 'P0001';
  end if;

  if v_route.status::text not in ('draft', 'assigned', 'in_progress', 'pickup_confirmed') then
    raise exception 'Route status does not allow pickup confirmation: %.', v_route.status::text using errcode = 'P0001';
  end if;

  if p_expected_route_status is not null and v_route.status <> p_expected_route_status then
    raise exception 'Route status changed from % to %. Refresh the route before confirming pickup.', p_expected_route_status::text, v_route.status::text
      using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'User does not have permission to confirm pickup for this route.' using errcode = '42501';
  end if;

  if p_pickup_batch is not null then
    if nullif(p_pickup_batch->>'route_id', '') is not null and nullif(p_pickup_batch->>'route_id', '')::uuid <> p_route_id then
      raise exception 'Pickup batch route does not match the selected route.' using errcode = 'P0001';
    end if;

    if nullif(p_pickup_batch->>'operator_id', '') is not null and nullif(p_pickup_batch->>'operator_id', '')::uuid <> v_route.operator_id then
      raise exception 'Pickup batch operator does not match the route operator.' using errcode = 'P0001';
    end if;

    if p_pickup_batch ? 'product_summary' and jsonb_typeof(p_pickup_batch->'product_summary') <> 'array' then
      raise exception 'Pickup batch product summary is invalid.' using errcode = 'P0001';
    end if;
  end if;

  if v_expected_stop_count > 0 then
    select count(*)
    into v_invalid_count
    from unnest(p_selected_stop_ids) as selected_stop_id
    left join public.route_stops rs
      on rs.id = selected_stop_id
     and rs.route_id = p_route_id
    where rs.id is null;

    if v_invalid_count > 0 then
      raise exception 'Selected pickup stop does not belong to this route.' using errcode = 'P0001';
    end if;

    select string_agg(format('stop %s is %s', rs.id, rs.status::text), '; ')
    into v_invalid_stops
    from public.route_stops rs
    where rs.route_id = p_route_id
      and rs.id = any(p_selected_stop_ids)
      and rs.status <> 'pending'::public.route_stop_status;

    if v_invalid_stops is not null then
      raise exception 'Stop status does not allow pickup confirmation: %.', v_invalid_stops using errcode = 'P0001';
    end if;
  end if;

  with product_ids as (
    select product_id from jsonb_to_recordset(v_inventory_movements) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_pick_list_rows) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_stock_line_rows) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_new_stop_item_rows) as x(product_id uuid)
  )
  select string_agg(product_id::text, ', ')
  into v_missing_products
  from (
    select distinct product_id
    from product_ids
    where product_id is not null
  ) ids
  left join public.products p on p.id = ids.product_id
  where p.id is null;

  if v_missing_products is not null then
    raise exception 'Product is missing from inventory/product catalog: %.', v_missing_products using errcode = 'P0001';
  end if;

  if jsonb_array_length(v_inventory_movements) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    )
    where x.product_id is null
      or coalesce(x.quantity, 0) <= 0
      or x.reason not in ('storage_to_operator_bag', 'operator_bag_to_storage')
      or (
        x.reason = 'storage_to_operator_bag'
        and (
          x.from_entity_type <> 'storage'
          or x.from_entity_id is null
          or x.to_entity_type <> 'operator_bag'
          or x.to_entity_id is distinct from v_route.operator_id
        )
      )
      or (
        x.reason = 'operator_bag_to_storage'
        and (
          x.from_entity_type <> 'operator_bag'
          or x.from_entity_id is distinct from v_route.operator_id
          or x.to_entity_type <> 'storage'
          or x.to_entity_id is null
        )
      );

    if v_invalid_count > 0 then
      raise exception 'Inventory movement could not be created because the movement payload is invalid.' using errcode = 'P0001';
    end if;

    select exists (
      select 1
      from jsonb_to_recordset(v_inventory_movements) as x(reason text)
      where x.reason = 'storage_to_operator_bag'
    )
    into v_has_storage_deductions;

    for v_stock in
      select x.product_id, x.from_entity_id, sum(x.quantity)::integer as needed_qty
      from jsonb_to_recordset(v_inventory_movements) as x(
        product_id uuid,
        quantity integer,
        from_entity_type text,
        from_entity_id uuid,
        to_entity_type text,
        to_entity_id uuid,
        reason text
      )
      where x.reason = 'storage_to_operator_bag'
      group by x.product_id, x.from_entity_id
    loop
      perform pg_advisory_xact_lock(hashtext(v_stock.product_id::text), hashtext(v_stock.from_entity_id::text));

      select p.name
      into v_product_name
      from public.products p
      where p.id = v_stock.product_id;

      select coalesce(sum(cibl.quantity_on_hand), 0)::integer
      into v_available
      from public.current_inventory_by_location cibl
      where cibl.location_type = 'storage'
        and cibl.product_id = v_stock.product_id
        and cibl.location_id = v_stock.from_entity_id;

      v_needed := coalesce(v_stock.needed_qty, 0);
      if v_available is null or v_available <= 0 then
        raise exception 'Product % is missing from inventory at the selected storage location.', coalesce(v_product_name, v_stock.product_id::text)
          using errcode = 'P0001';
      end if;

      if v_available < v_needed then
        raise exception 'Not enough storage stock for %. Needed %, available %.', coalesce(v_product_name, v_stock.product_id::text), v_needed, v_available
          using errcode = 'P0001';
      end if;
    end loop;
  end if;

  if jsonb_array_length(v_new_stop_item_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    )
    left join public.route_stops rs
      on rs.id = x.route_stop_id
     and rs.route_id = p_route_id
    where x.id is null
      or x.route_stop_id is null
      or x.machine_id is null
      or x.product_id is null
      or coalesce(x.planned_quantity, 0) < 0
      or coalesce(x.picked_quantity, 0) < 0
      or x.source not in ('refill_recommendation', 'manual_admin_assignment')
      or rs.id is null
      or rs.machine_id <> x.machine_id
      or (v_expected_stop_count > 0 and x.route_stop_id <> all(p_selected_stop_ids));

    if v_invalid_count > 0 then
      raise exception 'Added pickup product is not linked to a valid selected stop.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_array_length(v_stop_item_picks) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_stop_item_picks) as x(id uuid, picked_quantity integer)
    left join public.route_stop_items rsi
      on rsi.id = x.id
     and rsi.route_id = p_route_id
    left join jsonb_to_recordset(v_new_stop_item_rows) as new_rsi(id uuid)
      on new_rsi.id = x.id
    where x.id is null
      or x.picked_quantity is null
      or x.picked_quantity < 0
      or coalesce(rsi.id, new_rsi.id) is null;

    if v_invalid_count > 0 then
      raise exception 'Route pick item is missing from this route.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_array_length(v_refill_line_picks) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_refill_line_picks) as x(id uuid, picked_qty integer)
    left join public.refill_order_lines rol on rol.id = x.id
    left join public.refill_orders ro
      on ro.id = rol.refill_order_id
     and ro.route_id = p_route_id
    where x.id is null
      or x.picked_qty is null
      or x.picked_qty < 0
      or ro.id is null;

    if v_invalid_count > 0 then
      raise exception 'Refill order line is missing from this route.' using errcode = 'P0001';
    end if;
  end if;

  if p_pickup_batch is not null or coalesce(array_length(v_batch_stop_ids, 1), 0) > 0 then
    v_pickup_batch_id := coalesce(nullif(p_pickup_batch->>'id', '')::uuid, gen_random_uuid());

    insert into public.route_pickup_batches (
      id,
      route_id,
      operator_id,
      status,
      selected_stop_ids,
      product_summary,
      storage_deducted,
      confirmed_at
    )
    values (
      v_pickup_batch_id,
      p_route_id,
      coalesce(nullif(p_pickup_batch->>'operator_id', '')::uuid, v_route.operator_id),
      coalesce(nullif(p_pickup_batch->>'status', ''), 'confirmed'),
      coalesce(v_batch_stop_ids, '{}'::uuid[]),
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb),
      coalesce((p_pickup_batch->>'storage_deducted')::boolean, v_has_storage_deductions),
      coalesce(nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz, now())
    );

    if coalesce(array_length(v_batch_stop_ids, 1), 0) > 0 then
      insert into public.route_pickup_batch_stops (pickup_batch_id, route_stop_id)
      select v_pickup_batch_id, unnest(v_batch_stop_ids)
      on conflict do nothing;
    end if;
  end if;

  if jsonb_array_length(v_new_stop_item_rows) > 0 then
    insert into public.route_stop_items (
      id,
      route_id,
      route_stop_id,
      machine_id,
      product_id,
      machine_slot_id,
      slot_code,
      planned_quantity,
      picked_quantity,
      source,
      notes
    )
    select
      x.id,
      p_route_id,
      x.route_stop_id,
      x.machine_id,
      x.product_id,
      x.machine_slot_id,
      x.slot_code,
      x.planned_quantity,
      x.picked_quantity,
      x.source,
      x.notes
    from jsonb_to_recordset(v_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    );
  end if;

  if p_replace_pick_list then
    delete from public.route_pick_list_items
    where route_id = p_route_id;
  end if;

  if jsonb_array_length(v_pick_list_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_pick_list_rows) as x(
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid
    )
    left join public.route_stops rs
      on rs.id = x.route_stop_id
     and rs.route_id = p_route_id
    left join public.route_stop_items rsi
      on rsi.id = x.route_stop_item_id
     and rsi.route_id = p_route_id
    where x.product_id is null
      or x.planned_qty is null
      or x.picked_qty is null
      or x.planned_qty < 0
      or x.picked_qty < 0
      or x.action_type not in ('planned_pick', 'extra_product', 'substitution')
      or (x.route_stop_id is not null and rs.id is null)
      or (x.route_stop_id is not null and v_expected_stop_count > 0 and x.route_stop_id <> all(p_selected_stop_ids))
      or (x.route_stop_item_id is not null and rsi.id is null)
      or (x.route_stop_item_id is not null and x.route_stop_id is not null and rsi.route_stop_id <> x.route_stop_id)
      or (x.route_stop_id is not null and x.machine_id is not null and rs.machine_id <> x.machine_id);

    if v_invalid_count > 0 then
      raise exception 'Pick list row is not valid for the selected route stops.' using errcode = 'P0001';
    end if;

    insert into public.route_pick_list_items (
      route_id,
      route_stop_id,
      route_stop_item_id,
      machine_id,
      product_id,
      planned_qty,
      picked_qty,
      action_type,
      pickup_batch_id,
      reason,
      notes,
      needs_review,
      created_by
    )
    select
      p_route_id,
      x.route_stop_id,
      x.route_stop_item_id,
      x.machine_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      x.action_type,
      coalesce(x.pickup_batch_id, v_pickup_batch_id),
      x.reason,
      x.notes,
      coalesce(x.needs_review, false),
      x.created_by
    from jsonb_to_recordset(v_pick_list_rows) as x(
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid
    );
  end if;

  if jsonb_array_length(v_inventory_movements) > 0 then
    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_route_id,
      related_pickup_batch_id,
      created_by,
      notes
    )
    select
      x.product_id,
      x.quantity,
      x.from_entity_type::public.inventory_entity_type,
      x.from_entity_id,
      x.to_entity_type::public.inventory_entity_type,
      x.to_entity_id,
      x.reason::public.movement_reason,
      p_route_id,
      case
        when x.reason = 'storage_to_operator_bag' then coalesce(x.related_pickup_batch_id, v_pickup_batch_id)
        else x.related_pickup_batch_id
      end,
      x.created_by,
      x.notes
    from jsonb_to_recordset(v_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    );
  end if;

  if jsonb_array_length(v_stock_line_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    where x.product_id is null
      or x.planned_qty is null
      or x.picked_qty is null
      or x.planned_qty < 0
      or x.picked_qty < 0;

    if v_invalid_count > 0 then
      raise exception 'Route stock line payload is invalid.' using errcode = 'P0001';
    end if;

    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      updated_at
    )
    select
      p_route_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(v_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    on conflict (route_id, product_id)
    do update set
      planned_qty = excluded.planned_qty,
      picked_qty = excluded.picked_qty,
      updated_at = excluded.updated_at;
  end if;

  if jsonb_array_length(v_stop_item_picks) > 0 then
    update public.route_stop_items rsi
    set picked_quantity = x.picked_quantity,
        updated_at = now()
    from jsonb_to_recordset(v_stop_item_picks) as x(id uuid, picked_quantity integer)
    where rsi.id = x.id
      and rsi.route_id = p_route_id;
  end if;

  if jsonb_array_length(v_refill_line_picks) > 0 then
    update public.refill_order_lines rol
    set picked_qty = x.picked_qty
    from jsonb_to_recordset(v_refill_line_picks) as x(id uuid, picked_qty integer),
      public.refill_orders ro
    where rol.id = x.id
      and ro.id = rol.refill_order_id
      and ro.route_id = p_route_id;
  end if;

  if v_expected_stop_count > 0 then
    update public.route_stops
    set status = 'picked'::public.route_stop_status
    where route_id = p_route_id
      and id = any(p_selected_stop_ids)
      and status = 'pending'::public.route_stop_status;

    get diagnostics v_updated_stop_count = row_count;
    if v_updated_stop_count <> v_expected_stop_count then
      raise exception 'Stop status does not allow pickup confirmation: only pending stops can be picked for this route.'
        using errcode = 'P0001';
    end if;
  end if;

  select count(*)
  into v_pending_after_count
  from public.route_stops
  where route_id = p_route_id
    and status = 'pending'::public.route_stop_status;

  if v_pending_after_count = 0 then
    v_next_route_status := 'pickup_confirmed'::public.route_status;
  else
    v_next_route_status := 'in_progress'::public.route_status;
  end if;

  update public.routes
  set status = v_next_route_status,
      started_at = coalesce(started_at, p_started_at, now())
  where id = p_route_id;

  update public.refill_orders
  set status = 'picked'::public.refill_status
  where route_id = p_route_id
    and status in ('assigned'::public.refill_status, 'in_progress'::public.refill_status, 'picked'::public.refill_status)
    and (
      coalesce(array_length(p_selected_machine_ids, 1), 0) = 0
      or machine_id = any(p_selected_machine_ids)
    );

  return query select
    v_pickup_batch_id,
    v_next_route_status,
    coalesce(p_selected_stop_ids, '{}'::uuid[]),
    v_pending_after_count;
end;
$$;

revoke all on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[]
) from public;

grant execute on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[]
) to authenticated;

create or replace function public.validate_route_workflow_schema(
  p_route_statuses text[] default array[
    'draft',
    'assigned',
    'in_progress',
    'pickup_confirmed',
    'completed',
    'reviewed',
    'cancelled'
  ],
  p_route_stop_statuses text[] default array[
    'pending',
    'picked',
    'in_progress',
    'completed',
    'skipped',
    'canceled',
    'arrived',
    'refilling',
    'cash_collected',
    'issue_reported'
  ]
)
returns table(enum_name text, missing_values text[])
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with route_values as (
    select enumlabel::text as value
    from pg_catalog.pg_enum
    where enumtypid = 'public.route_status'::regtype
  ),
  route_stop_values as (
    select enumlabel::text as value
    from pg_catalog.pg_enum
    where enumtypid = 'public.route_stop_status'::regtype
  ),
  route_missing as (
    select array_agg(required order by ord) as values
    from unnest(p_route_statuses) with ordinality as required_status(required, ord)
    where not exists (select 1 from route_values where value = required_status.required)
  ),
  route_stop_missing as (
    select array_agg(required order by ord) as values
    from unnest(p_route_stop_statuses) with ordinality as required_status(required, ord)
    where not exists (select 1 from route_stop_values where value = required_status.required)
  )
  select 'route_status'::text, coalesce(values, '{}'::text[]) from route_missing where coalesce(array_length(values, 1), 0) > 0
  union all
  select 'route_stop_status'::text, coalesce(values, '{}'::text[]) from route_stop_missing where coalesce(array_length(values, 1), 0) > 0;
$$;

revoke all on function public.validate_route_workflow_schema(text[], text[]) from public;
grant execute on function public.validate_route_workflow_schema(text[], text[]) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605250004_purchase_rpc_rls_policies.sql
-- ============================================================================

create or replace function public.snacky_profile_has_any_role(profile_roles team_role[], primary_role team_role, allowed_roles text[])
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from unnest(array_remove(coalesce(profile_roles, array[]::team_role[]) || array[primary_role], null)) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$$;

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
        or public.snacky_profile_has_any_role(tm.roles, tm.role, allowed_roles)
      )
  );
$$;

create or replace function public.snacky_current_profile_can_add_products()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.can_add_products = true
        or tm.can_add_products = true
        or public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'warehouse', 'purchasing'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'warehouse', 'purchasing'])
      )
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;

create or replace function public.snacky_operator_can_read_product(target_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator'])
      )
      and (
        exists (
          select 1
          from public.routes r
          join public.route_stock_lines rsl on rsl.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsl.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.route_stop_items rsi on rsi.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsi.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.refill_orders ro on ro.route_id = r.id
          join public.refill_order_lines rol on rol.refill_order_id = ro.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rol.product_id = target_product_id
        )
      )
  );
$$;

grant execute on function public.snacky_profile_has_any_role(team_role[], team_role, text[]) to authenticated;
grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_current_profile_can_add_products() to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;
grant execute on function public.snacky_operator_can_read_product(uuid) to authenticated;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'alter table public.products enable row level security';
    execute 'drop policy if exists "snacky_products_select_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_insert_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_update_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_delete_by_effective_role" on public.products';

    execute $sql$
      create policy "snacky_products_select_by_effective_role"
      on public.products for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance'])
        or public.snacky_operator_can_read_product(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_insert_by_effective_role"
      on public.products for insert
      to authenticated
      with check (public.snacky_current_profile_can_add_products())
    $sql$;

    execute $sql$
      create policy "snacky_products_update_by_effective_role"
      on public.products for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_products_delete_by_effective_role"
      on public.products for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.storage_locations') is not null then
    execute 'alter table public.storage_locations enable row level security';
    execute 'drop policy if exists "snacky_storage_locations_select_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_insert_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_update_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_delete_by_effective_role" on public.storage_locations';

    execute $sql$
      create policy "snacky_storage_locations_select_by_effective_role"
      on public.storage_locations for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_insert_by_effective_role"
      on public.storage_locations for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_update_by_effective_role"
      on public.storage_locations for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_delete_by_effective_role"
      on public.storage_locations for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.suppliers') is not null then
    execute 'alter table public.suppliers enable row level security';
    execute 'drop policy if exists "snacky_suppliers_select_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_insert_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_update_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_delete_by_effective_role" on public.suppliers';

    execute $sql$
      create policy "snacky_suppliers_select_by_effective_role"
      on public.suppliers for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_insert_by_effective_role"
      on public.suppliers for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_update_by_effective_role"
      on public.suppliers for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_delete_by_effective_role"
      on public.suppliers for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.purchase_orders') is not null then
    execute 'alter table public.purchase_orders enable row level security';
    execute 'drop policy if exists "snacky_purchase_orders_select_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_insert_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_update_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_delete_draft_by_effective_role" on public.purchase_orders';

    execute $sql$
      create policy "snacky_purchase_orders_select_by_effective_role"
      on public.purchase_orders for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_insert_by_effective_role"
      on public.purchase_orders for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_update_by_effective_role"
      on public.purchase_orders for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_delete_draft_by_effective_role"
      on public.purchase_orders for delete
      to authenticated
      using (
        status = 'draft'
        and public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing'])
      )
    $sql$;
  end if;

  if to_regclass('public.purchase_order_lines') is not null then
    execute 'alter table public.purchase_order_lines enable row level security';
    execute 'drop policy if exists "snacky_purchase_order_lines_select_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_insert_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_update_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_delete_draft_by_effective_role" on public.purchase_order_lines';

    execute $sql$
      create policy "snacky_purchase_order_lines_select_by_effective_role"
      on public.purchase_order_lines for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_insert_by_effective_role"
      on public.purchase_order_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_update_by_effective_role"
      on public.purchase_order_lines for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_delete_draft_by_effective_role"
      on public.purchase_order_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing'])
        and exists (
          select 1
          from public.purchase_orders po
          where po.id = purchase_order_id
            and po.status = 'draft'
        )
      )
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'alter table public.inventory_movements enable row level security';
    execute 'drop policy if exists "snacky_inventory_movements_select_by_effective_role" on public.inventory_movements';
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
      create policy "snacky_inventory_movements_select_by_effective_role"
      on public.inventory_movements for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or (related_route_id is not null and public.snacky_operator_can_access_route(related_route_id))
      )
    $sql$;

    execute $sql$
      create policy "snacky_inventory_movements_insert_by_effective_role"
      on public.inventory_movements for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_current_profile_has_any_role(array['warehouse', 'purchasing'])
          and reason::text = 'purchase_received'
          and from_entity_type::text = 'supplier'
          and to_entity_type::text = 'storage'
        )
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'manual_correction', 'damaged', 'expired', 'theft_or_missing', 'product_substitution'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'manual_correction', 'damaged', 'expired', 'product_substitution'])
        )
      )
    $sql$;
  end if;
end $$;

grant select on table public.products to authenticated;
grant select on table public.storage_locations to authenticated;
grant select on table public.suppliers to authenticated;
grant select on table public.purchase_orders to authenticated;
grant select on table public.purchase_order_lines to authenticated;
grant select on table public.inventory_movements to authenticated;
grant select on table public.current_inventory_by_location to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605260001_vms_sales_append_mapping_kpi.sql
-- ============================================================================

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


-- ============================================================================
-- Source migration: supabase/migrations/202605260002_purchase_unit_cost_memory.sql
-- ============================================================================

alter table public.products
  add column if not exists last_purchase_date date,
  add column if not exists last_supplier_id uuid,
  add column if not exists last_purchase_line_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_last_supplier_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_last_supplier_id_fkey
      foreign key (last_supplier_id) references public.suppliers(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_last_purchase_line_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_last_purchase_line_id_fkey
      foreign key (last_purchase_line_id) references public.purchase_order_lines(id) on delete set null;
  end if;
end $$;

create index if not exists idx_products_last_supplier_id
  on public.products(last_supplier_id);

create index if not exists idx_products_last_purchase_line_id
  on public.products(last_purchase_line_id);

with latest_received_cost as (
  select distinct on (pol.product_id)
    pol.product_id,
    pol.id as purchase_line_id,
    round(coalesce(pol.unit_cost_lyd, pol.unit_cost, 0)::numeric, 4) as latest_cost,
    coalesce(po.received_date, po.order_date, pol.created_at::date) as purchase_date,
    po.supplier_id
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) > 0
    and po.status = 'received'
  order by
    pol.product_id,
    coalesce(po.received_at, po.received_date::timestamptz, po.order_date::timestamptz, pol.created_at) desc,
    coalesce(pol.line_position, 0) desc,
    pol.id desc
)
update public.products p
set
  cost_price = round(latest_received_cost.latest_cost, 2),
  current_cost_price_lyd = latest_received_cost.latest_cost,
  last_purchase_cost_lyd = latest_received_cost.latest_cost,
  last_purchase_date = latest_received_cost.purchase_date,
  last_supplier_id = latest_received_cost.supplier_id,
  last_purchase_line_id = latest_received_cost.purchase_line_id,
  cost_price_source = 'latest_purchase',
  price_updated_at = coalesce(p.price_updated_at, now()),
  updated_at = now()
from latest_received_cost
where p.id = latest_received_cost.product_id;

create or replace function public.snacky_create_purchase_with_lines(
  p_supplier_id uuid,
  p_order_date date,
  p_receipt_number text,
  p_payment_method text,
  p_payment_status text,
  p_receipt_url text,
  p_receipt_file_name text,
  p_receipt_content_type text,
  p_receipt_storage_path text,
  p_notes text,
  p_calculated_total_lyd numeric,
  p_manual_total_lyd numeric,
  p_total_adjustment_lyd numeric,
  p_total_source text,
  p_total_amount numeric,
  p_created_by uuid,
  p_submit_action text,
  p_lines jsonb
)
returns table (
  id uuid,
  receipt_number text,
  status text,
  total_amount numeric,
  payment_status text,
  movement_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase_id uuid;
  v_storage_id uuid;
  v_submit_action text;
  v_payment_status text;
  v_total_source text;
  v_total_amount numeric;
  v_created_by uuid;
  v_actor_team_member_id uuid;
  v_movement_count integer := 0;
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'Permission denied for purchase save' using errcode = '42501';
  end if;

  select coalesce(p.team_member_id, tm.id)
  into v_actor_team_member_id
  from public.profiles p
  left join public.team_members tm
    on tm.id = p.team_member_id
    or tm.auth_user_id = p.id
  where p.id = auth.uid()
    and p.active_status = 'active'
  limit 1;

  if p_created_by is not null
    and v_actor_team_member_id is not null
    and p_created_by <> v_actor_team_member_id
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  then
    raise exception 'Permission denied for purchase actor' using errcode = '42501';
  end if;

  v_created_by := coalesce(v_actor_team_member_id, p_created_by);
  v_submit_action := case
    when lower(trim(coalesce(p_submit_action, ''))) in ('received', 'receive', 'submitted', 'submit') then 'received'
    else 'draft'
  end;
  v_payment_status := lower(trim(coalesce(p_payment_status, 'paid')));
  if v_payment_status = 'partial' then
    v_payment_status := 'partially_paid';
  end if;
  if v_payment_status not in ('paid', 'unpaid', 'partially_paid', 'voided') then
    v_payment_status := 'paid';
  end if;
  v_total_source := case
    when lower(trim(coalesce(p_total_source, ''))) = 'manual' then 'manual'
    else 'calculated'
  end;
  v_total_amount := greatest(coalesce(p_total_amount, p_manual_total_lyd, p_calculated_total_lyd, 0), 0);

  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Purchase must include at least one line item' using errcode = '22023';
  end if;

  insert into public.purchase_orders (
    supplier_id,
    status,
    order_date,
    receipt_number,
    payment_method,
    payment_status,
    receipt_url,
    receipt_file_name,
    receipt_content_type,
    receipt_storage_path,
    notes,
    calculated_total_lyd,
    manual_total_lyd,
    total_adjustment_lyd,
    total_source,
    total_amount,
    created_by
  )
  values (
    p_supplier_id,
    'draft',
    coalesce(p_order_date, current_date),
    nullif(trim(coalesce(p_receipt_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_payment_method, '')), ''), 'cash'),
    v_payment_status,
    nullif(trim(coalesce(p_receipt_url, '')), ''),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_receipt_content_type, '')), ''),
    nullif(trim(coalesce(p_receipt_storage_path, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    greatest(coalesce(p_calculated_total_lyd, 0), 0),
    p_manual_total_lyd,
    p_total_adjustment_lyd,
    v_total_source,
    v_total_amount,
    v_created_by
  )
  returning purchase_orders.id into v_purchase_id;

  with parsed_lines as (
    select
      line.product_id,
      greatest(coalesce(line.line_position, 0), 0) as line_position,
      floor(greatest(coalesce(line.boxes_qty, line.box_qty, line.box_quantity, 0), 0))::integer as boxes_qty,
      floor(greatest(coalesce(line.units_per_box, line.pieces_per_box, 1), 1))::integer as units_per_box,
      floor(greatest(coalesce(line.loose_units_qty, line.loose_units, 0), 0))::integer as loose_units_qty,
      line.total_units as explicit_total_units,
      line.received_units,
      line.quantity,
      line.ordered_qty,
      greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0) as raw_unit_cost,
      greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0) as raw_line_total
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid,
      line_position integer,
      boxes_qty numeric,
      box_qty numeric,
      box_quantity numeric,
      units_per_box numeric,
      pieces_per_box numeric,
      loose_units_qty numeric,
      loose_units numeric,
      total_units numeric,
      received_units numeric,
      quantity numeric,
      ordered_qty numeric,
      unit_cost numeric,
      unit_cost_lyd numeric,
      line_total numeric,
      line_total_lyd numeric,
      notes text
    )
  ),
  normalized_lines as (
    select
      parsed_lines.product_id,
      parsed_lines.line_position,
      parsed_lines.boxes_qty,
      parsed_lines.units_per_box,
      parsed_lines.loose_units_qty,
      floor(
        greatest(
          coalesce(
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as total_units,
      floor(
        greatest(
          coalesce(
            parsed_lines.ordered_qty,
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as ordered_qty,
      parsed_lines.raw_unit_cost,
      parsed_lines.raw_line_total
    from parsed_lines
  ),
  priced_lines as (
    select
      normalized_lines.product_id,
      normalized_lines.line_position,
      normalized_lines.boxes_qty,
      normalized_lines.units_per_box,
      normalized_lines.loose_units_qty,
      normalized_lines.total_units,
      greatest(normalized_lines.ordered_qty, normalized_lines.total_units) as ordered_qty,
      case
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.raw_unit_cost
        when normalized_lines.raw_line_total > 0 and normalized_lines.total_units > 0 then normalized_lines.raw_line_total / normalized_lines.total_units
        else 0
      end as unit_cost,
      case
        when normalized_lines.raw_line_total > 0 then normalized_lines.raw_line_total
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.total_units * normalized_lines.raw_unit_cost
        else 0
      end as line_total
    from normalized_lines
  )
  insert into public.purchase_order_lines (
    purchase_order_id,
    product_id,
    line_position,
    boxes_qty,
    units_per_box,
    loose_units_qty,
    total_units,
    ordered_qty,
    received_qty,
    unit_cost,
    unit_cost_lyd,
    line_total,
    line_total_lyd
  )
  select
    v_purchase_id,
    priced_lines.product_id,
    priced_lines.line_position,
    priced_lines.boxes_qty,
    priced_lines.units_per_box,
    priced_lines.loose_units_qty,
    priced_lines.total_units,
    priced_lines.ordered_qty,
    case when v_submit_action = 'received' then priced_lines.total_units else 0 end,
    priced_lines.unit_cost,
    priced_lines.unit_cost,
    priced_lines.line_total,
    priced_lines.line_total
  from priced_lines
  where priced_lines.product_id is not null
    and priced_lines.total_units > 0;

  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v_purchase_id) then
    raise exception 'Purchase must include at least one valid line item' using errcode = '22023';
  end if;

  if v_submit_action = 'received' then
    select sl.id
    into v_storage_id
    from public.storage_locations sl
    where sl.active = true
      and sl.location_type = 'main_storage'
    order by sl.name
    limit 1;

    if v_storage_id is null then
      select sl.id
      into v_storage_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type in ('vehicle', 'temporary', 'other')
      order by sl.name
      limit 1;
    end if;

    if v_storage_id is null then
      raise exception 'No active storage location found' using errcode = '23514';
    end if;

    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_purchase_id,
      related_purchase_line_id,
      unit_cost_lyd,
      line_total_lyd,
      created_by,
      notes
    )
    select
      pol.product_id,
      pol.total_units,
      'supplier',
      p_supplier_id,
      'storage',
      v_storage_id,
      'purchase_received',
      v_purchase_id,
      pol.id,
      coalesce(pol.unit_cost_lyd, pol.unit_cost, 0),
      coalesce(pol.line_total_lyd, pol.line_total, 0),
      v_created_by,
      'Purchase received'
    from public.purchase_order_lines pol
    where pol.purchase_order_id = v_purchase_id
      and pol.total_units > 0;

    get diagnostics v_movement_count = row_count;

    if v_movement_count = 0 then
      raise exception 'Purchase receipt created no inventory movements' using errcode = '23514';
    end if;

    with latest_line as (
      select distinct on (pol.product_id)
        pol.product_id,
        pol.id as purchase_line_id,
        round(coalesce(pol.unit_cost_lyd, pol.unit_cost, 0)::numeric, 4) as latest_cost
      from public.purchase_order_lines pol
      where pol.purchase_order_id = v_purchase_id
        and coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) > 0
      order by pol.product_id, pol.line_position desc, pol.id desc
    )
    update public.products p
    set
      cost_price = round(latest_line.latest_cost, 2),
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      last_purchase_date = coalesce(p_order_date, current_date),
      last_supplier_id = p_supplier_id,
      last_purchase_line_id = latest_line.purchase_line_id,
      cost_price_source = 'latest_purchase',
      price_updated_at = now(),
      updated_at = now()
    from latest_line
    where p.id = latest_line.product_id;

    update public.purchase_orders po
    set
      status = 'received',
      received_at = now(),
      received_date = current_date,
      received_by = v_created_by,
      updated_at = now()
    where po.id = v_purchase_id;
  end if;

  return query
  select
    po.id,
    po.receipt_number,
    po.status,
    po.total_amount,
    po.payment_status,
    v_movement_count
  from public.purchase_orders po
  where po.id = v_purchase_id;
end;
$$;

revoke all on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) from public;

revoke execute on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) from anon;

grant execute on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605260003_vms_import_permissions_and_safe_schema.sql
-- ============================================================================

create table if not exists public.vms_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_type text not null default 'csv',
  file_name text,
  file_type text,
  sheet_name text,
  uploaded_by uuid references public.team_members(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  imported_by uuid references public.team_members(id) on delete set null,
  imported_at timestamptz not null default now(),
  report_type text,
  report_start_date date,
  report_end_date date,
  import_mode text not null default 'append_new',
  status text not null default 'previewed',
  row_count integer default 0,
  rows_found integer not null default 0,
  rows_imported integer not null default 0,
  rows_skipped integer default 0,
  rows_skipped_duplicate integer not null default 0,
  rows_needing_review integer not null default 0,
  error_count integer default 0,
  errors jsonb not null default '[]'::jsonb,
  unknown_machines jsonb not null default '[]'::jsonb,
  unmapped_products jsonb not null default '[]'::jsonb,
  column_mapping jsonb not null default '{}'::jsonb,
  notes text
);

alter table public.vms_import_batches
  add column if not exists file_type text,
  add column if not exists sheet_name text,
  add column if not exists report_type text,
  add column if not exists row_count integer default 0,
  add column if not exists rows_skipped integer default 0,
  add column if not exists error_count integer default 0,
  add column if not exists errors jsonb not null default '[]'::jsonb,
  add column if not exists unknown_machines jsonb not null default '[]'::jsonb,
  add column if not exists unmapped_products jsonb not null default '[]'::jsonb,
  add column if not exists column_mapping jsonb not null default '{}'::jsonb,
  add column if not exists uploaded_by uuid references public.team_members(id) on delete set null,
  add column if not exists uploaded_at timestamptz,
  add column if not exists report_start_date date,
  add column if not exists report_end_date date,
  add column if not exists import_mode text not null default 'append_new',
  add column if not exists rows_found integer not null default 0,
  add column if not exists rows_imported integer not null default 0,
  add column if not exists rows_skipped_duplicate integer not null default 0,
  add column if not exists rows_needing_review integer not null default 0,
  add column if not exists preview_summary jsonb not null default '{}'::jsonb,
  add column if not exists review_summary jsonb not null default '[]'::jsonb,
  add column if not exists failed_at timestamptz,
  add column if not exists last_reprocessed_at timestamptz,
  add column if not exists reprocess_count integer not null default 0;

update public.vms_import_batches
set
  uploaded_by = coalesce(uploaded_by, imported_by),
  uploaded_at = coalesce(uploaded_at, imported_at, now()),
  rows_found = greatest(coalesce(rows_found, 0), coalesce(row_count, 0)),
  rows_needing_review = greatest(coalesce(rows_needing_review, 0), coalesce(error_count, 0))
where uploaded_by is null
   or uploaded_at is null
   or rows_found = 0;

create table if not exists public.vms_import_previews (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_type text not null default 'csv',
  report_type text not null default 'custom',
  sheets jsonb not null default '[]'::jsonb,
  uploaded_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  file_size_bytes bigint
);

alter table public.vms_import_previews
  add column if not exists file_size_bytes bigint;

create table if not exists public.vms_import_preview_rows (
  id uuid primary key default gen_random_uuid(),
  preview_id uuid not null references public.vms_import_previews(id) on delete cascade,
  sheet_name text,
  row_number integer not null,
  raw_row jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(preview_id, sheet_name, row_number)
);

create table if not exists public.vms_header_mappings (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,
  source_signature text not null,
  header_names jsonb not null default '[]'::jsonb,
  required_field_mapping jsonb not null default '{}'::jsonb,
  optional_field_mapping jsonb not null default '{}'::jsonb,
  last_used_mapping jsonb not null default '{}'::jsonb,
  use_count integer not null default 1,
  created_by uuid references public.team_members(id) on delete set null,
  updated_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(report_type, source_signature)
);

create table if not exists public.vms_machine_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_machine_key text not null unique,
  vms_machine_name text,
  machine_id uuid references public.machines(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  confidence_score numeric(5,4) not null default 1,
  status text not null default 'needs_review',
  aliases text[] not null default '{}'::text[],
  created_by uuid references public.team_members(id) on delete set null,
  updated_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_product_mappings
  add column if not exists confidence_score numeric(5,4) not null default 1,
  add column if not exists snacky_product_name text;

create index if not exists idx_vms_import_batches_uploaded_at
  on public.vms_import_batches(uploaded_at desc);
create index if not exists idx_vms_import_batches_status
  on public.vms_import_batches(status);
create index if not exists idx_vms_import_preview_rows_preview
  on public.vms_import_preview_rows(preview_id, row_number);
create index if not exists idx_vms_header_mappings_report_type_updated
  on public.vms_header_mappings(report_type, updated_at desc);
create index if not exists idx_vms_machine_mappings_status
  on public.vms_machine_mappings(status);

do $$ begin
  alter table public.vms_import_batches
    add constraint vms_import_batches_import_mode_check
    check (import_mode in ('append_new', 'replace_range', 'preview_only'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_import_batches
    add constraint vms_import_batches_status_check
    check (status in ('previewed', 'processing', 'imported', 'failed', 'cancelled', 'canceled', 'completed', 'completed_with_warnings'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_machine_mappings
    add constraint vms_machine_mappings_confidence_check
    check (confidence_score >= 0 and confidence_score <= 1);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_machine_mappings
    add constraint vms_machine_mappings_status_check
    check (status in ('confirmed', 'suggested', 'needs_review', 'ignored'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vms_product_mappings
    add constraint vms_product_mappings_confidence_check
    check (confidence_score >= 0 and confidence_score <= 1);
exception when duplicate_object then null; end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_previews',
    'vms_import_preview_rows',
    'vms_import_rows',
    'vms_import_raw_rows',
    'vms_header_mappings',
    'vms_product_mappings',
    'vms_machine_mappings'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
      execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_delete_by_vms_import_role" on public.%I', table_name, table_name);

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

      execute format($policy$
        create policy "snacky_%s_delete_by_vms_import_role"
        on public.%I for delete
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.vms_sales_raw') is not null then
    grant select on public.vms_sales_raw to authenticated;
  end if;
  if to_regclass('public.vms_sales_clean') is not null then
    grant select on public.vms_sales_clean to authenticated;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605260004_vms_import_validation_hardening.sql
-- ============================================================================

alter table public.vms_import_batches
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.vms_import_preview_rows (
  id uuid primary key default gen_random_uuid(),
  preview_id uuid references public.vms_import_previews(id) on delete cascade,
  import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  sheet_name text,
  row_number integer not null,
  raw_row jsonb not null default '[]'::jsonb,
  normalized_row jsonb not null default '{}'::jsonb,
  mapped_product_id uuid references public.products(id) on delete set null,
  mapped_machine_id uuid references public.machines(id) on delete set null,
  status text not null default 'pending',
  review_reason text,
  suggested_mapping jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.vms_import_preview_rows
  add column if not exists preview_id uuid references public.vms_import_previews(id) on delete cascade,
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  add column if not exists sheet_name text,
  add column if not exists raw_row jsonb not null default '[]'::jsonb,
  add column if not exists normalized_row jsonb not null default '{}'::jsonb,
  add column if not exists mapped_product_id uuid references public.products(id) on delete set null,
  add column if not exists mapped_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists status text not null default 'pending',
  add column if not exists review_reason text,
  add column if not exists suggested_mapping jsonb not null default '{}'::jsonb;

create index if not exists idx_vms_import_preview_rows_batch
  on public.vms_import_preview_rows(import_batch_id, row_number);

create index if not exists idx_vms_import_preview_rows_status
  on public.vms_import_preview_rows(status);

do $$ begin
  alter table public.vms_import_preview_rows
    add constraint vms_import_preview_rows_status_check
    check (status in ('pending', 'ready', 'needs_review', 'invalid_row', 'duplicate', 'imported', 'skipped'));
exception when duplicate_object then null; end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_previews',
    'vms_import_preview_rows',
    'vms_import_rows',
    'vms_import_raw_rows',
    'vms_header_mappings',
    'vms_product_mappings',
    'vms_machine_mappings'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);

      execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_delete_by_vms_import_role" on public.%I', table_name, table_name);

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

      execute format($policy$
        create policy "snacky_%s_delete_by_vms_import_role"
        on public.%I for delete
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'grant select on public.products to authenticated';
    execute 'drop policy if exists "snacky_products_select_for_vms_import_validation" on public.products';
    execute $policy$
      create policy "snacky_products_select_for_vms_import_validation"
      on public.products for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$;
  end if;

  if to_regclass('public.machines') is not null then
    execute 'grant select on public.machines to authenticated';
    execute 'drop policy if exists "snacky_machines_select_for_vms_import_validation" on public.machines';
    execute $policy$
      create policy "snacky_machines_select_for_vms_import_validation"
      on public.machines for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$;
  end if;
end $$;

insert into public.vms_machine_mappings (
  vms_machine_key,
  vms_machine_name,
  machine_id,
  location_id,
  confidence_score,
  status,
  aliases
)
select
  'KhalijUniversity',
  'Khalij University',
  m.id,
  m.location_id,
  1,
  'confirmed',
  array['KhalijUniversity', 'Khalij University', '@الخليج', '@خليج']::text[]
from public.machines m
where trim(m.name) = 'جامعة طرابلس الاهلية'
on conflict (vms_machine_key) do update
set
  vms_machine_name = excluded.vms_machine_name,
  machine_id = excluded.machine_id,
  location_id = excluded.location_id,
  confidence_score = excluded.confidence_score,
  status = excluded.status,
  aliases = excluded.aliases,
  updated_at = now();

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605260005_vms_import_pipeline_contract.sql
-- ============================================================================

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

alter table public.vms_import_batches
  drop constraint if exists vms_import_batches_import_mode_check,
  drop constraint if exists vms_import_batches_status_check;

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


-- ============================================================================
-- Source migration: supabase/migrations/202605260006_vms_product_mapping_contract.sql
-- ============================================================================

-- Makes VMS product mapping memory a stable first-class contract.
-- Keeps the newer Snacky column names and the legacy import column names in
-- sync so existing import code can continue to run while the UI uses the
-- safer canonical fields.

create table if not exists public.vms_product_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_product_code text,
  vms_product_name text not null,
  snacky_product_id uuid references public.products(id) on delete set null,
  snacky_product_name text,
  confidence_score numeric,
  status text not null default 'confirmed',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_product_mappings
  add column if not exists vms_product_code text,
  add column if not exists vms_product_id text,
  add column if not exists vms_product_name text,
  add column if not exists snacky_product_id uuid references public.products(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists snacky_product_name text,
  add column if not exists confidence_score numeric,
  add column if not exists status text not null default 'confirmed',
  add column if not exists match_status text not null default 'confirmed',
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists vms_cost_price_lyd numeric(12,4),
  add column if not exists latest_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists latest_vms_machine_id text,
  add column if not exists latest_machine_name text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  add column if not exists vms_third_party_product_id text,
  add column if not exists vms_barcode text,
  add column if not exists vms_image_url text,
  add column if not exists vms_raw_metadata jsonb not null default '{}'::jsonb;

update public.vms_product_mappings vpm
set
  vms_product_code = nullif(coalesce(vpm.vms_product_code, vpm.vms_product_id), ''),
  vms_product_id = nullif(coalesce(vpm.vms_product_id, vpm.vms_product_code), ''),
  snacky_product_id = coalesce(vpm.snacky_product_id, vpm.product_id),
  product_id = coalesce(vpm.product_id, vpm.snacky_product_id),
  snacky_product_name = coalesce(vpm.snacky_product_name, p.name),
  status = coalesce(nullif(vpm.status, ''), nullif(vpm.match_status, ''), 'confirmed'),
  match_status = coalesce(nullif(vpm.match_status, ''), nullif(vpm.status, ''), 'confirmed'),
  confidence_score = coalesce(vpm.confidence_score, case when coalesce(vpm.product_id, vpm.snacky_product_id) is null then 0 else 1 end),
  updated_at = coalesce(vpm.updated_at, now())
from public.products p
where p.id = coalesce(vpm.snacky_product_id, vpm.product_id);

update public.vms_product_mappings
set
  vms_product_name = coalesce(nullif(vms_product_name, ''), nullif(vms_product_code, ''), nullif(vms_product_id, ''), 'Unnamed VMS product'),
  vms_product_code = nullif(coalesce(vms_product_code, vms_product_id), ''),
  vms_product_id = nullif(coalesce(vms_product_id, vms_product_code), ''),
  snacky_product_id = coalesce(snacky_product_id, product_id),
  product_id = coalesce(product_id, snacky_product_id),
  status = coalesce(nullif(status, ''), nullif(match_status, ''), 'confirmed'),
  match_status = coalesce(nullif(match_status, ''), nullif(status, ''), 'confirmed'),
  confidence_score = coalesce(confidence_score, case when coalesce(product_id, snacky_product_id) is null then 0 else 1 end),
  updated_at = coalesce(updated_at, now())
where vms_product_name is null
   or vms_product_name = ''
   or vms_product_code is null
   or vms_product_id is null
   or (snacky_product_id is null and product_id is not null)
   or (product_id is null and snacky_product_id is not null)
   or status is null
   or match_status is null
   or confidence_score is null
   or updated_at is null;

alter table public.vms_product_mappings
  alter column vms_product_name set not null,
  alter column status set default 'confirmed',
  alter column status set not null,
  alter column match_status set default 'confirmed',
  alter column match_status set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table public.vms_product_mappings
  drop constraint if exists vms_product_mappings_status_check,
  drop constraint if exists vms_product_mappings_match_status_check,
  drop constraint if exists vms_product_mappings_confidence_check;

alter table public.vms_product_mappings
  add constraint vms_product_mappings_status_check
    check (status in ('confirmed', 'suggested', 'needs_review', 'ignored')),
  add constraint vms_product_mappings_match_status_check
    check (match_status in ('confirmed', 'suggested', 'needs_review', 'ignored')),
  add constraint vms_product_mappings_confidence_check
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));

create index if not exists idx_vms_product_mappings_status_updated
  on public.vms_product_mappings(status, updated_at desc);

create index if not exists idx_vms_product_mappings_snacky_product
  on public.vms_product_mappings(snacky_product_id);

create index if not exists idx_vms_product_mappings_product_id
  on public.vms_product_mappings(product_id);

create index if not exists idx_vms_product_mappings_last_seen
  on public.vms_product_mappings(last_seen_at desc);

create or replace function public.snacky_sync_vms_product_mapping_aliases()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_product_name text;
begin
  new.vms_product_code = nullif(coalesce(new.vms_product_code, new.vms_product_id), '');
  new.vms_product_id = nullif(coalesce(new.vms_product_id, new.vms_product_code), '');
  new.snacky_product_id = coalesce(new.snacky_product_id, new.product_id);
  new.product_id = coalesce(new.product_id, new.snacky_product_id);
  new.status = coalesce(nullif(new.status, ''), nullif(new.match_status, ''), 'confirmed');
  new.match_status = coalesce(nullif(new.match_status, ''), new.status);
  new.confidence_score = coalesce(new.confidence_score, case when new.product_id is null then 0 else 1 end);

  if new.product_id is null then
    new.snacky_product_name = null;
  elsif nullif(new.snacky_product_name, '') is null then
    select p.name into resolved_product_name
    from public.products p
    where p.id = new.product_id;
    new.snacky_product_name = resolved_product_name;
  end if;

  new.created_at = coalesce(new.created_at, now());
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists snacky_sync_vms_product_mapping_aliases_before_write
  on public.vms_product_mappings;

create trigger snacky_sync_vms_product_mapping_aliases_before_write
before insert or update on public.vms_product_mappings
for each row execute function public.snacky_sync_vms_product_mapping_aliases();

create or replace function public.snacky_current_profile_can_view_vms_import()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

create or replace function public.snacky_current_profile_can_manage_vms_mappings()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

grant execute on function public.snacky_current_profile_can_view_vms_import() to authenticated;
grant execute on function public.snacky_current_profile_can_manage_vms_mappings() to authenticated;

alter table public.vms_product_mappings enable row level security;
grant select, insert, update on public.vms_product_mappings to authenticated;

drop policy if exists "snacky_vms_product_mappings_select_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_insert_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_update_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_delete_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_select_by_vms_import_permission" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_insert_by_vms_import_permission" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_update_by_vms_import_permission" on public.vms_product_mappings;

create policy "snacky_vms_product_mappings_select_by_vms_import_permission"
on public.vms_product_mappings for select
to authenticated
using (public.snacky_current_profile_can_view_vms_import());

create policy "snacky_vms_product_mappings_insert_by_vms_import_permission"
on public.vms_product_mappings for insert
to authenticated
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_product_mappings_update_by_vms_import_permission"
on public.vms_product_mappings for update
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings())
with check (public.snacky_current_profile_can_manage_vms_mappings());

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_previews',
    'vms_import_preview_rows',
    'vms_import_rows',
    'vms_import_raw_rows',
    'vms_header_mappings',
    'vms_machine_mappings',
    'vms_sales_raw'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
      execute format('drop policy if exists "snacky_%s_select_by_vms_import_permission" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_insert_by_vms_import_permission" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_update_by_vms_import_permission" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_delete_by_vms_import_permission" on public.%I', table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_select_by_vms_import_permission"
        on public.%I for select
        to authenticated
        using (public.snacky_current_profile_can_view_vms_import())
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_insert_by_vms_import_permission"
        on public.%I for insert
        to authenticated
        with check (public.snacky_current_profile_can_manage_vms_mappings())
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_update_by_vms_import_permission"
        on public.%I for update
        to authenticated
        using (public.snacky_current_profile_can_manage_vms_mappings())
        with check (public.snacky_current_profile_can_manage_vms_mappings())
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_delete_by_vms_import_permission"
        on public.%I for delete
        to authenticated
        using (public.snacky_current_profile_can_manage_vms_mappings())
      $policy$, table_name, table_name);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'grant select on public.products to authenticated';
    execute 'drop policy if exists "snacky_products_select_for_vms_mapping" on public.products';
    execute $policy$
      create policy "snacky_products_select_for_vms_mapping"
      on public.products for select
      to authenticated
      using (public.snacky_current_profile_can_view_vms_import())
    $policy$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202605270001_vms_order_details_transactions.sql
-- ============================================================================

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

create or replace view public.latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
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
        vib.status = 'imported'
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


-- ============================================================================
-- Source migration: supabase/migrations/202605290001_route_completion_recovery.sql
-- ============================================================================

-- Adds audit and idempotency metadata for route completion recovery.
-- The application keeps these columns best-effort so older databases can still
-- complete routes, but production should run this migration.

alter table public.routes
  add column if not exists completed_by uuid references public.team_members(id) on delete set null,
  add column if not exists completion_attempts integer not null default 0,
  add column if not exists last_completion_error text,
  add column if not exists repaired_at timestamptz,
  add column if not exists repaired_by uuid references public.team_members(id) on delete set null;

create index if not exists idx_routes_completed_by
  on public.routes(completed_by)
  where completed_by is not null;

alter table public.inventory_movements
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists idempotency_key text;

create unique index if not exists idx_inventory_movements_idempotency_key
  on public.inventory_movements(idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_inventory_movements_source
  on public.inventory_movements(source_type, source_id)
  where source_type is not null and source_id is not null;


-- ============================================================================
-- Source migration: supabase/migrations/202606010001_vms_machine_stock_snapshot_contract.sql
-- ============================================================================

-- Ensures VMS import batches can store file/import metadata and adds the
-- machine-goods inventory snapshot table used by Inventory of machine goods XLS files.

alter table public.vms_import_batches
  add column if not exists file_hash text,
  add column if not exists storage_path text,
  add column if not exists detected_min_datetime timestamptz,
  add column if not exists detected_max_datetime timestamptz,
  add column if not exists total_successful_sales numeric not null default 0,
  add column if not exists successful_rows_count integer not null default 0,
  add column if not exists failed_rows_count integer not null default 0,
  add column if not exists refunded_rows_count integer not null default 0,
  add column if not exists is_active boolean not null default false,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid,
  add column if not exists disable_reason text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text;

alter table public.vms_import_batches
  alter column is_active set default false,
  alter column total_successful_sales set default 0,
  alter column successful_rows_count set default 0,
  alter column failed_rows_count set default 0,
  alter column refunded_rows_count set default 0;

update public.vms_import_batches
set is_active = false
where status is distinct from 'imported'
   or deleted_at is not null;

create table if not exists public.vms_machine_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  row_number integer,
  machine_id uuid references public.machines(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  machine_code text,
  machine_name text,
  point_name text,
  vms_product_code text,
  vms_product_name text,
  product_specification text,
  product_barcode text,
  third_party_commodity_number text,
  product_unit text,
  production_date date,
  warranty_date date,
  inventory_quantity numeric not null default 0,
  out_of_stock_quantity numeric not null default 0,
  inventory_capacity numeric,
  raw_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.vms_machine_stock_snapshots
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  add column if not exists row_number integer,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists machine_code text,
  add column if not exists machine_name text,
  add column if not exists point_name text,
  add column if not exists vms_product_code text,
  add column if not exists vms_product_name text,
  add column if not exists product_specification text,
  add column if not exists product_barcode text,
  add column if not exists third_party_commodity_number text,
  add column if not exists product_unit text,
  add column if not exists production_date date,
  add column if not exists warranty_date date,
  add column if not exists inventory_quantity numeric not null default 0,
  add column if not exists out_of_stock_quantity numeric not null default 0,
  add column if not exists inventory_capacity numeric,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists idx_vms_machine_stock_snapshots_batch_row
  on public.vms_machine_stock_snapshots(import_batch_id, row_number)
  where import_batch_id is not null and row_number is not null;

create index if not exists idx_vms_machine_stock_snapshots_machine_product
  on public.vms_machine_stock_snapshots(machine_id, product_id, created_at desc);

alter table public.vms_machine_stock_snapshots enable row level security;
grant select, insert, update, delete on public.vms_machine_stock_snapshots to authenticated;

drop policy if exists "snacky_vms_machine_stock_snapshots_select_by_vms_import_permission" on public.vms_machine_stock_snapshots;
drop policy if exists "snacky_vms_machine_stock_snapshots_insert_by_vms_import_permission" on public.vms_machine_stock_snapshots;
drop policy if exists "snacky_vms_machine_stock_snapshots_update_by_vms_import_permission" on public.vms_machine_stock_snapshots;
drop policy if exists "snacky_vms_machine_stock_snapshots_delete_by_vms_import_permission" on public.vms_machine_stock_snapshots;

create policy "snacky_vms_machine_stock_snapshots_select_by_vms_import_permission"
on public.vms_machine_stock_snapshots for select
to authenticated
using (public.snacky_current_profile_can_view_vms_import());

create policy "snacky_vms_machine_stock_snapshots_insert_by_vms_import_permission"
on public.vms_machine_stock_snapshots for insert
to authenticated
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_machine_stock_snapshots_update_by_vms_import_permission"
on public.vms_machine_stock_snapshots for update
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings())
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_machine_stock_snapshots_delete_by_vms_import_permission"
on public.vms_machine_stock_snapshots for delete
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings());

update public.vms_import_batches
set
  source_usage = '{"source_type":"machine_stock_snapshot","main_sales_source":false,"reconciliation_only":false,"dashboards":["inventory","refills","products","machines"],"excluded_dashboards":["sales","finance"]}'::jsonb,
  dashboard_usage = '{"source_type":"machine_stock_snapshot","main_sales_source":false,"reconciliation_only":false,"dashboards":["inventory","refills","products","machines"],"excluded_dashboards":["sales","finance"]}'::jsonb,
  total_successful_sales = 0,
  successful_rows_count = 0,
  failed_rows_count = 0,
  refunded_rows_count = 0
where report_type = 'machine_stock_snapshot';

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606010002_vms_import_batch_metadata_contract.sql
-- ============================================================================

-- Reasserts the complete vms_import_batches metadata contract expected by
-- the import wizard. Keep this table limited to import metadata; raw VMS file
-- headers belong in row payload tables, not here.

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

do $$
begin
  if to_regclass('public.vms_import_batches') is not null then
    execute 'alter table public.vms_import_batches enable row level security';
  end if;
end $$;

alter table public.vms_import_batches
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists uploaded_by uuid,
  add column if not exists uploaded_at timestamptz default now(),
  add column if not exists file_name text,
  add column if not exists report_type text,
  add column if not exists report_start_date date,
  add column if not exists report_end_date date,
  add column if not exists import_mode text default 'append',
  add column if not exists status text default 'draft',
  add column if not exists rows_found integer default 0,
  add column if not exists rows_imported integer default 0,
  add column if not exists rows_skipped_duplicate integer default 0,
  add column if not exists rows_needing_review integer default 0,
  add column if not exists notes text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.vms_import_batches
  add column if not exists file_hash text,
  add column if not exists storage_path text,
  add column if not exists detected_min_datetime timestamptz,
  add column if not exists detected_max_datetime timestamptz,
  add column if not exists total_successful_sales numeric default 0,
  add column if not exists successful_rows_count integer default 0,
  add column if not exists failed_rows_count integer default 0,
  add column if not exists refunded_rows_count integer default 0,
  add column if not exists is_active boolean default false,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid,
  add column if not exists disable_reason text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text,
  add column if not exists source_usage jsonb,
  add column if not exists dashboard_usage jsonb,
  add column if not exists latest_error text,
  add column if not exists parse_diagnostics jsonb;

alter table public.vms_import_batches
  add column if not exists source_type text default 'csv',
  add column if not exists file_type text,
  add column if not exists sheet_name text,
  add column if not exists imported_by uuid,
  add column if not exists imported_at timestamptz,
  add column if not exists row_count integer default 0,
  add column if not exists rows_skipped integer default 0,
  add column if not exists error_count integer default 0,
  add column if not exists errors jsonb default '[]'::jsonb,
  add column if not exists unknown_machines jsonb default '[]'::jsonb,
  add column if not exists unmapped_products jsonb default '[]'::jsonb,
  add column if not exists column_mapping jsonb default '{}'::jsonb,
  add column if not exists preview_summary jsonb default '{}'::jsonb,
  add column if not exists review_summary jsonb default '[]'::jsonb,
  add column if not exists failed_at timestamptz,
  add column if not exists last_reprocessed_at timestamptz,
  add column if not exists reprocess_count integer default 0,
  add column if not exists storage_bucket text,
  add column if not exists original_file_name text;

alter table public.vms_import_batches
  alter column uploaded_at set default now(),
  alter column import_mode set default 'append',
  alter column status set default 'draft',
  alter column rows_found set default 0,
  alter column rows_imported set default 0,
  alter column rows_skipped_duplicate set default 0,
  alter column rows_needing_review set default 0,
  alter column created_at set default now(),
  alter column updated_at set default now(),
  alter column source_type set default 'csv',
  alter column row_count set default 0,
  alter column rows_skipped set default 0,
  alter column error_count set default 0,
  alter column errors set default '[]'::jsonb,
  alter column unknown_machines set default '[]'::jsonb,
  alter column unmapped_products set default '[]'::jsonb,
  alter column column_mapping set default '{}'::jsonb,
  alter column preview_summary set default '{}'::jsonb,
  alter column review_summary set default '[]'::jsonb,
  alter column reprocess_count set default 0,
  alter column total_successful_sales set default 0,
  alter column successful_rows_count set default 0,
  alter column failed_rows_count set default 0,
  alter column refunded_rows_count set default 0,
  alter column is_active set default false;

update public.vms_import_batches
set
  uploaded_at = coalesce(uploaded_at, imported_at, created_at, now()),
  import_mode = coalesce(import_mode, 'append'),
  status = coalesce(status, 'draft'),
  rows_found = coalesce(rows_found, row_count, 0),
  rows_imported = coalesce(rows_imported, 0),
  rows_skipped_duplicate = coalesce(rows_skipped_duplicate, 0),
  rows_needing_review = coalesce(rows_needing_review, error_count, 0),
  created_at = coalesce(created_at, uploaded_at, imported_at, now()),
  updated_at = coalesce(updated_at, now()),
  source_type = coalesce(source_type, 'csv'),
  row_count = coalesce(row_count, rows_found, 0),
  rows_skipped = coalesce(rows_skipped, 0),
  error_count = coalesce(error_count, 0),
  errors = coalesce(errors, '[]'::jsonb),
  unknown_machines = coalesce(unknown_machines, '[]'::jsonb),
  unmapped_products = coalesce(unmapped_products, '[]'::jsonb),
  column_mapping = coalesce(column_mapping, '{}'::jsonb),
  preview_summary = coalesce(preview_summary, '{}'::jsonb),
  review_summary = coalesce(review_summary, '[]'::jsonb),
  reprocess_count = coalesce(reprocess_count, 0),
  total_successful_sales = coalesce(total_successful_sales, 0),
  successful_rows_count = coalesce(successful_rows_count, 0),
  failed_rows_count = coalesce(failed_rows_count, 0),
  refunded_rows_count = coalesce(refunded_rows_count, 0),
  is_active = coalesce(is_active, false)
where uploaded_at is null
   or import_mode is null
   or status is null
   or rows_found is null
   or rows_imported is null
   or rows_skipped_duplicate is null
   or rows_needing_review is null
   or created_at is null
   or updated_at is null
   or source_type is null
   or row_count is null
   or rows_skipped is null
   or error_count is null
   or errors is null
   or unknown_machines is null
   or unmapped_products is null
   or column_mapping is null
   or preview_summary is null
   or review_summary is null
   or reprocess_count is null
   or total_successful_sales is null
   or successful_rows_count is null
   or failed_rows_count is null
   or refunded_rows_count is null
   or is_active is null;

create or replace function public.snacky_current_profile_can_view_vms_import()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

create or replace function public.snacky_current_profile_can_manage_vms_mappings()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

grant execute on function public.snacky_current_profile_can_view_vms_import() to authenticated;
grant execute on function public.snacky_current_profile_can_manage_vms_mappings() to authenticated;

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
    'vms_machine_stock_snapshots'
  ] loop
    if to_regclass('public.' || table_name) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);

    execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_delete_by_vms_import_role" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_select_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_insert_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_update_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_%s_delete_by_vms_import_permission" on public.%I', table_name, table_name);
    execute format('drop policy if exists "snacky_vms_select" on public.%I', table_name);
    execute format('drop policy if exists "snacky_vms_insert" on public.%I', table_name);
    execute format('drop policy if exists "snacky_vms_update" on public.%I', table_name);
    execute format('drop policy if exists "snacky_vms_delete" on public.%I', table_name);

    execute format($policy$
      create policy "snacky_vms_select"
      on public.%I for select
      to authenticated
      using (public.snacky_current_profile_can_view_vms_import())
    $policy$, table_name);

    execute format($policy$
      create policy "snacky_vms_insert"
      on public.%I for insert
      to authenticated
      with check (public.snacky_current_profile_can_manage_vms_mappings())
    $policy$, table_name);

    execute format($policy$
      create policy "snacky_vms_update"
      on public.%I for update
      to authenticated
      using (public.snacky_current_profile_can_manage_vms_mappings())
      with check (public.snacky_current_profile_can_manage_vms_mappings())
    $policy$, table_name);

    execute format($policy$
      create policy "snacky_vms_delete"
      on public.%I for delete
      to authenticated
      using (public.snacky_current_profile_can_manage_vms_mappings())
    $policy$, table_name);
  end loop;
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606010003_route_pickup_checklist_items.sql
-- ============================================================================

alter table if exists public.route_pick_list_items
  add column if not exists is_checked boolean not null default false;

create index if not exists idx_route_pick_list_items_is_checked
  on public.route_pick_list_items(route_id, is_checked);

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606010004_route_pickup_checklist_save_contract.sql
-- ============================================================================

alter table if exists public.route_stop_items
  add column if not exists is_checked boolean not null default false,
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by uuid;

alter table if exists public.route_pick_list_items
  add column if not exists is_checked boolean not null default false,
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by uuid;

create index if not exists idx_route_stop_items_pickup_checked
  on public.route_stop_items(route_id, is_checked);

create index if not exists idx_route_pick_list_items_checked
  on public.route_pick_list_items(route_id, is_checked);

update public.route_stop_items rsi
set
  is_checked = true,
  checked_at = coalesce(rsi.checked_at, rpli.checked_at, rpli.updated_at, now()),
  checked_by = coalesce(rsi.checked_by, rpli.checked_by)
from public.route_pick_list_items rpli
where rpli.route_stop_item_id = rsi.id
  and rpli.route_id = rsi.route_id
  and coalesce(rpli.is_checked, false) = true
  and coalesce(rsi.is_checked, false) = false;

create or replace function public.save_route_pickup_checklist_item(
  p_route_id uuid,
  p_route_stop_item_id uuid,
  p_is_checked boolean
)
returns table (
  id uuid,
  route_id uuid,
  route_stop_item_id uuid,
  product_id uuid,
  is_checked boolean,
  checked_at timestamptz,
  checked_by uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_route record;
  v_item record;
  v_stop_status text;
  v_checked_at timestamptz;
  v_checked_by uuid;
begin
  if p_route_id is null then
    raise exception 'Route id is required.' using errcode = 'P0001';
  end if;

  if p_route_stop_item_id is null then
    raise exception 'Route stop item is required.' using errcode = 'P0001';
  end if;

  select r.id, r.operator_id, r.status
  into v_route
  from public.routes r
  where r.id = p_route_id;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Completed or cancelled routes cannot be edited.' using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'User does not have permission to update this pickup checklist item.' using errcode = '42501';
  end if;

  select rsi.id, rsi.route_id, rsi.route_stop_id, rsi.product_id
  into v_item
  from public.route_stop_items rsi
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id;

  if not found then
    raise exception 'Pickup item not found.' using errcode = 'P0001';
  end if;

  select rs.status::text
  into v_stop_status
  from public.route_stops rs
  where rs.id = v_item.route_stop_id
    and rs.route_id = p_route_id;

  if v_stop_status is not null and v_stop_status <> 'pending' then
    raise exception 'Only pending pickup items can be checked.' using errcode = 'P0001';
  end if;

  v_checked_at := case when coalesce(p_is_checked, false) then now() else null end;
  v_checked_by := case when coalesce(p_is_checked, false) then auth.uid() else null end;

  update public.route_stop_items rsi
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = v_checked_at,
    checked_by = v_checked_by,
    updated_at = now()
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id;

  update public.route_pick_list_items rpli
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = v_checked_at,
    checked_by = v_checked_by,
    updated_at = now()
  where rpli.route_id = p_route_id
    and rpli.route_stop_item_id = p_route_stop_item_id
    and rpli.action_type = 'planned_pick';

  return query
  select
    rsi.id,
    rsi.route_id,
    rsi.id as route_stop_item_id,
    rsi.product_id,
    rsi.is_checked,
    rsi.checked_at,
    rsi.checked_by
  from public.route_stop_items rsi
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id;
end;
$$;

grant execute on function public.save_route_pickup_checklist_item(uuid, uuid, boolean) to authenticated;

drop policy if exists "snacky_route_stop_items_update_pickup_checklist_access" on public.route_stop_items;

create policy "snacky_route_stop_items_update_pickup_checklist_access"
on public.route_stop_items for update
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
)
with check (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
);

grant update (is_checked, checked_at, checked_by) on public.route_stop_items to authenticated;
grant update (is_checked, checked_at, checked_by) on public.route_pick_list_items to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606010005_route_pickup_checklist_rpc_signature.sql
-- ============================================================================

alter table if exists public.route_stop_items
  add column if not exists is_checked boolean not null default false,
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by uuid;

do $$
begin
  if to_regclass('public.route_stop_items') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.route_stop_items'::regclass
         and conname = 'route_stop_items_checked_by_fkey'
     ) then
    alter table public.route_stop_items
      add constraint route_stop_items_checked_by_fkey
      foreign key (checked_by) references auth.users(id) on delete set null not valid;
  end if;
end $$;

drop function if exists public.save_route_pickup_checklist_item(uuid, uuid, boolean);

create or replace function public.save_route_pickup_checklist_item(
  p_is_checked boolean,
  p_route_id uuid,
  p_route_stop_item_id uuid
)
returns public.route_stop_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_item public.route_stop_items;
  v_route record;
  v_has_access boolean := false;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select r.id, r.operator_id, r.status
  into v_route
  from public.routes r
  where r.id = p_route_id;

  if not found then
    raise exception 'Route not found' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Completed or cancelled routes cannot be edited' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = v_user_id
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or (
          v_route.operator_id = coalesce(p.team_member_id, tm.id)
          and (
            public.snacky_profile_has_any_role(p.roles, p.role, array['operator', 'warehouse'])
            or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator', 'warehouse'])
          )
        )
      )
  )
  into v_has_access;

  if not coalesce(v_has_access, false) then
    raise exception 'User does not have permission to update this pickup checklist item' using errcode = '42501';
  end if;

  select rsi.*
  into v_item
  from public.route_stop_items rsi
  join public.route_stops rs
    on rs.id = rsi.route_stop_id
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id
    and rs.route_id = p_route_id;

  if not found then
    raise exception 'Checklist item not found for this route' using errcode = 'P0001';
  end if;

  update public.route_stop_items rsi
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = case when coalesce(p_is_checked, false) then now() else null end,
    checked_by = case when coalesce(p_is_checked, false) then v_user_id else null end,
    updated_at = now()
  where rsi.id = p_route_stop_item_id
    and rsi.route_id = p_route_id
  returning rsi.* into v_item;

  update public.route_pick_list_items rpli
  set
    is_checked = coalesce(p_is_checked, false),
    checked_at = case when coalesce(p_is_checked, false) then v_item.checked_at else null end,
    checked_by = case when coalesce(p_is_checked, false) then v_user_id else null end,
    updated_at = now()
  where rpli.route_id = p_route_id
    and rpli.route_stop_item_id = p_route_stop_item_id
    and rpli.action_type = 'planned_pick';

  return v_item;
end;
$$;

grant execute on function public.save_route_pickup_checklist_item(boolean, uuid, uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606020001_product_restock_priority_fields.sql
-- ============================================================================

alter table public.products
  add column if not exists restock_priority text not null default 'normal',
  add column if not exists min_storage_qty integer not null default 0,
  add column if not exists target_storage_qty integer not null default 0,
  add column if not exists reorder_point integer not null default 0,
  add column if not exists reorder_qty integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_restock_priority_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_restock_priority_check
      check (restock_priority in ('high', 'normal', 'low'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_min_storage_qty_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_min_storage_qty_nonnegative
      check (min_storage_qty >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_target_storage_qty_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_target_storage_qty_nonnegative
      check (target_storage_qty >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_reorder_point_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_reorder_point_nonnegative
      check (reorder_point >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_reorder_qty_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_reorder_qty_nonnegative
      check (reorder_qty >= 0);
  end if;
end $$;

create index if not exists idx_products_restock_priority
  on public.products(restock_priority, active, name);

create index if not exists idx_products_storage_thresholds
  on public.products(min_storage_qty, reorder_point, target_storage_qty)
  where active = true;

update public.products
set restock_priority = 'high'
where restock_priority = 'normal'
  and (
    lower(name) like '%mr crunch%'
    or name like '%طربوش%'
    or lower(name) like '%doritos%'
  );


-- ============================================================================
-- Source migration: supabase/migrations/202606020002_finance_opening_balances_categories_cleanup.sql
-- ============================================================================

create table if not exists public.finance_opening_balances (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  currency text not null,
  balance_date date not null,
  opening_balance numeric(12,2) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_opening_balances_account_check check (account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')),
  constraint finance_opening_balances_currency_check check (currency in ('LYD', 'USD')),
  constraint finance_opening_balances_account_currency_check check (
    (account_id like '%_lyd' and currency = 'LYD')
    or (account_id like '%_usd' and currency = 'USD')
  ),
  unique(account_id, balance_date)
);

create index if not exists idx_finance_opening_balances_account_date
  on public.finance_opening_balances(account_id, balance_date desc);

create table if not exists public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null default 'both',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint finance_categories_type_check check (type in ('income', 'expense', 'transfer', 'both'))
);

alter table public.financial_transactions
  add column if not exists finance_category_id uuid references public.finance_categories(id) on delete set null,
  add column if not exists payer_text text,
  add column if not exists payee_text text,
  add column if not exists counterparty_text text;

alter table public.finance_settings
  add column if not exists reconciliation_cutoff_date date not null default '2026-05-15';

insert into public.finance_categories (name, type)
values
  ('Sales Revenue', 'income'),
  ('Ad Revenue', 'income'),
  ('Rent', 'expense'),
  ('Product Purchase', 'expense'),
  ('Salary / Employee Payment', 'expense'),
  ('Operator Payment', 'expense'),
  ('Delivery / Transport', 'expense'),
  ('Maintenance', 'expense'),
  ('Machine Purchase', 'expense'),
  ('Shipping', 'expense'),
  ('Customs', 'expense'),
  ('Marketing / Ads', 'expense'),
  ('Refund', 'both'),
  ('Charity', 'expense'),
  ('Owner Funding', 'transfer'),
  ('Owner Withdrawal', 'transfer'),
  ('Bank / Exchange', 'transfer'),
  ('Miscellaneous', 'both'),
  ('Other', 'both')
on conflict (name) do update
set type = excluded.type,
    is_active = true;

insert into public.finance_opening_balances (account_id, currency, balance_date, opening_balance, notes)
values
  ('owner_lyd', 'LYD', '2026-05-15', -24360.50, 'Owner / Anas reconciled opening balance as of 2026-05-15'),
  ('owner_usd', 'USD', '2026-05-15', -418.00, 'Owner / Anas reconciled opening balance as of 2026-05-15'),
  ('snacky_lyd', 'LYD', '2026-05-15', 9514.00, 'Snacky reconciled opening balance as of 2026-05-15'),
  ('snacky_usd', 'USD', '2026-05-15', 660.00, 'Snacky reconciled opening balance as of 2026-05-15')
on conflict (account_id, balance_date) do update
set currency = excluded.currency,
    opening_balance = excluded.opening_balance,
    notes = excluded.notes,
    updated_at = now();

insert into public.finance_settings (
  id,
  opening_balance,
  opening_balance_snacky_lyd,
  opening_balance_snacky_usd,
  opening_balance_owner_lyd,
  opening_balance_owner_usd,
  opening_balance_date,
  reconciliation_cutoff_date,
  default_currency
)
values (
  'default',
  9514.00,
  9514.00,
  660.00,
  -24360.50,
  -418.00,
  '2026-05-15',
  '2026-05-15',
  'LYD'
)
on conflict (id) do update
set opening_balance = excluded.opening_balance,
    opening_balance_snacky_lyd = excluded.opening_balance_snacky_lyd,
    opening_balance_snacky_usd = excluded.opening_balance_snacky_usd,
    opening_balance_owner_lyd = excluded.opening_balance_owner_lyd,
    opening_balance_owner_usd = excluded.opening_balance_owner_usd,
    opening_balance_date = excluded.opening_balance_date,
    reconciliation_cutoff_date = excluded.reconciliation_cutoff_date,
    updated_at = now();

create or replace view public.finance_account_balance_impacts as
select
  fob.id as financial_transaction_id,
  fob.balance_date as transaction_date,
  fob.account_id,
  fob.currency,
  fob.opening_balance as amount_delta,
  'opening_balance'::text as transaction_effect,
  'Opening Balance'::text as final_bucket,
  'finance_opening_balances'::text as source_file,
  null::text as source_sheet,
  null::integer as source_row
from public.finance_opening_balances fob
where fob.balance_date = '2026-05-15'

union all

select
  ft.id as financial_transaction_id,
  ft.transaction_date,
  ft.account_id as account_id,
  ft.currency,
  ft.signed_amount as amount_delta,
  ft.transaction_effect,
  ft.final_bucket,
  ft.source_file,
  ft.source_sheet,
  ft.source_row
from public.financial_transactions ft
where ft.transaction_status = 'active'
  and ft.transaction_date > '2026-05-15'
  and coalesce(ft.needs_review, false) = false
  and coalesce(ft.import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and ft.transaction_effect <> 'transfer'
  and ft.transaction_effect <> 'opening_balance'
  and ft.account_id is not null

union all

select
  ft.id,
  ft.transaction_date,
  ft.source_account_id,
  case when right(ft.source_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  -abs(ft.amount),
  ft.transaction_effect,
  ft.final_bucket,
  ft.source_file,
  ft.source_sheet,
  ft.source_row
from public.financial_transactions ft
where ft.transaction_status = 'active'
  and ft.transaction_date > '2026-05-15'
  and coalesce(ft.needs_review, false) = false
  and coalesce(ft.import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and ft.transaction_effect = 'transfer'
  and ft.source_account_id is not null

union all

select
  ft.id,
  ft.transaction_date,
  ft.destination_account_id,
  case when right(ft.destination_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  abs(ft.amount),
  ft.transaction_effect,
  ft.final_bucket,
  ft.source_file,
  ft.source_sheet,
  ft.source_row
from public.financial_transactions ft
where ft.transaction_status = 'active'
  and ft.transaction_date > '2026-05-15'
  and coalesce(ft.needs_review, false) = false
  and coalesce(ft.import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and ft.transaction_effect = 'transfer'
  and ft.destination_account_id is not null;

create or replace view public.finance_account_balances as
select
  account_id,
  currency,
  sum(amount_delta)::numeric(12,2) as balance
from public.finance_account_balance_impacts
group by account_id, currency;

grant select, insert, update on public.finance_opening_balances to authenticated;
grant select, insert, update on public.finance_categories to authenticated;
grant select on public.finance_account_balance_impacts to authenticated;
grant select on public.finance_account_balances to authenticated;


-- ============================================================================
-- Source migration: supabase/migrations/202606020003_finance_csv_import_review_categories.sql
-- ============================================================================

insert into public.finance_categories (name, type, is_active)
values
  ('Revenue', 'income', true),
  ('Products Restocking', 'expense', true),
  ('Rent', 'expense', true),
  ('Salary / Employee Payment', 'expense', true),
  ('Charity', 'expense', true),
  ('Ads', 'income', true),
  ('Shipping', 'expense', true),
  ('Maintenance', 'expense', true),
  ('Machine Purchase', 'expense', true),
  ('Marketing', 'expense', true),
  ('Refund', 'both', true),
  ('Owner Funding', 'transfer', true),
  ('Owner Withdrawal', 'transfer', true),
  ('Exchange', 'transfer', true),
  ('Miscellaneous', 'both', true),
  ('Uncategorized', 'both', true),
  ('Other', 'both', true)
on conflict (name) do update
set type = excluded.type,
    is_active = excluded.is_active;

update public.finance_categories
set is_active = false
where name in (
  'Sales Revenue',
  'Ad Revenue',
  'Ads Income',
  'Product Purchase',
  'Product Restocking',
  'Delivery / Transport',
  'Operator Payment',
  'Commute',
  'Customs',
  'Marketing / Ads',
  'Bank / Exchange'
);


-- ============================================================================
-- Source migration: supabase/migrations/202606020004_finance_transaction_datetime.sql
-- ============================================================================

alter table public.financial_transactions
  add column if not exists transaction_datetime timestamptz;

update public.financial_transactions
set transaction_datetime = transaction_date::timestamptz
where transaction_datetime is null
  and transaction_date is not null;

create index if not exists idx_financial_transactions_datetime
  on public.financial_transactions(transaction_datetime desc);


-- ============================================================================
-- Source migration: supabase/migrations/202606040001_purchase_finance_link_and_account.sql
-- ============================================================================

alter table purchase_orders
  add column if not exists payment_account_id text not null default 'snacky_lyd';

update purchase_orders
set payment_account_id = coalesce(nullif(trim(payment_account_id), ''), 'snacky_lyd')
where payment_account_id is null
   or trim(payment_account_id) = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_orders_payment_account_id_check'
  ) then
    alter table purchase_orders
      add constraint purchase_orders_payment_account_id_check
      check (payment_account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd'));
  end if;
end $$;

alter table financial_transactions
  add column if not exists linked_purchase_id uuid references purchase_orders(id) on delete set null,
  add column if not exists source_type text,
  add column if not exists source_id uuid;

update financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id),
  source_type = coalesce(source_type, case when related_purchase_id is not null then 'purchase' else source_type end),
  source_id = coalesce(source_id, related_purchase_id)
where transaction_kind = 'product_purchase'
  and related_purchase_id is not null;

create unique index if not exists idx_financial_transactions_linked_purchase
  on financial_transactions(linked_purchase_id)
  where linked_purchase_id is not null and transaction_kind = 'product_purchase';

create unique index if not exists idx_financial_transactions_source_type_id
  on financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;


-- ============================================================================
-- Source migration: supabase/migrations/202606040002_finance_transaction_schema_repair_and_purchase_backfill.sql
-- ============================================================================

alter table public.financial_transactions
  add column if not exists counterparty_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists payer_text text,
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid references public.purchase_orders(id) on delete set null,
  add column if not exists account_key text,
  add column if not exists category text,
  add column if not exists transaction_datetime timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_fkey'
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

update public.financial_transactions
set
  paid_to_text = coalesce(nullif(trim(paid_to_text), ''), nullif(trim(payee_text), ''), case when direction = 'money_out' then nullif(trim(counterparty_text), '') end),
  payee_text = coalesce(nullif(trim(payee_text), ''), nullif(trim(paid_to_text), ''), case when direction = 'money_out' then nullif(trim(counterparty_text), '') end),
  payer_text = coalesce(nullif(trim(payer_text), ''), case when direction = 'money_in' then nullif(trim(counterparty_text), '') end),
  counterparty_text = coalesce(
    nullif(trim(counterparty_text), ''),
    case when direction = 'money_in' then nullif(trim(payer_text), '') end,
    case when direction = 'money_out' then nullif(trim(paid_to_text), '') end,
    case when direction = 'money_out' then nullif(trim(payee_text), '') end
  ),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), nullif(trim(source_account_id), '')),
  category = coalesce(nullif(trim(category), ''), nullif(trim(final_bucket), ''), nullif(trim(transaction_type), '')),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz)
where counterparty_text is null
   or paid_to_text is null
   or payee_text is null
   or payer_text is null
   or account_key is null
   or category is null
   or transaction_datetime is null;

update public.financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end),
  source_type = case
    when coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null then 'purchase'
    else source_type
  end,
  source_id = coalesce(source_id, related_purchase_id, linked_purchase_id),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  category = coalesce(nullif(trim(category), ''), 'Products Restocking'),
  paid_to_text = coalesce(nullif(trim(paid_to_text), ''), nullif(trim(payee_text), ''), nullif(trim(counterparty_text), '')),
  payee_text = coalesce(nullif(trim(payee_text), ''), nullif(trim(paid_to_text), ''), nullif(trim(counterparty_text), '')),
  counterparty_text = coalesce(nullif(trim(counterparty_text), ''), nullif(trim(paid_to_text), ''), nullif(trim(payee_text), ''))
where transaction_kind = 'product_purchase'
  and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null;

with linked_purchase_transactions as (
  select
    id,
    coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) as purchase_id,
    row_number() over (
      partition by coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end)
      order by
        case when coalesce(transaction_status, 'active') = 'active' then 0 else 1 end,
        created_at,
        id
    ) as row_rank
  from public.financial_transactions
  where transaction_kind = 'product_purchase'
    and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null
),
duplicate_purchase_transactions as (
  select id, purchase_id
  from linked_purchase_transactions
  where row_rank > 1
)
update public.financial_transactions ft
set
  transaction_status = case when coalesce(ft.transaction_status, 'active') = 'active' then 'voided' else ft.transaction_status end,
  voided_at = case when coalesce(ft.transaction_status, 'active') = 'active' then coalesce(ft.voided_at, now()) else ft.voided_at end,
  status_reason = coalesce(ft.status_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
  linked_purchase_id = null,
  source_type = case when ft.source_type = 'purchase' then null else ft.source_type end,
  source_id = case when ft.source_type = 'purchase' then null else ft.source_id end,
  metadata = coalesce(ft.metadata, '{}'::jsonb) || jsonb_build_object(
    'duplicate_purchase_finance_transaction',
    true,
    'duplicate_purchase_id',
    dpt.purchase_id
  ),
  updated_at = now()
from duplicate_purchase_transactions dpt
where ft.id = dpt.id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_key'
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_key unique (linked_purchase_id);
  end if;
exception
  when duplicate_object then null;
end $$;

create unique index if not exists idx_financial_transactions_purchase_source_type_id
  on public.financial_transactions(source_type, source_id)
  where source_type = 'purchase' and source_id is not null;

create index if not exists idx_financial_transactions_account_key_date
  on public.financial_transactions(account_key, transaction_date desc);

create index if not exists idx_financial_transactions_category_date
  on public.financial_transactions(category, transaction_date desc);

insert into public.finance_categories (name, type, is_active)
values
  ('Products Restocking', 'expense', true),
  ('Transfer', 'transfer', true)
on conflict (name) do update
set type = excluded.type,
    is_active = true;

create or replace function public.backfill_purchase_financial_transactions(p_since date default null)
returns table (
  purchases_checked integer,
  transactions_created integer,
  transactions_skipped integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_existing_id uuid;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_description text;
  v_checked integer := 0;
  v_created integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
  then
    raise exception 'Permission denied for purchase finance backfill' using errcode = '42501';
  end if;

  for v_purchase in
    select
      po.*,
      s.name as supplier_name,
      coalesce(
        po.manual_total_lyd,
        po.total_amount,
        po.calculated_total_lyd,
        (
          select sum(coalesce(pol.line_total_lyd, pol.line_total, 0))
          from public.purchase_order_lines pol
          where pol.purchase_order_id = po.id
        ),
        0
      ) as finance_total
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    where coalesce(po.status, '') not in ('draft', 'cancelled', 'voided')
      and coalesce(po.payment_status, 'paid') in ('paid', 'confirmed', 'saved')
      and (p_since is null or coalesce(po.order_date, po.created_at::date) >= p_since)
    order by coalesce(po.order_date, po.created_at::date), po.created_at, po.id
  loop
    v_checked := v_checked + 1;
    begin
      v_amount := round(greatest(coalesce(v_purchase.finance_total, 0), 0), 2);
      if v_amount <= 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_account_key := case
        when nullif(trim(coalesce(v_purchase.payment_account_id, '')), '') in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
          then nullif(trim(v_purchase.payment_account_id), '')
        else 'snacky_lyd'
      end;
      v_currency := case when right(v_account_key, 3) = 'usd' then 'USD' else 'LYD' end;
      v_description := concat_ws(
        ' - ',
        'Purchase from ' || coalesce(nullif(trim(v_purchase.supplier_name), ''), 'supplier'),
        case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || trim(v_purchase.receipt_number) end,
        nullif(trim(coalesce(v_purchase.notes, '')), '')
      );

      select ft.id
      into v_existing_id
      from public.financial_transactions ft
      where ft.transaction_kind = 'product_purchase'
        and (
          ft.related_purchase_id = v_purchase.id
          or ft.linked_purchase_id = v_purchase.id
          or (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
        )
      order by
        case when coalesce(ft.transaction_status, 'active') = 'active' then 0 else 1 end,
        ft.created_at,
        ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set
          transaction_date = coalesce(v_purchase.order_date, v_purchase.created_at::date),
          transaction_datetime = coalesce(v_purchase.order_date, v_purchase.created_at::date)::timestamptz,
          direction = 'money_out',
          transaction_kind = 'product_purchase',
          transaction_type = 'Products Restocking',
          category = 'Products Restocking',
          description = v_description,
          notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
          amount = v_amount,
          signed_amount = -abs(v_amount),
          currency = v_currency,
          account_id = v_account_key,
          account_key = v_account_key,
          transaction_effect = 'expense',
          source_account_id = null,
          destination_account_id = null,
          bucket = 'Inventory',
          final_bucket = 'Products Restocking',
          review_status = 'confirmed',
          needs_review = false,
          transaction_status = 'active',
          payment_method = v_purchase.payment_method,
          receipt_url = v_purchase.receipt_url,
          payer_text = null,
          payee_text = nullif(trim(v_purchase.supplier_name), ''),
          paid_to_text = nullif(trim(v_purchase.supplier_name), ''),
          counterparty_text = nullif(trim(v_purchase.supplier_name), ''),
          linked_purchase_id = v_purchase.id,
          related_purchase_id = v_purchase.id,
          source_type = 'purchase',
          source_id = v_purchase.id,
          updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions (
          transaction_date,
          transaction_datetime,
          direction,
          transaction_kind,
          transaction_type,
          category,
          description,
          notes,
          amount,
          signed_amount,
          currency,
          account_id,
          account_key,
          transaction_effect,
          source_account_id,
          destination_account_id,
          bucket,
          final_bucket,
          review_status,
          needs_review,
          transaction_status,
          payment_method,
          receipt_url,
          payer_text,
          payee_text,
          paid_to_text,
          counterparty_text,
          linked_purchase_id,
          related_purchase_id,
          source_type,
          source_id,
          created_by,
          updated_at
        )
        values (
          coalesce(v_purchase.order_date, v_purchase.created_at::date),
          coalesce(v_purchase.order_date, v_purchase.created_at::date)::timestamptz,
          'money_out',
          'product_purchase',
          'Products Restocking',
          'Products Restocking',
          v_description,
          coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
          v_amount,
          -abs(v_amount),
          v_currency,
          v_account_key,
          v_account_key,
          'expense',
          null,
          null,
          'Inventory',
          'Products Restocking',
          'confirmed',
          false,
          'active',
          v_purchase.payment_method,
          v_purchase.receipt_url,
          null,
          nullif(trim(v_purchase.supplier_name), ''),
          nullif(trim(v_purchase.supplier_name), ''),
          nullif(trim(v_purchase.supplier_name), ''),
          v_purchase.id,
          v_purchase.id,
          'purchase',
          v_purchase.id,
          v_purchase.created_by,
          now()
        )
        on conflict (linked_purchase_id) do update
        set
          transaction_date = excluded.transaction_date,
          transaction_datetime = excluded.transaction_datetime,
          transaction_type = excluded.transaction_type,
          category = excluded.category,
          description = excluded.description,
          notes = excluded.notes,
          amount = excluded.amount,
          signed_amount = excluded.signed_amount,
          currency = excluded.currency,
          account_id = excluded.account_id,
          account_key = excluded.account_key,
          transaction_effect = excluded.transaction_effect,
          bucket = excluded.bucket,
          final_bucket = excluded.final_bucket,
          review_status = excluded.review_status,
          needs_review = excluded.needs_review,
          transaction_status = excluded.transaction_status,
          payment_method = excluded.payment_method,
          receipt_url = excluded.receipt_url,
          payee_text = excluded.payee_text,
          paid_to_text = excluded.paid_to_text,
          counterparty_text = excluded.counterparty_text,
          related_purchase_id = excluded.related_purchase_id,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          updated_at = now();
        v_created := v_created + 1;
      end if;
    exception
      when others then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'purchase_id',
          v_purchase.id,
          'message',
          sqlerrm
        ));
    end;
  end loop;

  return query select v_checked, v_created, v_skipped, v_errors;
end;
$$;

revoke all on function public.backfill_purchase_financial_transactions(date) from public;
grant execute on function public.backfill_purchase_financial_transactions(date) to authenticated;

do $$
begin
  perform 1 from public.backfill_purchase_financial_transactions();
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606040003_finance_ledger_resilience_and_purchase_backfill_rpc.sql
-- ============================================================================

alter table public.financial_transactions
  add column if not exists transaction_datetime timestamptz,
  add column if not exists currency text,
  add column if not exists account_key text,
  add column if not exists category text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists is_void boolean,
  add column if not exists void_reason text,
  add column if not exists transaction_status text default 'active',
  add column if not exists notes text,
  add column if not exists location text,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists created_by uuid references public.team_members(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_fkey'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

update public.financial_transactions
set
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), nullif(trim(source_account_id), ''), 'snacky_lyd'),
  category = coalesce(nullif(trim(category), ''), nullif(trim(final_bucket), ''), nullif(trim(transaction_type), ''), nullif(trim(bucket), ''), 'Uncategorized'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), 'active'),
  is_void = coalesce(is_void, transaction_status = 'voided' or voided_at is not null),
  void_reason = coalesce(nullif(trim(void_reason), ''), nullif(trim(status_reason), '')),
  counterparty_text = coalesce(
    nullif(trim(counterparty_text), ''),
    case when direction = 'money_in' then nullif(trim(payer_text), '') end,
    case when direction = 'money_out' then nullif(trim(paid_to_text), '') end
  ),
  payer_text = coalesce(nullif(trim(payer_text), ''), case when direction = 'money_in' then nullif(trim(counterparty_text), '') end),
  paid_to_text = coalesce(nullif(trim(paid_to_text), ''), case when direction = 'money_out' then nullif(trim(counterparty_text), '') end),
  updated_at = coalesce(updated_at, now())
where currency is null
   or trim(coalesce(currency, '')) = ''
   or account_key is null
   or trim(coalesce(account_key, '')) = ''
   or category is null
   or trim(coalesce(category, '')) = ''
   or transaction_datetime is null
   or transaction_status is null
   or trim(coalesce(transaction_status, '')) = ''
   or is_void is null
   or void_reason is null
   or counterparty_text is null
   or payer_text is null
   or paid_to_text is null
   or updated_at is null;

alter table public.financial_transactions
  alter column currency set default 'LYD',
  alter column is_void set default false,
  alter column is_void set not null,
  alter column transaction_status set default 'active';

update public.financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end),
  related_purchase_id = coalesce(related_purchase_id, linked_purchase_id, case when source_type = 'purchase' then source_id end),
  source_type = 'purchase',
  source_id = coalesce(source_id, related_purchase_id, linked_purchase_id),
  direction = 'money_out',
  transaction_kind = 'product_purchase',
  transaction_type = coalesce(nullif(trim(transaction_type), ''), 'Products Restocking'),
  category = 'Products Restocking',
  final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Products Restocking'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  updated_at = now()
where transaction_kind = 'product_purchase'
  and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null;

with linked_purchase_transactions as (
  select
    id,
    coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) as purchase_id,
    row_number() over (
      partition by coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end)
      order by
        case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end,
        created_at,
        id
    ) as row_rank
  from public.financial_transactions
  where transaction_kind = 'product_purchase'
    and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null
),
duplicate_purchase_transactions as (
  select id, purchase_id
  from linked_purchase_transactions
  where row_rank > 1
)
update public.financial_transactions ft
set
  transaction_status = case when coalesce(ft.transaction_status, 'active') = 'active' then 'voided' else ft.transaction_status end,
  is_void = true,
  voided_at = coalesce(ft.voided_at, now()),
  void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
  status_reason = coalesce(ft.status_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
  linked_purchase_id = null,
  source_type = case when ft.source_type = 'purchase' then null else ft.source_type end,
  source_id = case when ft.source_type = 'purchase' then null else ft.source_id end,
  metadata = coalesce(ft.metadata, '{}'::jsonb) || jsonb_build_object(
    'duplicate_purchase_finance_transaction',
    true,
    'duplicate_purchase_id',
    dpt.purchase_id
  ),
  updated_at = now()
from duplicate_purchase_transactions dpt
where ft.id = dpt.id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_key'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_key unique (linked_purchase_id);
  end if;
exception
  when duplicate_object then null;
end $$;

create unique index if not exists idx_financial_transactions_purchase_source_type_id
  on public.financial_transactions(source_type, source_id)
  where source_type = 'purchase' and source_id is not null;

create index if not exists idx_financial_transactions_account_key_date
  on public.financial_transactions(account_key, transaction_date desc);

create index if not exists idx_financial_transactions_category_date
  on public.financial_transactions(category, transaction_date desc);

insert into public.finance_categories (name, type, is_active)
values
  ('Products Restocking', 'expense', true),
  ('Transfer', 'transfer', true)
on conflict (name) do update
set type = excluded.type,
    is_active = true;

alter table public.financial_transactions enable row level security;

grant select, insert, update on table public.financial_transactions to authenticated;

drop policy if exists "financial_transactions_select_finance_roles" on public.financial_transactions;
drop policy if exists "financial_transactions_insert_finance_roles" on public.financial_transactions;
drop policy if exists "financial_transactions_update_finance_roles" on public.financial_transactions;

create policy "financial_transactions_select_finance_roles"
  on public.financial_transactions
  for select
  to authenticated
  using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']));

create policy "financial_transactions_insert_finance_roles"
  on public.financial_transactions
  for insert
  to authenticated
  with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']));

create policy "financial_transactions_update_finance_roles"
  on public.financial_transactions
  for update
  to authenticated
  using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']));

drop function if exists public.backfill_purchase_financial_transactions(date);

create or replace function public.backfill_purchase_financial_transactions(
  p_start_date date default '2026-06-01',
  p_end_date date default '2026-06-03'
)
returns table (
  purchases_checked integer,
  transactions_created integer,
  transactions_skipped integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_purchase_date date;
  v_existing_id uuid;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_description text;
  v_checked integer := 0;
  v_created integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
  then
    raise exception 'Permission denied for purchase finance backfill' using errcode = '42501';
  end if;

  for v_purchase in
    select
      po.*,
      s.name as supplier_name,
      coalesce(
        po.manual_total_lyd,
        po.total_amount,
        po.calculated_total_lyd,
        (
          select sum(coalesce(pol.line_total_lyd, pol.line_total, 0))
          from public.purchase_order_lines pol
          where pol.purchase_order_id = po.id
        ),
        0
      ) as finance_total
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    where coalesce(po.status, '') not in ('draft', 'cancelled', 'voided')
      and (
        coalesce(po.payment_status, 'paid') in ('paid', 'confirmed', 'saved')
        or coalesce(po.status, '') in ('received', 'confirmed', 'saved', 'ordered')
      )
      and coalesce(po.order_date, po.created_at::date) >= coalesce(p_start_date, '1900-01-01'::date)
      and coalesce(po.order_date, po.created_at::date) <= coalesce(p_end_date, current_date)
    order by coalesce(po.order_date, po.created_at::date), po.created_at, po.id
  loop
    v_checked := v_checked + 1;
    begin
      v_purchase_date := coalesce(v_purchase.order_date, v_purchase.created_at::date);
      v_amount := round(greatest(coalesce(v_purchase.finance_total, 0), 0), 2);
      if v_amount <= 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_account_key := case
        when nullif(trim(coalesce(v_purchase.payment_account_id, '')), '') in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
          then nullif(trim(v_purchase.payment_account_id), '')
        else 'snacky_lyd'
      end;
      v_currency := case when right(v_account_key, 3) = 'usd' then 'USD' else 'LYD' end;
      v_description := concat_ws(
        ' - ',
        'Purchase from ' || coalesce(nullif(trim(v_purchase.supplier_name), ''), 'supplier'),
        case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || trim(v_purchase.receipt_number) end,
        nullif(trim(coalesce(v_purchase.notes, '')), '')
      );

      select ft.id
      into v_existing_id
      from public.financial_transactions ft
      where ft.transaction_kind = 'product_purchase'
        and (
          ft.related_purchase_id = v_purchase.id
          or ft.linked_purchase_id = v_purchase.id
          or (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
        )
      order by
        case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
        ft.created_at,
        ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set
          transaction_date = v_purchase_date,
          transaction_datetime = v_purchase_date::timestamptz,
          direction = 'money_out',
          transaction_kind = 'product_purchase',
          transaction_type = 'Products Restocking',
          category = 'Products Restocking',
          description = v_description,
          notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
          amount = v_amount,
          signed_amount = -abs(v_amount),
          currency = v_currency,
          account_id = v_account_key,
          account_key = v_account_key,
          transaction_effect = 'expense',
          source_account_id = null,
          destination_account_id = null,
          bucket = 'Inventory',
          final_bucket = 'Products Restocking',
          review_status = 'confirmed',
          needs_review = false,
          transaction_status = 'active',
          is_void = false,
          voided_at = null,
          void_reason = null,
          payment_method = v_purchase.payment_method,
          receipt_url = v_purchase.receipt_url,
          payer_text = null,
          paid_to_text = nullif(trim(v_purchase.supplier_name), ''),
          counterparty_text = nullif(trim(v_purchase.supplier_name), ''),
          linked_purchase_id = v_purchase.id,
          related_purchase_id = v_purchase.id,
          source_type = 'purchase',
          source_id = v_purchase.id,
          updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions (
          transaction_date,
          transaction_datetime,
          direction,
          transaction_kind,
          transaction_type,
          category,
          description,
          notes,
          amount,
          signed_amount,
          currency,
          account_id,
          account_key,
          transaction_effect,
          source_account_id,
          destination_account_id,
          bucket,
          final_bucket,
          review_status,
          needs_review,
          transaction_status,
          is_void,
          payment_method,
          receipt_url,
          payer_text,
          paid_to_text,
          counterparty_text,
          linked_purchase_id,
          related_purchase_id,
          source_type,
          source_id,
          created_by,
          updated_at
        )
        values (
          v_purchase_date,
          v_purchase_date::timestamptz,
          'money_out',
          'product_purchase',
          'Products Restocking',
          'Products Restocking',
          v_description,
          coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
          v_amount,
          -abs(v_amount),
          v_currency,
          v_account_key,
          v_account_key,
          'expense',
          null,
          null,
          'Inventory',
          'Products Restocking',
          'confirmed',
          false,
          'active',
          false,
          v_purchase.payment_method,
          v_purchase.receipt_url,
          null,
          nullif(trim(v_purchase.supplier_name), ''),
          nullif(trim(v_purchase.supplier_name), ''),
          v_purchase.id,
          v_purchase.id,
          'purchase',
          v_purchase.id,
          v_purchase.created_by,
          now()
        )
        on conflict (linked_purchase_id) do update
        set
          transaction_date = excluded.transaction_date,
          transaction_datetime = excluded.transaction_datetime,
          direction = excluded.direction,
          transaction_kind = excluded.transaction_kind,
          transaction_type = excluded.transaction_type,
          category = excluded.category,
          description = excluded.description,
          notes = excluded.notes,
          amount = excluded.amount,
          signed_amount = excluded.signed_amount,
          currency = excluded.currency,
          account_id = excluded.account_id,
          account_key = excluded.account_key,
          transaction_effect = excluded.transaction_effect,
          source_account_id = excluded.source_account_id,
          destination_account_id = excluded.destination_account_id,
          bucket = excluded.bucket,
          final_bucket = excluded.final_bucket,
          review_status = excluded.review_status,
          needs_review = excluded.needs_review,
          transaction_status = excluded.transaction_status,
          is_void = false,
          voided_at = null,
          void_reason = null,
          payment_method = excluded.payment_method,
          receipt_url = excluded.receipt_url,
          payer_text = excluded.payer_text,
          paid_to_text = excluded.paid_to_text,
          counterparty_text = excluded.counterparty_text,
          related_purchase_id = excluded.related_purchase_id,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          updated_at = now();
        v_created := v_created + 1;
      end if;
    exception
      when others then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'purchase_id',
          v_purchase.id,
          'sqlstate',
          sqlstate,
          'message',
          sqlerrm
        ));
    end;
  end loop;

  return query select v_checked, v_created, v_skipped, v_errors;
end;
$$;

revoke all on function public.backfill_purchase_financial_transactions(date, date) from public;
grant execute on function public.backfill_purchase_financial_transactions(date, date) to authenticated;

do $$
begin
  perform 1 from public.backfill_purchase_financial_transactions('2026-06-01'::date, '2026-06-03'::date);
  perform 1 from public.backfill_purchase_financial_transactions('1900-01-01'::date, current_date);
end $$;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606060001_vms_import_status_sources.sql
-- ============================================================================

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


-- ============================================================================
-- Source migration: supabase/migrations/202606080001_finance_source_ledger_purchase_cash_backfill.sql
-- ============================================================================

-- Finance transaction ledger repair: purchases and cash collections must own one source-linked row.

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists category text,
  add column if not exists direction text,
  add column if not exists location text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists payment_method text,
  add column if not exists receipt_url text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists currency text default 'LYD',
  add column if not exists notes text,
  add column if not exists is_void boolean default false,
  add column if not exists void_reason text,
  add column if not exists transaction_status text default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_fkey'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'financial_transactions_linked_cash_collection_id_fkey'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_cash_collection_id_fkey
      foreign key (linked_cash_collection_id) references public.cash_collections(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

update public.financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end),
  related_purchase_id = coalesce(related_purchase_id, linked_purchase_id, case when source_type = 'purchase' then source_id end),
  source_type = 'purchase',
  source_id = coalesce(source_id, related_purchase_id, linked_purchase_id),
  direction = 'money_out',
  transaction_kind = 'product_purchase',
  transaction_type = 'Products Restocking',
  category = 'Products Restocking',
  final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Products Restocking'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), 'active'),
  is_void = coalesce(is_void, false),
  updated_at = now()
where transaction_kind = 'product_purchase'
  and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null;

update public.financial_transactions
set
  linked_cash_collection_id = coalesce(linked_cash_collection_id, related_cash_collection_id, case when source_type = 'cash_collection' then source_id end),
  related_cash_collection_id = coalesce(related_cash_collection_id, linked_cash_collection_id, case when source_type = 'cash_collection' then source_id end),
  source_type = 'cash_collection',
  source_id = coalesce(source_id, related_cash_collection_id, linked_cash_collection_id),
  direction = 'money_in',
  transaction_kind = 'cash_collection',
  transaction_type = 'Revenue',
  category = 'Revenue',
  final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Revenue'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), 'active'),
  is_void = coalesce(is_void, false),
  updated_at = now()
where transaction_kind = 'cash_collection'
  and coalesce(linked_cash_collection_id, related_cash_collection_id, case when source_type = 'cash_collection' then source_id end) is not null;

with linked as (
  select id, linked_purchase_id as source_id,
    row_number() over (partition by linked_purchase_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_purchase_id is not null
), duplicates as (
  select * from linked where rn > 1
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
    status_reason = coalesce(ft.status_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
    linked_purchase_id = null,
    source_type = case when ft.source_type = 'purchase' then null else ft.source_type end,
    source_id = case when ft.source_type = 'purchase' then null else ft.source_id end,
    updated_at = now()
from duplicates d
where ft.id = d.id;

with linked as (
  select id, linked_cash_collection_id as source_id,
    row_number() over (partition by linked_cash_collection_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_cash_collection_id is not null
), duplicates as (
  select * from linked where rn > 1
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance transaction superseded by the linked transaction.'),
    status_reason = coalesce(ft.status_reason, 'Duplicate cash collection finance transaction superseded by the linked transaction.'),
    linked_cash_collection_id = null,
    source_type = case when ft.source_type = 'cash_collection' then null else ft.source_type end,
    source_id = case when ft.source_type = 'cash_collection' then null else ft.source_id end,
    updated_at = now()
from duplicates d
where ft.id = d.id;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_purchase_id_key' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions add constraint financial_transactions_linked_purchase_id_key unique (linked_purchase_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_cash_collection_id_key' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions add constraint financial_transactions_linked_cash_collection_id_key unique (linked_cash_collection_id);
  end if;
exception
  when duplicate_object then null;
end $$;

with linked as (
  select id, source_type, source_id,
    row_number() over (partition by source_type, source_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where source_type is not null and source_id is not null
), duplicates as (
  select * from linked where rn > 1
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate source finance transaction superseded by the linked transaction.'),
    status_reason = coalesce(ft.status_reason, 'Duplicate source finance transaction superseded by the linked transaction.'),
    source_type = null,
    source_id = null,
    linked_purchase_id = case when ft.source_type = 'purchase' then null else ft.linked_purchase_id end,
    linked_cash_collection_id = case when ft.source_type = 'cash_collection' then null else ft.linked_cash_collection_id end,
    updated_at = now()
from duplicates d
where ft.id = d.id;

create unique index if not exists idx_financial_transactions_source_type_source_id
  on public.financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;

insert into public.finance_categories (name, type, is_active)
values ('Products Restocking', 'expense', true), ('Revenue', 'income', true)
on conflict (name) do update set type = excluded.type, is_active = true;

drop function if exists public.backfill_missing_finance_transactions();

create or replace function public.backfill_missing_finance_transactions()
returns table (
  purchases_checked integer,
  purchase_transactions_created integer,
  cash_collections_checked integer,
  cash_collection_transactions_created integer,
  skipped_existing integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_cash record;
  v_existing_id uuid;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_description text;
  v_purchases_checked integer := 0;
  v_purchase_created integer := 0;
  v_cash_checked integer := 0;
  v_cash_created integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  for v_purchase in
    select po.*, s.name as supplier_name
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    where po.payment_status = 'paid'
      and coalesce(po.status, '') <> 'voided'
  loop
    v_purchases_checked := v_purchases_checked + 1;
    begin
      v_amount := abs(coalesce(v_purchase.manual_total_lyd, v_purchase.total_amount, v_purchase.calculated_total_lyd, 0));
      if v_amount <= 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
      v_currency := case when v_account_key like '%usd' then 'USD' else 'LYD' end;
      v_description := concat_ws(' - ', 'Purchase from ' || coalesce(nullif(trim(v_purchase.supplier_name), ''), 'supplier'), case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || v_purchase.receipt_number end, nullif(trim(coalesce(v_purchase.notes, '')), ''));

      select ft.id into v_existing_id
      from public.financial_transactions ft
      where ft.linked_purchase_id = v_purchase.id
         or ft.related_purchase_id = v_purchase.id
         or (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
      order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end, ft.created_at, ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set transaction_date = v_purchase.order_date,
            transaction_datetime = v_purchase.order_date::timestamptz,
            direction = 'money_out',
            transaction_kind = 'product_purchase',
            transaction_type = 'Products Restocking',
            category = 'Products Restocking',
            description = v_description,
            notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
            amount = v_amount,
            signed_amount = -abs(v_amount),
            currency = v_currency,
            account_id = v_account_key,
            account_key = v_account_key,
            transaction_effect = 'expense',
            source_account_id = null,
            destination_account_id = null,
            bucket = 'Inventory',
            final_bucket = 'Products Restocking',
            review_status = 'confirmed',
            needs_review = false,
            transaction_status = 'active',
            is_void = false,
            voided_at = null,
            void_reason = null,
            payment_method = v_purchase.payment_method,
            receipt_url = v_purchase.receipt_url,
            paid_to_text = nullif(trim(v_purchase.supplier_name), ''),
            payee_text = nullif(trim(v_purchase.supplier_name), ''),
            counterparty_text = nullif(trim(v_purchase.supplier_name), ''),
            linked_purchase_id = v_purchase.id,
            related_purchase_id = v_purchase.id,
            source_type = 'purchase',
            source_id = v_purchase.id,
            updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions(transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category, description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect, source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review, transaction_status, is_void, payment_method, receipt_url, paid_to_text, payee_text, counterparty_text, linked_purchase_id, related_purchase_id, source_type, source_id, created_by, updated_at)
        values (v_purchase.order_date, v_purchase.order_date::timestamptz, 'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', v_description, coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description), v_amount, -abs(v_amount), v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking', 'confirmed', false, 'active', false, v_purchase.payment_method, v_purchase.receipt_url, nullif(trim(v_purchase.supplier_name), ''), nullif(trim(v_purchase.supplier_name), ''), nullif(trim(v_purchase.supplier_name), ''), v_purchase.id, v_purchase.id, 'purchase', v_purchase.id, v_purchase.created_by, now())
        on conflict (linked_purchase_id) do update set updated_at = now();
        v_purchase_created := v_purchase_created + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'purchase', 'source_id', v_purchase.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  for v_cash in
    select cc.*, m.name as machine_name, m.machine_code, l.name as location_name
    from public.cash_collections cc
    left join public.machines m on m.id = cc.machine_id
    left join public.locations l on l.id = m.location_id
    where coalesce(cc.actual_cash_collected, 0) > 0
      and coalesce(cc.review_status, '') <> 'voided'
  loop
    v_cash_checked := v_cash_checked + 1;
    begin
      v_amount := abs(coalesce(v_cash.actual_cash_collected, 0));
      v_description := 'Cash collection from ' || coalesce(nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''), nullif(trim(v_cash.location_name), ''), v_cash.id::text);
      if nullif(trim(coalesce(v_cash.cash_bag_id, '')), '') is not null then
        v_description := v_description || ' - Bag ' || v_cash.cash_bag_id;
      end if;

      select ft.id into v_existing_id
      from public.financial_transactions ft
      where ft.linked_cash_collection_id = v_cash.id
         or ft.related_cash_collection_id = v_cash.id
         or (ft.source_type = 'cash_collection' and ft.source_id = v_cash.id)
      order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end, ft.created_at, ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set transaction_date = coalesce(v_cash.collected_at, v_cash.counted_at, now())::date,
            transaction_datetime = coalesce(v_cash.collected_at, v_cash.counted_at, now()),
            direction = 'money_in',
            transaction_kind = 'cash_collection',
            transaction_type = 'Revenue',
            category = 'Revenue',
            description = v_description,
            notes = v_description,
            amount = v_amount,
            signed_amount = abs(v_amount),
            currency = 'LYD',
            account_id = 'snacky_lyd',
            account_key = 'snacky_lyd',
            transaction_effect = 'income',
            source_account_id = null,
            destination_account_id = null,
            bucket = 'Revenue',
            final_bucket = 'Revenue',
            review_status = 'confirmed',
            needs_review = false,
            transaction_status = 'active',
            is_void = false,
            voided_at = null,
            void_reason = null,
            payment_method = 'cash',
            payer_text = 'Cash customers',
            counterparty_text = 'Cash customers',
            linked_cash_collection_id = v_cash.id,
            related_cash_collection_id = v_cash.id,
            related_route_id = v_cash.route_id,
            related_machine_id = v_cash.machine_id,
            location = coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), '')),
            source_type = 'cash_collection',
            source_id = v_cash.id,
            updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions(transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category, description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect, source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review, transaction_status, is_void, payment_method, payer_text, counterparty_text, related_cash_collection_id, linked_cash_collection_id, related_route_id, related_machine_id, location, source_type, source_id, created_by, updated_at)
        values (coalesce(v_cash.collected_at, v_cash.counted_at, now())::date, coalesce(v_cash.collected_at, v_cash.counted_at, now()), 'money_in', 'cash_collection', 'Revenue', 'Revenue', v_description, v_description, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd', 'income', null, null, 'Revenue', 'Revenue', 'confirmed', false, 'active', false, 'cash', 'Cash customers', 'Cash customers', v_cash.id, v_cash.id, v_cash.route_id, v_cash.machine_id, coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), '')), 'cash_collection', v_cash.id, v_cash.operator_id, now())
        on conflict (linked_cash_collection_id) do update set updated_at = now();
        v_cash_created := v_cash_created + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'cash_collection', 'source_id', v_cash.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  return query select v_purchases_checked, v_purchase_created, v_cash_checked, v_cash_created, v_skipped, v_errors;
end;
$$;

revoke all on function public.backfill_missing_finance_transactions() from public;
grant execute on function public.backfill_missing_finance_transactions() to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606080002_finance_auto_sync_triggers.sql
-- ============================================================================

-- Finance must be the source of truth for every money event.
-- Purchases and cash collections create/update their financial_transactions row automatically.

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_purchase_id uuid,
  add column if not exists related_cash_collection_id uuid,
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists category text,
  add column if not exists direction text,
  add column if not exists location text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists payment_method text,
  add column if not exists receipt_url text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists currency text default 'LYD',
  add column if not exists notes text,
  add column if not exists is_void boolean default false,
  add column if not exists void_reason text,
  add column if not exists transaction_status text default 'active';

insert into public.finance_categories (name, type, is_active)
values ('Products Restocking', 'expense', true), ('Revenue', 'income', true), ('Uncategorized', 'expense', true)
on conflict (name) do update set is_active = true;

create or replace function public.snacky_finance_account_currency(p_account_key text)
returns text
language sql
immutable
as $$
  select case when lower(coalesce(p_account_key, '')) like '%usd%' then 'USD' else 'LYD' end
$$;

create or replace function public.ensure_purchase_finance_transaction(p_purchase_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_supplier_name text;
  v_description text;
  v_transaction_id uuid;
begin
  select po.*, s.name as supplier_name
    into v_purchase
  from public.purchase_orders po
  left join public.suppliers s on s.id = po.supplier_id
  where po.id = p_purchase_id;

  if not found then
    raise exception 'Purchase % not found', p_purchase_id using errcode = 'P0002';
  end if;

  if coalesce(v_purchase.payment_status, '') <> 'paid'
     or coalesce(v_purchase.status, '') in ('cancelled', 'voided') then
    return null;
  end if;

  v_amount := abs(coalesce(v_purchase.manual_total_lyd, v_purchase.total_amount, v_purchase.calculated_total_lyd, 0));
  if v_amount <= 0 then
    return null;
  end if;

  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := public.snacky_finance_account_currency(v_account_key);
  v_supplier_name := nullif(trim(coalesce(v_purchase.supplier_name, '')), '');
  v_description := concat_ws(
    ' - ',
    'Purchase from ' || coalesce(v_supplier_name, 'supplier'),
    case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || v_purchase.receipt_number end,
    nullif(trim(coalesce(v_purchase.notes, '')), '')
  );

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or ft.related_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review,
      transaction_status, is_void, voided_at, void_reason, payment_method, receipt_url, payer_text,
      paid_to_text, payee_text, counterparty_text, linked_purchase_id, related_purchase_id, source_type,
      source_id, created_by, updated_at
    ) values (
      v_purchase.order_date, v_purchase.order_date::timestamptz, 'money_out', 'product_purchase',
      'Products Restocking', 'Products Restocking', v_description,
      coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      'confirmed', false, 'active', false, null, null, v_purchase.payment_method, v_purchase.receipt_url,
      null, v_supplier_name, v_supplier_name, v_supplier_name, p_purchase_id, p_purchase_id, 'purchase',
      p_purchase_id, v_purchase.created_by, now()
    )
    returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = v_purchase.order_date,
        transaction_datetime = v_purchase.order_date::timestamptz,
        direction = 'money_out',
        transaction_kind = 'product_purchase',
        transaction_type = 'Products Restocking',
        category = 'Products Restocking',
        description = v_description,
        notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
        amount = v_amount,
        signed_amount = -abs(v_amount),
        currency = v_currency,
        account_id = v_account_key,
        account_key = v_account_key,
        transaction_effect = 'expense',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Inventory',
        final_bucket = 'Products Restocking',
        review_status = 'confirmed',
        needs_review = false,
        transaction_status = 'active',
        is_void = false,
        voided_at = null,
        void_reason = null,
        payment_method = v_purchase.payment_method,
        receipt_url = v_purchase.receipt_url,
        payer_text = null,
        paid_to_text = v_supplier_name,
        payee_text = v_supplier_name,
        counterparty_text = v_supplier_name,
        linked_purchase_id = p_purchase_id,
        related_purchase_id = p_purchase_id,
        source_type = 'purchase',
        source_id = p_purchase_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

create or replace function public.ensure_cash_collection_finance_transaction(p_cash_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_cash record;
  v_amount numeric;
  v_datetime timestamptz;
  v_description text;
  v_location text;
  v_transaction_id uuid;
begin
  select cc.*, m.name as machine_name, m.machine_code, l.name as location_name
    into v_cash
  from public.cash_collections cc
  left join public.machines m on m.id = cc.machine_id
  left join public.locations l on l.id = m.location_id
  where cc.id = p_cash_collection_id;

  if not found then
    raise exception 'Cash collection % not found', p_cash_collection_id using errcode = 'P0002';
  end if;

  if v_cash.actual_cash_collected is null or coalesce(v_cash.review_status, '') = 'voided' then
    return null;
  end if;

  v_amount := abs(coalesce(v_cash.actual_cash_collected, 0));
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''));
  v_description := 'Cash collection from ' || coalesce(nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''), nullif(trim(v_cash.location_name), ''), p_cash_collection_id::text);
  if nullif(trim(coalesce(v_cash.cash_bag_id, '')), '') is not null then
    v_description := v_description || ' - Bag ' || v_cash.cash_bag_id;
  end if;

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or ft.related_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review,
      transaction_status, is_void, voided_at, void_reason, payment_method, payer_text, payee_text,
      paid_to_text, counterparty_text, related_cash_collection_id, linked_cash_collection_id,
      related_route_id, related_machine_id, location, source_type, source_id, created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_description, v_description, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'confirmed', false, 'active', false, null, null,
      'cash', 'Cash customers', null, null, 'Cash customers', p_cash_collection_id, p_cash_collection_id,
      v_cash.route_id, v_cash.machine_id, v_location, 'cash_collection', p_cash_collection_id,
      v_cash.operator_id, now()
    )
    returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = v_datetime::date,
        transaction_datetime = v_datetime,
        direction = 'money_in',
        transaction_kind = 'cash_collection',
        transaction_type = 'Revenue',
        category = 'Revenue',
        description = v_description,
        notes = v_description,
        amount = v_amount,
        signed_amount = abs(v_amount),
        currency = 'LYD',
        account_id = 'snacky_lyd',
        account_key = 'snacky_lyd',
        transaction_effect = 'income',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Revenue',
        final_bucket = 'Revenue',
        review_status = 'confirmed',
        needs_review = false,
        transaction_status = 'active',
        is_void = false,
        voided_at = null,
        void_reason = null,
        payment_method = 'cash',
        payer_text = 'Cash customers',
        payee_text = null,
        paid_to_text = null,
        counterparty_text = 'Cash customers',
        related_cash_collection_id = p_cash_collection_id,
        linked_cash_collection_id = p_cash_collection_id,
        related_route_id = v_cash.route_id,
        related_machine_id = v_cash.machine_id,
        location = v_location,
        source_type = 'cash_collection',
        source_id = p_cash_collection_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

create or replace function public.snacky_purchase_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.ensure_purchase_finance_transaction(new.id);
  return new;
end;
$$;

create or replace function public.snacky_cash_collection_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.ensure_cash_collection_finance_transaction(new.id);
  return new;
end;
$$;

drop trigger if exists trg_snacky_purchase_finance_sync on public.purchase_orders;
create trigger trg_snacky_purchase_finance_sync
after insert or update of payment_status, status, manual_total_lyd, total_amount, calculated_total_lyd, order_date, supplier_id, payment_method, receipt_url, receipt_number, notes, payment_account_id
on public.purchase_orders
for each row
execute function public.snacky_purchase_finance_sync_trigger();

drop trigger if exists trg_snacky_cash_collection_finance_sync on public.cash_collections;
create trigger trg_snacky_cash_collection_finance_sync
after insert or update of actual_cash_collected, review_status, collected_at, counted_at, cash_bag_id, route_id, machine_id, operator_id
on public.cash_collections
for each row
execute function public.snacky_cash_collection_finance_sync_trigger();

drop function if exists public.backfill_missing_finance_transactions();

create or replace function public.backfill_missing_finance_transactions()
returns table (
  purchases_checked integer,
  purchase_transactions_created integer,
  purchase_transactions_skipped_existing integer,
  cash_collections_checked integer,
  cash_collection_transactions_created integer,
  cash_collection_transactions_skipped_existing integer,
  skipped_existing integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_cash record;
  v_before uuid;
  v_after uuid;
  v_purchases_checked integer := 0;
  v_purchase_created integer := 0;
  v_purchase_skipped integer := 0;
  v_cash_checked integer := 0;
  v_cash_created integer := 0;
  v_cash_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  for v_purchase in
    select po.id
    from public.purchase_orders po
    where po.payment_status = 'paid'
      and coalesce(po.status, '') not in ('cancelled', 'voided')
  loop
    v_purchases_checked := v_purchases_checked + 1;
    begin
      v_before := null;
      v_after := null;
      select ft.id into v_before
      from public.financial_transactions ft
      where ft.linked_purchase_id = v_purchase.id
         or ft.related_purchase_id = v_purchase.id
         or (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
      limit 1;

      v_after := public.ensure_purchase_finance_transaction(v_purchase.id);
      if v_after is null then
        v_purchase_skipped := v_purchase_skipped + 1;
      elsif v_before is null then
        v_purchase_created := v_purchase_created + 1;
      else
        v_purchase_skipped := v_purchase_skipped + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'purchase', 'source_id', v_purchase.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  for v_cash in
    select cc.id
    from public.cash_collections cc
    where cc.actual_cash_collected is not null
      and coalesce(cc.review_status, '') <> 'voided'
  loop
    v_cash_checked := v_cash_checked + 1;
    begin
      v_before := null;
      v_after := null;
      select ft.id into v_before
      from public.financial_transactions ft
      where ft.linked_cash_collection_id = v_cash.id
         or ft.related_cash_collection_id = v_cash.id
         or (ft.source_type = 'cash_collection' and ft.source_id = v_cash.id)
      limit 1;

      v_after := public.ensure_cash_collection_finance_transaction(v_cash.id);
      if v_after is null then
        v_cash_skipped := v_cash_skipped + 1;
      elsif v_before is null then
        v_cash_created := v_cash_created + 1;
      else
        v_cash_skipped := v_cash_skipped + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'cash_collection', 'source_id', v_cash.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  return query select
    v_purchases_checked,
    v_purchase_created,
    v_purchase_skipped,
    v_cash_checked,
    v_cash_created,
    v_cash_skipped,
    v_purchase_skipped + v_cash_skipped,
    v_errors;
end;
$$;

revoke all on function public.ensure_purchase_finance_transaction(uuid) from public;
grant execute on function public.ensure_purchase_finance_transaction(uuid) to authenticated;
revoke all on function public.ensure_cash_collection_finance_transaction(uuid) from public;
grant execute on function public.ensure_cash_collection_finance_transaction(uuid) to authenticated;
revoke all on function public.backfill_missing_finance_transactions() from public;
grant execute on function public.backfill_missing_finance_transactions() to authenticated;

-- Repair all historical rows immediately when this migration is applied.
select * from public.backfill_missing_finance_transactions();

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606080003_finance_health_and_ledger_contract.sql
-- ============================================================================

-- Restore the finance ledger read contract and expose an admin health report.
-- This does not add new finance features; it makes existing ledger pages resilient and auditable.

alter table public.financial_transactions
  add column if not exists transaction_datetime timestamptz,
  add column if not exists notes text,
  add column if not exists currency text default 'LYD',
  add column if not exists account_id text,
  add column if not exists account_key text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists import_status text,
  add column if not exists category text,
  add column if not exists payment_method text,
  add column if not exists transaction_status text default 'active',
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists related_location_id uuid,
  add column if not exists receipt_url text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists status_reason text;

update public.financial_transactions
set
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), nullif(trim(source_account_id), ''), 'snacky_lyd'),
  category = coalesce(nullif(trim(category), ''), nullif(trim(final_bucket), ''), nullif(trim(transaction_type), ''), nullif(trim(bucket), '')),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), case when coalesce(is_void, false) or voided_at is not null then 'voided' else 'active' end),
  import_status = coalesce(nullif(trim(import_status), ''), case when coalesce(needs_review, false) then 'needs_review' else 'imported' end),
  is_void = coalesce(is_void, false),
  notes = coalesce(notes, description),
  updated_at = now()
where transaction_datetime is null
   or currency is null
   or account_key is null
   or category is null
   or transaction_status is null
   or import_status is null
   or is_void is null
   or notes is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_purchase_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_cash_collection_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_cash_collection_id_fkey
      foreign key (linked_cash_collection_id) references public.cash_collections(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_related_route_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_related_route_id_fkey
      foreign key (related_route_id) references public.routes(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_related_machine_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_related_machine_id_fkey
      foreign key (related_machine_id) references public.machines(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_related_location_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_related_location_id_fkey
      foreign key (related_location_id) references public.locations(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_financial_transactions_status_date
  on public.financial_transactions(transaction_status, transaction_date desc);

create index if not exists idx_financial_transactions_source_type_source_id
  on public.financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;

create index if not exists idx_financial_transactions_linked_purchase_active
  on public.financial_transactions(linked_purchase_id)
  where linked_purchase_id is not null and coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false;

create index if not exists idx_financial_transactions_linked_cash_collection_active
  on public.financial_transactions(linked_cash_collection_id)
  where linked_cash_collection_id is not null and coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false;

drop function if exists public.finance_health_report();

create or replace function public.finance_health_report()
returns jsonb
language plpgsql
security definer
set search_path = public, information_schema, pg_catalog
as $$
declare
  v_expected text[] := array[
    'id', 'transaction_date', 'transaction_datetime', 'direction', 'transaction_kind', 'transaction_type',
    'location', 'description', 'notes', 'amount', 'signed_amount', 'currency', 'account_id', 'account_key',
    'transaction_effect', 'source_account_id', 'destination_account_id', 'import_status', 'category', 'bucket',
    'final_bucket', 'payment_method', 'transaction_status', 'review_status', 'needs_review', 'source_sheet',
    'source_row', 'related_purchase_id', 'linked_purchase_id', 'source_type', 'source_id',
    'related_cash_collection_id', 'linked_cash_collection_id', 'related_route_id', 'related_machine_id',
    'related_location_id', 'receipt_url', 'counterparty_text', 'payer_text', 'paid_to_text', 'is_void',
    'voided_at', 'void_reason', 'created_at', 'updated_at', 'created_by'
  ];
  v_missing text[];
  v_purchase_count integer;
  v_cash_count integer;
  v_transaction_count integer;
  v_linked_purchase_count integer;
  v_linked_cash_count integer;
  v_missing_purchase_count integer;
  v_missing_cash_count integer;
begin
  select coalesce(array_agg(expected_column order by expected_column), array[]::text[])
  into v_missing
  from unnest(v_expected) as expected_column
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'financial_transactions'
      and c.column_name = expected_column
  );

  select count(*)::integer into v_purchase_count from public.purchase_orders;
  select count(*)::integer into v_cash_count from public.cash_collections;
  select count(*)::integer into v_transaction_count from public.financial_transactions;

  select count(*)::integer
  into v_linked_purchase_count
  from public.purchase_orders po
  where exists (
    select 1
    from public.financial_transactions ft
    where ft.linked_purchase_id = po.id
       or ft.related_purchase_id = po.id
       or (ft.source_type = 'purchase' and ft.source_id = po.id)
  );

  select count(*)::integer
  into v_linked_cash_count
  from public.cash_collections cc
  where exists (
    select 1
    from public.financial_transactions ft
    where ft.linked_cash_collection_id = cc.id
       or ft.related_cash_collection_id = cc.id
       or (ft.source_type = 'cash_collection' and ft.source_id = cc.id)
  );

  v_missing_purchase_count := greatest(v_purchase_count - v_linked_purchase_count, 0);
  v_missing_cash_count := greatest(v_cash_count - v_linked_cash_count, 0);

  return jsonb_build_object(
    'schema_status', case when cardinality(v_missing) = 0 then 'ok' else 'missing_columns' end,
    'missing_columns', to_jsonb(v_missing),
    'transactions_count', v_transaction_count,
    'purchases_count', v_purchase_count,
    'cash_collections_count', v_cash_count,
    'purchases_with_linked_finance_transaction', v_linked_purchase_count,
    'cash_collections_with_linked_finance_transaction', v_linked_cash_count,
    'purchases_missing_finance_transaction', v_missing_purchase_count,
    'cash_collections_missing_finance_transaction', v_missing_cash_count,
    'failed_sync_count', v_missing_purchase_count + v_missing_cash_count,
    'schema_columns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'column_name', c.column_name,
        'data_type', c.data_type,
        'is_nullable', c.is_nullable,
        'column_default', c.column_default,
        'ordinal_position', c.ordinal_position
      ) order by c.ordinal_position), '[]'::jsonb)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'financial_transactions'
    ),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'constraint_name', tc.constraint_name,
        'constraint_type', tc.constraint_type,
        'definition', coalesce(cc.check_clause, '')
      ) order by tc.constraint_name), '[]'::jsonb)
      from information_schema.table_constraints tc
      left join information_schema.check_constraints cc on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
      where tc.table_schema = 'public' and tc.table_name = 'financial_transactions'
    ),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'indexname', i.indexname,
        'indexdef', i.indexdef
      ) order by i.indexname), '[]'::jsonb)
      from pg_indexes i
      where i.schemaname = 'public' and i.tablename = 'financial_transactions'
    )
  );
end;
$$;


-- ============================================================================
-- Source migration: supabase/migrations/202606080004_finance_sync_pipeline_hardening.sql
-- ============================================================================

-- Harden the live finance sync pipeline for new purchases and cash collections.
-- Backfills repair old data; these RPCs/triggers protect every new save.

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists source_sheet text,
  add column if not exists source_row integer,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_purchase_id uuid,
  add column if not exists related_cash_collection_id uuid,
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists category text,
  add column if not exists direction text,
  add column if not exists location text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists payment_method text,
  add column if not exists receipt_url text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists currency text default 'LYD',
  add column if not exists notes text,
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists status_reason text,
  add column if not exists transaction_status text default 'active';

create or replace function public.snacky_finance_account_currency(p_account_key text)
returns text
language sql
immutable
as $$
  select case when lower(coalesce(p_account_key, '')) like '%usd%' then 'USD' else 'LYD' end
$$;

create or replace function public.ensure_purchase_finance_transaction(p_purchase_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_supplier_name text;
  v_description text;
  v_transaction_id uuid;
begin
  select po.*, s.name as supplier_name
    into v_purchase
  from public.purchase_orders po
  left join public.suppliers s on s.id = po.supplier_id
  where po.id = p_purchase_id;

  if not found then
    raise exception 'Purchase % not found', p_purchase_id using errcode = 'P0002';
  end if;

  if coalesce(v_purchase.status, '') in ('cancelled', 'voided') then
    return null;
  end if;

  v_amount := abs(coalesce(v_purchase.manual_total_lyd, v_purchase.total_amount, v_purchase.calculated_total_lyd, 0));
  if v_amount <= 0 then
    return null;
  end if;

  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := public.snacky_finance_account_currency(v_account_key);
  v_supplier_name := nullif(trim(coalesce(v_purchase.supplier_name, '')), '');
  v_description := concat_ws(
    ' - ',
    'Purchase from ' || coalesce(v_supplier_name, 'supplier'),
    case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || v_purchase.receipt_number end,
    case when nullif(trim(coalesce(v_purchase.payment_status, '')), '') is not null then 'Payment ' || v_purchase.payment_status end,
    nullif(trim(coalesce(v_purchase.notes, '')), '')
  );

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or ft.related_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review,
      transaction_status, is_void, voided_at, void_reason, payment_method, receipt_url, payer_text,
      paid_to_text, payee_text, counterparty_text, linked_purchase_id, related_purchase_id, source_type,
      source_id, created_by, updated_at
    ) values (
      coalesce(v_purchase.order_date, now()::date), coalesce(v_purchase.order_date, now()::date)::timestamptz,
      'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', v_description,
      coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      'confirmed', false, 'active', false, null, null, v_purchase.payment_method, v_purchase.receipt_url,
      null, v_supplier_name, v_supplier_name, v_supplier_name, p_purchase_id, p_purchase_id, 'purchase',
      p_purchase_id, v_purchase.created_by, now()
    )
    returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = coalesce(v_purchase.order_date, now()::date),
        transaction_datetime = coalesce(v_purchase.order_date, now()::date)::timestamptz,
        direction = 'money_out',
        transaction_kind = 'product_purchase',
        transaction_type = 'Products Restocking',
        category = 'Products Restocking',
        description = v_description,
        notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
        amount = v_amount,
        signed_amount = -abs(v_amount),
        currency = v_currency,
        account_id = v_account_key,
        account_key = v_account_key,
        transaction_effect = 'expense',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Inventory',
        final_bucket = 'Products Restocking',
        review_status = 'confirmed',
        needs_review = false,
        transaction_status = 'active',
        is_void = false,
        voided_at = null,
        void_reason = null,
        payment_method = v_purchase.payment_method,
        receipt_url = v_purchase.receipt_url,
        payer_text = null,
        paid_to_text = v_supplier_name,
        payee_text = v_supplier_name,
        counterparty_text = v_supplier_name,
        linked_purchase_id = p_purchase_id,
        related_purchase_id = p_purchase_id,
        source_type = 'purchase',
        source_id = p_purchase_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

create or replace function public.ensure_cash_collection_finance_transaction(p_cash_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_cash record;
  v_amount numeric;
  v_datetime timestamptz;
  v_description text;
  v_location text;
  v_transaction_id uuid;
begin
  select cc.*, m.name as machine_name, m.machine_code, l.name as location_name
    into v_cash
  from public.cash_collections cc
  left join public.machines m on m.id = cc.machine_id
  left join public.locations l on l.id = m.location_id
  where cc.id = p_cash_collection_id;

  if not found then
    raise exception 'Cash collection % not found', p_cash_collection_id using errcode = 'P0002';
  end if;

  if v_cash.actual_cash_collected is null or coalesce(v_cash.review_status, '') = 'voided' then
    return null;
  end if;

  v_amount := abs(coalesce(v_cash.actual_cash_collected, 0));
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''));
  v_description := 'Cash collection from ' || coalesce(nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''), nullif(trim(v_cash.location_name), ''), p_cash_collection_id::text);
  if nullif(trim(coalesce(v_cash.cash_bag_id, '')), '') is not null then
    v_description := v_description || ' - Bag ' || v_cash.cash_bag_id;
  end if;

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or ft.related_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review,
      transaction_status, is_void, voided_at, void_reason, payment_method, payer_text, payee_text,
      paid_to_text, counterparty_text, related_cash_collection_id, linked_cash_collection_id,
      related_route_id, related_machine_id, location, source_type, source_id, created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_description, v_description, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'confirmed', false, 'active', false, null, null,
      'cash', 'Cash customers', null, null, 'Cash customers', p_cash_collection_id, p_cash_collection_id,
      v_cash.route_id, v_cash.machine_id, v_location, 'cash_collection', p_cash_collection_id,
      v_cash.operator_id, now()
    )
    returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = v_datetime::date,
        transaction_datetime = v_datetime,
        direction = 'money_in',
        transaction_kind = 'cash_collection',
        transaction_type = 'Revenue',
        category = 'Revenue',
        description = v_description,
        notes = v_description,
        amount = v_amount,
        signed_amount = abs(v_amount),
        currency = 'LYD',
        account_id = 'snacky_lyd',
        account_key = 'snacky_lyd',
        transaction_effect = 'income',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Revenue',
        final_bucket = 'Revenue',
        review_status = 'confirmed',
        needs_review = false,
        transaction_status = 'active',
        is_void = false,
        voided_at = null,
        void_reason = null,
        payment_method = 'cash',
        payer_text = 'Cash customers',
        payee_text = null,
        paid_to_text = null,
        counterparty_text = 'Cash customers',
        related_cash_collection_id = p_cash_collection_id,
        linked_cash_collection_id = p_cash_collection_id,
        related_route_id = v_cash.route_id,
        related_machine_id = v_cash.machine_id,
        location = v_location,
        source_type = 'cash_collection',
        source_id = p_cash_collection_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

create or replace function public.snacky_purchase_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.ensure_purchase_finance_transaction(new.id);
  return new;
end;
$$;

create or replace function public.snacky_cash_collection_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.ensure_cash_collection_finance_transaction(new.id);
  return new;
end;
$$;

drop trigger if exists trg_snacky_purchase_finance_sync on public.purchase_orders;
create trigger trg_snacky_purchase_finance_sync
after insert or update on public.purchase_orders
for each row
execute function public.snacky_purchase_finance_sync_trigger();

drop trigger if exists trg_snacky_cash_collection_finance_sync on public.cash_collections;
create trigger trg_snacky_cash_collection_finance_sync
after insert or update on public.cash_collections
for each row
execute function public.snacky_cash_collection_finance_sync_trigger();

update public.financial_transactions
set source_type = 'manual', updated_at = now()
where source_type is null
  and source_sheet is null
  and linked_purchase_id is null
  and linked_cash_collection_id is null
  and related_purchase_id is null
  and related_cash_collection_id is null;

update public.financial_transactions
set source_type = 'import', updated_at = now()
where source_type is null
  and source_sheet is not null;

create or replace function public.finance_health_report()
returns jsonb
language plpgsql
security definer
set search_path = public, information_schema, pg_catalog
as $$
declare
  v_expected text[] := array[
    'id', 'transaction_date', 'transaction_datetime', 'direction', 'transaction_kind', 'transaction_type',
    'location', 'description', 'notes', 'amount', 'signed_amount', 'currency', 'account_id', 'account_key',
    'transaction_effect', 'source_account_id', 'destination_account_id', 'import_status', 'category', 'bucket',
    'final_bucket', 'payment_method', 'transaction_status', 'review_status', 'needs_review', 'source_sheet',
    'source_row', 'related_purchase_id', 'linked_purchase_id', 'source_type', 'source_id',
    'related_cash_collection_id', 'linked_cash_collection_id', 'related_route_id', 'related_machine_id',
    'related_location_id', 'receipt_url', 'counterparty_text', 'payer_text', 'paid_to_text', 'is_void',
    'voided_at', 'void_reason', 'created_at', 'updated_at', 'created_by'
  ];
  v_missing text[];
  v_purchase_count integer;
  v_cash_count integer;
  v_transaction_count integer;
  v_linked_purchase_count integer;
  v_linked_cash_count integer;
  v_missing_purchase_count integer;
  v_missing_cash_count integer;
begin
  select coalesce(array_agg(expected_column order by expected_column), array[]::text[])
  into v_missing
  from unnest(v_expected) as expected_column
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'financial_transactions'
      and c.column_name = expected_column
  );

  select count(*)::integer into v_purchase_count
  from public.purchase_orders po
  where coalesce(po.status, '') not in ('cancelled', 'voided')
    and abs(coalesce(po.manual_total_lyd, po.total_amount, po.calculated_total_lyd, 0)) > 0;

  select count(*)::integer into v_cash_count
  from public.cash_collections cc
  where cc.actual_cash_collected is not null
    and coalesce(cc.review_status, '') <> 'voided';

  select count(*)::integer into v_transaction_count from public.financial_transactions;

  select count(*)::integer into v_linked_purchase_count
  from public.purchase_orders po
  where coalesce(po.status, '') not in ('cancelled', 'voided')
    and abs(coalesce(po.manual_total_lyd, po.total_amount, po.calculated_total_lyd, 0)) > 0
    and exists (
      select 1 from public.financial_transactions ft
      where (ft.linked_purchase_id = po.id or ft.related_purchase_id = po.id or (ft.source_type = 'purchase' and ft.source_id = po.id))
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  select count(*)::integer into v_linked_cash_count
  from public.cash_collections cc
  where cc.actual_cash_collected is not null
    and coalesce(cc.review_status, '') <> 'voided'
    and exists (
      select 1 from public.financial_transactions ft
      where (ft.linked_cash_collection_id = cc.id or ft.related_cash_collection_id = cc.id or (ft.source_type = 'cash_collection' and ft.source_id = cc.id))
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  v_missing_purchase_count := greatest(v_purchase_count - v_linked_purchase_count, 0);
  v_missing_cash_count := greatest(v_cash_count - v_linked_cash_count, 0);

  return jsonb_build_object(
    'schema_status', case when cardinality(v_missing) = 0 then 'ok' else 'missing_columns' end,
    'missing_columns', to_jsonb(v_missing),
    'transactions_count', v_transaction_count,
    'purchases_count', v_purchase_count,
    'cash_collections_count', v_cash_count,
    'purchases_with_linked_finance_transaction', v_linked_purchase_count,
    'cash_collections_with_linked_finance_transaction', v_linked_cash_count,
    'purchases_missing_finance_transaction', v_missing_purchase_count,
    'cash_collections_missing_finance_transaction', v_missing_cash_count,
    'failed_sync_count', v_missing_purchase_count + v_missing_cash_count,
    'source_types_in_overview', to_jsonb(array['purchase', 'cash_collection', 'manual', 'import']),
    'schema_columns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'column_name', c.column_name,
        'data_type', c.data_type,
        'is_nullable', c.is_nullable,
        'column_default', c.column_default,
        'ordinal_position', c.ordinal_position
      ) order by c.ordinal_position), '[]'::jsonb)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'financial_transactions'
    ),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'constraint_name', tc.constraint_name,
        'constraint_type', tc.constraint_type,
        'definition', coalesce(cc.check_clause, '')
      ) order by tc.constraint_name), '[]'::jsonb)
      from information_schema.table_constraints tc
      left join information_schema.check_constraints cc on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
      where tc.table_schema = 'public' and tc.table_name = 'financial_transactions'
    ),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'indexname', i.indexname,
        'indexdef', i.indexdef
      ) order by i.indexname), '[]'::jsonb)
      from pg_indexes i
      where i.schemaname = 'public' and i.tablename = 'financial_transactions'
    )
  );
end;
$$;

revoke all on function public.ensure_purchase_finance_transaction(uuid) from public;
grant execute on function public.ensure_purchase_finance_transaction(uuid) to authenticated;
revoke all on function public.ensure_cash_collection_finance_transaction(uuid) from public;
grant execute on function public.ensure_cash_collection_finance_transaction(uuid) to authenticated;
revoke all on function public.finance_health_report() from public;
grant execute on function public.finance_health_report() to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Source migration: supabase/migrations/202606080005_db_level_finance_source_sync.sql
-- ============================================================================

-- Database-source finance synchronization for purchases and cash collections.
-- Finance Transactions is the money source of truth: every money-moving source row owns exactly one ledger row.

alter table public.purchase_orders
  add column if not exists currency text default 'LYD';

update public.purchase_orders
set currency = coalesce(nullif(trim(currency), ''), 'LYD')
where currency is null or trim(currency) = '';

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_purchase_id uuid,
  add column if not exists related_cash_collection_id uuid,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists currency text default 'LYD',
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists category text,
  add column if not exists location text,
  add column if not exists notes text,
  add column if not exists payment_method text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists related_location_id uuid,
  add column if not exists receipt_url text,
  add column if not exists transaction_status text default 'active',
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;

create or replace function public.finance_purchase_should_sync(p_purchase public.purchase_orders)
returns boolean
language sql
stable
as $$
  select coalesce(p_purchase.status, '') not in ('cancelled', 'voided')
     and coalesce(p_purchase.payment_status, 'paid') in ('paid', 'confirmed', 'saved')
$$;

create or replace function public.finance_cash_collection_should_sync(p_cash public.cash_collections)
returns boolean
language sql
stable
as $$
  select coalesce(p_cash.review_status, '') <> 'voided'
     and p_cash.actual_cash_collected is not null
$$;

create or replace function public.sync_purchase_to_financial_transaction(p_purchase_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase public.purchase_orders%rowtype;
  v_supplier_name text;
  v_lines_total numeric(12,2);
  v_amount numeric(12,2);
  v_account_key text;
  v_currency text;
  v_notes text;
  v_description text;
  v_transaction_id uuid;
begin
  select * into v_purchase
  from public.purchase_orders
  where id = p_purchase_id;

  if not found then
    raise exception 'Purchase % not found', p_purchase_id using errcode = 'P0002';
  end if;

  select nullif(trim(s.name), '') into v_supplier_name
  from public.suppliers s
  where s.id = v_purchase.supplier_id;

  select coalesce(sum(coalesce(pol.line_total_lyd, pol.line_total, pol.total_units * pol.unit_cost, pol.received_qty * pol.unit_cost, pol.ordered_qty * pol.unit_cost, 0)), 0)::numeric(12,2)
    into v_lines_total
  from public.purchase_order_lines pol
  where pol.purchase_order_id = p_purchase_id;

  v_amount := abs(coalesce(v_purchase.manual_total_lyd, nullif(v_purchase.total_amount, 0), nullif(v_purchase.calculated_total_lyd, 0), v_lines_total, 0))::numeric(12,2);
  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := coalesce(nullif(trim(v_purchase.currency), ''), case when lower(v_account_key) like '%usd%' then 'USD' else 'LYD' end, 'LYD');
  v_notes := concat_ws(' / ', nullif(trim(v_purchase.notes), ''), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);
  v_description := concat_ws(' - ', 'Purchase from ' || coalesce(v_supplier_name, 'supplier'), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or ft.related_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_purchase_should_sync(v_purchase) then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source purchase no longer qualifies for finance sync'),
          source_type = 'purchase',
          source_id = p_purchase_id,
          linked_purchase_id = p_purchase_id,
          related_purchase_id = p_purchase_id,
          updated_at = now()
      where id = v_transaction_id;
    end if;
    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      location, description, notes, amount, signed_amount, currency, account_id, account_key,
      transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
      payment_method, receipt_url, transaction_status, review_status, needs_review, is_void,
      counterparty_text, paid_to_text, payee_text, payer_text, linked_purchase_id, related_purchase_id,
      source_type, source_id, created_by, updated_at
    ) values (
      coalesce(v_purchase.order_date, current_date), coalesce(v_purchase.order_date, current_date)::timestamptz,
      'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', null,
      coalesce(nullif(v_description, ''), 'Purchase'), nullif(v_notes, ''), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      v_purchase.payment_method, v_purchase.receipt_url, 'active', 'confirmed', false, false,
      v_supplier_name, v_supplier_name, v_supplier_name, null, p_purchase_id, p_purchase_id,
      'purchase', p_purchase_id, v_purchase.created_by, now()
    ) returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = coalesce(v_purchase.order_date, current_date),
        transaction_datetime = coalesce(v_purchase.order_date, current_date)::timestamptz,
        direction = 'money_out',
        transaction_kind = 'product_purchase',
        transaction_type = 'Products Restocking',
        category = 'Products Restocking',
        location = null,
        description = coalesce(nullif(v_description, ''), 'Purchase'),
        notes = nullif(v_notes, ''),
        amount = v_amount,
        signed_amount = -abs(v_amount),
        currency = v_currency,
        account_id = v_account_key,
        account_key = v_account_key,
        transaction_effect = 'expense',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Inventory',
        final_bucket = 'Products Restocking',
        payment_method = v_purchase.payment_method,
        receipt_url = v_purchase.receipt_url,
        transaction_status = 'active',
        review_status = 'confirmed',
        needs_review = false,
        is_void = false,
        voided_at = null,
        void_reason = null,
        counterparty_text = v_supplier_name,
        paid_to_text = v_supplier_name,
        payee_text = v_supplier_name,
        payer_text = null,
        linked_purchase_id = p_purchase_id,
        related_purchase_id = p_purchase_id,
        source_type = 'purchase',
        source_id = p_purchase_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by ' || v_transaction_id::text),
      linked_purchase_id = null,
      related_purchase_id = null,
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_purchase_id = p_purchase_id
      or ft.related_purchase_id = p_purchase_id
      or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id));

  return v_transaction_id;
end;
$$;

create or replace function public.sync_cash_collection_to_financial_transaction(p_cash_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_machine_name text;
  v_machine_code text;
  v_location_name text;
  v_amount numeric(12,2);
  v_datetime timestamptz;
  v_location text;
  v_notes text;
  v_transaction_id uuid;
begin
  select * into v_cash
  from public.cash_collections
  where id = p_cash_collection_id;

  if not found then
    raise exception 'Cash collection % not found', p_cash_collection_id using errcode = 'P0002';
  end if;

  select nullif(trim(m.name), ''), nullif(trim(m.machine_code), ''), nullif(trim(l.name), '')
    into v_machine_name, v_machine_code, v_location_name
  from public.machines m
  left join public.locations l on l.id = m.location_id
  where m.id = v_cash.machine_id;

  v_amount := abs(coalesce(v_cash.actual_cash_collected, 0))::numeric(12,2);
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(v_location_name, v_machine_name, v_machine_code);
  v_notes := concat_ws(' - ', 'Cash collection', coalesce(v_machine_name, v_machine_code, p_cash_collection_id::text), v_location_name, case when nullif(trim(v_cash.cash_bag_id), '') is not null then 'Bag ' || v_cash.cash_bag_id end);

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or ft.related_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_cash_collection_should_sync(v_cash) then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source cash collection no longer qualifies for finance sync'),
          source_type = 'cash_collection',
          source_id = p_cash_collection_id,
          linked_cash_collection_id = p_cash_collection_id,
          related_cash_collection_id = p_cash_collection_id,
          updated_at = now()
      where id = v_transaction_id;
    end if;
    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      location, description, notes, amount, signed_amount, currency, account_id, account_key,
      transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
      payment_method, transaction_status, review_status, needs_review, is_void,
      counterparty_text, payer_text, paid_to_text, payee_text, related_cash_collection_id,
      linked_cash_collection_id, related_route_id, related_machine_id, source_type, source_id,
      created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_location, v_notes, v_notes, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'cash', 'active', 'confirmed', false, false,
      'Cash customers', 'Cash customers', null, null, p_cash_collection_id, p_cash_collection_id,
      v_cash.route_id, v_cash.machine_id, 'cash_collection', p_cash_collection_id, v_cash.operator_id, now()
    ) returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = v_datetime::date,
        transaction_datetime = v_datetime,
        direction = 'money_in',
        transaction_kind = 'cash_collection',
        transaction_type = 'Revenue',
        category = 'Revenue',
        location = v_location,
        description = v_notes,
        notes = v_notes,
        amount = v_amount,
        signed_amount = abs(v_amount),
        currency = 'LYD',
        account_id = 'snacky_lyd',
        account_key = 'snacky_lyd',
        transaction_effect = 'income',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Revenue',
        final_bucket = 'Revenue',
        payment_method = 'cash',
        transaction_status = 'active',
        review_status = 'confirmed',
        needs_review = false,
        is_void = false,
        voided_at = null,
        void_reason = null,
        counterparty_text = 'Cash customers',
        payer_text = 'Cash customers',
        paid_to_text = null,
        payee_text = null,
        related_cash_collection_id = p_cash_collection_id,
        linked_cash_collection_id = p_cash_collection_id,
        related_route_id = v_cash.route_id,
        related_machine_id = v_cash.machine_id,
        source_type = 'cash_collection',
        source_id = p_cash_collection_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance transaction superseded by ' || v_transaction_id::text),
      linked_cash_collection_id = null,
      related_cash_collection_id = null,
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_cash_collection_id = p_cash_collection_id
      or ft.related_cash_collection_id = p_cash_collection_id
      or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id));

  return v_transaction_id;
end;
$$;

create or replace function public.ensure_purchase_finance_transaction(p_purchase_id uuid)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select public.sync_purchase_to_financial_transaction(p_purchase_id)
$$;

create or replace function public.ensure_cash_collection_finance_transaction(p_cash_collection_id uuid)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select public.sync_cash_collection_to_financial_transaction(p_cash_collection_id)
$$;

create or replace function public.snacky_purchase_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.sync_purchase_to_financial_transaction(new.id);
  return new;
end;
$$;

create or replace function public.snacky_cash_collection_finance_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.sync_cash_collection_to_financial_transaction(new.id);
  return new;
end;
$$;

drop trigger if exists trg_snacky_purchase_finance_sync on public.purchase_orders;
create trigger trg_snacky_purchase_finance_sync
after insert or update on public.purchase_orders
for each row
execute function public.snacky_purchase_finance_sync_trigger();

drop trigger if exists trg_snacky_cash_collection_finance_sync on public.cash_collections;
create trigger trg_snacky_cash_collection_finance_sync
after insert or update on public.cash_collections
for each row
execute function public.snacky_cash_collection_finance_sync_trigger();

create or replace function public.backfill_missing_finance_transactions()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_cash record;
  v_purchase_checked integer := 0;
  v_purchase_synced integer := 0;
  v_cash_checked integer := 0;
  v_cash_synced integer := 0;
  v_transaction_id uuid;
begin
  for v_purchase in
    select po.*
    from public.purchase_orders po
    where public.finance_purchase_should_sync(po)
  loop
    v_purchase_checked := v_purchase_checked + 1;
    v_transaction_id := public.sync_purchase_to_financial_transaction(v_purchase.id);
    if v_transaction_id is not null then
      v_purchase_synced := v_purchase_synced + 1;
    end if;
  end loop;

  for v_cash in
    select cc.*
    from public.cash_collections cc
    where public.finance_cash_collection_should_sync(cc)
  loop
    v_cash_checked := v_cash_checked + 1;
    v_transaction_id := public.sync_cash_collection_to_financial_transaction(v_cash.id);
    if v_transaction_id is not null then
      v_cash_synced := v_cash_synced + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'purchase_records_checked', v_purchase_checked,
    'purchase_finance_transactions_synced', v_purchase_synced,
    'cash_collections_checked', v_cash_checked,
    'cash_collection_finance_transactions_synced', v_cash_synced
  );
end;
$$;

-- Backfill all existing qualifying records; no recency window.
select public.backfill_missing_finance_transactions();

-- Collapse duplicate source links before adding hard uniqueness guarantees.
with duplicate_source_rows as (
  select id,
         row_number() over (partition by source_type, source_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where source_type is not null
    and source_id is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate finance source link removed by finance sync hardening'),
    source_type = 'manual',
    source_id = null,
    linked_purchase_id = null,
    related_purchase_id = null,
    linked_cash_collection_id = null,
    related_cash_collection_id = null,
    updated_at = now()
from duplicate_source_rows d
where ft.id = d.id
  and d.rn > 1;

with duplicate_purchase_rows as (
  select id,
         row_number() over (partition by linked_purchase_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_purchase_id is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance link removed by finance sync hardening'),
    source_type = 'manual',
    source_id = null,
    linked_purchase_id = null,
    related_purchase_id = null,
    updated_at = now()
from duplicate_purchase_rows d
where ft.id = d.id
  and d.rn > 1;

with duplicate_cash_rows as (
  select id,
         row_number() over (partition by linked_cash_collection_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_cash_collection_id is not null
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance link removed by finance sync hardening'),
    source_type = 'manual',
    source_id = null,
    linked_cash_collection_id = null,
    related_cash_collection_id = null,
    updated_at = now()
from duplicate_cash_rows d
where ft.id = d.id
  and d.rn > 1;

create unique index if not exists financial_transactions_source_type_source_id_uidx
  on public.financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;

create unique index if not exists financial_transactions_linked_purchase_id_uidx
  on public.financial_transactions(linked_purchase_id)
  where linked_purchase_id is not null;

create unique index if not exists financial_transactions_linked_cash_collection_id_uidx
  on public.financial_transactions(linked_cash_collection_id)
  where linked_cash_collection_id is not null;

revoke all on function public.sync_purchase_to_financial_transaction(uuid) from public;
grant execute on function public.sync_purchase_to_financial_transaction(uuid) to authenticated;
revoke all on function public.sync_cash_collection_to_financial_transaction(uuid) from public;
grant execute on function public.sync_cash_collection_to_financial_transaction(uuid) to authenticated;
revoke all on function public.backfill_missing_finance_transactions() from public;
grant execute on function public.backfill_missing_finance_transactions() to authenticated;

select pg_notify('pgrst', 'reload schema');


-- ============================================================================
-- Verification queries (run after the repair script commits)
-- ============================================================================
-- 1) Core table existence
-- select table_name
-- from information_schema.tables
-- where table_schema = 'public'
--   and table_name in (
--     'profiles','locations','machines','suppliers','products','team_members','storage_locations',
--     'machine_slots','vms_product_mappings','vms_import_batches','vms_stock_snapshots',
--     'vms_machine_stock_snapshots','vms_sales_snapshots','vms_transactions_raw','inventory_movements',
--     'routes','route_stops','route_stop_items','route_pick_list_items','route_stock_lines',
--     'route_pickup_batches','route_pickup_batch_stops','refill_orders','refill_order_lines',
--     'cash_collections','issues','purchase_orders','purchase_order_lines','financial_transactions',
--     'finance_categories','finance_settings','finance_accounts','finance_import_rows',
--     'system_activity_logs','machine_refill_history'
--   )
-- order by table_name;
--
-- 2) Required views
-- select table_name
-- from information_schema.views
-- where table_schema = 'public'
--   and table_name in (
--     'current_inventory_by_location','latest_vms_stock_by_slot','refill_recommendations',
--     'machine_refill_history_metrics','machine_refill_history_monthly','vms_sales_clean',
--     'kpi_machine_daily','kpi_machine_monthly','kpi_product_daily','kpi_product_monthly',
--     'kpi_location_monthly','vms_transaction_status_daily','vms_transaction_status_monthly'
--   )
-- order by table_name;
--
-- 3) Required RPC/function contract
-- select proname, pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and proname in (
--     'snacky_current_profile_has_any_role','snacky_current_profile_can_add_products',
--     'snacky_operator_can_access_route','snacky_operator_can_read_product',
--     'snacky_create_purchase_with_lines','confirm_route_pickup_batch',
--     'save_route_pickup_checklist_item','validate_route_workflow_schema',
--     'apply_historical_route_deduction_batch','apply_vms_sales_snapshot_import',
--     'snacky_sync_vms_product_mapping_aliases','backfill_missing_finance_transactions',
--     'backfill_purchase_financial_transactions','finance_health_report'
--   )
-- order by proname, args;
--
-- 4) Required route workflow enum values
-- select 'route_status' as enum_name, enumlabel
-- from pg_enum
-- where enumtypid = 'route_status'::regtype
-- union all
-- select 'route_stop_status' as enum_name, enumlabel
-- from pg_enum
-- where enumtypid = 'route_stop_status'::regtype
-- order by enum_name, enumlabel;
--
-- 5) RLS enabled on core workflow tables
-- select c.relname as table_name, c.relrowsecurity as rls_enabled, count(p.polname) as policy_count
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- left join pg_policy p on p.polrelid = c.oid
-- where n.nspname = 'public'
--   and c.relname in (
--     'profiles','team_members','products','storage_locations','inventory_movements',
--     'purchase_orders','purchase_order_lines','routes','route_stops','route_stop_items',
--     'route_pick_list_items','route_stock_lines','cash_collections','issues','financial_transactions',
--     'vms_import_batches','vms_import_previews','vms_import_preview_rows','vms_product_mappings',
--     'vms_machine_mappings','vms_header_mappings','vms_sales_raw','vms_transactions_raw',
--     'vms_machine_stock_snapshots'
--   )
-- group by c.relname, c.relrowsecurity
-- order by c.relname;
--
-- 6) Finance sync health
-- select * from public.finance_health_report();

