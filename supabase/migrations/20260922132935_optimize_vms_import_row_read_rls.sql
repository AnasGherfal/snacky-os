alter policy crm_raw_record_boundary
on public.vms_import_rows
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy snacky_vms_import_rows_select_by_vms_import_permission
on public.vms_import_rows
using ((select public.snacky_current_profile_can_view_vms_import()));

alter policy snacky_vms_import_rows_select_by_vms_import_role
on public.vms_import_rows
using ((select public.snacky_current_profile_has_any_role(array['owner','admin']::text[])));
