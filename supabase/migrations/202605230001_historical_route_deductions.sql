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
