-- Multi-role helpers and RLS policies for product and warehouse inventory access.
-- These policies are safe to define even before RLS is enabled on the core tables.

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

create or replace function public.snacky_current_profile_can_add_products()
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
      and (
        p.can_add_products = true
        or public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'purchasing'])
      )
  );
$$;

create or replace function public.snacky_operator_can_read_product(target_product_id uuid)
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
      and p.team_member_id is not null
      and public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
      and (
        exists (
          select 1
          from public.routes r
          join public.route_stock_lines rsl on rsl.route_id = r.id
          where r.operator_id = p.team_member_id
            and rsl.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.route_stop_items rsi on rsi.route_id = r.id
          where r.operator_id = p.team_member_id
            and rsi.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.refill_orders ro on ro.route_id = r.id
          join public.refill_order_lines rol on rol.refill_order_id = ro.id
          where r.operator_id = p.team_member_id
            and rol.product_id = target_product_id
        )
      )
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
      and r.operator_id = p.team_member_id
      and public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
  );
$$;

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_current_profile_can_add_products() to authenticated;
grant execute on function public.snacky_operator_can_read_product(uuid) to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'drop policy if exists "snacky_products_select_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_insert_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_update_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_delete_by_effective_role" on public.products';

    execute $sql$
      create policy "snacky_products_select_by_effective_role"
      on public.products for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance'])
        or public.snacky_operator_can_read_product(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_insert_by_effective_role"
      on public.products for insert
      to authenticated
      with check (public.snacky_current_profile_can_add_products())
    $sql$;

    execute $sql$
      create policy "snacky_products_update_by_effective_role"
      on public.products for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_products_delete_by_effective_role"
      on public.products for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.storage_locations') is not null then
    execute 'drop policy if exists "snacky_storage_locations_select_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_insert_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_update_by_effective_role" on public.storage_locations';

    execute $sql$
      create policy "snacky_storage_locations_select_by_effective_role"
      on public.storage_locations for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_insert_by_effective_role"
      on public.storage_locations for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;

    execute $sql$
      create policy "snacky_storage_locations_update_by_effective_role"
      on public.storage_locations for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']))
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'drop policy if exists "snacky_inventory_movements_select_by_effective_role" on public.inventory_movements';
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
      create policy "snacky_inventory_movements_select_by_effective_role"
      on public.inventory_movements for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or (related_route_id is not null and public.snacky_operator_can_access_route(related_route_id))
      )
    $sql$;

    execute $sql$
      create policy "snacky_inventory_movements_insert_by_effective_role"
      on public.inventory_movements for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'damaged', 'expired', 'product_substitution'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'damaged', 'expired', 'product_substitution'])
        )
      )
    $sql$;
  end if;

  if to_regclass('public.purchase_orders') is not null then
    execute 'drop policy if exists "snacky_purchase_orders_select_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_insert_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_update_by_effective_role" on public.purchase_orders';

    execute $sql$
      create policy "snacky_purchase_orders_select_by_effective_role"
      on public.purchase_orders for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_insert_by_effective_role"
      on public.purchase_orders for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_orders_update_by_effective_role"
      on public.purchase_orders for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;
  end if;

  if to_regclass('public.purchase_order_lines') is not null then
    execute 'drop policy if exists "snacky_purchase_order_lines_select_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_insert_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_update_by_effective_role" on public.purchase_order_lines';

    execute $sql$
      create policy "snacky_purchase_order_lines_select_by_effective_role"
      on public.purchase_order_lines for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_insert_by_effective_role"
      on public.purchase_order_lines for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_purchase_order_lines_update_by_effective_role"
      on public.purchase_order_lines for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']))
    $sql$;
  end if;
end $$;
