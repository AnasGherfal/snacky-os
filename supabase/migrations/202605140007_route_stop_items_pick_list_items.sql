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
