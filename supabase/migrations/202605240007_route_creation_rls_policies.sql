do $$
begin
  if to_regclass('public.routes') is not null then
    execute 'grant select, insert, update, delete on table public.routes to authenticated';

    execute 'drop policy if exists "snacky_routes_insert_by_effective_role" on public.routes';
    execute 'drop policy if exists "snacky_routes_update_by_effective_role" on public.routes';
    execute 'drop policy if exists "snacky_routes_delete_by_effective_role" on public.routes';

    execute $sql$
      create policy "snacky_routes_insert_by_effective_role"
      on public.routes for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_routes_update_by_effective_role"
      on public.routes for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_routes_delete_by_effective_role"
      on public.routes for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.route_stops') is not null then
    execute 'grant select, insert, update, delete on table public.route_stops to authenticated';

    execute 'drop policy if exists "snacky_route_stops_insert_by_effective_role" on public.route_stops';
    execute 'drop policy if exists "snacky_route_stops_update_by_effective_role" on public.route_stops';
    execute 'drop policy if exists "snacky_route_stops_delete_by_effective_role" on public.route_stops';

    execute $sql$
      create policy "snacky_route_stops_insert_by_effective_role"
      on public.route_stops for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_route_stops_update_by_effective_role"
      on public.route_stops for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stops_delete_by_effective_role"
      on public.route_stops for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.route_stock_lines') is not null then
    execute 'grant select, insert, update, delete on table public.route_stock_lines to authenticated';

    execute 'drop policy if exists "snacky_route_stock_lines_insert_by_effective_role" on public.route_stock_lines';
    execute 'drop policy if exists "snacky_route_stock_lines_update_by_effective_role" on public.route_stock_lines';
    execute 'drop policy if exists "snacky_route_stock_lines_delete_by_effective_role" on public.route_stock_lines';

    execute $sql$
      create policy "snacky_route_stock_lines_insert_by_effective_role"
      on public.route_stock_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_route_stock_lines_update_by_effective_role"
      on public.route_stock_lines for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stock_lines_delete_by_effective_role"
      on public.route_stock_lines for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.route_stop_items') is not null then
    execute 'grant select, insert, update, delete on table public.route_stop_items to authenticated';

    execute 'drop policy if exists "snacky_route_stop_items_insert_by_effective_role" on public.route_stop_items';
    execute 'drop policy if exists "snacky_route_stop_items_update_by_effective_role" on public.route_stop_items';
    execute 'drop policy if exists "snacky_route_stop_items_delete_by_effective_role" on public.route_stop_items';

    execute $sql$
      create policy "snacky_route_stop_items_insert_by_effective_role"
      on public.route_stop_items for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_route_stop_items_update_by_effective_role"
      on public.route_stop_items for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stop_items_delete_by_effective_role"
      on public.route_stop_items for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.route_pick_list_items') is not null then
    execute 'grant select, insert, update, delete on table public.route_pick_list_items to authenticated';

    execute 'drop policy if exists "snacky_route_pick_list_items_insert_by_effective_role" on public.route_pick_list_items';
    execute 'drop policy if exists "snacky_route_pick_list_items_update_by_effective_role" on public.route_pick_list_items';
    execute 'drop policy if exists "snacky_route_pick_list_items_delete_by_effective_role" on public.route_pick_list_items';

    execute $sql$
      create policy "snacky_route_pick_list_items_insert_by_effective_role"
      on public.route_pick_list_items for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pick_list_items_update_by_effective_role"
      on public.route_pick_list_items for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pick_list_items_delete_by_effective_role"
      on public.route_pick_list_items for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.refill_orders') is not null then
    execute 'grant select, insert, update, delete on table public.refill_orders to authenticated';

    execute 'drop policy if exists "snacky_refill_orders_insert_by_effective_role" on public.refill_orders';
    execute 'drop policy if exists "snacky_refill_orders_update_by_effective_role" on public.refill_orders';
    execute 'drop policy if exists "snacky_refill_orders_delete_by_effective_role" on public.refill_orders';

    execute $sql$
      create policy "snacky_refill_orders_insert_by_effective_role"
      on public.refill_orders for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_refill_orders_update_by_effective_role"
      on public.refill_orders for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_refill_orders_delete_by_effective_role"
      on public.refill_orders for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;
  end if;

  if to_regclass('public.refill_order_lines') is not null then
    execute 'grant select, insert, update, delete on table public.refill_order_lines to authenticated';

    execute 'drop policy if exists "snacky_refill_order_lines_insert_by_effective_role" on public.refill_order_lines';
    execute 'drop policy if exists "snacky_refill_order_lines_update_by_effective_role" on public.refill_order_lines';
    execute 'drop policy if exists "snacky_refill_order_lines_delete_by_effective_role" on public.refill_order_lines';

    execute $sql$
      create policy "snacky_refill_order_lines_insert_by_effective_role"
      on public.refill_order_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
    $sql$;

    execute $sql$
      create policy "snacky_refill_order_lines_update_by_effective_role"
      on public.refill_order_lines for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_refill_order_lines_delete_by_effective_role"
      on public.refill_order_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        )
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
