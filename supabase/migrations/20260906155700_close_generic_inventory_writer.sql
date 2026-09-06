-- Inventory custody must be changed only by its owning business command.
-- The generic movement RPC had no parent receipt and could bypass pickup,
-- stop, return, substitution, purchase and route-adjustment invariants.

revoke all on function public.snacky_create_stock_movement_v1(
  text,
  uuid,
  integer,
  public.inventory_entity_type,
  uuid,
  public.inventory_entity_type,
  uuid,
  public.movement_reason,
  uuid,
  text,
  boolean
) from public, anon, authenticated, service_role;

-- SECURITY DEFINER commands execute as their owning database role and do not
-- need a broad PostgREST service-role table grant. Keep the immutable ledger
-- readable for protected server diagnostics, but deny every direct writer.
revoke all on table public.inventory_movements from service_role;
grant select on table public.inventory_movements to service_role;

-- These are canonical command receipts/projections, not service-client work
-- queues. Their SECURITY DEFINER owners perform every mutation.
revoke all on table public.inventory_adjustments from service_role;
grant select on table public.inventory_adjustments to service_role;

revoke all on table public.route_stop_inventory_commits from service_role;
grant select on table public.route_stop_inventory_commits to service_role;

revoke all on table public.route_inventory_discrepancies from service_role;
grant select on table public.route_inventory_discrepancies to service_role;

revoke all on table public.route_inventory_discrepancy_resolution_events from service_role;
grant select on table public.route_inventory_discrepancy_resolution_events to service_role;

revoke all on table public.route_inventory_reconciliations from service_role;
grant select on table public.route_inventory_reconciliations to service_role;

revoke all on table public.route_inventory_reconciliation_lines from service_role;
grant select on table public.route_inventory_reconciliation_lines to service_role;

revoke all on table public.route_manual_sales from service_role;
grant select on table public.route_manual_sales to service_role;

revoke all on table public.route_customer_compensations from service_role;
grant select on table public.route_customer_compensations to service_role;

revoke all on table public.operator_route_custody_leases from service_role;
grant select on table public.operator_route_custody_leases to service_role;

revoke all on table public.route_pickup_batches from service_role;
grant select on table public.route_pickup_batches to service_role;

revoke all on table public.route_pick_list_items from service_role;
grant select on table public.route_pick_list_items to service_role;

revoke all on table public.historical_route_deduction_apply_operations from service_role;
grant select on table public.historical_route_deduction_apply_operations to service_role;

revoke all on table public.historical_route_deduction_source_claims from service_role;
grant select on table public.historical_route_deduction_source_claims to service_role;

revoke all on table public.purchase_orders from service_role;
grant select on table public.purchase_orders to service_role;

revoke all on table public.purchase_order_lines from service_role;
grant select on table public.purchase_order_lines to service_role;

-- Supabase's database-wide defaults grant service_role EXECUTE on newly
-- created functions. These helpers are implementation details of the
-- canonical commands above; leaving their inherited grants in place would
-- re-open a SECURITY DEFINER path around the read-only table grants.
revoke all on function public._snacky_active_route_custody()
  from service_role;
revoke all on function public._snacky_assert_operator_bag_balance_changes(jsonb)
  from service_role;
revoke all on function public._snacky_assert_operator_route_custody_touches(jsonb)
  from service_role;
revoke all on function public._snacky_audit_route_inventory_discrepancy_status_change()
  from service_role;
revoke all on function public._snacky_reject_route_inventory_resolution_event_mutation()
  from service_role;
revoke all on function public._snacky_release_operator_route_custody(uuid, uuid, text, uuid)
  from service_role;
revoke all on function public._snacky_route_bag_balances(uuid)
  from service_role;
revoke all on function public._snacky_route_bag_history_balances(uuid)
  from service_role;
revoke all on function public._snacky_route_bag_ledger_token(uuid)
  from service_role;
revoke all on function public._snacky_sync_route_stock_lines(uuid)
  from service_role;
revoke all on function public.snacky_guard_operator_bag_balance_insert()
  from service_role;
revoke all on function public.snacky_guard_operator_bag_balance_update()
  from service_role;
revoke all on function public.snacky_guard_operator_bag_balance_delete()
  from service_role;
revoke all on function public.snacky_guard_operator_route_custody_insert()
  from service_role;
revoke all on function public.snacky_guard_operator_route_custody_update()
  from service_role;
revoke all on function public.snacky_guard_operator_route_custody_delete()
  from service_role;
revoke all on function public.snacky_guard_route_inventory_integrity()
  from service_role;
revoke all on function public.snacky_guard_terminal_route_inventory_movement()
  from service_role;
revoke all on function public.snacky_guard_route_pickup_batch_audit()
  from service_role;
revoke all on function public.snacky_release_terminal_route_custody()
  from service_role;

select pg_notify('pgrst', 'reload schema');
