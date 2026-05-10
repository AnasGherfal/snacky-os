# Snacky OS — Complete Codex Build Structure

## Purpose

Build **Snacky OS**, a custom internal operating system for Snacky vending operations. The goal is to make Snacky scalable from the current small fleet to 100+ machines by replacing manual decisions with structured workflows, automated refill recommendations, inventory control, cash reconciliation, issue tracking, and KPI dashboards.

Snacky OS should not be a pretty dashboard only. It must be an operations system.

The first priority is:

> The system automatically tells the operator what to take from storage, which machines to visit, what to refill, how much cash to collect, and what issues to report.

---

## 1. Product Vision

Snacky wants to become the first and biggest vending machine network in Libya, operating across schools, hospitals, universities, offices, selected malls, and other high-traffic locations.

Snacky OS must support:

- 8 machines now
- 12 machines within the near-term plan
- 30+ machines during expansion
- 100+ machines long term

Core business targets:

- Net Sales per Month per machine target: 2,800+ LYD
- Machine uptime target: 98%+
- Cash variance control
- Refill automation
- Operator accountability
- Inventory traceability
- Location performance tracking

---

## 2. Recommended Tech Stack

Use this stack:

```txt
Frontend: Next.js App Router + TypeScript
Styling: Tailwind CSS
Backend: Next.js Server Actions / Route Handlers
Database: Supabase PostgreSQL
Auth: Supabase Auth
Permissions: Supabase Row Level Security
Storage: Supabase Storage
Hosting: Vercel
Local Development: Supabase CLI + Docker
Future Mobile App: Expo, only if PWA becomes limiting
```

Do not use Google Sheets as the main system. Google Sheets can be used temporarily for exports, but the core operating system should be a relational database.

Do not start with native mobile app. Build a mobile-friendly PWA first.

---

## 3. System Architecture

```txt
                           ┌─────────────────┐
                           │       VMS       │
                           │ sales/stock/cash│
                           └────────┬────────┘
                                    │
                      API / CSV / scheduled report import
                                    │
                                    ▼
                         ┌────────────────────┐
                         │     Snacky OS      │
                         │ Next.js + Supabase │
                         └─────────┬──────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       │                           │                           │
       ▼                           ▼                           ▼
Owner/Admin Dashboard        Operator PWA              Automation Engine
KPIs, finance, routes        Routes, refills, cash     Refill suggestions,
machines, inventory          photos, issues            stock alerts, KPIs
       │                           │                           │
       ▼                           ▼                           ▼
Decision System              Execution System           Control System
```

The VMS remains the source for machine stock/sales/cash. Snacky OS becomes the source for operations, inventory, routes, cash reconciliation, team workflow, and business decisions.

---

## 4. Main Modules

Snacky OS must have these modules:

1. Authentication and Roles
2. Master Data
3. VMS Import and Mapping
4. Machine Planogram / Slots
5. Inventory Ledger
6. Refill Recommendation Engine
7. Route Management
8. Operator Workflow
9. Cash Collection and Reconciliation
10. Maintenance / Issues
11. Purchasing / Procurement
12. KPI Dashboard
13. Location Growth Pipeline
14. Audit Logs
15. Settings

Each module should be connected through one database.

---

## 5. User Roles

Create these roles:

```txt
owner
admin
supervisor
operator
warehouse
procurement
finance
viewer
```

### owner
Can access everything.

### admin
Can manage operations, routes, machines, products, inventory, reports, and users. Cannot delete critical financial records unless explicitly allowed.

### supervisor
Can manage routes, operators, refill execution, issues, stock checks, and cash variance reviews.

### operator
Can only see assigned routes and tasks. Can submit refill quantities, cash collection, photos, and issues.

### warehouse
Can manage storage stock, receive purchases, issue stock to operators, and accept returned stock.

### procurement
Can manage suppliers, purchase orders, supplier prices, and purchase suggestions.

### finance
Can view sales, cash, rent, costs, profit, variance, and reports.

### viewer
Read-only dashboards.

---

## 6. Core Database Principles

Use PostgreSQL. Do not store important operations only in app state.

Important principles:

1. Every machine has a unique Snacky machine code.
2. Every VMS machine must be mapped to a Snacky machine.
3. Every VMS product must be mapped to a Snacky product.
4. Inventory is tracked through movements, not manual quantity edits.
5. A refill creates inventory movements.
6. Cash collection always belongs to a route stop and machine.
7. Every issue belongs to a machine, location, or route stop.
8. Every major action should have `created_by`, `created_at`, and ideally audit history.
9. Never allow negative inventory unless an admin override is used.
10. Operator screens should be simple and permission-restricted.

---

## 7. Database Schema

Use Supabase migrations. Create the schema in SQL.

### 7.1 Enums

