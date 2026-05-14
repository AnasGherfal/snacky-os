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
