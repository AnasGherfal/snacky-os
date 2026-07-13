-- Grant the service role access to auth-linked profile tables so local login/profile hydration works.

grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.team_members to service_role;
