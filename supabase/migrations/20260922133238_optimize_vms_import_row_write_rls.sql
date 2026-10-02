alter policy snacky_vms_import_rows_insert_by_vms_import_permission
on public.vms_import_rows
with check ((select public.snacky_current_profile_can_manage_vms_mappings()));

alter policy snacky_vms_import_rows_insert_by_vms_import_role
on public.vms_import_rows
with check ((select public.snacky_current_profile_has_any_role(array['owner','admin']::text[])));

alter policy snacky_vms_import_rows_update_by_vms_import_permission
on public.vms_import_rows
using ((select public.snacky_current_profile_can_manage_vms_mappings()))
with check ((select public.snacky_current_profile_can_manage_vms_mappings()));

alter policy snacky_vms_import_rows_update_by_vms_import_role
on public.vms_import_rows
using ((select public.snacky_current_profile_has_any_role(array['owner','admin']::text[])))
with check ((select public.snacky_current_profile_has_any_role(array['owner','admin']::text[])));
