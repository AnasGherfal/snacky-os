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
