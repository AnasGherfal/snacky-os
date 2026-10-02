-- Read-only permission optimization. No write policies, grants, ledger rows,
-- route statuses, assignments, pickup or completion functions are changed.
-- Abort rather than overwrite a policy whose original access rule has drifted.
do $guard$
declare item record; old_expression text;
begin
 for item in select * from (values
  ('route_stops','snacky_route_stops_select_by_route_access','owner,admin,supervisor'),
  ('route_pick_list_items','snacky_route_pick_list_items_select_by_route_access','owner,admin,supervisor,warehouse'),
  ('route_pickup_batches','snacky_route_pickup_batches_select_by_route_access','owner,admin,supervisor,warehouse'),
  ('route_stop_items','snacky_route_stop_items_select_by_route_access','owner,admin,supervisor,warehouse'),
  ('route_stock_lines','snacky_route_stock_lines_select_by_route_access','owner,admin,supervisor,warehouse'),
  ('route_inventory_reconciliations','snacky_route_inventory_reconciliations_select','owner,admin,supervisor,warehouse'),
  ('route_inventory_discrepancies','snacky_route_inventory_discrepancies_select','owner,admin,supervisor,warehouse'),
  ('route_inventory_reconciliation_lines','snacky_route_inventory_reconciliation_lines_select','owner,admin,supervisor,warehouse')
 ) as targets(table_name,policy_name,roles_csv)
 loop
  select qual into old_expression from pg_policies
   where schemaname='public' and tablename=item.table_name
    and policyname=item.policy_name and cmd='SELECT' and permissive='PERMISSIVE';
  if old_expression is distinct from format(
   '(snacky_current_profile_has_any_role(ARRAY[%s]) OR snacky_operator_can_access_route(route_id))',
   (select string_agg(quote_literal(role_name)||'::text',', ') from unnest(string_to_array(item.roles_csv,',')) role_name)
  ) then raise exception 'Route read policy drift: %.%',item.table_name,item.policy_name; end if;
 end loop;
end $guard$;

alter policy snacky_route_stops_select_by_route_access on public.route_stops
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_pick_list_items_select_by_route_access on public.route_pick_list_items
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_pickup_batches_select_by_route_access on public.route_pickup_batches
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_stop_items_select_by_route_access on public.route_stop_items
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_stock_lines_select_by_route_access on public.route_stock_lines
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_inventory_reconciliations_select on public.route_inventory_reconciliations
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_inventory_discrepancies_select on public.route_inventory_discrepancies
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

alter policy snacky_route_inventory_reconciliation_lines_select on public.route_inventory_reconciliation_lines
using (case when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[])) then true else public.snacky_operator_can_access_route(route_id) end);

select pg_notify('pgrst','reload schema');
