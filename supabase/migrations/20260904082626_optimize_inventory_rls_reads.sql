-- Preserve the existing access rules while allowing PostgreSQL to evaluate
-- row-independent profile checks once per statement instead of once per row.
-- This is especially important for security-invoker inventory/refill views,
-- which scan the inventory ledger more than once.

alter policy snacky_inventory_movements_select_by_effective_role
on public.inventory_movements
using (
  (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']::text[]))
  or (
    related_route_id is not null
    and public.snacky_operator_can_access_route(related_route_id)
  )
);

alter policy snacky_products_select_by_effective_role
on public.products
using (
  (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']::text[]))
  or public.snacky_operator_can_read_product(id)
);

alter policy snacky_products_select_for_vms_import_validation
on public.products
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin']::text[])));

alter policy snacky_products_select_for_vms_mapping
on public.products
using ((select public.snacky_current_profile_can_view_vms_import()));

alter policy snacky_storage_locations_select_by_effective_role
on public.storage_locations
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']::text[])));

alter policy snacky_machines_select_for_vms_import_validation
on public.machines
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin']::text[])));

alter policy snacky_vms_select
on public.vms_import_batches
using ((select public.snacky_current_profile_can_view_vms_import()));

alter policy snacky_team_members_self_read
on public.team_members
using (auth_user_id = (select auth.uid()));
