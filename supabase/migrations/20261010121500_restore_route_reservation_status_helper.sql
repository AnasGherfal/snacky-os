-- Keep the isolated migration replay consistent with the production route ledger.
-- The pickup/route stock guards call this function during ordinary inserts.
-- Missing it causes all native route and purchase integration checks to fail.
create or replace function public.snacky_route_is_reservation_status(p_status text)
returns boolean
language sql stable security definer
set search_path to 'public', 'auth'
as $fn$
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
$fn$;
