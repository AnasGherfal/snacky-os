alter policy crm_legacy_noncrm_access
on public.machine_slots
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_raw_record_boundary
on public.machine_slots
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_legacy_noncrm_access
on public.machines
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_raw_record_boundary
on public.machines
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_raw_record_boundary
on public.products
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_raw_record_boundary
on public.vms_import_batches
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_legacy_noncrm_access
on public.vms_stock_snapshots
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_raw_record_boundary
on public.vms_stock_snapshots
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));
