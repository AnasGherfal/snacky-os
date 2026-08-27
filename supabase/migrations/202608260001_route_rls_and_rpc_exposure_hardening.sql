-- Reconcile route RLS with the policies already deployed in production and
-- remove unauthenticated access to privileged RPC functions.

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'routes',
    'route_stops',
    'route_stock_lines',
    'route_stop_items',
    'route_pick_list_items',
    'refill_orders',
    'refill_order_lines'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is not null then
      execute format('alter table public.%I enable row level security', target_table);
      execute format('revoke all on table public.%I from anon, authenticated', target_table);
      execute format(
        'grant select, insert, update, delete on table public.%I to authenticated',
        target_table
      );
    end if;
  end loop;
end $$;

-- Managers see every route. Warehouse needs route headers for pick lists,
-- finance needs them for cash/ledger links, and viewer is the read-only
-- dashboard role. Operators remain limited to routes assigned to them.
drop policy if exists "snacky_routes_select_by_effective_role" on public.routes;
create policy "snacky_routes_select_by_effective_role"
on public.routes for select
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'finance', 'viewer']
  ))
  or public.snacky_operator_can_access_route(id)
);

-- Refill tables previously had write policies but no SELECT policy. Enabling
-- RLS without these would make route pickup and stop execution read zero rows.
drop policy if exists "snacky_refill_orders_select_by_route_access" on public.refill_orders;
create policy "snacky_refill_orders_select_by_route_access"
on public.refill_orders for select
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse']
  ))
  or public.snacky_operator_can_access_route(route_id)
);

drop policy if exists "snacky_refill_order_lines_select_by_route_access" on public.refill_order_lines;
create policy "snacky_refill_order_lines_select_by_route_access"
on public.refill_order_lines for select
to authenticated
using (
  exists (
    select 1
    from public.refill_orders ro
    where ro.id = refill_order_id
  )
);

-- Snacky OS has no public RPC surface. SECURITY DEFINER functions can bypass
-- RLS, so anonymous/Public execution is never appropriate for this internal OS.
do $$
declare
  function_signature text;
begin
  for function_signature in
    select format(
      '%I.%I(%s)',
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid)
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format(
      'revoke execute on function %s from public, anon',
      function_signature
    );
  end loop;
end $$;

-- Prevent future privileged functions from becoming anonymous RPC endpoints
-- through PostgreSQL's default PUBLIC execute privilege.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon;

select pg_notify('pgrst', 'reload schema');
