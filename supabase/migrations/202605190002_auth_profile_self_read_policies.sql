do $$
begin
  if to_regclass('public.profiles') is null then
    raise notice 'profiles table is not available; skipping self-read policy setup.';
    return;
  end if;

  execute 'drop policy if exists "snacky_profiles_self_read" on public.profiles';

  execute $sql$
    create policy "snacky_profiles_self_read"
    on public.profiles for select
    to authenticated
    using (id = auth.uid())
  $sql$;
end $$;

do $$
begin
  if to_regclass('public.team_members') is null then
    raise notice 'team_members table is not available; skipping self-read policy setup.';
    return;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'team_members'
      and column_name = 'auth_user_id'
  ) then
    raise notice 'team_members.auth_user_id is not available; skipping team member self-read policy setup.';
    return;
  end if;

  execute 'drop policy if exists "snacky_team_members_self_read" on public.team_members';

  execute $sql$
    create policy "snacky_team_members_self_read"
    on public.team_members for select
    to authenticated
    using (auth_user_id = auth.uid())
  $sql$;
end $$;
