alter policy crm_raw_record_boundary
on public.inventory_movements
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));
