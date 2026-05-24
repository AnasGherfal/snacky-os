alter table if exists public.route_pick_list_items
  add column if not exists route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists route_stop_item_id uuid references public.route_stop_items(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null;

create index if not exists idx_route_pick_list_items_route_stop_id
  on public.route_pick_list_items(route_stop_id);

create index if not exists idx_route_pick_list_items_route_stop_item_id
  on public.route_pick_list_items(route_stop_item_id);

create index if not exists idx_route_pick_list_items_machine_id
  on public.route_pick_list_items(machine_id);

select pg_notify('pgrst', 'reload schema');
