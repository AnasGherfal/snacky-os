-- Restore a pure route-status classifier required by reservation-aware inventory
-- writers and route pickup checks. Existing production already has this helper,
-- but clean database replays must define it as well.
--
-- This classifier reads no tables and requires no elevated database privileges.
create or replace function public.snacky_route_is_reservation_status(p_status text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
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

comment on function public.snacky_route_is_reservation_status(text) is
  'Pure classifier for route statuses with outstanding planning reservations; terminal routes are excluded.';

select pg_notify('pgrst', 'reload schema');
