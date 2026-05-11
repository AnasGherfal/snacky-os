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
  create type inventory_entity_type as enum ('supplier', '', 'operator_bag', 'machine', 'waste', 'adjustment');
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
