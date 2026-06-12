create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  with profile_ctx as (
    select
      p.roles as profile_roles,
      p.role as profile_role,
      tm.roles as team_roles,
      tm.role as team_role,
      p.active_status = 'active' as effective_active
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
  ),
  team_member_ctx as (
    select
      null::public.team_role[] as profile_roles,
      null::public.team_role as profile_role,
      tm.roles as team_roles,
      tm.role as team_role,
      coalesce(
        tm.active_status = 'active',
        case when tm.active is false then false else true end
      ) as effective_active
    from public.team_members tm
    where tm.auth_user_id = auth.uid()
      and not exists (select 1 from profile_ctx)
  )
  select exists (
    select 1
    from (
      select * from profile_ctx
      union all
      select * from team_member_ctx
    ) ctx
    where ctx.effective_active
      and (
        public.snacky_profile_has_any_role(ctx.profile_roles, ctx.profile_role, allowed_roles)
        or public.snacky_profile_has_any_role(ctx.team_roles, ctx.team_role, allowed_roles)
      )
  );
$$;

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