```sql
create type user_role as enum (
  'owner', 'admin', 'supervisor', 'operator', 'warehouse', 'procurement', 'finance', 'viewer'
);

create type machine_status as enum (
  'active', 'inactive', 'maintenance', 'relocation_pending', 'removed'
);

create type machine_type as enum (
  'lift', 'non_lift', 'combo', 'other'
);

create type location_type as enum (
  'school', 'hospital', 'mall', 'university', 'office', 'gym', 'other'
);

create type route_status as enum (
  'draft', 'assigned', 'in_progress', 'completed', 'reviewed', 'cancelled'
);

create type route_stop_status as enum (
  'pending', 'arrived', 'refilling', 'cash_collected', 'completed', 'skipped', 'issue_reported'
);

create type refill_order_status as enum (
  'draft', 'generated', 'picked', 'in_progress', 'completed', 'reviewed', 'cancelled'
);

create type inventory_location_type as enum (
  'storage', 'operator_bag', 'machine', 'supplier', 'waste', 'unknown'
);

create type inventory_movement_reason as enum (
  'purchase_received',
  'storage_to_operator',
  'operator_to_machine',
  'operator_to_storage',
  'machine_to_storage',
  'stock_count_adjustment',
  'damaged',
  'expired',
  'missing',
  'manual_correction'
);

create type issue_priority as enum (
  'critical', 'high', 'normal', 'low'
);

create type issue_status as enum (
  'open', 'assigned', 'in_progress', 'resolved', 'closed', 'cancelled'
);

create type mapping_status as enum (
  'confirmed', 'needs_review', 'ignored'
);

create type cash_review_status as enum (
  'pending', 'ok', 'review_required', 'resolved'
);

create type purchase_order_status as enum (
  'draft', 'ordered', 'received_partial', 'received_full', 'cancelled'
);

create type lead_stage as enum (
  'lead', 'contacted', 'meeting_scheduled', 'proposal_sent', 'negotiating', 'contract_signed', 'installed', 'rejected', 'lost'
);
```

---

### 7.2 profiles

Linked to Supabase auth users.

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role user_role not null default 'operator',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.3 locations

```sql
create table locations (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  type location_type not null,
  address text,
  contact_person text,
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
```

---

### 7.4 machines

```sql
create table machines (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  vms_machine_id text unique,
  serial_number text,
  type machine_type not null default 'other',
  status machine_status not null default 'active',
  location_id uuid references locations(id),
  rent_amount numeric(12,2) default 0,
  target_nsm numeric(12,2) default 2800,
  target_uptime numeric(5,2) default 98,
  installed_at date,
  last_service_at date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.5 suppliers

```sql
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  phone text,
  email text,
  address text,
  payment_terms text,
  delivery_days integer default 1,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.6 products

```sql
create table products (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  barcode text,
  name text not null,
  brand text,
  category text,
  supplier_id uuid references suppliers(id),
  cost_price numeric(12,2) not null default 0,
  sale_price numeric(12,2) not null default 0,
  case_quantity integer default 1,
  expiry_sensitive boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_price_nonnegative check (sale_price >= 0),
  constraint cost_price_nonnegative check (cost_price >= 0)
);
```

---

### 7.7 storage_locations

```sql
create table storage_locations (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.8 machine_slots

Planogram table. Every product position inside a machine.

```sql
create table machine_slots (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id) on delete cascade,
  slot_code text not null,
  product_id uuid references products(id),
  capacity integer not null default 0,
  min_qty integer not null default 0,
  par_qty integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(machine_id, slot_code),
  constraint slot_capacity_nonnegative check (capacity >= 0),
  constraint slot_min_nonnegative check (min_qty >= 0),
  constraint slot_par_nonnegative check (par_qty >= 0),
  constraint par_less_or_equal_capacity check (par_qty <= capacity)
);
```

---

### 7.9 vms_product_mappings

```sql
create table vms_product_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_product_id text,
  vms_product_name text not null,
  product_id uuid references products(id),
  status mapping_status not null default 'needs_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vms_product_id, vms_product_name)
);
```

---

### 7.10 vms_import_batches

```sql
create table vms_import_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'csv',
  file_name text,
  imported_by uuid references profiles(id),
  imported_at timestamptz not null default now(),
  row_count integer default 0,
  success_count integer default 0,
  error_count integer default 0,
  notes text
);
```

---

### 7.11 vms_stock_snapshots

Stores latest stock readings from VMS.

```sql
create table vms_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references vms_import_batches(id) on delete cascade,
  machine_id uuid references machines(id),
  vms_machine_id text,
  slot_code text,
  product_id uuid references products(id),
  vms_product_id text,
  vms_product_name text,
  current_qty integer not null default 0,
  capacity integer,
  snapshot_at timestamptz not null default now(),
  raw jsonb,
  created_at timestamptz not null default now(),
  constraint current_qty_nonnegative check (current_qty >= 0)
);

create index idx_vms_stock_machine_slot_snapshot on vms_stock_snapshots(machine_id, slot_code, snapshot_at desc);
```

---

### 7.12 vms_sales_snapshots

```sql
create table vms_sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references vms_import_batches(id) on delete cascade,
  machine_id uuid references machines(id),
  product_id uuid references products(id),
  vms_machine_id text,
  vms_product_id text,
  vms_product_name text,
  units_sold integer not null default 0,
  gross_sales numeric(12,2) not null default 0,
  period_start timestamptz,
  period_end timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  constraint units_sold_nonnegative check (units_sold >= 0)
);
```

---

### 7.13 inventory_movements

Inventory must be ledger-based.

```sql
create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  quantity integer not null,
  from_type inventory_location_type not null,
  from_id uuid,
  to_type inventory_location_type not null,
  to_id uuid,
  reason inventory_movement_reason not null,
  related_route_id uuid,
  related_route_stop_id uuid,
  related_refill_order_id uuid,
  related_purchase_order_id uuid,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint inventory_quantity_positive check (quantity > 0)
);

