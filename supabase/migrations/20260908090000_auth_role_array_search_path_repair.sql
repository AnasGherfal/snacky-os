-- Route writers run with an empty search_path. Keep the shared role helper
-- safe in that context by fully qualifying its enum-array casts and builtins.
create or replace function public.snacky_profile_has_any_role(
  profile_roles public.team_role[],
  primary_role public.team_role,
  allowed_roles text[]
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists(
    select 1
    from pg_catalog.unnest(
      pg_catalog.array_remove(
        coalesce(profile_roles, '{}'::public.team_role[])
          || pg_catalog.array_append('{}'::public.team_role[], primary_role),
        null
      )
    ) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$function$;

revoke all on function public.snacky_profile_has_any_role(public.team_role[], public.team_role, text[])
  from public, anon;
grant execute on function public.snacky_profile_has_any_role(public.team_role[], public.team_role, text[])
  to authenticated, service_role;

notify pgrst, 'reload schema';
