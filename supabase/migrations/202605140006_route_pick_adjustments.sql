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
