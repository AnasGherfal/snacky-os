alter type route_status add value if not exists 'available';
alter type route_status add value if not exists 'ready';
alter type route_status add value if not exists 'started';
alter type route_status add value if not exists 'pickup_confirmed';
alter type route_status add value if not exists 'filling';
alter type route_status add value if not exists 'machine_filling';
alter type route_status add value if not exists 'canceled';

comment on type route_status is
  'Snacky OS route lifecycle. App writes stable statuses draft, assigned, in_progress, completed, reviewed, cancelled; extra values are accepted for legacy deployed rows and displayed by route-workflow helpers.';

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
          and r.status::text in ('draft', 'available', 'ready')
        )
      )
  );
$$;

grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('public.route_stock_lines') is not null then
    execute 'grant select, insert, update, delete on table public.route_stock_lines to authenticated';
    execute 'drop policy if exists "snacky_route_stock_lines_insert_by_effective_role" on public.route_stock_lines';

    execute $sql$
      create policy "snacky_route_stock_lines_insert_by_effective_role"
      on public.route_stock_lines for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
