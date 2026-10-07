begin;

-- Fresh/disposable databases must contain the same route-reservation helper
-- that production route inventory functions call. Production already has this
-- function; CREATE OR REPLACE keeps this migration safe there as well.

create or replace function public.snacky_route_is_reservation_status(p_status text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $function$
  select lower(coalesce(p_status, '')) = any(array[
    'draft',
    'assigned',
    'in_progress',
    'pickup_confirmed',
    'available',
    'ready',
    'started',
    'filling',
    'machine_filling',
    'partially_completed',
    'stop_completed'
  ]);
$function$;

alter function public.snacky_route_is_reservation_status(text) owner to postgres;
revoke all on function public.snacky_route_is_reservation_status(text) from public, anon;
grant execute on function public.snacky_route_is_reservation_status(text) to authenticated, service_role;

commit;
