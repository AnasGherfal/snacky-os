alter policy crm_raw_record_boundary
on public.vms_monthly_product_profit
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy snacky_vms_monthly_product_profit_select_by_vms_import_permissi
on public.vms_monthly_product_profit
using ((select public.snacky_current_profile_can_view_vms_import()));
