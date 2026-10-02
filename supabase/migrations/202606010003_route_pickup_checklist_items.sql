alter table if exists public.route_pick_list_items
  add column if not exists is_checked boolean not null default false;

create index if not exists idx_route_pick_list_items_is_checked
  on public.route_pick_list_items(route_id, is_checked);

select pg_notify('pgrst', 'reload schema');
