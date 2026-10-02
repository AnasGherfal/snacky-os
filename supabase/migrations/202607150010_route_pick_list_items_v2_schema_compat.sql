-- Production compatibility for the single-signature pickup confirmation RPC.
--
-- Some production environments did not receive
-- 202607140001_route_pick_list_active_rows.sql because an older migration backlog
-- stopped before it. snacky_confirm_route_pickup_batch_v2 soft-retires and
-- reactivates route_pick_list_items, so it requires the complete active-row
-- contract below.
--
-- This migration is additive and idempotent. It deletes no route, pickup,
-- checklist, inventory, VMS, finance, or payroll data.

do $migration$
begin
  if to_regclass('public.route_pick_list_items') is null then
    raise exception 'Required table public.route_pick_list_items does not exist.'
      using errcode = '42P01';
  end if;
end
$migration$;

alter table public.route_pick_list_items
  add column if not exists is_active boolean,
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_reason text;

-- Preserve every existing checklist row as active unless it was already marked
-- otherwise by a newer schema version.
update public.route_pick_list_items
set is_active = true
where is_active is null;

alter table public.route_pick_list_items
  alter column is_active set default true,
  alter column is_active set not null;

create index if not exists idx_route_pick_list_items_route_id_is_active
  on public.route_pick_list_items(route_id, is_active);

create index if not exists idx_route_pick_list_items_active_route_stop_item
  on public.route_pick_list_items(route_id, route_stop_item_id)
  where is_active = true;

-- Fail this migration immediately if the complete v2 checklist contract is not
-- present, preventing another one-column-at-a-time production loop.
do $verification$
declare
  v_missing text[];
begin
  select coalesce(array_agg(required_column order by required_column), '{}'::text[])
  into v_missing
  from unnest(array[
    'is_active',
    'superseded_at',
    'superseded_reason'
  ]) as required_column
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'route_pick_list_items'
      and c.column_name = required_column
  );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'route_pick_list_items is still missing required pickup columns: %', array_to_string(v_missing, ', ')
      using errcode = '42703';
  end if;
end
$verification$;

select pg_notify('pgrst', 'reload schema');