create index idx_inventory_movements_product on inventory_movements(product_id);
create index idx_inventory_movements_created_at on inventory_movements(created_at desc);
```

---

### 7.14 routes

```sql
create table routes (
  id uuid primary key default gen_random_uuid(),
  route_code text unique not null,
  route_date date not null,
  operator_id uuid references profiles(id),
  status route_status not null default 'draft',
  notes text,
  created_by uuid references profiles(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.15 route_stops

```sql
create table route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  machine_id uuid not null references machines(id),
  stop_order integer not null default 1,
  status route_stop_status not null default 'pending',
  arrived_at timestamptz,
  completed_at timestamptz,
  skip_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(route_id, machine_id)
);
```

---

### 7.16 refill_orders

```sql
create table refill_orders (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id),
  route_stop_id uuid references route_stops(id),
  machine_id uuid not null references machines(id),
  status refill_order_status not null default 'generated',
  generated_at timestamptz not null default now(),
  picked_at timestamptz,
  completed_at timestamptz,
  reviewed_at timestamptz,
  created_by uuid references profiles(id),
  notes text
);
```

---

### 7.17 refill_order_lines

```sql
create table refill_order_lines (
  id uuid primary key default gen_random_uuid(),
  refill_order_id uuid not null references refill_orders(id) on delete cascade,
  machine_slot_id uuid references machine_slots(id),
  product_id uuid not null references products(id),
  current_qty_vms integer not null default 0,
  capacity integer not null default 0,
  min_qty integer not null default 0,
  par_qty integer not null default 0,
  suggested_qty integer not null default 0,
  storage_available_qty integer,
  final_pick_qty integer not null default 0,
  picked_qty integer,
  filled_qty integer,
  returned_qty integer,
  shortage_qty integer,
  priority text not null default 'medium',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refill_qty_nonnegative check (
    current_qty_vms >= 0 and capacity >= 0 and min_qty >= 0 and par_qty >= 0 and suggested_qty >= 0 and final_pick_qty >= 0
  )
);
```

---

### 7.18 cash_collections

```sql
create table cash_collections (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id),
  route_stop_id uuid references route_stops(id),
  machine_id uuid not null references machines(id),
  operator_id uuid references profiles(id),
  vms_expected_cash numeric(12,2) default 0,
  actual_cash_collected numeric(12,2) default 0,
  variance numeric(12,2) generated always as (actual_cash_collected - vms_expected_cash) stored,
  review_status cash_review_status not null default 'pending',
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
```

---

### 7.19 issues

```sql
create table issues (
  id uuid primary key default gen_random_uuid(),
  issue_code text unique,
  machine_id uuid references machines(id),
  location_id uuid references locations(id),
  route_id uuid references routes(id),
  route_stop_id uuid references route_stops(id),
  reported_by uuid references profiles(id),
  assigned_to uuid references profiles(id),
  type text not null,
  priority issue_priority not null default 'normal',
  status issue_status not null default 'open',
  description text,
  photo_url text,
  due_at timestamptz,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.20 purchase_orders

```sql
create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_code text unique not null,
  supplier_id uuid references suppliers(id),
  status purchase_order_status not null default 'draft',
  order_date date not null default current_date,
  expected_delivery_date date,
  received_date date,
  created_by uuid references profiles(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.21 purchase_order_lines

```sql
create table purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id),
  ordered_qty integer not null default 0,
  received_qty integer not null default 0,
  unit_cost numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_qty_nonnegative check (ordered_qty >= 0 and received_qty >= 0)
);
```

---

### 7.22 location_leads

```sql
create table location_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type location_type,
  stage lead_stage not null default 'lead',
  contact_person text,
  phone text,
  address text,
  estimated_traffic integer,
  proposed_rent numeric(12,2),
  expected_nsm numeric(12,2),
  next_action text,
  next_action_date date,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 7.23 audit_logs

```sql
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id),
  action text not null,
  table_name text,
  record_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
```

---

## 8. Required Database Views

### 8.1 current_inventory_by_location

Purpose: calculate current stock by product and location from inventory movements.

```sql
create or replace view current_inventory_by_location as
with incoming as (
  select
    product_id,
    to_type as location_type,
    to_id as location_id,
    sum(quantity) as qty
  from inventory_movements
  group by product_id, to_type, to_id
),
outgoing as (
  select
    product_id,
    from_type as location_type,
    from_id as location_id,
    sum(quantity) as qty
  from inventory_movements
  group by product_id, from_type, from_id
),
combined as (
  select product_id, location_type, location_id, qty from incoming
  union all
  select product_id, location_type, location_id, -qty from outgoing
)
select
  product_id,
  location_type,
  location_id,
  sum(qty) as current_qty
from combined
group by product_id, location_type, location_id;
```

---

### 8.2 latest_vms_stock_by_slot

```sql
create or replace view latest_vms_stock_by_slot as
select distinct on (machine_id, slot_code)
  id,
  machine_id,
  slot_code,
  product_id,
  current_qty,
  capacity,
  snapshot_at
from vms_stock_snapshots
where machine_id is not null
order by machine_id, slot_code, snapshot_at desc;
```

---

### 8.3 refill_recommendations

Purpose: generate automatic refill recommendations.

```sql
create or replace view refill_recommendations as
select
  ms.machine_id,
  m.code as machine_code,
  m.name as machine_name,
  l.name as location_name,
  ms.id as machine_slot_id,
  ms.slot_code,
  ms.product_id,
  p.name as product_name,
  coalesce(v.current_qty, 0) as current_qty,
  ms.capacity,
  ms.min_qty,
  ms.par_qty,
  greatest(ms.par_qty - coalesce(v.current_qty, 0), 0) as suggested_qty,
  case
    when coalesce(v.current_qty, 0) = 0 then 'critical'
    when coalesce(v.current_qty, 0) <= ms.min_qty then 'high'
    when coalesce(v.current_qty, 0) < ms.par_qty then 'medium'
    else 'ok'
  end as priority,
  v.snapshot_at as latest_snapshot_at
from machine_slots ms
join machines m on m.id = ms.machine_id
left join locations l on l.id = m.location_id
left join products p on p.id = ms.product_id
left join latest_vms_stock_by_slot v
  on v.machine_id = ms.machine_id
 and v.slot_code = ms.slot_code
where ms.active = true
  and ms.product_id is not null
  and m.status = 'active';
```

Later, improve this view using sales velocity.

---

## 9. Refill Engine Logic

Start simple, then improve.

### MVP logic

```txt
current_qty = latest VMS stock for machine slot
suggested_qty = par_qty - current_qty

if current_qty = 0:
  priority = critical
elif current_qty <= min_qty:
  priority = high
elif current_qty < par_qty:
  priority = medium
else:
  priority = ok
```

Only generate refill order lines where:

```txt
suggested_qty > 0
priority in critical, high, medium
```

### Advanced logic later

Use sales velocity:

```txt
sold_last_7_days = sales units from VMS
avg_daily_sales = sold_last_7_days / 7
estimated_days_left = current_qty / avg_daily_sales

needs_refill = true if:
- current_qty <= min_qty
- current_qty = 0
- estimated_days_left <= next_visit_days + safety_buffer_days
```

Recommended quantity:

```txt
recommended_qty = min(par_qty - current_qty, storage_available_qty)
```

---

## 10. Inventory Logic

Do not update stock balance directly. Always create a movement.

### Receiving products from supplier

```txt
supplier → storage
reason = purchase_received
```

### Operator takes products before route

```txt
storage → operator_bag
reason = storage_to_operator
```

### Operator fills machine

```txt
operator_bag → machine
reason = operator_to_machine
```

### Operator returns leftovers

```txt
operator_bag → storage
reason = operator_to_storage
```

### Damaged / expired products

```txt
machine/storage/operator_bag → waste
reason = damaged or expired
```

---

## 11. Main User Workflows

### 11.1 Daily Owner/Supervisor Flow

```txt
1. Open dashboard
2. Check machines needing refill
3. Check storage alerts
4. Generate route from refill recommendations
5. Assign route to operator
6. Review operator route progress
7. Review cash variance
8. Review issues
9. Approve/close route
```

---

### 11.2 Operator Flow

```txt
1. Login
2. Open Today's Route
3. Click Start Route
4. Review total pick list
5. Pick products from storage
6. Confirm picked quantities
7. Go to first machine
8. Mark Arrived
9. Refill items shown by system
10. Enter actual filled quantity
11. Collect cash
12. Enter actual cash
13. Complete cleaning checklist
14. Upload photo
15. Report issue if needed
16. Complete stop
17. Repeat for all stops
18. Return leftovers to storage
19. Complete route
```

---

### 11.3 VMS Import Flow

```txt
1. Admin opens VMS Import page
2. Uploads CSV from VMS
3. System creates vms_import_batch
4. System parses CSV rows
5. System maps VMS machine IDs to Snacky machines
6. System maps VMS product names/IDs to Snacky products
7. System inserts vms_stock_snapshots
8. System inserts vms_sales_snapshots if present
9. System reports unmapped machines/products
10. Refill recommendations update automatically
```

CSV import should be flexible. Different VMS exports may have column names like:

```txt
machine_id
machine_name
slot
product_id
product_name
current_stock
capacity
sold_qty
sales_amount
cash_expected
```

Create a parser that can be configured later.

---

### 11.4 Route Generation Flow

```txt
1. Supervisor selects machines or priority level
2. System pulls refill_recommendations
3. System groups selected recommendations by machine
4. System creates route
5. System creates route_stops
6. System creates refill_orders
7. System creates refill_order_lines
8. System creates pick list totals by product
9. Operator sees assigned route
```

---

### 11.5 Cash Reconciliation Flow

```txt
1. VMS expected cash is imported or entered
2. Operator enters actual cash collected
3. System calculates variance
4. If absolute variance <= allowed threshold: status = ok
5. If variance is high: status = review_required
6. Supervisor reviews and resolves
```

Suggested threshold:

```txt
Default: 10 LYD
Or 2% of expected cash, whichever is higher
```

---

## 12. UI Routes / Pages

Use Next.js App Router.

```txt
src/app/(auth)/login/page.tsx
src/app/(app)/layout.tsx
src/app/(app)/dashboard/page.tsx
src/app/(app)/machines/page.tsx
src/app/(app)/machines/new/page.tsx
src/app/(app)/machines/[id]/page.tsx
src/app/(app)/machines/[id]/edit/page.tsx
src/app/(app)/machines/[id]/slots/page.tsx
src/app/(app)/locations/page.tsx
src/app/(app)/locations/new/page.tsx
src/app/(app)/locations/[id]/page.tsx
src/app/(app)/products/page.tsx
src/app/(app)/products/new/page.tsx
src/app/(app)/products/[id]/edit/page.tsx
src/app/(app)/suppliers/page.tsx
src/app/(app)/inventory/page.tsx
src/app/(app)/inventory/movements/page.tsx
src/app/(app)/inventory/receive/page.tsx
src/app/(app)/vms-import/page.tsx
src/app/(app)/vms-import/[batchId]/page.tsx
src/app/(app)/vms-mapping/page.tsx
src/app/(app)/refills/page.tsx
src/app/(app)/routes/page.tsx
src/app/(app)/routes/new/page.tsx
src/app/(app)/routes/[id]/page.tsx
src/app/(app)/operator/page.tsx
src/app/(app)/operator/routes/[id]/page.tsx
src/app/(app)/operator/stops/[id]/page.tsx
src/app/(app)/cash/page.tsx
src/app/(app)/issues/page.tsx
src/app/(app)/issues/[id]/page.tsx
src/app/(app)/purchasing/page.tsx
src/app/(app)/growth/page.tsx
src/app/(app)/settings/page.tsx
```

---

## 13. Main Components

```txt
src/components/AppShell.tsx
src/components/Sidebar.tsx
src/components/Topbar.tsx
src/components/DataTable.tsx
src/components/StatCard.tsx
src/components/StatusBadge.tsx
src/components/PriorityBadge.tsx
src/components/ConfirmDialog.tsx
src/components/FormField.tsx
src/components/EmptyState.tsx
src/components/PageHeader.tsx
src/components/MobileActionBar.tsx
src/components/PhotoUpload.tsx
```

---

## 14. Lib / Service Structure

```txt
src/lib/supabase/client.ts
src/lib/supabase/server.ts
src/lib/auth/roles.ts
src/lib/db/types.ts
src/lib/format.ts
src/lib/validators.ts
src/lib/vms/parse-csv.ts
src/lib/vms/column-mapper.ts
src/lib/refills/recommendations.ts
src/lib/refills/generate-route.ts
src/lib/inventory/movements.ts
src/lib/cash/reconciliation.ts
src/lib/issues/sla.ts
src/lib/errors.ts
```

---

## 15. Server Actions

Use server actions for mutations.

```txt
src/app/(app)/machines/actions.ts
- createMachine
- updateMachine
- archiveMachine

src/app/(app)/products/actions.ts
- createProduct
- updateProduct
- archiveProduct

src/app/(app)/locations/actions.ts
- createLocation
- updateLocation

src/app/(app)/inventory/actions.ts
- receivePurchaseStock
- createInventoryMovement
- adjustInventoryCount

src/app/(app)/vms-import/actions.ts
- uploadVmsCsv
- processVmsImport
- confirmProductMapping

src/app/(app)/routes/actions.ts
- createRouteFromRecommendations
- assignRoute
- startRoute
- completeRoute
- reviewRoute

src/app/(app)/operator/actions.ts
- confirmPickedItems
- markStopArrived
- submitRefillQuantities
- submitCashCollection
- submitCleaningChecklist
- submitIssue
- completeStop
- returnLeftovers

src/app/(app)/issues/actions.ts
- createIssue
- assignIssue
- resolveIssue
```

---

## 16. API Route Handlers

Use route handlers only where needed.

```txt
src/app/api/vms/import/route.ts
POST: upload and parse CSV

src/app/api/refills/recommendations/route.ts
GET: return recommendations

src/app/api/routes/[id]/pick-list/route.ts
GET: route total pick list

src/app/api/webhooks/vms/route.ts
POST: future VMS webhook/API integration
```

---

## 17. Dashboard Requirements

Dashboard should show decision cards, not just charts.

### Cards

```txt
Total sales today
Total sales this month
Machines active
Machines needing refill
Critical stockouts
Open issues
Cash variance pending review
Low storage items
Routes in progress
Average NSM per machine
```

### Tables

```txt
Machines needing refill today
Worst-performing machines
Best-performing machines
Open critical issues
Cash variance review list
Low inventory purchase suggestions
Operator route status
```

---

## 18. Page Requirements

### Machines page

List:

```txt
Machine code
Name
Location
Type
Status
Rent
Target NSM
Latest sales
Needs refill?
Open issues
Actions
```

Machine detail:

```txt
Machine info
Current planogram
Latest VMS stock
Sales history
Refill history
Cash history
Issues
Location/rent info
```

---

### Products page

List:

```txt
SKU
Name
Category
Supplier
Cost price
Sale price
Margin
Storage stock
Active
```

Product detail:

```txt
Sales by machine
Inventory movements
Supplier cost history
Stockout history
```

---

### Inventory page

Views:

```txt
Storage stock
Operator bag stock
Machine expected stock
Inventory movements
Low stock alerts
Receive purchase stock
Adjust stock count
```

---

### VMS Import page

Must support:

```txt
Upload CSV
Preview rows
Map columns
Show unmapped products
Show unmapped machines
Confirm import
Show import summary
```

Import summary:

```txt
Rows processed
Successful rows
Errors
Products needing mapping
Machines needing mapping
Snapshots created
```

---

### Refill Recommendations page

List:

```txt
Machine
Location
Slot
Product
Current Qty
Min Qty
Par Qty
Suggested Qty
Storage Available
Priority
Select for route
```

Actions:

```txt
Generate route
Ignore recommendation
Change quantity
```

---

### Routes page

List:

```txt
Route code
Date
Operator
Stops
Status
Started
Completed
Cash variance
Review status
```

Route detail:

```txt
Stops
Pick list
Refill orders
Cash collections
Issues reported
Photos
Route review button
```

---

### Operator page

Mobile-first.

Must be extremely simple.

Screens:

```txt
Today's route
Pick list
Machine stop
Refill form
Cash form
Cleaning checklist
Photo upload
Issue report
Return leftovers
Complete route
```

No profit data.
No supplier cost data.
No company-wide dashboard.

---

### Cash page

List:

```txt
Machine
Route
Operator
Expected cash
Actual cash
Variance
Review status
Reviewed by
```

Actions:

```txt
Mark OK
Mark resolved
Add note
```

---

### Issues page

List:

```txt
Issue code
Machine
Location
Type
Priority
Status
Assigned to
Due at
Age
```

SLA:

```txt
critical: due within 24 hours
high: due within 48 hours
normal: due within 72 hours
low: due within 7 days
```

---

### Purchasing page

Must show purchase suggestions:

```txt
Product
Storage qty
Reserved for routes
Sales velocity
Minimum storage level
Suggested buy qty
Supplier
```

---

### Growth page

Track future locations:

```txt
Name
Type
Stage
Contact
Proposed rent
Expected NSM
Next action
Next action date
```

---

## 19. Folder Structure to Build

Target structure:

```txt
snacky-os/
├── docs/
│   ├── CODEX_BUILD_STRUCTURE.md
│   ├── DATABASE_SCHEMA.md
│   ├── VMS_IMPORT_SPEC.md
│   ├── OPERATOR_WORKFLOW.md
│   └── DEPLOYMENT.md
├── supabase/
│   ├── migrations/
│   ├── seed.sql
│   └── config.toml
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   └── login/
│   │   ├── (app)/
│   │   │   ├── dashboard/
│   │   │   ├── machines/
│   │   │   ├── locations/
│   │   │   ├── products/
│   │   │   ├── suppliers/
│   │   │   ├── inventory/
│   │   │   ├── vms-import/
│   │   │   ├── vms-mapping/
│   │   │   ├── refills/
│   │   │   ├── routes/
│   │   │   ├── operator/
│   │   │   ├── cash/
│   │   │   ├── issues/
│   │   │   ├── purchasing/
│   │   │   ├── growth/
│   │   │   └── settings/
│   │   └── api/
│   ├── components/
│   ├── lib/
│   ├── types/
│   └── middleware.ts
├── .env.example
├── package.json
└── README.md
```

---

## 20. Authentication and Security

Add authentication early.

Requirements:

```txt
- Login page
- Protected app routes
- Redirect unauthenticated users to login
- Role-based navigation
- RLS policies for all tables
- Operator can only see assigned routes
- Operator cannot see profit/cost data
- Owner/admin can see all data
```

RLS should be enabled for all business tables.

Example helpers:

```sql
create or replace function public.current_user_role()
returns user_role
language sql
security definer
as $$
  select role from public.profiles where id = auth.uid();
$$;
```

Example policy idea:

```sql
create policy "owners and admins can read all machines"
on machines for select
to authenticated
using (public.current_user_role() in ('owner', 'admin', 'supervisor'));
```

Operator route policy idea:

```sql
create policy "operators can read assigned routes"
on routes for select
to authenticated
using (
  operator_id = auth.uid()
  or public.current_user_role() in ('owner', 'admin', 'supervisor')
);
```

---

## 21. MVP Acceptance Criteria

MVP is complete when all of this works:

```txt
[ ] Owner can log in
[ ] Owner can create machines
[ ] Owner can create locations
[ ] Owner can create products
[ ] Owner can create suppliers
[ ] Owner can set machine slots/planogram
[ ] Owner can upload VMS CSV
[ ] System maps VMS machines/products
[ ] System shows unmapped products/machines
[ ] System creates latest VMS stock snapshots
[ ] Refill recommendations update automatically
[ ] Owner can generate route from recommendations
[ ] Operator can see assigned route
[ ] Operator can confirm pick list
[ ] Inventory movement is created: storage → operator bag
[ ] Operator can complete machine refill
[ ] Inventory movement is created: operator bag → machine
[ ] Operator can enter cash collected
[ ] Cash variance is calculated
[ ] Operator can complete cleaning checklist
[ ] Operator can upload photo
[ ] Operator can report issue
[ ] Operator can return leftovers
[ ] Inventory movement is created: operator bag → storage
[ ] Supervisor can review route
[ ] Dashboard shows machines needing refill, open issues, cash variance, and low inventory
```

---

## 22. Build Order for Codex

Give Codex one task at a time. Do not ask it to build the whole platform in one step.

### Task 0 — Inspect project

Prompt:

```txt
Inspect this repository and summarize the current Next.js/Supabase structure. Do not make changes yet. Identify existing pages, schema, seed data, and missing pieces compared to docs/CODEX_BUILD_STRUCTURE.md.
```

Expected output:

```txt
- Summary of files
- Current database schema
- Missing modules
- Suggested implementation order
```

---

### Task 1 — Add full docs

Prompt:

```txt
Add docs/CODEX_BUILD_STRUCTURE.md using the provided Snacky OS build spec. Also add docs/DATABASE_SCHEMA.md, docs/VMS_IMPORT_SPEC.md, and docs/OPERATOR_WORKFLOW.md with concise references to the same system. Do not change app code yet.
```

---

### Task 2 — Upgrade database schema

Prompt:

```txt
Create a new Supabase migration that upgrades the database to the complete Snacky OS schema described in docs/CODEX_BUILD_STRUCTURE.md. Include enums, tables, constraints, indexes, views, and basic updated_at triggers. Preserve existing demo data if possible, or update seed.sql to match the new schema. Then run the local migration/reset command and fix SQL errors.
```

Acceptance:

```txt
- npx supabase db reset works
- Tables are created
- Views work
- Seed data loads
```

---

### Task 3 — Generate TypeScript DB types

Prompt:

```txt
Add generated Supabase database types to src/types/database.types.ts. Update Supabase client/server helpers to use typed clients. Make sure npm run typecheck passes.
```

---

### Task 4 — App shell and protected layout

Prompt:

```txt
Implement the app shell with sidebar, topbar, and grouped routes. Add placeholder authentication protection using Supabase Auth. Add role-based navigation structure, but keep RLS integration simple until the next task. Make all app pages use consistent PageHeader, StatCard, DataTable, StatusBadge, and EmptyState components.
```

---

### Task 5 — Master data CRUD

Prompt:

```txt
Implement CRUD screens and server actions for locations, machines, products, suppliers, storage locations, and machine slots. Use server actions for create/update/archive. Use forms with validation. Add detail pages for machines and products. Keep UI simple and mobile-friendly.
```

Acceptance:

```txt
- Can create/edit machine
- Can assign machine to location
- Can create/edit product
- Can create machine slots
- Planogram appears on machine detail page
```

---

### Task 6 — Inventory ledger

Prompt:

```txt
Implement inventory ledger pages using inventory_movements and current_inventory_by_location. Add receive stock flow, manual adjustment flow, and movement history. Do not allow direct stock edits except via adjustment movements. Show storage stock, operator bag stock, and machine stock separately.
```

Acceptance:

```txt
- Receive stock creates supplier/storage movement
- Current inventory view updates
- Movement history is visible
```

---

### Task 7 — VMS CSV import

Prompt:

```txt
Build VMS CSV import. Add upload UI, CSV parser, preview table, configurable column mapping, import batch creation, machine mapping, product mapping, vms_stock_snapshots insertion, and import summary. Show unmapped machines/products and allow product mapping confirmation.
```

Acceptance:

```txt
- Upload CSV
- Preview rows
- Confirm import
- Snapshots inserted
- Unmapped products visible
- Refill recommendations update after import
```

---

### Task 8 — Refill recommendation page

Prompt:

```txt
Implement refill recommendations page using refill_recommendations view. Show machine, location, slot, product, current qty, min, par, suggested qty, storage available, priority. Allow selecting recommendations and generating a route.
```

Acceptance:

```txt
- Recommendations appear from VMS snapshots
- Critical/high priorities are clear
- Selected recommendations can generate route
```

---

### Task 9 — Route generation

Prompt:

```txt
Implement route generation from selected refill recommendations. Create route, route_stops, refill_orders, and refill_order_lines. Generate route_code automatically. Add route detail page with stops, refill lines, and total pick list by product.
```

Acceptance:

```txt
- Owner selects recommendations
- System creates route
- Route detail shows pick list totals
```

---

### Task 10 — Operator PWA workflow

Prompt:

```txt
Build mobile-first operator workflow. Operator can see assigned route, start route, confirm pick list, mark stop arrived, enter filled quantities, enter cash collected, complete cleaning checklist, upload stop photo placeholder, report issue, complete stop, and return leftovers.
```

Acceptance:

```txt
- Operator can complete a full route
- Inventory movements are created correctly
- Cash collection is created
- Issue can be reported
```

---

### Task 11 — Cash reconciliation

Prompt:

```txt
Implement cash reconciliation page. Show expected cash, actual cash, variance, operator, machine, route, review status. Auto mark review_required when variance exceeds configured threshold. Add supervisor review action.
```

---

### Task 12 — Issues and SLA

Prompt:

```txt
Implement issues module with issue list, detail page, create issue, assign issue, resolve issue, status changes, priority badges, and SLA due_at calculation: critical 24h, high 48h, normal 72h, low 7 days.
```

---

### Task 13 — Dashboard

Prompt:

```txt
Implement owner dashboard with decision cards and tables: machines needing refill, critical stockouts, open issues, cash variance pending review, low storage products, active routes, and machine performance placeholders.
```

---

### Task 14 — Purchasing suggestions

Prompt:

```txt
Implement purchasing suggestions based on storage inventory, reserved route quantities, minimum storage levels, and sales velocity if available. Add purchase orders and receiving flow integration.
```

---

### Task 15 — RLS and role permissions

Prompt:

```txt
Enable Row Level Security on all business tables. Add policies for owner/admin/supervisor/operator/warehouse/procurement/finance. Operators should only read assigned routes, route stops, refill lines, cash collections, and issues related to their routes. Owner/admin can access all. Add tests or manual policy verification steps.
```

---

### Task 16 — Quality and deployment readiness

Prompt:

```txt
Run lint, typecheck, build, and fix all errors. Add README setup instructions, .env.example, seed data, and deployment notes for Vercel + Supabase. Do not deploy automatically.
```

---

## 23. Commands Codex Should Use

```bash
npm install
npm run lint
npm run typecheck
npm run build
npx supabase start
npx supabase db reset
npx supabase status
```

Add these scripts to package.json if missing:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## 24. VMS CSV Example

Use this sample for testing:

```csv
vms_machine_id,machine_name,slot_code,vms_product_id,vms_product_name,current_qty,capacity,sold_last_7_days,gross_sales_last_7_days,expected_cash
M001,Hospital Machine 01,A1,P001,Water 500ml,2,12,28,84,340
M001,Hospital Machine 01,A2,P002,Pepsi Can 330ml,5,10,14,42,340
M002,School Machine 01,A1,P001,Water 500ml,0,12,35,105,500
M002,School Machine 01,A2,P003,Hot Chips,4,10,12,36,500
```

Expected behavior:

```txt
- M001 maps to Hospital Machine 01
- M002 maps to School Machine 01
- Water maps to Water 500ml
- Pepsi Can 330ml may need mapping to Pepsi 330ml
- Hot Chips maps to Hot Chips
- System creates stock snapshots
- School Machine 01 Water becomes critical
```

---

## 25. UI Style Direction

Keep it clean, serious, and operational.

```txt
Style: simple SaaS dashboard
Colors: neutral base, Snacky accent color can be added later
Priority badges: critical/high/medium/ok
Mobile: operator pages must work perfectly on phone
Tables: readable and filterable
Forms: simple, not fancy
```

Do not spend time on logo, animations, or perfect visuals until workflows work.

---

## 26. Non-Negotiable Rules for Codex

```txt
1. Do not create fake disconnected features.
2. Every operation must connect to the database.
3. Inventory must use movements, not direct edits.
4. Refill recommendations must come from VMS stock + machine slots.
5. Operator screens must be mobile-first.
6. Do not expose cost/profit data to operators.
7. Use TypeScript and typed Supabase clients.
8. Use server actions for mutations where appropriate.
9. Add clear error handling.
10. Keep the MVP simple and working before adding advanced features.
```

---

## 27. Final Codex Master Prompt

Paste this into Codex after adding this file to the repo:

```txt
You are building Snacky OS, an internal operating system for a vending machine company in Libya. Read docs/CODEX_BUILD_STRUCTURE.md fully before coding.

The goal is not just a dashboard. The goal is an operations system that can scale Snacky from 8 machines to 100+ machines.

Use:
- Next.js App Router + TypeScript
- Supabase PostgreSQL
- Supabase Auth
- Supabase Storage
- Tailwind CSS
- Server Actions / Route Handlers

Core principle:
The system must automatically tell operators what to take from storage, which machines to visit, what to refill, how much cash to collect, and what issues to report.

Build in phases. Do not try to finish everything in one response. Start by inspecting the repo and comparing it to docs/CODEX_BUILD_STRUCTURE.md. Then suggest the next concrete coding task. When coding, keep changes small, run lint/typecheck/build where possible, and explain what changed.

Non-negotiable business rules:
1. Inventory must be ledger-based through inventory_movements.
2. Refill recommendations come from machine_slots + latest VMS stock snapshots.
3. Operators can only access assigned routes and execution screens.
4. Owner/admin/supervisor can manage the full operation.
5. Cash variance must be calculated and reviewable.
6. Issues must have priority and SLA due dates.
7. VMS import must support CSV now and API/webhook later.
8. The MVP must be useful before it is beautiful.

First task:
Inspect the existing repository. Summarize current files, database schema, seed data, and missing pieces compared to this spec. Do not change code until you finish the inspection.
```

---

## 28. First Real MVP Target

The first version is successful when Snacky can do this:

```txt
1. Upload latest VMS stock report
2. System maps products and machines
3. System shows refill recommendations
4. Owner generates a route
5. Operator sees what to take
6. Operator refills machines
7. Inventory updates automatically
8. Cash is collected and variance calculated
9. Issues are reported
10. Dashboard shows what needs attention
```

That is Snacky becoming a system.
