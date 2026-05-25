create or replace function public.snacky_profile_has_any_role(profile_roles team_role[], primary_role team_role, allowed_roles text[])
returns boolean
language sql
stable
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
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
        or public.snacky_profile_has_any_role(tm.roles, tm.role, allowed_roles)
      )
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
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.can_add_products = true
        or tm.can_add_products = true
        or public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'warehouse', 'purchasing'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'warehouse', 'purchasing'])
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
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
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
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator'])
      )
      and (
        exists (
          select 1
          from public.routes r
          join public.route_stock_lines rsl on rsl.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsl.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.route_stop_items rsi on rsi.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsi.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.refill_orders ro on ro.route_id = r.id
          join public.refill_order_lines rol on rol.refill_order_id = ro.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rol.product_id = target_product_id
        )
      )
  );
$$;

grant execute on function public.snacky_profile_has_any_role(team_role[], team_role, text[]) to authenticated;
grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_current_profile_can_add_products() to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;
grant execute on function public.snacky_operator_can_read_product(uuid) to authenticated;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'alter table public.products enable row level security';
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
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_products_delete_by_effective_role"
      on public.products for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.storage_locations') is not null then
    execute 'alter table public.storage_locations enable row level security';
    execute 'drop policy if exists "snacky_storage_locations_select_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_insert_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_update_by_effective_role" on public.storage_locations';
    execute 'drop policy if exists "snacky_storage_locations_delete_by_effective_role" on public.storage_locations';

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

    execute $sql$
      create policy "snacky_storage_locations_delete_by_effective_role"
      on public.storage_locations for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.suppliers') is not null then
    execute 'alter table public.suppliers enable row level security';
    execute 'drop policy if exists "snacky_suppliers_select_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_insert_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_update_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_delete_by_effective_role" on public.suppliers';

    execute $sql$
      create policy "snacky_suppliers_select_by_effective_role"
      on public.suppliers for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_insert_by_effective_role"
      on public.suppliers for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_update_by_effective_role"
      on public.suppliers for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_delete_by_effective_role"
      on public.suppliers for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;

  if to_regclass('public.purchase_orders') is not null then
    execute 'alter table public.purchase_orders enable row level security';
    execute 'drop policy if exists "snacky_purchase_orders_select_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_insert_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_update_by_effective_role" on public.purchase_orders';
    execute 'drop policy if exists "snacky_purchase_orders_delete_draft_by_effective_role" on public.purchase_orders';

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

    execute $sql$
      create policy "snacky_purchase_orders_delete_draft_by_effective_role"
      on public.purchase_orders for delete
      to authenticated
      using (
        status = 'draft'
        and public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing'])
      )
    $sql$;
  end if;

  if to_regclass('public.purchase_order_lines') is not null then
    execute 'alter table public.purchase_order_lines enable row level security';
    execute 'drop policy if exists "snacky_purchase_order_lines_select_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_insert_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_update_by_effective_role" on public.purchase_order_lines';
    execute 'drop policy if exists "snacky_purchase_order_lines_delete_draft_by_effective_role" on public.purchase_order_lines';

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

    execute $sql$
      create policy "snacky_purchase_order_lines_delete_draft_by_effective_role"
      on public.purchase_order_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing'])
        and exists (
          select 1
          from public.purchase_orders po
          where po.id = purchase_order_id
            and po.status = 'draft'
        )
      )
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'alter table public.inventory_movements enable row level security';
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
          public.snacky_current_profile_has_any_role(array['warehouse', 'purchasing'])
          and reason::text = 'purchase_received'
          and from_entity_type::text = 'supplier'
          and to_entity_type::text = 'storage'
        )
        or (
          public.snacky_current_profile_has_any_role(array['warehouse'])
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'manual_correction', 'damaged', 'expired', 'theft_or_missing', 'product_substitution'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'manual_correction', 'damaged', 'expired', 'product_substitution'])
        )
      )
    $sql$;
  end if;
end $$;

grant select on table public.products to authenticated;
grant select on table public.storage_locations to authenticated;
grant select on table public.suppliers to authenticated;
grant select on table public.purchase_orders to authenticated;
grant select on table public.purchase_order_lines to authenticated;
grant select on table public.inventory_movements to authenticated;
grant select on table public.current_inventory_by_location to authenticated;

select pg_notify('pgrst', 'reload schema');
