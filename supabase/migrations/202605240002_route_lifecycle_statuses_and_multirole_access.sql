alter type route_status add value if not exists 'available';
alter type route_status add value if not exists 'ready';
alter type route_status add value if not exists 'started';
alter type route_status add value if not exists 'pickup_confirmed';
alter type route_status add value if not exists 'machine_filling';
alter type route_status add value if not exists 'canceled';

create or replace function public.snacky_profile_has_any_role(profile_roles team_role[], primary_role team_role, allowed_roles text[])
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from unnest(array_remove(coalesce(profile_roles, array[]::team_role[]) || array[primary_role], null)) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$$;

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and p.team_member_id is not null
      and public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
      and (
        r.operator_id = p.team_member_id
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;

grant execute on function public.snacky_profile_has_any_role(team_role[], team_role, text[]) to authenticated;
grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.routes') is not null then
    execute 'drop policy if exists "snacky_routes_select_by_effective_role" on public.routes';
    execute $sql$
      create policy "snacky_routes_select_by_effective_role"
      on public.routes for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stops') is not null then
    execute 'drop policy if exists "snacky_route_stops_select_by_route_access" on public.route_stops';
    execute $sql$
      create policy "snacky_route_stops_select_by_route_access"
      on public.route_stops for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stock_lines') is not null then
    execute 'drop policy if exists "snacky_route_stock_lines_select_by_route_access" on public.route_stock_lines';
    execute $sql$
      create policy "snacky_route_stock_lines_select_by_route_access"
      on public.route_stock_lines for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stop_items') is not null then
    execute 'drop policy if exists "snacky_route_stop_items_select_by_route_access" on public.route_stop_items';
    execute $sql$
      create policy "snacky_route_stop_items_select_by_route_access"
      on public.route_stop_items for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_pick_list_items') is not null then
    execute 'drop policy if exists "snacky_route_pick_list_items_select_by_route_access" on public.route_pick_list_items';
    execute $sql$
      create policy "snacky_route_pick_list_items_select_by_route_access"
      on public.route_pick_list_items for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
      create policy "snacky_inventory_movements_insert_by_effective_role"
      on public.inventory_movements for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'damaged', 'expired', 'product_substitution', 'manual_correction'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'machine', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'machine', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'damaged', 'expired', 'product_substitution', 'manual_correction'])
        )
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
