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
