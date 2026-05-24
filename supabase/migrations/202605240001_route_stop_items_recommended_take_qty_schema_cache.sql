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
