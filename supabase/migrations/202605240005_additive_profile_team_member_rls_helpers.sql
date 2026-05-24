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

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_current_profile_can_add_products() to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;
grant execute on function public.snacky_operator_can_read_product(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
