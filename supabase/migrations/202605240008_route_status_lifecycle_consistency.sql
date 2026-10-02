alter type route_status add value if not exists 'available';
alter type route_status add value if not exists 'ready';
alter type route_status add value if not exists 'started';
alter type route_status add value if not exists 'pickup_confirmed';
alter type route_status add value if not exists 'filling';
alter type route_status add value if not exists 'machine_filling';
alter type route_status add value if not exists 'canceled';

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
          and r.status::text in ('available', 'ready', 'draft')
        )
      )
  );
$$;

grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
