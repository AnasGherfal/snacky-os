create or replace function public.snacky_route_leftover_storage_location_id(p_route_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_storage_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'You are not authorized to access storage for this route.' using errcode = '42501';
  end if;

  select sl.id
    into v_storage_id
  from public.storage_locations sl
  where sl.active = true
    and sl.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  order by sl.location_type, sl.name
  limit 1;

  return v_storage_id;
end;
$$;

grant execute on function public.snacky_route_leftover_storage_location_id(uuid) to authenticated;