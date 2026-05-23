alter table route_stop_items
  add column if not exists slot_allocations jsonb not null default '[]'::jsonb;

alter table refill_order_lines
  add column if not exists slot_allocations jsonb not null default '[]'::jsonb;

create index if not exists idx_route_stop_items_slot_allocations
  on route_stop_items using gin (slot_allocations);

create index if not exists idx_refill_order_lines_slot_allocations
  on refill_order_lines using gin (slot_allocations);
