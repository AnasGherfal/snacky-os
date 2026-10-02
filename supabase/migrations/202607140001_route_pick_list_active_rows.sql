alter table if exists public.route_pick_list_items
  add column if not exists is_active boolean not null default true,
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_reason text;

create index if not exists idx_route_pick_list_items_route_id_is_active
  on public.route_pick_list_items(route_id, is_active);

create index if not exists idx_route_pick_list_items_active_route_stop_item
  on public.route_pick_list_items(route_id, route_stop_item_id)
  where coalesce(is_active, true) = true;

select pg_notify('pgrst', 'reload schema');
